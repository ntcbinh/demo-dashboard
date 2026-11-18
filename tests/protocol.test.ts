import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeBinaryFrame,
  decodeJsonFrame,
  encodeJsonFrame,
  FrameKind,
  frameByteLength,
  FRAME_HEADER_BYTES,
  PROTOCOL_VERSION,
  writeBinaryFrame,
} from "../src/lib/protocol.ts";
import { SensorStatus, type SensorStatusCode } from "../src/lib/sensors.ts";

type Sample = { index: number; value: number; status: number };

/**
 * `indices` lists the sensors a frame reports, while `values` and `statuses`
 * are indexed *by sensor* — so they must span the whole sensor space, not just
 * the reported count. The stride of 3 keeps the reported set sparse, which is
 * what a deadband-filtered delta frame actually looks like.
 */
function fixture(count: number) {
  const stride = 3;
  const sensorSpace = count * stride;
  const indices = new Uint16Array(count);
  const values = new Float32Array(sensorSpace);
  const statuses = new Uint8Array(sensorSpace);

  for (let i = 0; i < count; i++) {
    const sensor = i * stride;
    indices[i] = sensor;
    values[sensor] = i * 1.5 + 0.25;
    statuses[sensor] = (i % 3) as SensorStatusCode;
  }

  return { indices, values, statuses };
}

function encode(count: number, kind = FrameKind.Delta, seq = 7, timestamp = 1_700_000_000_000) {
  const { indices, values, statuses } = fixture(count);
  const buffer = new ArrayBuffer(frameByteLength(count));
  const written = writeBinaryFrame(
    new DataView(buffer),
    { kind, seq, timestamp, count },
    indices,
    values,
    statuses,
  );
  return { buffer, written, indices, values, statuses };
}

function collect(buffer: ArrayBuffer) {
  const samples: Sample[] = [];
  const header = decodeBinaryFrame(buffer, (index, value, status) => {
    samples.push({ index, value, status });
  });
  return { header, samples };
}

describe("binary frame codec", () => {
  it("round-trips header fields and every sample", () => {
    const { buffer, values, statuses, indices } = encode(64);
    const { header, samples } = collect(buffer);

    assert.equal(header.kind, FrameKind.Delta);
    assert.equal(header.version, PROTOCOL_VERSION);
    assert.equal(header.count, 64);
    assert.equal(header.seq, 7);
    assert.equal(header.timestamp, 1_700_000_000_000);
    assert.equal(samples.length, 64);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const sensor = indices[i];
      assert.equal(sample.index, sensor);
      assert.equal(sample.status, statuses[sensor]);
      // Values go over the wire as float32, so compare at that precision.
      assert.equal(sample.value, Math.fround(values[sensor]));
    }
  });

  it("writes exactly header + 8 bytes per sample", () => {
    const { written } = encode(100);
    assert.equal(written, FRAME_HEADER_BYTES + 100 * 8);
  });

  it("decodes an empty frame without emitting samples", () => {
    const { buffer } = encode(0);
    const { header, samples } = collect(buffer);
    assert.equal(header.count, 0);
    assert.equal(samples.length, 0);
  });

  it("rejects a frame shorter than its header", () => {
    assert.throws(() => collect(new ArrayBuffer(8)), /shorter than header/);
  });

  it("rejects a frame truncated mid-record", () => {
    const { buffer } = encode(10);
    // Keep the header (which still claims 10 records) but drop the tail.
    const truncated = buffer.slice(0, FRAME_HEADER_BYTES + 5 * 8);
    assert.throws(() => collect(truncated), /Truncated frame/);
  });

  it("rejects an unknown protocol version", () => {
    const { buffer } = encode(4);
    new DataView(buffer).setUint8(1, PROTOCOL_VERSION + 1);
    assert.throws(() => collect(buffer), /version mismatch/);
  });

  it("rejects an unknown frame kind", () => {
    const { buffer } = encode(4);
    new DataView(buffer).setUint8(0, 99);
    assert.throws(() => collect(buffer), /Unknown frame kind/);
  });
});

describe("json frame codec", () => {
  it("round-trips the same samples as the binary path", () => {
    const count = 32;
    const { indices, values, statuses } = fixture(count);
    const header = { kind: FrameKind.Snapshot, seq: 3, timestamp: 1_700_000_000_123, count };

    const text = encodeJsonFrame(header, indices, values, statuses);
    const samples: Sample[] = [];
    const decoded = decodeJsonFrame(text, (index, value, status) => {
      samples.push({ index, value, status });
    });

    assert.equal(decoded.kind, FrameKind.Snapshot);
    assert.equal(decoded.count, count);
    assert.equal(decoded.seq, 3);
    assert.equal(samples.length, count);
    assert.equal(samples[0].index, indices[0]);
    assert.equal(samples[0].status, statuses[indices[0]]);
  });

  it("stays materially larger than the binary encoding", () => {
    const count = 2_000;
    const { indices, values, statuses } = fixture(count);
    const header = { kind: FrameKind.Delta, seq: 1, timestamp: Date.now(), count };

    const jsonBytes = Buffer.byteLength(encodeJsonFrame(header, indices, values, statuses));
    const binaryBytes = frameByteLength(count);

    // The binary framing is the reason the live feed is affordable; if this
    // ratio ever collapses, the second encoding has stopped earning its place.
    //
    // The bound is 2.5x rather than the ~3.9x the running simulator reports:
    // this fixture's values are small integers-and-a-quarter, so they
    // serialise unusually compactly. Real sensor readings carry more
    // significant digits and widen the gap.
    assert.ok(
      jsonBytes > binaryBytes * 2.5,
      `expected JSON to exceed 2.5x binary, got ${jsonBytes} vs ${binaryBytes}`,
    );
  });

  it("rejects a version mismatch", () => {
    const payload = JSON.stringify({
      kind: FrameKind.Delta,
      version: PROTOCOL_VERSION + 5,
      seq: 1,
      timestamp: 0,
      samples: [],
    });
    assert.throws(() => decodeJsonFrame(payload, () => {}), /version mismatch/);
  });
});

describe("status codes", () => {
  it("fits every status in the single wire byte", () => {
    for (const status of Object.values(SensorStatus)) {
      assert.ok(status >= 0 && status <= 255);
    }
  });
});
