// Relative, extension-qualified imports (rather than the `@/` alias) so this
// module and its tests also run under plain `node --test`, which has no
// knowledge of the bundler's path mapping.
import { createRng } from "../lib/rng.ts";
import {
  buildSensorCatalog,
  classify,
  SENSOR_COUNT,
  type Sensor,
  type SensorStatusCode,
} from "../lib/sensors.ts";

/**
 * In-memory historical readings, queried server-side.
 *
 * This is the half of the dashboard that does *not* stream: half a million
 * recorded readings that the browser must never download in full. Filtering,
 * sorting and paging all happen here, and the client receives one page at a
 * time.
 *
 * Storage is columnar typed arrays, not an array of row objects. 500,000 row
 * objects would cost roughly 100 MB and keep the GC busy; the five columns
 * below total about 8 MB, and row objects are materialised only for the
 * ≤100 rows actually being returned.
 */

export const READING_COUNT = 500_000;
const HISTORY_SEED = 0xa11ce;
const HISTORY_SPAN_MS = 24 * 60 * 60 * 1000;

export type ReadingSortKey =
  | "recordedAt"
  | "value"
  | "sensorId"
  | "machineId"
  | "status";

export type SortDirection = "asc" | "desc";

export type ReadingQuery = {
  readonly page: number;
  readonly pageSize: number;
  readonly sort: ReadingSortKey;
  readonly dir: SortDirection;
  readonly line: string | null;
  readonly kind: string | null;
  readonly status: SensorStatusCode | null;
  readonly search: string | null;
};

export type ReadingRow = {
  readonly id: string;
  readonly sensorId: string;
  readonly sensorName: string;
  readonly machineId: string;
  readonly line: string;
  readonly kind: string;
  readonly unit: string;
  readonly value: number;
  readonly status: SensorStatusCode;
  readonly recordedAt: number;
};

export type ReadingsPage = {
  readonly rows: readonly ReadingRow[];
  /** Rows matching the filter, across all pages. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** Server-side query time in milliseconds, surfaced in the UI. */
  readonly queryMs: number;
  /** Whether this query reused a cached filter+sort ordering. */
  readonly cached: boolean;
};

type Dataset = {
  readonly sensors: readonly Sensor[];
  readonly sensorIndex: Uint16Array;
  readonly value: Float32Array;
  readonly status: Uint8Array;
  readonly recordedAt: Float64Array;
  /** Numeric rank per sensor for `machineId`, so that sort stays numeric. */
  readonly machineRank: Uint16Array;
  readonly lineOf: readonly string[];
  readonly kindOf: readonly string[];
  readonly searchOf: readonly string[];
};

let dataset: Dataset | null = null;

/**
 * Cache of filtered + sorted orderings, keyed by filter and sort. Paging
 * within one filter/sort then costs only the slice for the requested page,
 * which is what makes next/previous feel instant.
 */
const orderCache = new Map<string, Uint32Array>();
const ORDER_CACHE_LIMIT = 8;

function getDataset(): Dataset {
  if (dataset !== null) return dataset;

  const sensors = buildSensorCatalog(SENSOR_COUNT);
  const rng = createRng(HISTORY_SEED);

  const sensorIndex = new Uint16Array(READING_COUNT);
  const value = new Float32Array(READING_COUNT);
  const status = new Uint8Array(READING_COUNT);
  const recordedAt = new Float64Array(READING_COUNT);

  const now = Date.now();
  const start = now - HISTORY_SPAN_MS;

  for (let i = 0; i < READING_COUNT; i++) {
    const index = Math.floor(rng() * sensors.length);
    const sensor = sensors[index];
    const timestamp = start + rng() * HISTORY_SPAN_MS;
    const range = sensor.max - sensor.min;

    const wave =
      Math.sin(((timestamp - start) / sensor.periodMs) * Math.PI * 2 + sensor.phase) *
      sensor.amplitude;
    let reading = sensor.baseline + wave + (rng() - 0.5) * 2 * sensor.noise * 3;

    // Seed a realistic minority of out-of-band readings so the status filter
    // has something to find.
    const roll = rng();
    if (roll > 0.97) {
      reading = sensor.alarmAt + range * rng() * 0.05;
    } else if (roll > 0.9) {
      reading = sensor.warnAt + range * rng() * 0.08;
    }

    reading = Math.min(sensor.max, Math.max(sensor.min, reading));

    sensorIndex[i] = index;
    value[i] = reading;
    status[i] = classify(sensor, reading);
    recordedAt[i] = timestamp;
  }

  const machineIds = [...new Set(sensors.map((sensor) => sensor.machineId))].sort();
  const machineRankByName = new Map(machineIds.map((id, rank) => [id, rank]));
  const machineRank = new Uint16Array(sensors.length);
  const lineOf: string[] = new Array<string>(sensors.length);
  const kindOf: string[] = new Array<string>(sensors.length);
  const searchOf: string[] = new Array<string>(sensors.length);

  for (let i = 0; i < sensors.length; i++) {
    const sensor = sensors[i];
    machineRank[i] = machineRankByName.get(sensor.machineId) ?? 0;
    lineOf[i] = sensor.line;
    kindOf[i] = sensor.kind;
    // Precomputed lowercase haystack: building this per request would mean
    // half a million `toLowerCase()` calls per keystroke.
    searchOf[i] = `${sensor.id} ${sensor.name} ${sensor.machineId}`.toLowerCase();
  }

  dataset = {
    sensors,
    sensorIndex,
    value,
    status,
    recordedAt,
    machineRank,
    lineOf,
    kindOf,
    searchOf,
  };
  return dataset;
}

