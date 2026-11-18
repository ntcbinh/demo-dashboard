import type { SensorStatusCode } from "./sensors.ts";

/**
 * Wire protocol between the sensor simulator and the browser.
 *
 * Two encodings are implemented on purpose so the dashboard can switch at
 * runtime and show the cost difference:
 *
 *   binary  16-byte header + 8 bytes per sample. Decoding is a `DataView`
 *           walk straight into the client's typed arrays — no intermediate
 *           objects, no garbage, no `JSON.parse` pause.
 *   json    the shape most projects reach for first. Readable in devtools,
 *           roughly 4x the bytes and it allocates one object per sample.
 *
 * At 5,000 sensors and 10 frames/second that difference is the whole reason
 * the binary path exists: ~250 KB/s and ~0 allocations versus ~1.2 MB/s and
 * 50,000 short-lived objects per second.
 */

export const PROTOCOL_VERSION = 1;

/** uint8 kind, uint8 version, uint16 count, uint32 seq, float64 timestamp. */
export const FRAME_HEADER_BYTES = 16;

/** uint16 index, uint8 status, uint8 padding, float32 value. */
export const FRAME_RECORD_BYTES = 8;

export const FrameKind = {
  /** Every sensor. Sent once on connect so the client starts fully populated. */
  Snapshot: 1,
  /** Only sensors whose value moved since the previous frame. */
  Delta: 2,
} as const;

export type FrameKindCode = (typeof FrameKind)[keyof typeof FrameKind];

export type Encoding = "binary" | "json";

export type FrameHeader = {
  readonly kind: FrameKindCode;
  readonly version: number;
  readonly count: number;
  readonly seq: number;
  readonly timestamp: number;
};

/** JSON mirror of a binary frame. `s` holds samples as flat triples. */
export type JsonFrame = {
  readonly kind: FrameKindCode;
  readonly version: number;
  readonly seq: number;
  readonly timestamp: number;
  readonly samples: ReadonlyArray<{
    readonly i: number;
    readonly v: number;
    readonly s: number;
  }>;
};

/**
 * Receives one decoded sample. Deliberately a plain callback taking three
 * primitives: it stays monomorphic and allocates nothing, which matters when
 * it is invoked 50,000 times per second.
 */
export type SampleSink = (
  index: number,
  value: number,
  status: SensorStatusCode,
) => void;

export function isFrameKind(value: number): value is FrameKindCode {
  return value === FrameKind.Snapshot || value === FrameKind.Delta;
}

export function frameByteLength(count: number): number {
  return FRAME_HEADER_BYTES + count * FRAME_RECORD_BYTES;
}

/**
 * Writes a frame into `target`, which must be at least `frameByteLength(count)`
 * bytes. The server reuses one buffer across ticks, so this never allocates in
 * the steady state.
 */
export function writeBinaryFrame(
  target: DataView,
  header: { kind: FrameKindCode; seq: number; timestamp: number; count: number },
  indices: Uint16Array | Uint32Array,
  values: Float32Array,
  statuses: Uint8Array,
): number {
  const { kind, seq, timestamp, count } = header;

  target.setUint8(0, kind);
  target.setUint8(1, PROTOCOL_VERSION);
  target.setUint16(2, count, true);
  target.setUint32(4, seq, true);
  target.setFloat64(8, timestamp, true);

  let offset = FRAME_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const index = indices[i];
    target.setUint16(offset, index, true);
    target.setUint8(offset + 2, statuses[index]);
    // offset + 3 is padding, which keeps the float32 4-byte aligned.
    target.setFloat32(offset + 4, values[index], true);
    offset += FRAME_RECORD_BYTES;
  }

  return offset;
}

export function readFrameHeader(view: DataView): FrameHeader {
  const kind = view.getUint8(0);
  if (!isFrameKind(kind)) {
    throw new Error(`Unknown frame kind: ${kind}`);
  }
  return {
    kind,
    version: view.getUint8(1),
    count: view.getUint16(2, true),
    seq: view.getUint32(4, true),
    timestamp: view.getFloat64(8, true),
  };
}

/**
 * Walks a binary frame, handing every sample to `sink`. Returns the header.
 *
 * Throws on a truncated frame rather than feeding the store partial garbage —
 * the caller treats that as a protocol error and reconnects.
 */
export function decodeBinaryFrame(buffer: ArrayBuffer, sink: SampleSink): FrameHeader {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`Frame shorter than header: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);
  const header = readFrameHeader(view);

  if (header.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Protocol version mismatch: frame ${header.version}, client ${PROTOCOL_VERSION}`,
    );
  }

  const expected = frameByteLength(header.count);
  if (buffer.byteLength < expected) {
    throw new Error(
      `Truncated frame: ${buffer.byteLength} bytes, expected ${expected}`,
    );
  }

  let offset = FRAME_HEADER_BYTES;
  for (let i = 0; i < header.count; i++) {
    sink(
      view.getUint16(offset, true),
      view.getFloat32(offset + 4, true),
      view.getUint8(offset + 2) as SensorStatusCode,
    );
    offset += FRAME_RECORD_BYTES;
  }

  return header;
}

export function encodeJsonFrame(
  header: { kind: FrameKindCode; seq: number; timestamp: number; count: number },
  indices: Uint16Array | Uint32Array,
  values: Float32Array,
  statuses: Uint8Array,
): string {
  const samples = new Array<{ i: number; v: number; s: number }>(header.count);
  for (let i = 0; i < header.count; i++) {
    const index = indices[i];
    samples[i] = {
      i: index,
      // Match the precision the binary path gets from float32 so the two
      // encodings are compared on bytes, not on significant digits.
      v: Math.round(values[index] * 1000) / 1000,
      s: statuses[index],
    };
  }

  const frame: JsonFrame = {
    kind: header.kind,
    version: PROTOCOL_VERSION,
    seq: header.seq,
    timestamp: header.timestamp,
    samples,
  };

  return JSON.stringify(frame);
}

export function decodeJsonFrame(text: string, sink: SampleSink): FrameHeader {
  const frame = JSON.parse(text) as JsonFrame;

  if (!isFrameKind(frame.kind)) {
    throw new Error(`Unknown frame kind: ${String(frame.kind)}`);
  }
  if (frame.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Protocol version mismatch: frame ${frame.version}, client ${PROTOCOL_VERSION}`,
    );
  }

  for (const sample of frame.samples) {
    sink(sample.i, sample.v, sample.s as SensorStatusCode);
  }

  return {
    kind: frame.kind,
    version: frame.version,
    count: frame.samples.length,
    seq: frame.seq,
    timestamp: frame.timestamp,
  };
}

/** Control messages are always JSON; they are rare and never on the hot path. */
export type ClientControlMessage =
  | { readonly type: "setEncoding"; readonly encoding: Encoding }
  | { readonly type: "setPaused"; readonly paused: boolean }
  | { readonly type: "setRateHz"; readonly rateHz: number };

export type ServerHelloMessage = {
  readonly type: "hello";
  readonly sensorCount: number;
  readonly tickMs: number;
  readonly sampleRateHz: number;
  readonly encoding: Encoding;
  readonly protocolVersion: number;
};

export type ServerControlMessage = ServerHelloMessage | {
  readonly type: "ack";
  readonly encoding: Encoding;
  readonly paused: boolean;
  readonly rateHz: number;
};

export function isServerControlMessage(value: unknown): value is ServerControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "hello" || type === "ack";
}
