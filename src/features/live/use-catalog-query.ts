"use client";

import { useQuery } from "@tanstack/react-query";
import {
  fromCatalogPayload,
  type SensorCatalogPayload,
  type SensorMeta,
} from "@/lib/sensors";

/**
 * Loads the sensor catalog once.
 *
 * The catalog is static metadata, so it is fetched through Query with an
 * infinite stale time and then kept: the rows handed to the live table are
 * this array, and its identity must stay stable or the table's row model is
 * rebuilt for nothing.
 */
export function useCatalogQuery() {
  return useQuery<readonly SensorMeta[]>({
    queryKey: ["sensor-catalog"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/sensors", { signal });
      if (!response.ok) {
        throw new Error(`Sensor catalog request failed with ${response.status}`);
      }
      const payload = (await response.json()) as SensorCatalogPayload;
      return fromCatalogPayload(payload);
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}
