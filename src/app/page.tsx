import { Dashboard } from "@/features/dashboard";
import { ConnectionSlot } from "@/features/live/connection-slot";
import { SENSOR_COUNT } from "@/lib/sensors";
import { READING_COUNT } from "@/server/history-store";

/**
 * The page itself is a Server Component and stays static: it renders the
 * heading and hands off to the client dashboard, which owns the WebSocket.
 * With Cache Components enabled this shell is part of the prerendered output,
 * so the layout paints before any data arrives.
 *
 * `ConnectionSlot` is the one client island up here, so the live badge does
 * not pull the whole header out of the static shell.
 */
export default function Home() {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border-subtle bg-surface-1">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-contrast"
            >
              SO
            </span>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold tracking-tight text-text-primary">
                Sensor Operations
              </h1>
              <p className="mt-0.5 text-[11px] leading-none text-text-muted">
                <span className="tabular">{SENSOR_COUNT.toLocaleString("en-US")}</span> sensors at
                10 Hz ·{" "}
                <span className="tabular">{READING_COUNT.toLocaleString("en-US")}</span> readings
                queried server-side
              </p>
            </div>
          </div>
          <ConnectionSlot />
        </div>
      </header>
      <Dashboard />
    </main>
  );
}
