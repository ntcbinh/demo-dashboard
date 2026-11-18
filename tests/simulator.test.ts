import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SensorSimulator } from "../server/simulator.ts";
import { buildSensorCatalog, classify, SensorStatus } from "../src/lib/sensors.ts";

describe("sensor catalog", () => {
  it("is deterministic for a given seed", () => {
    const first = buildSensorCatalog(200);
    const second = buildSensorCatalog(200);
    assert.deepEqual(first, second);
  });

  it("gives every sensor thresholds inside its range, warning below alarm", () => {
    for (const sensor of buildSensorCatalog(500)) {
      assert.ok(sensor.warnAt > sensor.min, `${sensor.id} warn above min`);
      assert.ok(sensor.alarmAt > sensor.warnAt, `${sensor.id} alarm above warn`);
      assert.ok(sensor.alarmAt < sensor.max, `${sensor.id} alarm below max`);
      assert.ok(sensor.baseline > sensor.min && sensor.baseline < sensor.warnAt);
    }
  });

  it("classifies against the thresholds", () => {
    const sensor = buildSensorCatalog(1)[0];
    assert.equal(classify(sensor, sensor.min), SensorStatus.Normal);
    assert.equal(classify(sensor, sensor.warnAt), SensorStatus.Warning);
    assert.equal(classify(sensor, sensor.alarmAt), SensorStatus.Alarm);
    assert.equal(classify(sensor, sensor.alarmAt + 1), SensorStatus.Alarm);
  });
});

describe("simulator", () => {
  it("reports every sensor on the first tick", () => {
    const simulator = new SensorSimulator({ sensorCount: 300 });
    assert.equal(simulator.changedCount, 300);
  });

  it("keeps values inside each sensor's range", () => {
    const simulator = new SensorSimulator({ sensorCount: 400 });
    let now = Date.now();
    for (let tick = 0; tick < 60; tick++) {
      now += 100;
      simulator.tick(now);
      for (let i = 0; i < simulator.count; i++) {
        const sensor = simulator.sensors[i];
        const value = simulator.values[i];
        assert.ok(
          value >= sensor.min && value <= sensor.max,
          `${sensor.id} value ${value} outside [${sensor.min}, ${sensor.max}]`,
        );
      }
    }
  });

  it("suppresses sub-deadband movement so a delta is smaller than a snapshot", () => {
    const simulator = new SensorSimulator({ sensorCount: 2_000, deadbandRatio: 0.004 });
    let now = Date.now();
    let total = 0;
    const ticks = 30;

    for (let tick = 0; tick < ticks; tick++) {
      now += 100;
      simulator.tick(now);
      total += simulator.changedCount;
    }

    const average = total / ticks;
    assert.ok(average < simulator.count, `deadband reported everything (${average})`);
    assert.ok(average > 0, "deadband suppressed everything");
  });

  it("reports nothing extra when the deadband is wide enough to swallow the noise", () => {
    // A deadband of a full range means only a threshold crossing can report.
    const simulator = new SensorSimulator({ sensorCount: 500, deadbandRatio: 10 });
    let now = Date.now();
    simulator.tick((now += 100));
    simulator.tick((now += 100));
    assert.equal(simulator.changedCount, 0);
  });

  it("never withholds a status transition, however wide the deadband", () => {
    // A deadband of a full range suppresses all ordinary movement, so the only
    // thing that can still report is a threshold crossing. Anomaly episodes
    // drive those crossings; this asserts the invariant that matters most
    // operationally: an alarm is never delayed by report-by-exception.
    const simulator = new SensorSimulator({
      sensorCount: 300,
      deadbandRatio: 10,
      concurrentEpisodes: 24,
    });

    let now = Date.now();
    simulator.tick((now += 100));
    let previous = Uint8Array.from(simulator.statuses);
    let transitions = 0;

    for (let tick = 0; tick < 400; tick++) {
      now += 100;
      simulator.tick(now);

      const reported = new Set(
        Array.from(simulator.changed.subarray(0, simulator.changedCount)),
      );

      for (let i = 0; i < simulator.count; i++) {
        if (simulator.statuses[i] === previous[i]) continue;
        transitions++;
        assert.ok(
          reported.has(i),
          `sensor ${i} changed ${previous[i]} -> ${simulator.statuses[i]} without reporting`,
        );
      }

      previous = Uint8Array.from(simulator.statuses);
    }

    assert.ok(transitions > 0, "no status transitions occurred, so nothing was proven");
  });

  it("counts statuses consistently with the value array", () => {
    const simulator = new SensorSimulator({ sensorCount: 600 });
    simulator.tick(Date.now() + 5_000);
    const counts = simulator.statusCounts();
    const total =
      counts[SensorStatus.Normal] +
      counts[SensorStatus.Warning] +
      counts[SensorStatus.Alarm] +
      counts[SensorStatus.Stale];
    assert.equal(total, simulator.count);
  });
});
