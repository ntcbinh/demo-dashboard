"use client";

import { useState } from "react";
import { HistoryTable } from "@/features/history/history-table";
import { KpiRow } from "@/features/live/kpi-row";
import { LiveTable } from "@/features/live/live-table";
import { RealtimeChart } from "@/features/live/realtime-chart";
import { StatusChart } from "@/features/live/status-chart";
import { useCatalogQuery } from "@/features/live/use-catalog-query";
import { Button } from "@/components/ui";
import { useHydrated } from "@/lib/use-hydrated";
import { PerfPanel } from "@/features/telemetry/perf-panel";

/**
 * Dashboard shell.
 *
 * The two tables are the two halves of the problem: the live tab is a
 * client-side virtualised view over a streaming dataset, the history tab is a
 * server-paged view over one too large to send. They are kept side by side
 * deliberately — the same table library, two very different data strategies.
 *
 * Everything below the page header is client-rendered behind `useHydrated`.
 * The values here are moving before React finishes hydrating, so prerendering
 * them would guarantee a mismatch; the page shell above stays static.
 */

type Tab = "live" | "history";

const TABS: ReadonlyArray<{ id: Tab; label: string; hint: string }> = [
  { id: "live", label: "Live stream", hint: "5,000 sensors over WebSocket" },
  { id: "history", label: "History", hint: "500,000 rows, server-side" },
];

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("live");
  const hydrated = useHydrated();

  // One gate for the whole streaming subtree. Every panel below reads values
  // that change faster than hydration completes, so none of them may render
  // real data until the markup has been adopted.
  if (!hydrated) return <DashboardShell />;

  return <LiveDashboard tab={tab} onTabChange={setTab} />;
}

function LiveDashboard({
  tab,
  onTabChange,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  const catalog = useCatalogQuery();
  const sensors = catalog.data;
  const setTab = onTabChange;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <KpiRow sensorCount={sensors?.length ?? 0} />

      <div className="grid gap-4 lg:grid-cols-2">
        {sensors === undefined ? (
          <>
            <ChartSkeleton />
            <ChartSkeleton />
          </>
        ) : (
          <>
            <RealtimeChart sensors={sensors} />
            <StatusChart />
          </>
        )}
      </div>

      <PerfPanel />

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <nav
          className="flex gap-1 self-start rounded-xl border border-border-subtle bg-surface-1 p-1 shadow-panel"
          aria-label="Data views"
        >
          {TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => setTab(item.id)}
                className={`rounded-lg px-3.5 py-2 text-left transition-colors ${
                  selected ? "bg-accent" : "hover:bg-surface-2"
                }`}
              >
                <span
                  className={`block text-xs font-semibold ${
                    selected ? "text-accent-contrast" : "text-text-secondary"
                  }`}
                >
                  {item.label}
                </span>
                <span
                  className={`mt-0.5 block text-[10px] leading-none ${
                    selected ? "text-accent-contrast/70" : "text-text-muted"
                  }`}
                >
                  {item.hint}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col">
          {tab === "live" ? (
            catalog.isError ? (
              <CatalogError
                message={(catalog.error as Error).message}
                onRetry={() => void catalog.refetch()}
              />
            ) : sensors === undefined ? (
              <TableSkeleton label="Loading sensor catalog…" />
            ) : (
              <LiveTable sensors={sensors} />
            )
          ) : (
            <HistoryTable />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Pre-hydration shell: the same geometry as the live dashboard, with no live
 * values in it. This is what the server prerenders.
 */
function DashboardShell() {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-[5.25rem] animate-pulse rounded-xl border border-border-subtle bg-surface-1"
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
      <div className="h-40 animate-pulse rounded-xl border border-border-subtle bg-surface-1" />
      <TableSkeleton label="Starting live feed…" />
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-[19.5rem] animate-pulse rounded-lg border border-border-subtle bg-surface-1" />
  );
}

function TableSkeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-64 flex-1 items-center justify-center rounded-xl border border-border-subtle bg-surface-1 text-xs text-text-muted shadow-panel">
      {label}
    </div>
  );
}

function CatalogError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 text-center shadow-panel">
      <p className="text-xs font-medium text-critical">Could not load the sensor catalog</p>
      <p className="max-w-sm text-[11px] text-text-muted">{message}</p>
      <div className="mt-1">
        <Button onClick={onRetry} variant="accent">
          Retry
        </Button>
      </div>
    </div>
  );
}
