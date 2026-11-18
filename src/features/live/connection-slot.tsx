"use client";

import { ConnectionBadge } from "./connection-badge";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * Renders the live connection badge only once hydrated, matching the gate the
 * rest of the streaming UI uses. Before that it reserves the same space, so
 * the header does not shift when the badge appears.
 */
export function ConnectionSlot() {
  const hydrated = useHydrated();

  if (!hydrated) {
    return <span className="h-[30px] w-[132px] rounded-lg bg-surface-2" aria-hidden="true" />;
  }
  return <ConnectionBadge />;
}
