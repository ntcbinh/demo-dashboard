import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { queryReadings, READING_COUNT, type ReadingQuery } from "../src/server/history-store.ts";
import { SensorStatus } from "../src/lib/sensors.ts";

const BASE: ReadingQuery = {
  page: 0,
  pageSize: 50,
  sort: "recordedAt",
  dir: "desc",
  line: null,
  kind: null,
  status: null,
  search: null,
};

function query(overrides: Partial<ReadingQuery> = {}) {
  return queryReadings({ ...BASE, ...overrides });
}

describe("history query", () => {
  it("returns the whole dataset when unfiltered", () => {
    const result = query();
    assert.equal(result.total, READING_COUNT);
    assert.equal(result.rows.length, 50);
  });

  it("sorts descending by default and ascending on request", () => {
    const descending = query({ sort: "value", dir: "desc" }).rows;
    const ascending = query({ sort: "value", dir: "asc" }).rows;

    for (let i = 1; i < descending.length; i++) {
      assert.ok(descending[i - 1].value >= descending[i].value);
    }
    for (let i = 1; i < ascending.length; i++) {
      assert.ok(ascending[i - 1].value <= ascending[i].value);
    }
    assert.ok(descending[0].value >= ascending[0].value);
  });

  it("pages without gaps or repeats", () => {
    const first = query({ pageSize: 25, page: 0 }).rows;
    const second = query({ pageSize: 25, page: 1 }).rows;
    const wide = query({ pageSize: 50, page: 0 }).rows;

    assert.deepEqual(
      [...first, ...second].map((row) => row.id),
      wide.map((row) => row.id),
    );
  });

  it("clamps an out-of-range page to the last one", () => {
    const result = query({ pageSize: 100, page: 10_000_000 });
    const lastPage = Math.ceil(result.total / 100) - 1;
    assert.equal(result.page, lastPage);
    assert.ok(result.rows.length > 0);
  });

  it("clamps the page size rather than trusting the client", () => {
    assert.equal(query({ pageSize: 10_000 }).rows.length, 200);
    assert.equal(query({ pageSize: 0 }).rows.length, 1);
    assert.equal(query({ pageSize: Number.NaN }).rows.length, 1);
  });

  it("filters by status and returns only matching rows", () => {
    const result = query({ status: SensorStatus.Alarm });
    assert.ok(result.total > 0);
    assert.ok(result.total < READING_COUNT);
    for (const row of result.rows) {
      assert.equal(row.status, SensorStatus.Alarm);
    }
  });

  it("filters by line", () => {
    const result = query({ line: "LINE-03" });
    assert.ok(result.total > 0);
    for (const row of result.rows) {
      assert.equal(row.line, "LINE-03");
    }
  });

  it("filters by sensor kind", () => {
    const result = query({ kind: "vibration" });
    assert.ok(result.total > 0);
    for (const row of result.rows) {
      assert.equal(row.kind, "vibration");
    }
  });

  it("searches across sensor id, name and machine", () => {
    const result = query({ search: "SNR-0042" });
    assert.ok(result.total > 0);
    for (const row of result.rows) {
      assert.equal(row.sensorId, "SNR-0042");
    }
  });

  it("combines filters conjunctively", () => {
    const line = query({ line: "LINE-02" }).total;
    const combined = query({ line: "LINE-02", status: SensorStatus.Alarm });
    assert.ok(combined.total <= line);
    for (const row of combined.rows) {
      assert.equal(row.line, "LINE-02");
      assert.equal(row.status, SensorStatus.Alarm);
    }
  });

  it("returns an empty page for a filter nothing matches", () => {
    const result = query({ search: "no-such-sensor-anywhere" });
    assert.equal(result.total, 0);
    assert.equal(result.rows.length, 0);
    assert.equal(result.page, 0);
  });

  it("reuses a cached ordering for a repeated filter and sort", () => {
    const key: Partial<ReadingQuery> = { sort: "machineId", dir: "asc", line: "LINE-05" };
    query(key);
    const second = query({ ...key, page: 1 });
    assert.equal(second.cached, true);
  });

  it("orders ties stably so paging cannot repeat a row", () => {
    // Status has only a handful of distinct values, so almost every comparison
    // is a tie — exactly the case where an unstable sort duplicates rows
    // across pages.
    const pageSize = 100;
    const first = query({ sort: "status", dir: "asc", pageSize, page: 0 }).rows;
    const second = query({ sort: "status", dir: "asc", pageSize, page: 1 }).rows;
    const ids = new Set([...first, ...second].map((row) => row.id));
    assert.equal(ids.size, pageSize * 2);
  });

  it("reports its own query time", () => {
    const result = query({ sort: "value", dir: "asc", kind: "pressure" });
    assert.ok(Number.isFinite(result.queryMs));
    assert.ok(result.queryMs >= 0);
  });
});
