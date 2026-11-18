# Sensor Operations — realtime monitoring dashboard

A dashboard for an industrial sensor floor: **5,000 sensors streaming at 10 Hz
over WebSocket**, plus **500,000 historical readings** queried server-side.

Built to show three things working together at a scale where they actually
conflict: a large data table, a realtime feed, and the performance work needed
to keep both responsive.

```bash
npm install
npm run dev     # simulator on :3101 + Next.js on :3000
```

Open <http://localhost:3000>. No configuration, no external services — the
sensor floor is simulated locally.

---

## What's in it

| Panel | What it demonstrates |
|---|---|
| **Live sensors** | 5,000-row virtualised table, per-row subscriptions, live sorting and filtering |
| **Reading history** | 500,000 rows with server-side filter / sort / page, TanStack Query caching and prefetch |
| **Live trend** | Recharts time series with render cadence decoupled from data cadence |
| **Sensors out of band** | Stacked warning/alarm counts, sampled at 1 Hz off the hot path |
| **Transport & render metrics** | Live instrumentation — every performance claim below is measurable in the UI |

## Stack

Next.js 16 (App Router, Cache Components) · React 19 · TypeScript (strict) ·
TanStack Query v5 · TanStack Table v9 · TanStack Virtual · Recharts ·
Tailwind CSS v4 · `ws`

Runtime dependencies are the five libraries above. The dev runner, the test
suite and the simulator add none — they use Node 24's built-in child process
handling, `node:test`, and native TypeScript execution.

---

## Architecture

```
server/
  simulator.ts         sensor physics + anomaly episodes, in typed arrays
  ws-server.ts         standalone WebSocket feed on :3101
scripts/
  dev.mjs              runs the simulator and Next.js with one lifecycle
src/
  lib/
    protocol.ts        binary + JSON wire codecs (shared by server & browser)
    sensors.ts         deterministic sensor catalog (shared by all three tiers)
    rng.ts             seeded PRNG
  server/
    history-store.ts   500k readings, columnar, filtered/sorted/paged here
  app/
    api/sensors        catalog, columnar payload, `use cache`
    api/readings       server-side paged history
  features/
    live/              store, stream provider, virtualised table, charts
    history/           query hook + server-paged table
    telemetry/         metrics store + performance panel
```

The simulator runs **outside Next.js** deliberately: it needs a long-lived
process holding simulation state and ticking on a fixed interval, which is the
opposite of a request-scoped function. It also means the browser's WebSocket
survives Next.js hot reloads.

---

## The performance work

Each item below is visible in the **Transport & render metrics** panel while
the app runs. The numbers are from a local run at 5,000 sensors / 10 Hz.

### 1. Binary wire protocol — 1.30 MB/s → 186 KB/s

A 16-byte header plus 8 bytes per sample, decoded with a `DataView` walk
straight into the client's typed arrays. No intermediate objects, no
`JSON.parse` pause.

| | JSON | Binary |
|---|---|---|
| Throughput | 1.30 MB/s | **186 KB/s** |
| Decode time | 0.26 ms/frame | **0.05 ms/frame** |
| Allocations | ~24,000 objects/s | **none** |

Both encodings ship, and the panel switches between them at runtime — the
comparison is live, not a claim.

### 2. Report-by-exception — ~52% of samples never sent

Each sensor has a deadband; it is only reported once it moves further than
that from the value last sent. This is how real SCADA/OPC-UA feeds avoid
shipping sensor noise. About 2,400 of 5,000 sensors report per frame.

A status transition **always** reports regardless of the deadband — an alarm
must never be delayed because a value only crept across its threshold. That
invariant has a test.

### 3. Live values never enter the table's data

The table's `data` is static sensor metadata. Live values live in typed arrays
outside React, and each mounted row subscribes to its own sensor through
`useSyncExternalStore`, returning a revision counter — a primitive, so a row
whose sensor stayed inside its deadband does not re-render at all.

A frame therefore re-renders the ~21 rows the virtualiser has mounted, never
5,000, and the row model is never rebuilt.

> Virtualisation is easy to defeat by accident. During development this table
> mounted all 5,000 rows and the browser sat at **1 fps**: the scroll container
> used `flex-1`, but nothing in its ancestor chain bounded the height, so it
> simply grew to fit every row — and a container tall enough for all of them
> makes every row "visible". Giving the viewport a real height took it to
> **120 fps**. The metrics panel is what surfaced it.

### 4. Re-sorting is rationed; the data is not

Sorting by a live column needs a new `data` identity to re-run the sort. Doing
that per frame would rebuild the row model ten times a second *and* make rows
jump faster than anyone can read them. A live sort re-orders **once a second**
while the values inside the rows keep updating at the full rate.

### 5. Render cadence decoupled from data cadence

