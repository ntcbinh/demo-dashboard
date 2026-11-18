"use client";

import { useMemo } from "react";
import { RING_SIZE } from "./sensor-store";
import { useSensorStore } from "./stream-provider";

/**
 * Per-row sparkline.
 *
 * Drawn as a plain SVG polyline rather than through a chart library: there are
 * only ~24 of these mounted at a time (the virtualiser unmounts the rest), and
 * a chart component per row would bring its own containers, resize observers
 * and tooltip machinery into every one of them.
 *
 * It deliberately does not subscribe to the store. The row above it already
 * does, so this re-renders with its row and reads the ring buffer during
 * render — one subscription per row instead of one per cell.
 */

const WIDTH = 88;
const HEIGHT = 20;

export function Sparkline({
  index,
  min,
  max,
  color,
}: {
  index: number;
  min: number;
  max: number;
  color: string;
}) {
  const store = useSensorStore();
  // One scratch buffer per mounted sparkline, reused across renders, so
  // reading the ring never allocates on the hot path.
  const scratch = useMemo(() => new Float32Array(RING_SIZE), []);

  const length = store.readSparkline(index, scratch);
  if (length < 2) {
    return <svg width={WIDTH} height={HEIGHT} aria-hidden="true" />;
  }

  const span = max - min || 1;
  const stepX = WIDTH / (length - 1);
  let path = "";
  for (let i = 0; i < length; i++) {
    const x = i * stepX;
    const normalized = (scratch[i] - min) / span;
    const y = HEIGHT - Math.min(1, Math.max(0, normalized)) * HEIGHT;
    path += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      className="overflow-visible"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
