"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatClockMs, formatValue } from "@/lib/format";
import type { SensorMeta } from "@/lib/sensors";
import { Panel, SegmentedControl } from "@/components/ui";
import { useFocusIndex, useSensorStore } from "./stream-provider";
import type { FocusSeriesPoint } from "./sensor-store";

/**
 * Live trend for the one selected sensor.
 *
 * Recharts is declarative and re-renders on every data change, so wiring it
 * directly to a 10 Hz feed would hand React a full chart reconciliation ten
 * times a second for a chart whose pixels barely move.
 *
 * Instead the render cadence is decoupled from the data cadence: the store
 * keeps every sample in a ring buffer, and this component samples that ring on
 * its own timer. The data stays complete; only the redraws are rationed. Note
 * that no sample is skipped — `readFocusSeries` returns the whole window, so
 * dropping to 2 fps costs redraw frequency, never fidelity.
 */

const REDRAW_OPTIONS = [
  { value: "2", label: "2 fps", title: "Redraw twice a second" },
  { value: "4", label: "4 fps", title: "Redraw four times a second" },
  { value: "10", label: "10 fps", title: "Redraw on every incoming frame" },
] as const;

type RedrawRate = (typeof REDRAW_OPTIONS)[number]["value"];

const EMPTY_SERIES: FocusSeriesPoint[] = [];

export function RealtimeChart({ sensors }: { sensors: readonly SensorMeta[] }) {
  const store = useSensorStore();
  const focusIndex = useFocusIndex();
  const [redrawRate, setRedrawRate] = useState<RedrawRate>("4");
  const [series, setSeries] = useState<FocusSeriesPoint[]>([]);
  const redrawsRef = useRef(0);

  const sensor = focusIndex >= 0 ? sensors[focusIndex] : undefined;
  // Derived, not stored: clearing the series in an effect would be a second
  // source of truth for "nothing selected".
  const data = sensor === undefined ? EMPTY_SERIES : series;

  useEffect(() => {
    if (focusIndex < 0) return;

    const intervalMs = 1000 / Number(redrawRate);
    const copy = (): void => {
      redrawsRef.current++;
      setSeries(store.readFocusSeries());
    };

    // Both the first read and the repeats happen off the effect body, so the
    // effect never forces an extra render pass before the first paint.
    const first = setTimeout(copy, 0);
    const timer = setInterval(copy, intervalMs);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [store, focusIndex, redrawRate]);

  // Fixed Y domain from the sensor's declared range, so the axis does not
  // rescale under the line on every redraw. The range is used as-is rather
  // than padded: padding below the minimum puts impossible values on the axis
  // (a vibration sensor reading -2 mm/s), and every threshold already sits
  // inside the range.
  const domain = useMemo<[number, number]>(
    () => (sensor === undefined ? [0, 1] : [sensor.min, sensor.max]),
    [sensor],
  );

  return (
    <Panel
      title={sensor === undefined ? "Live trend" : `${sensor.id} · ${sensor.name}`}
      subtitle={
        sensor === undefined
          ? "Select a sensor in the live table"
          : `${sensor.machineId} · ${sensor.unit} · warn ${formatValue(sensor.warnAt, 1)} · alarm ${formatValue(sensor.alarmAt, 1)}`
      }
      actions={
        <SegmentedControl
          label="Redraw"
          value={redrawRate}
          options={REDRAW_OPTIONS}
          onChange={setRedrawRate}
        />
      }
      className="min-h-0"
    >
      <div className="h-56 px-2 py-3">
        {sensor === undefined || data.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatClockMs}
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                stroke="var(--chart-grid)"
                minTickGap={48}
              />
              <YAxis
                domain={domain}
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                stroke="var(--chart-grid)"
                width={48}
                tickFormatter={(value: number) => formatValue(value, 0)}
              />
              {/* Thresholds are labelled, so the bands are not colour-only. */}
              <ReferenceLine
                y={sensor.warnAt}
                stroke="var(--chart-warning)"
                strokeWidth={1}
                label={{
                  value: "warning",
                  position: "insideTopLeft",
                  fontSize: 9,
                  fill: "var(--text-muted)",
                }}
              />
              <ReferenceLine
                y={sensor.alarmAt}
                stroke="var(--chart-critical)"
                strokeWidth={1}
                label={{
                  value: "alarm",
                  position: "insideTopLeft",
                  fontSize: 9,
                  fill: "var(--text-muted)",
                }}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
                content={<TrendTooltip unit={sensor.unit} />}
              />
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--chart-series-1)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="var(--chart-series-1)"
                fillOpacity={0.1}
                // Animation on a streaming chart fights the next data update
                // and is the single most expensive Recharts default here.
                isAnimationActive={false}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--chart-series-1)",
                  stroke: "var(--surface-1)",
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-text-muted">
      Waiting for samples…
    </div>
  );
}

type TooltipPayloadEntry = { readonly payload?: FocusSeriesPoint };

function TrendTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: readonly TooltipPayloadEntry[];
  unit: string;
}) {
  const point = payload?.[0]?.payload;
  if (active !== true || point === undefined) return null;
  return (
    <div className="rounded border border-border-strong bg-surface-1 px-2 py-1.5 text-xs shadow-sm">
      <div className="tabular font-semibold text-text-primary">
        {formatValue(point.v, 2)}
        <span className="ml-1 text-[10px] font-medium text-text-muted">{unit}</span>
      </div>
      <div className="tabular mt-0.5 text-[10px] text-text-muted">{formatClockMs(point.t)}</div>
    </div>
  );
}
