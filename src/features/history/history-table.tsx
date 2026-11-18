"use client";

import { useCallback, useMemo, useState } from "react";
import {
  columnSizingFeature,
  createColumnHelper,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { SENSOR_KINDS, SENSOR_LINES, SensorStatus } from "@/lib/sensors";
import { formatClock, formatCount, formatValue } from "@/lib/format";
import { Button, FilterBar, Panel, SelectField, StatusChip, TextField } from "@/components/ui";
import { isReadingSortKey, type ReadingRow } from "@/server/history-store";
import { useReadingsQuery, type ReadingsFilters } from "./use-readings-query";

/**
 * Historical readings: 500,000 rows the browser never downloads.
 *
 * This is the server-side counterpart to the live table. `manualPagination`
 * and `manualSorting` tell TanStack Table that those stages already happened
 * on the server, so it renders exactly the page it was given and leaves the
 * row count to `rowCount`. Sorting a column or typing in a filter changes the
 * query key, which is what actually fetches new data.
 */

// `columnSizingFeature` is what makes `size` / `getSize` exist at all: in v9
// an optional API is absent until its feature is registered.
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  columnSizingFeature,
});
const helper = createColumnHelper<typeof features, ReadingRow>();

/** Stable empty fallback: `?? []` inline would invalidate the row model each render. */
const EMPTY_ROWS: ReadingRow[] = [];

const columns = helper.columns([
  helper.accessor("recordedAt", {
    header: "Recorded",
    size: 110,
    cell: (context) => (
      <span className="tabular text-text-secondary">{formatClock(context.getValue())}</span>
    ),
  }),
  helper.accessor("sensorId", {
    header: "Sensor",
    size: 96,
    cell: (context) => (
      <span className="tabular font-medium text-text-secondary">{context.getValue()}</span>
    ),
  }),
  helper.accessor("sensorName", {
    header: "Name",
    size: 170,
    enableSorting: false,
    cell: (context) => <span className="truncate">{context.getValue()}</span>,
  }),
  helper.accessor("machineId", {
    header: "Machine",
    size: 160,
    cell: (context) => (
      <span className="truncate text-text-secondary">{context.getValue()}</span>
    ),
  }),
  helper.accessor("value", {
    header: "Value",
    size: 120,
    cell: (context) => {
      const row = context.row.original;
      return (
        <span className="tabular font-medium text-text-primary">
          {formatValue(row.value, row.value > 500 ? 0 : 2)}
          <span className="ml-1 text-[10px] font-normal text-text-muted">{row.unit}</span>
        </span>
      );
    },
  }),
  helper.accessor("status", {
    header: "State",
    size: 104,
    cell: (context) => <StatusChip status={context.getValue()} />,
  }),
]);

const STATUS_OPTIONS = [
  { value: "all", label: "All states" },
  { value: String(SensorStatus.Alarm), label: "Alarm" },
  { value: String(SensorStatus.Warning), label: "Warning" },
  { value: String(SensorStatus.Normal), label: "Normal" },
] as const;

const PAGE_SIZE_OPTIONS = [
  { value: "25", label: "25 rows" },
  { value: "50", label: "50 rows" },
  { value: "100", label: "100 rows" },
] as const;

