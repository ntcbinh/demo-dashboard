import type { NextRequest } from "next/server";
import { SensorStatus, type SensorStatusCode } from "@/lib/sensors";
import {
  isReadingSortKey,
  queryReadings,
  type ReadingQuery,
} from "@/server/history-store";

/**
 * Server-side paged history.
 *
 * Every expensive stage — filter, sort, page — runs on the server, and the
 * response carries only the requested page plus the total count the client
 * needs to render pagination. The client never sees the 500,000-row dataset.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;

  const query: ReadingQuery = {
    page: readInt(params.get("page"), 0),
    pageSize: readInt(params.get("pageSize"), 50),
    sort: readSort(params.get("sort")),
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    line: emptyToNull(params.get("line")),
    kind: emptyToNull(params.get("kind")),
    status: readStatus(params.get("status")),
    search: emptyToNull(params.get("search")),
  };

  const result = queryReadings(query);

  return Response.json(result, {
    headers: {
      // Query results depend on request parameters only; the dataset itself is
      // fixed for the lifetime of the server process.
      "cache-control": "private, max-age=10",
    },
  });
}

function readInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readSort(raw: string | null): ReadingQuery["sort"] {
  return raw !== null && isReadingSortKey(raw) ? raw : "recordedAt";
}

function readStatus(raw: string | null): SensorStatusCode | null {
  if (raw === null || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  switch (parsed) {
    case SensorStatus.Normal:
    case SensorStatus.Warning:
    case SensorStatus.Alarm:
    case SensorStatus.Stale:
      return parsed;
    default:
      return null;
  }
}

function emptyToNull(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" || trimmed === "all" ? null : trimmed;
}
