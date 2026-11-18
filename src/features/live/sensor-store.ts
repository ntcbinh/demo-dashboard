import { SensorStatus, type SensorStatusCode } from "@/lib/sensors";
import type { FrameHeader } from "@/lib/protocol";

/**
 * Live sensor state, held outside React.
 *
 * React state is the wrong tool for 5,000 values changing 10 times a second:
 * every commit would walk the whole tree to update the handful of rows that
 * happen to be on screen. Instead the values live in flat typed arrays and
 * components subscribe per sensor through `useSyncExternalStore`, so a frame
 * re-renders only the rows the virtualiser has actually mounted.
 *
 * The arrays are allocated once. Nothing in the steady-state path allocates,
 * which keeps the major GC out of the animation frame budget.
 */

/** Sparkline window kept for every sensor. */
export const RING_SIZE = 64;

/** Longer window kept for the one sensor the chart is focused on. */
export const FOCUS_RING_SIZE = 600;

export type AggregateSnapshot = {
  readonly normal: number;
  readonly warning: number;
  readonly alarm: number;
  readonly stale: number;
  /** Sensors reported in the most recent frame. */
  readonly reported: number;
  readonly seq: number;
  readonly timestamp: number;
};

export type FocusSeriesPoint = {
  readonly t: number;
  readonly v: number;
};

const EMPTY_AGGREGATE: AggregateSnapshot = {
  normal: 0,
  warning: 0,
  alarm: 0,
  stale: 0,
  reported: 0,
  seq: 0,
  timestamp: 0,
};

export class SensorStore {
  readonly count: number;

  /** Latest value per sensor. */
  readonly values: Float32Array;
  /** Latest status per sensor. */
  readonly statuses: Uint8Array;
  /** Wall-clock time each sensor last reported, for staleness detection. */
  readonly updatedAt: Float64Array;

  /**
   * Bumped whenever a sensor reports. Rows subscribe to this number: it is a
   * primitive, so `useSyncExternalStore` bails out of the re-render when the
   * sensor did not change.
   */
  private readonly revisions: Uint32Array;

  /** `count * RING_SIZE` sparkline samples, newest at `ringCursor`. */
  private readonly ring: Float32Array;
  private ringCursor = 0;
  private ringFilled = 0;

  private readonly sensorListeners = new Map<number, Set<() => void>>();
  private readonly aggregateListeners = new Set<() => void>();

  /** Dirty set for the current frame, as a flag array plus a dense list. */
  private readonly dirtyFlags: Uint8Array;
  private readonly dirtyList: Uint32Array;
  private dirtyCount = 0;

  private aggregate: AggregateSnapshot = EMPTY_AGGREGATE;
  private reportedThisFrame = 0;

  private focusIndex = -1;
  private readonly focusValues: Float32Array;
  private readonly focusTimes: Float64Array;
  private focusCursor = 0;
  private focusFilled = 0;
  private focusRevision = 0;
  private readonly focusListeners = new Set<() => void>();

  constructor(count: number) {
    this.count = count;
    this.values = new Float32Array(count);
    this.statuses = new Uint8Array(count).fill(SensorStatus.Stale);
    this.updatedAt = new Float64Array(count);
    this.revisions = new Uint32Array(count);
    this.ring = new Float32Array(count * RING_SIZE);
    this.dirtyFlags = new Uint8Array(count);
    this.dirtyList = new Uint32Array(count);
    this.focusValues = new Float32Array(FOCUS_RING_SIZE);
    this.focusTimes = new Float64Array(FOCUS_RING_SIZE);
  }

  // --- ingest ------------------------------------------------------------

  /**
   * Records one sample. Called straight from the frame decoder, once per
   * reported sensor — up to 50,000 times a second — so it stays branch-light
   * and allocation-free.
   */
  writeSample = (index: number, value: number, status: SensorStatusCode): void => {
    if (index < 0 || index >= this.count) return;

    this.values[index] = value;
    this.statuses[index] = status;
    this.revisions[index]++;

    if (this.dirtyFlags[index] === 0) {
      this.dirtyFlags[index] = 1;
      this.dirtyList[this.dirtyCount++] = index;
    }
  };

  /**
   * Closes a frame: advances the sparkline ring, refreshes the aggregate and
   * appends to the focused sensor's series.
   *
   * The ring advances once per frame rather than per sample so that every
   * sensor's sparkline shares one time axis — a sensor inside its deadband
   * simply repeats its last value, which is what "no change reported" means.
   */
  commitFrame(header: FrameHeader, now: number): void {
    const cursor = (this.ringCursor + 1) % RING_SIZE;
    this.ringCursor = cursor;
    if (this.ringFilled < RING_SIZE) this.ringFilled++;

    const { values, ring, statuses, updatedAt, count } = this;
    let normal = 0;
    let warning = 0;
    let alarm = 0;
    let stale = 0;

    for (let i = 0; i < count; i++) {
      ring[i * RING_SIZE + cursor] = values[i];
      switch (statuses[i]) {
        case SensorStatus.Normal:
          normal++;
          break;
        case SensorStatus.Warning:
          warning++;
          break;
        case SensorStatus.Alarm:
          alarm++;
          break;
        default:
          stale++;
      }
    }

    for (let i = 0; i < this.dirtyCount; i++) {
      updatedAt[this.dirtyList[i]] = now;
    }

    this.reportedThisFrame = header.count;
    this.aggregate = {
      normal,
      warning,
      alarm,
      stale,
      reported: header.count,
      seq: header.seq,
      timestamp: header.timestamp,
    };

    if (this.focusIndex >= 0) {
      this.focusCursor = (this.focusCursor + 1) % FOCUS_RING_SIZE;
      if (this.focusFilled < FOCUS_RING_SIZE) this.focusFilled++;
      this.focusValues[this.focusCursor] = values[this.focusIndex];
      this.focusTimes[this.focusCursor] = header.timestamp;
      this.focusRevision++;
    }
  }