export function HistoryTable() {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [sorting, setSorting] = useState<SortingState>([{ id: "recordedAt", desc: true }]);
  const [search, setSearch] = useState("");
  const [line, setLine] = useState("all");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState<string>("all");

  const sort = sorting[0];
  const filters = useMemo<ReadingsFilters>(
    () => ({
      page: pagination.pageIndex,
      pageSize: pagination.pageSize,
      sort: sort !== undefined && isReadingSortKey(sort.id) ? sort.id : "recordedAt",
      dir: sort?.desc === false ? "asc" : "desc",
      line,
      kind,
      status,
      search,
    }),
    [pagination.pageIndex, pagination.pageSize, sort, line, kind, status, search],
  );

  const { query, total, lastPage } = useReadingsQuery(filters);

  /** Any filter change invalidates the current page offset. */
  const resetAndSet = useCallback(
    <T,>(setter: (value: T) => void) =>
      (value: T): void => {
        setter(value);
        setPagination((current) => ({ ...current, pageIndex: 0 }));
      },
    [],
  );

  const table = useTable(
    {
      features,
      columns,
      data: query.data?.rows ?? EMPTY_ROWS,
      rowCount: total,
      getRowId: (row) => row.id,
      state: { sorting, pagination },
      onSortingChange: setSorting,
      onPaginationChange: setPagination,
      // Both stages already ran on the server; these flags stop the table
      // re-doing them on the single page it holds.
      manualSorting: true,
      manualPagination: true,
    },
    (state) => ({ sorting: state.sorting, pagination: state.pagination }),
  );

  const rows = table.getRowModel().rows;
  const result = query.data;
  const showingFrom = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const showingTo = Math.min(total, (pagination.pageIndex + 1) * pagination.pageSize);

  return (
    <Panel
      title="Reading history"
      subtitle={
        result === undefined
          ? "Loading…"
          : `${formatCount(total)} matching rows · server query ${result.queryMs} ms${
              result.cached ? " (cached ordering)" : ""
            }`
      }
      className="min-h-0 flex-1"
      actions={
        <span className="text-[11px] text-text-muted">
          {query.isFetching ? "fetching…" : "server-side sort · filter · page"}
        </span>
      }
    >
      <FilterBar>
        <TextField
          label="Search"
          value={search}
          placeholder="Sensor id, name or machine"
          onChange={resetAndSet(setSearch)}
          className="w-56"
        />
        <SelectField
          label="Line"
          value={line}
          onChange={resetAndSet(setLine)}
          options={[
            { value: "all", label: "All lines" },
            ...SENSOR_LINES.map((item) => ({ value: item, label: item })),
          ]}
        />
        <SelectField
          label="Type"
          value={kind}
          onChange={resetAndSet(setKind)}
          options={[
            { value: "all", label: "All types" },
            ...SENSOR_KINDS.map((item) => ({ value: item, label: item })),
          ]}
        />
        <SelectField
          label="State"
          value={status}
          onChange={resetAndSet(setStatus)}
          options={STATUS_OPTIONS}
        />
        <SelectField
          label="Page size"
          value={String(pagination.pageSize)}
          onChange={(value) => setPagination({ pageIndex: 0, pageSize: Number(value) })}
          options={PAGE_SIZE_OPTIONS}
        />
      </FilterBar>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
        {query.isError ? (
          <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2 shadow-panel">
              <tr>
                {table.getHeaderGroups()[0]?.headers.map((header) => {
                  const sortDirection = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      style={{ width: header.getSize() }}
                      aria-sort={
                        sortDirection === "asc"
                          ? "ascending"
                          : sortDirection === "desc"
                            ? "descending"
                            : undefined
                      }
                      className="border-b border-border-subtle px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex items-center gap-1 transition-colors hover:text-accent"
                        >
                          <table.FlexRender header={header} />
                          <span
                            aria-hidden="true"
                            className={`text-[8px] ${
                              sortDirection === false ? "opacity-40" : "text-accent"
                            }`}
                          >
                            {sortDirection === "asc" ? "▲" : sortDirection === "desc" ? "▼" : "↕"}
                          </span>
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody
              // Dim the stale page while the next one is in flight, instead of
              // replacing it with a spinner.
              className={query.isFetching ? "opacity-60 transition-opacity" : undefined}
            >
              {rows.length === 0 && !query.isPending ? (
                <tr>
                  <td colSpan={columns.length} className="px-3 py-8 text-center text-text-muted">
                    No readings match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border-subtle/70 transition-colors hover:bg-surface-2"
                  >
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id} className="truncate px-3 py-2">
                        <table.FlexRender cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border-subtle bg-surface-2/50 px-5 py-3">
        <span className="tabular text-[11px] text-text-secondary">
          {total === 0
            ? "No rows"
            : `${formatCount(showingFrom)}–${formatCount(showingTo)} of ${formatCount(total)}`}
        </span>
        <div className="flex items-center gap-1.5">
          <PageButton
            label="First"
            disabled={pagination.pageIndex === 0}
            onClick={() => setPagination((current) => ({ ...current, pageIndex: 0 }))}
          />
          <PageButton
            label="Prev"
            disabled={pagination.pageIndex === 0}
            onClick={() =>
              setPagination((current) => ({
                ...current,
                pageIndex: Math.max(0, current.pageIndex - 1),
              }))
            }
          />
          <span className="tabular px-2 text-[11px] font-medium text-text-primary">
            {pagination.pageIndex + 1} / {formatCount(lastPage + 1)}
          </span>
          <PageButton
            label="Next"
            disabled={pagination.pageIndex >= lastPage}
            onClick={() =>
              setPagination((current) => ({
                ...current,
                pageIndex: Math.min(lastPage, current.pageIndex + 1),
              }))
            }
          />
          <PageButton
            label="Last"
            disabled={pagination.pageIndex >= lastPage}
            onClick={() => setPagination((current) => ({ ...current, pageIndex: lastPage }))}
          />
        </div>
      </footer>
    </Panel>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
      <p className="text-xs font-medium text-critical">Could not load readings</p>
      <p className="max-w-sm text-[11px] text-text-muted">{message}</p>
      <div className="mt-1">
        <Button onClick={onRetry} variant="accent">
          Retry
        </Button>
      </div>
    </div>
  );
}
