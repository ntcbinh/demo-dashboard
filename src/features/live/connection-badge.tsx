"use client";

import { useMetrics } from "./stream-provider";

/**
 * Connection state in the page header.
 *
 * The dot pulses only while connected, so "live" is legible at a glance from
 * across a room — but the state is spelled out in text beside it, because a
 * coloured dot alone is not an accessible status.
 */
const PRESENTATION = {
  open: { label: "Live", dot: "bg-good", text: "text-good", pulse: true },
  connecting: { label: "Connecting", dot: "bg-warning", text: "text-warning", pulse: false },
  closed: { label: "Disconnected", dot: "bg-critical", text: "text-critical", pulse: false },
  error: { label: "Connection error", dot: "bg-critical", text: "text-critical", pulse: false },
} as const;

export function ConnectionBadge() {
  const metrics = useMetrics();
  const presentation = PRESENTATION[metrics.connection];

  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 shadow-panel">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {presentation.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${presentation.dot}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${presentation.dot}`} />
      </span>
      <span className={`text-[11px] font-medium ${presentation.text}`}>{presentation.label}</span>
      <span className="tabular text-[11px] text-text-muted">
        {metrics.framesPerSecond.toFixed(1)} fps
      </span>
    </span>
  );
}
