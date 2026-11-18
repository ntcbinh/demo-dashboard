"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnSort,
  type ColumnVisibilityState,
  type ReactTable,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import {
  SENSOR_KINDS,
  SENSOR_LINES,
  SensorStatus,
  type SensorKind,
  type SensorMeta,
  type SensorStatusCode,
} from "@/lib/sensors";
import { formatValue } from "@/lib/format";
import {
  FilterBar,
  Panel,
  SelectField,
  StatusChip,
  TextField,
  statusPresentation,
} from "@/components/ui";
import {
  useFocusIndex,
  useRowCommitCounter,
  useSensorRevision,
  useSensorStore,
} from "./stream-provider";
import type { SensorStore } from "./sensor-store";
import { Sparkline } from "./sparkline";

/**
 * The live sensor table: 5,000 rows, every one of them changing up to ten
 * times a second.
 *
 * Two decisions carry the performance here.
 *
 * 1. **Only mounted rows re-render.** The table's `data` holds *static* sensor
 *    metadata; live values are never part of it. Each visible row subscribes
 *    to its own sensor and reads the current value out of the store during
 *    render. A frame therefore re-renders the ~24 rows the virtualiser has
 *    mounted, not 5,000 — and the row model is never rebuilt.
 *
 * 2. **Re-sorting is rationed, not the data.** Sorting by a live column needs
 *    a new `data` identity to re-run the sort. Doing that per frame would
 *    rebuild the row model ten times a second *and* make rows jump around
 *    faster than anyone can read them, so a live sort re-orders once a second
 *    while the values inside the rows keep updating at full rate.
 */

const features = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  columnSizingFeature,
});

type LiveFeatures = typeof features;

/** The slices the owner subscribes to; see the selector passed to `useTable`. */
type LiveSelection = {
  sorting: SortingState;
  columnVisibility: ColumnVisibilityState;
};

type LiveTableInstance = ReactTable<LiveFeatures, SensorMeta, LiveSelection>;

const helper = createColumnHelper<LiveFeatures, SensorMeta>();

const ROW_HEIGHT = 36;

/** How often a live sort or a live filter re-evaluates. */
const LIVE_REFRESH_MS = 1_000;

/** Columns whose sort order depends on streaming values. */
const LIVE_SORT_COLUMNS = new Set(["value", "status"]);

type StatusFilter = "all" | "normal" | "warning" | "alarm";

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All states" },
  { value: "alarm", label: "Alarm only" },
  { value: "warning", label: "Warning only" },
  { value: "normal", label: "Normal only" },
] as const satisfies ReadonlyArray<{ value: StatusFilter; label: string }>;

const STATUS_FILTER_CODE: Record<Exclude<StatusFilter, "all">, SensorStatusCode> = {
  normal: SensorStatus.Normal,
  warning: SensorStatus.Warning,
  alarm: SensorStatus.Alarm,
};

/**
 * Columns are built once at module scope. Rebuilding them per render would
 * invalidate the row model on every frame — the most common way to make a
 * TanStack table slow.
 *
 * The live columns read from the store rather than from row data. Their
 * accessors exist so sorting has something to compare; the rendered value
 * comes from the same place, one read later.
 */
function buildColumns(store: SensorStore) {
  return helper.columns([
    helper.accessor("id", {
      header: "Sensor",
      size: 92,
      cell: (context) => (
        <span className="tabular font-medium text-text-secondary">{context.getValue()}</span>
      ),
    }),
    helper.accessor("name", {
      header: "Name",
      size: 168,
      cell: (context) => <span className="truncate">{context.getValue()}</span>,
    }),
    helper.accessor("machineId", {
      header: "Machine",
      size: 160,
      cell: (context) => (
        <span className="truncate text-text-secondary">{context.getValue()}</span>
      ),
    }),
    helper.accessor("kind", {
      header: "Type",
      size: 104,
      cell: (context) => (
        <span className="truncate text-text-muted">{context.getValue()}</span>
      ),
    }),
    helper.accessor((row) => store.values[row.index], {
      id: "value",
      header: "Value",
      size: 116,
      cell: (context) => <ValueCell sensor={context.row.original} store={store} />,
    }),
    helper.accessor((row) => store.statuses[row.index], {
      id: "status",
      header: "State",
      size: 104,
      cell: (context) => (
        <StatusChip status={store.statuses[context.row.original.index] as SensorStatusCode} />
      ),
    }),
    helper.display({
      id: "trend",
      header: "Trend",
      size: 104,
      cell: (context) => {
        const sensor = context.row.original;
        const status = store.statuses[sensor.index] as SensorStatusCode;
        return (
          <Sparkline
            index={sensor.index}
            min={sensor.min}
            max={sensor.max}
            color={STATUS_STROKE[status] ?? STATUS_STROKE[SensorStatus.Stale]}
          />
        );
      },
    }),
  ]);
}

