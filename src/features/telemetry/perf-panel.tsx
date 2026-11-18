"use client";

import { formatBytes, formatCount, formatValue } from "@/lib/format";
import { Button, Panel, SegmentedControl } from "@/components/ui";
import { useMetrics } from "@/features/live/stream-provider";
import { useStreamControls } from "@/features/live/stream-provider";

/**
 * Live transport and render metrics.
 *
 * The panel is the point of the project as much as the dashboard is: it makes
 * every claim about the data path checkable while the app runs. Switch the
 * encoding and watch bytes/second move without frames/second changing; raise
 * the rate and watch row commits scale with mounted rows rather than with the
 * 5,000 sensors behind them.
 */

const ENCODING_OPTIONS = [
  { value: "binary", label: "Binary", title: "16-byte header + 8 bytes per sample" },
  { value: "json", label: "JSON", title: "One object per sample, ~4x the bytes" },
] as const;

const RATE_OPTIONS = [
  { value: "1", label: "1 Hz" },
  { value: "5", label: "5 Hz" },
  { value: "10", label: "10 Hz" },
] as const;

export function PerfPanel() {
  const metrics = useMetrics();
  const controls = useStreamControls();

  return (
    <Panel
      title="Transport & render metrics"
      subtitle="Measured in the browser, updated twice a second"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-border-subtle bg-surface-2/50 px-5 py-3">
        <SegmentedControl
          label="Encoding"
          value={controls.encoding}
          options={ENCODING_OPTIONS}
          onChange={controls.setEncoding}
        />
        <SegmentedControl
          label="Feed rate"
          value={String(controls.rateHz) as "1" | "5" | "10"}
          options={RATE_OPTIONS}
          onChange={(value) => controls.setRateHz(Number(value))}
        />
        <Button
          onClick={() => controls.setPaused(!controls.paused)}
          variant={controls.paused ? "accent" : "default"}
        >
          {controls.paused ? "Resume feed" : "Pause feed"}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-4">
        <Metric
          label="Wire throughput"
          value={formatBytes(metrics.bytesPerSecond)}
          unit="/s"
          hint={`${metrics.encoding} encoding`}
        />
        <Metric
          label="Frames decoded"
          value={formatValue(metrics.framesPerSecond, 1)}
          unit="/s"
          hint={`${formatCount(metrics.coalescedFrames)} coalesced into a paint`}
        />
        <Metric
          label="Samples applied"
          value={formatCount(metrics.samplesPerSecond)}
          unit="/s"
          hint="values written into typed arrays"
        />
        <Metric
          label="Decode time"
          value={formatValue(metrics.decodeMs, 2)}
          unit="ms"
          hint="mean, per frame"
        />
        <Metric
          label="Notify time"
          value={formatValue(metrics.flushMs, 2)}
          unit="ms"
          hint="mean, per paint"
        />
        <Metric
          label="Browser frame rate"
          value={formatValue(metrics.fps, 0)}
          unit="fps"
          hint="requestAnimationFrame"
          tone={metrics.fps > 0 && metrics.fps < 45 ? "critical" : "neutral"}
        />
        <Metric
          label="Row commits"
          value={formatCount(metrics.rowCommitsPerSecond)}
          unit="/s"
          hint="React commits in the live body"
        />
        <Metric
          label="Row subscriptions"
          value={formatCount(metrics.subscribers)}
          hint="one per mounted row"
        />
      </dl>
    </Panel>
  );
}

function Metric({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "neutral" | "critical";
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd className="mt-1">
        <span
          className={`tabular text-[17px] font-semibold ${
            tone === "critical" ? "text-critical" : "text-text-primary"
          }`}
        >
          {value}
        </span>
        {unit !== undefined && (
          <span className="ml-0.5 text-[11px] font-medium text-text-muted">{unit}</span>
        )}
        {hint !== undefined && (
          <span className="mt-1 block truncate text-[10px] leading-none text-text-muted">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}