export function queryReadings(query: ReadingQuery): ReadingsPage {
  const startedAt = performance.now();
  const data = getDataset();

  const cacheKey = [
    query.sort,
    query.dir,
    query.line ?? "",
    query.kind ?? "",
    query.status ?? "",
    query.search ?? "",
  ].join("|");

  let order = orderCache.get(cacheKey);
  const cached = order !== undefined;

  if (order === undefined) {
    order = buildOrder(data, query);
    orderCache.set(cacheKey, order);
    if (orderCache.size > ORDER_CACHE_LIMIT) {
      // Insertion-ordered eviction; the working set here is a handful of
      // filter/sort combinations per session.
      const oldest = orderCache.keys().next().value;
      if (oldest !== undefined) orderCache.delete(oldest);
    }
  }

  const total = order.length;
  const pageSize = clampInt(query.pageSize, 1, 200);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(query.page, 0, pageCount - 1);
  const from = page * pageSize;
  const to = Math.min(total, from + pageSize);

  const rows: ReadingRow[] = [];
  for (let i = from; i < to; i++) {
    rows.push(materialise(data, order[i]));
  }

  return {
    rows,
    total,
    page,
    pageSize,
    queryMs: Math.round((performance.now() - startedAt) * 100) / 100,
    cached,
  };
}

function buildOrder(data: Dataset, query: ReadingQuery): Uint32Array {
  const { sensorIndex, status, lineOf, kindOf, searchOf } = data;
  const needle = query.search?.trim().toLowerCase() ?? "";

  // One pass to select matching row ids, written into a buffer sized for the
  // worst case and then trimmed — no intermediate arrays growing by push.
  const selected = new Uint32Array(READING_COUNT);
  let count = 0;

  for (let i = 0; i < READING_COUNT; i++) {
    const sensor = sensorIndex[i];
    if (query.status !== null && status[i] !== query.status) continue;
    if (query.line !== null && lineOf[sensor] !== query.line) continue;
    if (query.kind !== null && kindOf[sensor] !== query.kind) continue;
    if (needle !== "" && !searchOf[sensor].includes(needle)) continue;
    selected[count++] = i;
  }

  const order = selected.subarray(0, count);
  const descending = query.dir === "desc";
  const compare = comparatorFor(data, query.sort);

  order.sort((a, b) => {
    const result = compare(a, b);
    // Ties fall back to row id so paging is stable across requests.
    const resolved = result !== 0 ? result : a - b;
    return descending ? -resolved : resolved;
  });

  // `subarray` is a view over the oversized buffer; copy so the cache entry
  // does not pin all 2 MB of it.
  return order.slice();
}

function comparatorFor(
  data: Dataset,
  sort: ReadingSortKey,
): (a: number, b: number) => number {
  switch (sort) {
    case "value":
      return (a, b) => data.value[a] - data.value[b];
    case "status":
      return (a, b) => data.status[a] - data.status[b];
    case "sensorId":
      // Sensor ids are zero-padded from the index, so their lexicographic
      // order is the index order — a numeric compare, no string work.
      return (a, b) => data.sensorIndex[a] - data.sensorIndex[b];
    case "machineId":
      return (a, b) => data.machineRank[data.sensorIndex[a]] - data.machineRank[data.sensorIndex[b]];
    case "recordedAt":
    default:
      return (a, b) => data.recordedAt[a] - data.recordedAt[b];
  }
}

function materialise(data: Dataset, row: number): ReadingRow {
  const index = data.sensorIndex[row];
  const sensor = data.sensors[index];
  return {
    id: `R-${row}`,
    sensorId: sensor.id,
    sensorName: sensor.name,
    machineId: sensor.machineId,
    line: sensor.line,
    kind: sensor.kind,
    unit: sensor.unit,
    value: Math.round(data.value[row] * 1000) / 1000,
    status: data.status[row] as SensorStatusCode,
    recordedAt: data.recordedAt[row],
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isReadingSortKey(value: string): value is ReadingSortKey {
  return (
    value === "recordedAt" ||
    value === "value" ||
    value === "sensorId" ||
    value === "machineId" ||
    value === "status"
  );
}
