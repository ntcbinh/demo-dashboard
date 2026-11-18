"use client";

import { formatBytes, formatCount, formatValue } from "@/lib/format";
import { StatTile } from "@/components/ui";
import { useAggregate, useMetrics } from "./stream-provider";

/**
 * Fleet headline numbers.
 *
 * Reads the store's aggregate, which is recomputed once per frame rather than
 * per sensor — four counters off a 5,000-element pass, not 5,000 subscriptions.
 */
export function KpiRow({ sensorCount }: { sensorCount: number }) {
  const aggregate = useAggregate();
  const metrics = useMetrics();

  const reportedShare =
    sensorCount === 0 ? 0 : (aggregate.reported / sensorCount) * 100;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile
        label="Sensors online"
        value={formatCount(sensorCount - aggregate.stale)}
        hint={`of ${formatCount(sensorCount)} configured`}
        tone="accent"
      />
      <StatTile
        label="In alarm"
        value={formatCount(aggregate.alarm)}
        tone={aggregate.alarm > 0 ? "critical" : "neutral"}
        hint="above alarm threshold"
      />
      <StatTile
        label="In warning"
        value={formatCount(aggregate.warning)}
        tone={aggregate.warning > 0 ? "warning" : "neutral"}
        hint="above warning threshold"
      />
      <StatTile
        label="Reported last frame"
        value={formatValue(reportedShare, 0)}
        unit="%"
        hint={`${formatCount(aggregate.reported)} sensors left their deadband`}
      />
      <StatTile
        label="Wire throughput"
        value={formatBytes(metrics.bytesPerSecond)}
        unit="/s"
        hint={`${metrics.encoding} encoding · ${formatValue(metrics.framesPerSecond, 1)} fps`}
        tone={metrics.connection === "open" ? "neutral" : "critical"}
      />
    </div>
  );
}
