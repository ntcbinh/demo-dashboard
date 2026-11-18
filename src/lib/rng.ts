/**
 * Deterministic PRNG (mulberry32).
 *
 * The simulator, the REST history dataset and the client all derive data from
 * seeded sequences so that a demo run is reproducible: the same seed always
 * produces the same sensor catalog and the same anomaly episodes.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in `[min, max)`. */
export function randFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in `[min, max]`. */
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

/** Picks one element; the array must not be empty. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}