Recharts re-renders on every data change, so wiring it to a 10 Hz feed hands
React a full chart reconciliation ten times a second. Instead the store keeps
every sample in a ring buffer and the chart samples that ring on its own timer
(2/4/10 fps, switchable). **No sample is dropped** — the whole window is
redrawn each time; only the redraw frequency is rationed.

The fleet chart goes further: it never subscribes to the stream at all, reading
the aggregate at 1 Hz.

### 6. One React notification per paint

Decoding writes into the store immediately; subscribers are notified once per
animation frame. A burst of frames collapses into a single React commit instead
of one commit per frame.

### 7. The feed drops peers that stop listening

A sensor feed pushes continuously and never expects a reply, so a peer that
disappears without a TCP FIN — a sleeping laptop, a dropped VPN — looks exactly
like a healthy quiet client, and the server keeps serialising ~190 KB/s into a
socket nobody reads. The server pings every 15 s and terminates any client that
misses a full window.

On the browser side, the connection is owned by the effect instance that
created it, not by the shared ref. Without that, a closing socket's `onclose`
can null out a ref that a newer connection has already claimed — orphaning the
new socket with no way to close it. That shows up as a slowly climbing
throughput reading, which is how it was found here.

### 8. Server-side history, columnar — 204.7 ms → 0.5 ms

500,000 rows as row objects would cost ~100 MB. Five typed-array columns cost
about 8 MB, and row objects are materialised only for the ≤100 rows actually
returned.

Filtered-and-sorted orderings are cached by filter+sort key, so paging within
one view costs only a slice:

| | first query | paging within it |
|---|---|---|
| Server time | 204.7 ms | **0.5 ms** |

The UI reports its own server query time and whether the ordering was cached.
TanStack Query keeps the previous page on screen during a fetch and prefetches
the next one.

---

## Design notes

The accent is indigo on a cool slate neutral, chosen by measurement rather than
taste. In a monitoring UI the accent must not be mistaken for a status, so
candidates were scored against the four reserved status colours: indigo sits
ΔE 26.9 from critical and far from good. Amber and aqua were tested and
rejected — ΔE 8.1 from critical and 10.0 from good, both below the threshold at
which full-colour vision separates them.

Colours live only in `globals.css`; the charts reference them as
`var(--chart-*)` from SVG attributes, so there is no second copy in TypeScript
to drift. Ink contrast clears 4.5:1 for body text on every surface in both
modes.

Every measured quantity is set in the mono face with tabular figures.
Proportional digits change width as values stream in, so a column of live
numbers visibly shivers even when the values barely move.

Status roles (normal / warning / alarm / stale) are reserved and never reused
as a series colour. On a light surface the warning step sits below 3:1 contrast
by design, so **every status is rendered with an icon and a text label** —
state never depends on colour alone. Both tables double as the accessible
table view for the charts.

The fleet chart plots only warning and alarm. Stacking "normal" alongside them
is technically the full picture, but a healthy floor is ~99% normal, so the
stack becomes one flat green block and the trend the chart exists to show
disappears into a sliver.

Sparklines are hand-rolled SVG polylines rather than chart components: ~21 are
mounted at a time, and a chart library per row would bring its own containers,
resize observers and tooltip machinery into every one.

---

## Scripts

```bash
npm run dev        # simulator + Next.js together, shared lifecycle
npm run dev:next   # Next.js alone
npm run ws         # simulator alone
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # node:test — 34 tests, no test framework dependency
```

Tests cover the wire codecs (round-trip, truncation, version mismatch), the
simulator's deadband and its alarm-reporting invariant, and the server-side
query (filtering, stable tie ordering, page clamping, cache reuse).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SENSOR_WS_PORT` | `3101` | Simulator port |
| `SENSOR_TICK_MS` | `100` | Simulation tick |
| `SENSOR_RATE_HZ` | `10` | Maximum feed rate |
| `SENSOR_HEARTBEAT_MS` | `15000` | Ping interval for reaping dead clients |
| `NEXT_PUBLIC_SENSOR_WS_URL` | `ws://localhost:3101` | Browser's WebSocket URL |

## Known limitations

- The dashboard below the page header is client-rendered behind a hydration
  gate. Its values change faster than hydration completes, so prerendering them
  guarantees a mismatch; the page shell above stays static.
- `useVirtualizer` triggers a React Compiler "incompatible library" warning.
  It is a known TanStack Virtual limitation, not an application fault — the
  rows are not memoised, which is correct here anyway.
- Metrics are per browser page. A page left open across a dev session that
  predates a fix can keep stale handlers alive and over-report; a reload gives
  a clean measurement, which is what the numbers above were taken from.
- The simulated floor is not a physical model. Values follow a sinusoid with
  noise, and anomaly episodes ramp, hold and recover; it is shaped to exercise
  the UI, not to be metrologically faithful.