const STATUS_STROKE: Record<SensorStatusCode, string> = {
  [SensorStatus.Normal]: "var(--chart-good)",
  [SensorStatus.Warning]: "var(--chart-warning)",
  [SensorStatus.Alarm]: "var(--chart-critical)",
  [SensorStatus.Stale]: "var(--chart-stale)",
};

function ValueCell({ sensor, store }: { sensor: SensorMeta; store: SensorStore }) {
  const status = store.statuses[sensor.index] as SensorStatusCode;
  const presentation = statusPresentation(status);
  const digits = sensor.max > 500 ? 0 : 2;
  return (
    <span className={`tabular font-medium ${presentation.text}`}>
      {formatValue(store.values[sensor.index], digits)}
      <span className="ml-1 text-[10px] font-normal text-text-muted">{sensor.unit}</span>
    </span>
  );
}

export function LiveTable({ sensors }: { sensors: readonly SensorMeta[] }) {
  const store = useSensorStore();
  const columns = useMemo(() => buildColumns(store), [store]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [query, setQuery] = useState("");
  const [line, setLine] = useState<string>("all");
  const [kind, setKind] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const sortsOnLiveColumn = sorting.some((sort: ColumnSort) => LIVE_SORT_COLUMNS.has(sort.id));
  const needsLiveRefresh = sortsOnLiveColumn || statusFilter !== "all";

  /**
   * Filters run outside the table because one of them — the state filter —
   * is a predicate over streaming data, not over row data. Keeping all four
   * filters in one place avoids two different filtering paths.
   */
  const [rows, setRows] = useState<readonly SensorMeta[]>(sensors);

  useEffect(() => {
    const compute = (): void => {
      setRows(selectRows(sensors, { query, line, kind, statusFilter }, store));
    };

    // Deferred rather than called inline: a synchronous setState inside an
    // effect body triggers a second render pass before the browser paints.
    const first = setTimeout(compute, 0);
    const timer = needsLiveRefresh ? setInterval(compute, LIVE_REFRESH_MS) : undefined;

    return () => {
      clearTimeout(first);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sensors, query, line, kind, statusFilter, needsLiveRefresh, store]);

  const table = useTable(
    {
      features,
      columns,
      data: rows as SensorMeta[],
      getRowId: (row) => row.id,
      state: { sorting },
      onSortingChange: setSorting,
    },
    // Narrow the owner's subscription: this component only needs to re-render
    // for sorting and visibility, not for every registered state slice.
    (state) => ({ sorting: state.sorting, columnVisibility: state.columnVisibility }),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => modelRows[index]?.id ?? index,
    overscan: 8,
  });

  // Clicking a row focuses the trend chart, so the table has to show which
  // row that was. Subscribing here rather than per row keeps it to one
  // subscription for a value that changes only on a click.
  const focusIndex = useFocusIndex();

  const virtualItems = virtualizer.getVirtualItems();
  const headerGroups = table.getHeaderGroups();
  const totalWidth = table.getTotalSize();

  const onSelect = useCallback(
    (index: number) => {
      store.setFocus(index);
    },
    [store],
  );

  return (
    <Panel
      title="Live sensors"
      subtitle={`${rows.length.toLocaleString("en-US")} of ${sensors.length.toLocaleString("en-US")} sensors · ${virtualItems.length} rows mounted${
        sortsOnLiveColumn ? " · live sort re-orders every 1s" : ""
      }`}
      className="min-h-0 flex-1"
    >
      <FilterBar>
        <TextField
          label="Search"
          value={query}
          placeholder="Sensor id, name or machine"
          onChange={setQuery}
          className="w-56"
        />
        <SelectField
          label="Line"
          value={line}
          onChange={setLine}
          options={[
            { value: "all", label: "All lines" },
            ...SENSOR_LINES.map((item) => ({ value: item, label: item })),
          ]}
        />
        <SelectField
          label="Type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All types" },
            ...SENSOR_KINDS.map((item) => ({ value: item, label: item })),
          ]}
        />
        <SelectField
          label="State"
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_FILTER_OPTIONS}
        />
      </FilterBar>

      {/*
        * The virtualiser needs a scroll container with a real height. `flex-1`
        * does not provide one here: the dashboard is a normally scrolling
        * page, so a flexible child just grows to fit its content — and a
        * container tall enough for all 5,000 rows makes every row "visible",
        * which silently defeats virtualisation entirely.
        */}
      <div
        ref={scrollRef}
        className="thin-scrollbar overflow-auto border-b border-border-subtle"
        style={{ height: "clamp(20rem, 55vh, 45rem)" }}
      >
        <table
          className="text-xs"
          style={{ display: "grid", width: totalWidth, minWidth: "100%" }}
        >
          <thead
            className="sticky top-0 z-10 bg-surface-2 shadow-panel"
            style={{ display: "grid" }}
          >
            {headerGroups.map((group) => (
              <tr key={group.id} style={{ display: "flex", width: "100%" }}>
                {group.headers.map((header) => {
                  const sortDirection = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sortDirection === "asc"
                          ? "ascending"
                          : sortDirection === "desc"
                            ? "descending"
                            : undefined
                      }
                      style={{ display: "flex", width: header.getSize() }}
                      className="items-center border-b border-border-subtle px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {header.isPlaceholder ? null : canSort ? (
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
            ))}
          </thead>

          <tbody
            style={{
              display: "grid",
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualItems.map((item) => {
              const row = modelRows[item.index];
              if (row === undefined) return null;
              return (
                <LiveRow
                  key={row.id}
                  table={table}
                  row={row}
                  dataIndex={item.index}
                  start={item.start}
                  selected={row.original.index === focusIndex}
                  onSelect={onSelect}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type LiveRowProps = {
  table: LiveTableInstance;
  row: Row<LiveFeatures, SensorMeta>;
  dataIndex: number;
  start: number;
  selected: boolean;
  onSelect: (index: number) => void;
};

/**
 * One mounted row, and the only subscriber to its sensor.
 *
 * `useSensorRevision` returns a plain counter, so React bails out of the
 * re-render when this sensor stayed inside its deadband and did not report.
 *
 * The cell elements are built *here*, during this row's own render, which is
 * essential: React skips re-rendering a child whose element reference is
 * unchanged, so cells created once in the parent would never pick up a new
 * value no matter how often this row re-rendered. Building them per row
 * render is also what makes one subscription per row enough for every live
 * cell in it.
 */
function LiveRow({ table, row, dataIndex, start, selected, onSelect }: LiveRowProps) {
  const sensorIndex = row.original.index;
  useSensorRevision(sensorIndex);
  useRowCommitCounter();

  return (
    <tr
      data-index={dataIndex}
      aria-selected={selected}
      onClick={() => onSelect(sensorIndex)}
      style={{
        display: "flex",
        position: "absolute",
        transform: `translateY(${start}px)`,
        width: "100%",
        height: ROW_HEIGHT,
      }}
      className={`cursor-pointer border-b border-border-subtle/70 transition-colors ${
        selected ? "bg-accent-wash" : "hover:bg-surface-2"
      }`}
    >
      {row.getVisibleCells().map((cell, cellIndex) => (
        <td
          key={cell.id}
          style={{ display: "flex", width: cell.column.getSize() }}
          className="relative items-center overflow-hidden px-3"
        >
          {selected && cellIndex === 0 && (
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
          )}
          <table.FlexRender cell={cell} />
        </td>
      ))}
    </tr>
  );
}

function selectRows(
  sensors: readonly SensorMeta[],
  filters: { query: string; line: string; kind: string; statusFilter: StatusFilter },
  store: SensorStore,
): readonly SensorMeta[] {
  const { query, line, kind, statusFilter } = filters;
  const needle = query.trim().toLowerCase();
  const wantedStatus =
    statusFilter === "all" ? null : STATUS_FILTER_CODE[statusFilter];

  // No filter active: hand back the original array so its identity — and with
  // it the memoised row model — stays stable.
  if (needle === "" && line === "all" && kind === "all" && wantedStatus === null) {
    return sensors;
  }

  const matches: SensorMeta[] = [];
  for (const sensor of sensors) {
    if (line !== "all" && sensor.line !== line) continue;
    if (kind !== "all" && sensor.kind !== (kind as SensorKind)) continue;
    if (wantedStatus !== null && store.statuses[sensor.index] !== wantedStatus) continue;
    if (
      needle !== "" &&
      !sensor.id.toLowerCase().includes(needle) &&
      !sensor.name.toLowerCase().includes(needle) &&
      !sensor.machineId.toLowerCase().includes(needle)
    ) {
      continue;
    }
    matches.push(sensor);
  }
  return matches;
}
