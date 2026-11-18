import { createRng, pick, randFloat, randInt } from "./rng.ts";

/**
 * The sensor catalog is the one piece of data every layer needs: the WebSocket
 * simulator, the REST history dataset and the browser. It is generated from a
 * fixed seed rather than stored, so all three agree without shipping a fixture.
 */

/** Wire-level status codes. Kept numeric so they fit in one byte per sample. */
export const SensorStatus = {
  Normal: 0,
  Warning: 1,
  Alarm: 2,
  Stale: 3,
} as const;

export type SensorStatusCode =
  (typeof SensorStatus)[keyof typeof SensorStatus];

export const SENSOR_STATUS_LABEL: Record<SensorStatusCode, string> = {
  [SensorStatus.Normal]: "Normal",
  [SensorStatus.Warning]: "Warning",
  [SensorStatus.Alarm]: "Alarm",
  [SensorStatus.Stale]: "Stale",
};

export type SensorKind =
  | "temperature"
  | "vibration"
  | "pressure"
  | "current"
  | "rpm"
  | "flow";

type KindSpec = {
  readonly kind: SensorKind;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  /** Fraction of the range at which warning / alarm thresholds sit. */
  readonly warnRatio: number;
  readonly alarmRatio: number;
  /** Baseline noise as a fraction of the range. */
  readonly noiseRatio: number;
};

const KIND_SPECS: readonly KindSpec[] = [
  { kind: "temperature", unit: "°C", min: 15, max: 140, warnRatio: 0.72, alarmRatio: 0.88, noiseRatio: 0.004 },
  { kind: "vibration", unit: "mm/s", min: 0, max: 45, warnRatio: 0.6, alarmRatio: 0.8, noiseRatio: 0.012 },
  { kind: "pressure", unit: "bar", min: 0, max: 12, warnRatio: 0.78, alarmRatio: 0.92, noiseRatio: 0.006 },
  { kind: "current", unit: "A", min: 0, max: 80, warnRatio: 0.75, alarmRatio: 0.9, noiseRatio: 0.009 },
  { kind: "rpm", unit: "rpm", min: 0, max: 3600, warnRatio: 0.85, alarmRatio: 0.95, noiseRatio: 0.003 },
  { kind: "flow", unit: "L/min", min: 0, max: 260, warnRatio: 0.7, alarmRatio: 0.88, noiseRatio: 0.008 },
] as const;

const LINES = ["LINE-01", "LINE-02", "LINE-03", "LINE-04", "LINE-05", "LINE-06"] as const;

const MACHINE_TYPES = [
  "PRESS",
  "ROBOT",
  "CNC",
  "CONVEYOR",
  "WELDER",
  "PUMP",
  "COMPRESSOR",
  "OVEN",
] as const;

export type Sensor = {
  /**
   * Dense index into every typed array in the system, and the sensor's id on
   * the binary wire protocol. Stable for a given `SENSOR_COUNT` and seed.
   */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly machineId: string;
  readonly kind: SensorKind;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly warnAt: number;
  readonly alarmAt: number;
  /** Simulation parameters, also used to rebuild the history dataset. */
  readonly baseline: number;
  readonly amplitude: number;
  readonly periodMs: number;
  readonly phase: number;
  readonly noise: number;
};

export const SENSOR_COUNT = 5000;
export const CATALOG_SEED = 0x5eed_1234;

/** Columnar wire shape for `/api/sensors` — ~4x smaller than an array of objects. */
export type SensorCatalogPayload = {
  readonly count: number;
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly lines: readonly string[];
  readonly machineIds: readonly string[];
  readonly kinds: readonly SensorKind[];
  readonly units: readonly string[];
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly warnAt: readonly number[];
  readonly alarmAt: readonly number[];
};