  /**
   * Notifies subscribers and clears the dirty set. Called once per animation
   * frame so a burst of frames collapses into a single React commit.
   */
  flush(): void {
    for (let i = 0; i < this.dirtyCount; i++) {
      const index = this.dirtyList[i];
      this.dirtyFlags[index] = 0;
      const listeners = this.sensorListeners.get(index);
      if (listeners !== undefined) {
        for (const listener of listeners) listener();
      }
    }
    this.dirtyCount = 0;

    for (const listener of this.aggregateListeners) listener();
    if (this.focusIndex >= 0) {
      for (const listener of this.focusListeners) listener();
    }
  }

  /** Marks every sensor stale, e.g. after the socket drops. */
  markAllStale(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.statuses[i] !== SensorStatus.Stale) {
        this.statuses[i] = SensorStatus.Stale;
        this.revisions[i]++;
        if (this.dirtyFlags[i] === 0) {
          this.dirtyFlags[i] = 1;
          this.dirtyList[this.dirtyCount++] = i;
        }
      }
    }
    this.aggregate = { ...this.aggregate, normal: 0, warning: 0, alarm: 0, stale: this.count };
    this.flush();
  }

  // --- reads -------------------------------------------------------------

  getRevision = (index: number): number => this.revisions[index] ?? 0;

  getAggregate = (): AggregateSnapshot => this.aggregate;

  getReportedThisFrame = (): number => this.reportedThisFrame;

  /**
   * Copies a sensor's sparkline into `target` in chronological order and
   * returns how many samples were written. The caller owns the buffer, so
   * reading a sparkline allocates nothing.
   */
  readSparkline(index: number, target: Float32Array): number {
    const length = Math.min(this.ringFilled, target.length);
    const base = index * RING_SIZE;
    const oldest = (this.ringCursor - length + 1 + RING_SIZE) % RING_SIZE;
    for (let i = 0; i < length; i++) {
      target[i] = this.ring[base + ((oldest + i) % RING_SIZE)];
    }
    return length;
  }

  // --- focus -------------------------------------------------------------

  setFocus(index: number): void {
    if (index === this.focusIndex) return;
    this.focusIndex = index;
    this.focusCursor = 0;
    this.focusFilled = 0;
    this.focusRevision++;
    for (const listener of this.focusListeners) listener();
  }

  getFocusIndex = (): number => this.focusIndex;

  getFocusRevision = (): number => this.focusRevision;

  /**
   * Materialises the focused sensor's series for the chart. This is the one
   * read that allocates, and it is called at the chart's own throttled
   * cadence — a few times a second — not once per frame.
   */
  readFocusSeries(): FocusSeriesPoint[] {
    if (this.focusIndex < 0 || this.focusFilled === 0) return [];
    const length = this.focusFilled;
    const points: FocusSeriesPoint[] = new Array<FocusSeriesPoint>(length);
    const oldest = (this.focusCursor - length + 1 + FOCUS_RING_SIZE) % FOCUS_RING_SIZE;
    for (let i = 0; i < length; i++) {
      const slot = (oldest + i) % FOCUS_RING_SIZE;
      points[i] = { t: this.focusTimes[slot], v: this.focusValues[slot] };
    }
    return points;
  }

  // --- subscriptions -----------------------------------------------------

  subscribeSensor = (index: number, listener: () => void): (() => void) => {
    let listeners = this.sensorListeners.get(index);
    if (listeners === undefined) {
      listeners = new Set<() => void>();
      this.sensorListeners.set(index, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.sensorListeners.get(index);
      if (current === undefined) return;
      current.delete(listener);
      // Rows scroll in and out constantly; dropping empty sets keeps the map
      // proportional to what is on screen rather than to everything ever seen.
      if (current.size === 0) this.sensorListeners.delete(index);
    };
  };

  subscribeAggregate = (listener: () => void): (() => void) => {
    this.aggregateListeners.add(listener);
    return () => this.aggregateListeners.delete(listener);
  };

  subscribeFocus = (listener: () => void): (() => void) => {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  };

  /** Number of live per-sensor subscriptions; surfaced in the metrics panel. */
  get subscriberCount(): number {
    let total = 0;
    for (const listeners of this.sensorListeners.values()) total += listeners.size;
    return total;
  }
}
