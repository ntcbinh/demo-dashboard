"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReadingsPage, ReadingSortKey, SortDirection } from "@/server/history-store";

/**
 * Query layer for the server-paged history table.
 *
 * Every server-owned slice of state — page, size, sort, direction and all four
 * filters — is part of the query key. Leaving any of them out would let Query
 * serve a cached page that answers a different question.
 */

export type ReadingsFilters = {
  readonly page: number;
  readonly pageSize: number;
  readonly sort: ReadingSortKey;
  readonly dir: SortDirection;
  readonly line: string;
  readonly kind: string;
  readonly status: string;
  readonly search: string;
};

function toSearchParams(filters: ReadingsFilters): string {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    sort: filters.sort,
    dir: filters.dir,
  });
  if (filters.line !== "all") params.set("line", filters.line);
  if (filters.kind !== "all") params.set("kind", filters.kind);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.search.trim() !== "") params.set("search", filters.search.trim());
  return params.toString();
}

async function fetchReadings(
  filters: ReadingsFilters,
  signal: AbortSignal,
): Promise<ReadingsPage> {
  const response = await fetch(`/api/readings?${toSearchParams(filters)}`, { signal });
  if (!response.ok) {
    throw new Error(`Readings request failed with ${response.status}`);
  }
  return (await response.json()) as ReadingsPage;
}

export function readingsQueryKey(filters: ReadingsFilters) {
  return ["readings", filters] as const;
}

export function useReadingsQuery(filters: ReadingsFilters) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: readingsQueryKey(filters),
    queryFn: ({ signal }) => fetchReadings(filters, signal),
    // Keep the current page on screen while the next one loads, so paging
    // does not flash an empty table.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const total = query.data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / filters.pageSize) - 1);
  const hasNextPage = filters.page < lastPage;

  // Warm the next page while the user reads the current one. The server
  // already has this filter+sort ordering cached, so it is nearly free.
  useEffect(() => {
    if (!hasNextPage) return;
    const next: ReadingsFilters = { ...filters, page: filters.page + 1 };
    void queryClient.prefetchQuery({
      queryKey: readingsQueryKey(next),
      queryFn: ({ signal }) => fetchReadings(next, signal),
      staleTime: 10_000,
    });
  }, [queryClient, filters, hasNextPage]);

  return { query, total, lastPage };
}
