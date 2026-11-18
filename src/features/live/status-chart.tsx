"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatClock, formatCount } from "@/lib/format";
import { Panel, statusPresentation } from "@/components/ui";
import { SensorStatus } from "@/lib/sensors";
import { useSensorStore } from "./stream-provider";

/**
 * Sensors out of band, over time.
 *
 * Only warning and alarm are plotted. Stacking "normal" alongside them would
 * technically be the full picture, but a healthy floor is ~99% normal, so the
 * stack becomes one flat green block and the thing the chart exists to show —
 * whether the floor is getting worse — disappears into a sliver at the top.
 * The normal count is a headline number instead, which is the form that suits
 * a single dominant value.
 *
 * Sampled at 1 Hz on its own timer. This question does not need ten updates a
 * second, so the chart never subscribes to the frame stream at all — it reads
 * the store's aggregate on a slow interval, keeping the stacked redraw off the
 * hot path.
 */

const WINDOW_SECONDS = 90;
const SAMPLE_MS = 1_000;

type StatusPoint = {
  readonly t: number;
  readonly warning: number;
  readonly alarm: number;
};

const SERIES = [
  { key: "warning", status: SensorStatus.Warning, color: "var(--chart-warning)" },
  { key: "alarm", status: SensorStatus.Alarm, color: "var(--chart-critical)" },
] as const;

export function StatusChart() {
  const store = useSensorStore();
  const [points, setPoints] = useState<StatusPoint[]>([]);
  const pointsRef = useRef<StatusPoint[]>([]);

  useEffect(() => {
    const sample = (): void => {
      const aggregate = store.getAggregate();
      const next: StatusPoint = {
        t: Date.now(),
        warning: aggregate.warning,
        alarm: aggregate.alarm,
      };
      // Keep a bounded window; a growing array would slowly make every redraw
      // more expensive than the last.
      const window = [...pointsRef.current, next].slice(-WINDOW_SECONDS);
      pointsRef.current = window;
      setPoints(window);
    };

    const first = setTimeout(sample, 0);
    const timer = setInterval(sample, SAMPLE_MS);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [store]);

  return (
    <Panel
      title="Sensors out of band"
      subtitle={`Warning and alarm counts · last ${WINDOW_SECONDS}s, sampled at 1 Hz`}
      actions={<StatusLegend />}
    >
      <div className="h-56 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatClock}
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              stroke="var(--chart-grid)"
              minTickGap={48}
            />
            <YAxis
              // `allowDecimals={false}` keeps the ticks on whole sensors —
              // "2.5 sensors in alarm" is not a quantity that exists.
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              stroke="var(--chart-grid)"
              width={48}
              tickFormatter={formatCount}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
              content={<StatusTooltip />}
            />
            {SERIES.map((series) => (
              <Area
                key={series.key}
                type="monotone"
                dataKey={series.key}
                stackId="status"
                stroke="var(--surface-1)"
                // A 2px stroke in the surface colour is the gap that separates
                // touching stack segments — no border ink around the marks.
                strokeWidth={2}
                fill={series.color}
                fillOpacity={0.9}
                isAnimationActive={false}
                dot={false}
                activeDot={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function StatusLegend() {
  return (
    <ul className="flex items-center gap-3">
      {SERIES.map((series) => {
        const presentation = statusPresentation(series.status);
        return (
          <li key={series.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`text-[9px] leading-none ${presentation.text}`}
            >
              {presentation.glyph}
            </span>
            <span className="text-[11px] font-medium text-text-secondary">
              {presentation.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type StatusTooltipEntry = { readonly payload?: StatusPoint };

function StatusTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly StatusTooltipEntry[];
}) {
  const point = payload?.[0]?.payload;
  if (active !== true || point === undefined) return null;

  return (
    <div className="rounded border border-border-strong bg-surface-1 px-2 py-1.5 text-xs shadow-sm">
      <div className="tabular text-[10px] text-text-muted">{formatClock(point.t)}</div>
      <ul className="mt-1 space-y-0.5">
        {SERIES.map((series) => {
          const presentation = statusPresentation(series.status);
          return (
            <li key={series.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`text-[9px] leading-none ${presentation.text}`}>
                  {presentation.glyph}
                </span>
                <span className="text-text-secondary">{presentation.label}</span>
              </span>
              <span className="tabular font-medium text-text-primary">
                {formatCount(point[series.key])}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
