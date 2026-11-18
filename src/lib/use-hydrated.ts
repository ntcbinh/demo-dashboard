"use client";

import { useSyncExternalStore } from "react";

/** Never fires; the value is constant per environment. */
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * `false` during server rendering and on the first client render, `true`
 * afterwards.
 *
 * Needed because the live dashboard reads values that are already moving by
 * the time React hydrates: the prerendered HTML says "connecting", the socket
 * opens, and the first client render disagrees with the markup it is supposed
 * to be adopting. Gating the streaming subtree on this makes the server HTML
 * and the first client render identical by construction.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` +
 * `useEffect`: the server/client split is exactly what `getServerSnapshot`
 * is for, and it avoids a state update during the mount effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
