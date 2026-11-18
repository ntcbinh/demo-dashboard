import { createRng } from "../src/lib/rng.ts";
import {
  buildSensorCatalog,
  classify,
  SENSOR_COUNT,
  SensorStatus,
  type Sensor,
  type SensorStatusCode,
} from "../src/lib/sensors.ts";

/**
 * Sensor floor simulator.
 *
 * Every sensor follows a slow sinusoid plus noise around its baseline. On top
 * of that, a small number of sensors are always inside an "anomaly episode":
 * a ramp up into the warning or alarm band, a plateau, then a recovery. That
 * gives the dashboard something real to react to — alarms that appear, persist
 * for a while and clear — instead of values flickering randomly across
 * thresholds.
 *
 * State lives in typed arrays indexed by `sensor.index`, so one tick is a
 * straight numeric loop over contiguous memory.
 */

type Episode = {
  /** Sensor currently drifting, or -1 for a free slot. */
  index: number;
  /** Peak offset added to the sensor's normal value, in sensor units. */
  magnitude: number;
  startedAt: number;
  rampMs: number;
  holdMs: number;
  recoverMs: number;
};

export type SimulatorOptions = {
  readonly sensorCount?: number;
  readonly seed?: number;
  /** How many sensors drift out of band at any one time. */
  readonly concurrentEpisodes?: number;
  /**
   * Report-by-exception deadband, as a fraction of each sensor's range. A
   * sensor is only reported once it has moved further than this from the value
   * last sent, which is how real SCADA/OPC-UA feeds avoid shipping sensor
   * noise. Status transitions always report regardless of the deadband.
   */
  readonly deadbandRatio?: number;
};

export class SensorSimulator {
  readonly sensors: readonly Sensor[];
  readonly count: number;

  /** Current value per sensor. */
  readonly values: Float32Array;
  /** Current status per sensor, derived from thresholds. */
  readonly statuses: Uint8Array;

  /**
   * Indices whose value changed in the most recent tick. Reused across ticks;
   * read together with `changedCount`.
   */
  readonly changed: Uint16Array;
  changedCount = 0;

  /** Value last published per sensor, which the deadband compares against. */
  private readonly reported: Float32Array;
  /** Status last published per sensor; a change here always forces a report. */
  private readonly reportedStatus: Uint8Array;
  /** Absolute deadband per sensor, in sensor units. */
  private readonly deadband: Float32Array;
  private readonly episodes: Episode[];
  private readonly rng: () => number;
  private readonly startedAt = Date.now();

  constructor(options: SimulatorOptions = {}) {
    const count = options.sensorCount ?? SENSOR_COUNT;
    this.sensors = buildSensorCatalog(count);
    this.count = count;
    this.values = new Float32Array(count);
    this.reported = new Float32Array(count);
    this.statuses = new Uint8Array(count);
    this.reportedStatus = new Uint8Array(count);
    this.changed = new Uint16Array(count);
    this.deadband = new Float32Array(count);
    this.rng = createRng(options.seed ?? 0xc0ffee);

    const deadbandRatio = options.deadbandRatio ?? 0.004;
    for (let i = 0; i < count; i++) {
      const sensor = this.sensors[i];
      this.deadband[i] = (sensor.max - sensor.min) * deadbandRatio;
      // Seed `reported` far from any real value so the first tick reports
      // every sensor and the initial snapshot is complete.
      this.reported[i] = Number.NEGATIVE_INFINITY;
      this.reportedStatus[i] = 255;
    }

    const episodeCount = options.concurrentEpisodes ?? Math.max(4, Math.round(count * 0.004));
    this.episodes = Array.from({ length: episodeCount }, () => ({
      index: -1,
      magnitude: 0,
      startedAt: 0,
      rampMs: 0,
      holdMs: 0,
      recoverMs: 0,
    }));

    // Prime the arrays so the first snapshot frame is already meaningful.
    this.tick(this.startedAt);
  }

  /**
   * Advances the simulation to `now` and refreshes `changed` / `changedCount`.
   */
  tick(now: number): void {
    const elapsed = now - this.startedAt;
    this.advanceEpisodes(now);

    let changedCount = 0;

    for (let i = 0; i < this.count; i++) {
      const sensor = this.sensors[i];
      const wave =
        Math.sin((elapsed / sensor.periodMs) * Math.PI * 2 + sensor.phase) *
        sensor.amplitude;
      const noise = (this.rng() - 0.5) * 2 * sensor.noise;

      let value = sensor.baseline + wave + noise;
      value += this.episodeOffset(i, now);
      value = clamp(value, sensor.min, sensor.max);

      this.values[i] = value;
      this.statuses[i] = classify(sensor, value);

      const status = this.statuses[i];
      // Report when the value leaves the deadband, or whenever the status
      // changes — an alarm must never be withheld because the value only
      // crept across the threshold.
      if (
        status !== this.reportedStatus[i] ||
        Math.abs(value - this.reported[i]) >= this.deadband[i]
      ) {
        this.changed[changedCount++] = i;
        this.reported[i] = value;
        this.reportedStatus[i] = status;
      }
    }

    this.changedCount = changedCount;
  }

  /** Indices of every sensor, for a snapshot frame. */
  allIndices(): Uint16Array {
    const all = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) all[i] = i;
    return all;
  }

  statusCounts(): Record<SensorStatusCode, number> {
    const counts: Record<SensorStatusCode, number> = {
      [SensorStatus.Normal]: 0,
      [SensorStatus.Warning]: 0,
      [SensorStatus.Alarm]: 0,
      [SensorStatus.Stale]: 0,
    };
    for (let i = 0; i < this.count; i++) {
      counts[this.statuses[i] as SensorStatusCode]++;
    }
    return counts;
  }

  private advanceEpisodes(now: number): void {
    for (const episode of this.episodes) {
      if (episode.index === -1) {
        this.startEpisode(episode, now);
        continue;
      }
      const total = episode.rampMs + episode.holdMs + episode.recoverMs;
      if (now - episode.startedAt > total) {
        // Free the slot; it is refilled on the next tick so recoveries are
        // visible rather than instantly replaced.
        episode.index = -1;
      }
    }
  }

  private startEpisode(episode: Episode, now: number): void {
    const index = Math.floor(this.rng() * this.count);
    const sensor = this.sensors[index];
    const range = sensor.max - sensor.min;

    episode.index = index;
    // Most episodes reach the warning band; a minority push into alarm.
    const reachesAlarm = this.rng() < 0.35;
    const target = reachesAlarm
      ? sensor.alarmAt + range * 0.04
      : sensor.warnAt + range * 0.05;
    episode.magnitude = Math.max(0, target - sensor.baseline);
    episode.startedAt = now;
    episode.rampMs = 3_000 + this.rng() * 9_000;
    episode.holdMs = 4_000 + this.rng() * 14_000;
    episode.recoverMs = 3_000 + this.rng() * 8_000;
  }

  private episodeOffset(index: number, now: number): number {
    for (const episode of this.episodes) {
      if (episode.index !== index) continue;

      const age = now - episode.startedAt;
      if (age < episode.rampMs) {
        return episode.magnitude * easeInOut(age / episode.rampMs);
      }
      const held = age - episode.rampMs;
      if (held < episode.holdMs) {
        return episode.magnitude;
      }
      const recovering = held - episode.holdMs;
      if (recovering < episode.recoverMs) {
        return episode.magnitude * (1 - easeInOut(recovering / episode.recoverMs));
      }
      return 0;
    }
    return 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}