export function buildSensorCatalog(count: number = SENSOR_COUNT): Sensor[] {
  const rng = createRng(CATALOG_SEED);
  const sensors: Sensor[] = new Array<Sensor>(count);

  for (let index = 0; index < count; index++) {
    const spec = pick(rng, KIND_SPECS);
    const line = pick(rng, LINES);
    const machineType = pick(rng, MACHINE_TYPES);
    const machineNo = randInt(rng, 1, 12);
    const machineId = `${machineType}-${String(machineNo).padStart(2, "0")}`;
    const range = spec.max - spec.min;

    // Baselines sit in the lower-middle of the range so a drifting sensor has
    // room to climb into the warning and alarm bands.
    const baseline = spec.min + range * randFloat(rng, 0.3, 0.55);

    sensors[index] = {
      index,
      id: `SNR-${String(index).padStart(4, "0")}`,
      name: `${machineId} ${spec.kind}`,
      line,
      machineId: `${line} / ${machineId}`,
      kind: spec.kind,
      unit: spec.unit,
      min: spec.min,
      max: spec.max,
      warnAt: spec.min + range * spec.warnRatio,
      alarmAt: spec.min + range * spec.alarmRatio,
      baseline,
      amplitude: range * randFloat(rng, 0.03, 0.1),
      periodMs: randFloat(rng, 6_000, 42_000),
      phase: randFloat(rng, 0, Math.PI * 2),
      noise: range * spec.noiseRatio,
    };
  }

  return sensors;
}

export function classify(sensor: Sensor, value: number): SensorStatusCode {
  if (value >= sensor.alarmAt) return SensorStatus.Alarm;
  if (value >= sensor.warnAt) return SensorStatus.Warning;
  return SensorStatus.Normal;
}

export function toCatalogPayload(sensors: readonly Sensor[]): SensorCatalogPayload {
  const count = sensors.length;
  const ids: string[] = new Array<string>(count);
  const names: string[] = new Array<string>(count);
  const lines: string[] = new Array<string>(count);
  const machineIds: string[] = new Array<string>(count);
  const kinds: SensorKind[] = new Array<SensorKind>(count);
  const units: string[] = new Array<string>(count);
  const min: number[] = new Array<number>(count);
  const max: number[] = new Array<number>(count);
  const warnAt: number[] = new Array<number>(count);
  const alarmAt: number[] = new Array<number>(count);

  for (let i = 0; i < count; i++) {
    const sensor = sensors[i];
    ids[i] = sensor.id;
    names[i] = sensor.name;
    lines[i] = sensor.line;
    machineIds[i] = sensor.machineId;
    kinds[i] = sensor.kind;
    units[i] = sensor.unit;
    // Thresholds are the only numbers the client needs at full precision for
    // colouring; one decimal is plenty and keeps the JSON small.
    min[i] = round1(sensor.min);
    max[i] = round1(sensor.max);
    warnAt[i] = round1(sensor.warnAt);
    alarmAt[i] = round1(sensor.alarmAt);
  }

  return { count, ids, names, lines, machineIds, kinds, units, min, max, warnAt, alarmAt };
}

/** Client-side row shape for the live table: static metadata only. */
export type SensorMeta = {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly machineId: string;
  readonly kind: SensorKind;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly warnAt: number;
  readonly alarmAt: number;
};

export function fromCatalogPayload(payload: SensorCatalogPayload): SensorMeta[] {
  const metas: SensorMeta[] = new Array<SensorMeta>(payload.count);
  for (let i = 0; i < payload.count; i++) {
    metas[i] = {
      index: i,
      id: payload.ids[i],
      name: payload.names[i],
      line: payload.lines[i],
      machineId: payload.machineIds[i],
      kind: payload.kinds[i],
      unit: payload.units[i],
      min: payload.min[i],
      max: payload.max[i],
      warnAt: payload.warnAt[i],
      alarmAt: payload.alarmAt[i],
    };
  }
  return metas;
}

export const SENSOR_KINDS: readonly SensorKind[] = KIND_SPECS.map((spec) => spec.kind);
export const SENSOR_LINES: readonly string[] = LINES;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
