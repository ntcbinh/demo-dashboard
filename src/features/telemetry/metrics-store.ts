import type { Encoding } from "@/lib/protocol";

/**
 * Transport and render metrics for the performance panel.
 *
 * The panel exists so the optimisations in this project are measurable rather
 * than asserted: switch the wire encoding or the frame rate and the numbers
 * move while the UI keeps its frame budget.
 *
 * Counters are accumulated on the hot path and only turned into a snapshot
 * object once per sampling window, so reading metrics never costs a frame.
 */

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type MetricsSnapshot = {
  readonly connection: ConnectionState;
  readonly encoding: Encoding;
  /** Frames decoded in the last sampling window, scaled to per second. */
  readonly framesPerSecond: number;
  readonly bytesPerSecond: number;
  readonly samplesPerSecond: number;
  /** Rendered frames per second, measured from `requestAnimationFrame`. */
  readonly fps: number;
  /** Rolling mean time to decode one frame into the store, in milliseconds. */
  readonly decodeMs: number;
  /** Rolling mean time spent notifying React subscribers, in milliseconds. */
  readonly flushMs: number;
  /** React commits of the live table body in the last window, per second. */
  readonly rowCommitsPerSecond: number;
  /** Per-sensor subscriptions currently mounted. */
  readonly subscribers: number;
  readonly totalFrames: number;
  readonly totalBytes: number;
  /**
   * Frames that arrived while a notification was already queued for this
   * paint. Their data is applied in full; only the React notification is
   * shared, which is the point of the coalescing step.
   */
  readonly coalescedFrames: number;
};

const SAMPLE_WINDOW_MS = 500;
/** Weight of the newest measurement in the rolling means. */
const EMA_ALPHA = 0.15;

const INITIAL: MetricsSnapshot = {
  connection: "connecting",
  encoding: "binary",
  framesPerSecond: 0,
  bytesPerSecond: 0,
  samplesPerSecond: 0,
  fps: 0,
  decodeMs: 0,
  flushMs: 0,
  rowCommitsPerSecond: 0,
  subscribers: 0,
  totalFrames: 0,
  totalBytes: 0,
  coalescedFrames: 0,
};

export class MetricsStore {
  private snapshot: MetricsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();

  private frames = 0;
  private bytes = 0;
  private samples = 0;
  private paints = 0;
  private rowCommits = 0;

  private decodeMs = 0;
  private flushMs = 0;

  private totalFrames = 0;
  private totalBytes = 0;
  private coalescedFrames = 0;

  private connection: ConnectionState = "connecting";
  private encoding: Encoding = "binary";
  private subscriberCount = 0;

  private windowStart = 0;

  recordFrame(byteLength: number, sampleCount: number, decodeMs: number): void {
    this.frames++;
    this.bytes += byteLength;
    this.samples += sampleCount;
    this.totalFrames++;
    this.totalBytes += byteLength;
    this.decodeMs = ema(this.decodeMs, decodeMs);
  }

  recordFlush(flushMs: number): void {
    this.flushMs = ema(this.flushMs, flushMs);
  }

  recordPaint(): void {
    this.paints++;
  }

  /** Called by the live table body on every React commit. */
  recordRowCommit(): void {
    this.rowCommits++;
  }

  /** A frame arrived while a notification was already queued for this paint. */
  recordCoalescedFrame(): void {
    this.coalescedFrames++;
  }

  setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.publish(performance.now(), true);
  }

  setEncoding(encoding: Encoding): void {
    if (this.encoding === encoding) return;
    this.encoding = encoding;
    // Byte counters are only comparable within one encoding.
    this.totalBytes = 0;
    this.totalFrames = 0;
    this.publish(performance.now(), true);
  }

  setSubscriberCount(count: number): void {
    this.subscriberCount = count;
  }

  /**
   * Turns the accumulated counters into a snapshot if the sampling window has
   * elapsed. Called once per animation frame.
   */
  sample(now: number): void {
    if (this.windowStart === 0) {
      this.windowStart = now;
      return;
    }
    const elapsed = now - this.windowStart;
    if (elapsed < SAMPLE_WINDOW_MS) return;
    this.publish(now, false, elapsed);
  }

  getSnapshot = (): MetricsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(now: number, immediate: boolean, elapsed = 0): void {
    if (immediate) {
      this.snapshot = {
        ...this.snapshot,
        connection: this.connection,
        encoding: this.encoding,
        totalFrames: this.totalFrames,
        totalBytes: this.totalBytes,
      };
    } else {
      const perSecond = 1000 / elapsed;
      this.snapshot = {
        connection: this.connection,
        encoding: this.encoding,
        framesPerSecond: round(this.frames * perSecond, 1),
        bytesPerSecond: Math.round(this.bytes * perSecond),
        samplesPerSecond: Math.round(this.samples * perSecond),
        fps: round(this.paints * perSecond, 0),
        decodeMs: round(this.decodeMs, 2),
        flushMs: round(this.flushMs, 2),
        rowCommitsPerSecond: Math.round(this.rowCommits * perSecond),
        subscribers: this.subscriberCount,
        totalFrames: this.totalFrames,
        totalBytes: this.totalBytes,
        coalescedFrames: this.coalescedFrames,
      };

      this.frames = 0;
      this.bytes = 0;
      this.samples = 0;
      this.paints = 0;
      this.rowCommits = 0;
      this.windowStart = now;
    }

    for (const listener of this.listeners) listener();
  }
}

function ema(current: number, next: number): number {
  return current === 0 ? next : current + EMA_ALPHA * (next - current);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
