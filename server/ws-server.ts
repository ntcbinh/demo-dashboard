import { WebSocketServer, type WebSocket } from "ws";
import {
  encodeJsonFrame,
  frameByteLength,
  FrameKind,
  PROTOCOL_VERSION,
  writeBinaryFrame,
  type ClientControlMessage,
  type Encoding,
  type ServerControlMessage,
} from "../src/lib/protocol.ts";
import { SENSOR_COUNT } from "../src/lib/sensors.ts";
import { SensorSimulator } from "./simulator.ts";

/**
 * Standalone WebSocket sensor feed.
 *
 * It runs outside Next.js on purpose. The dashboard needs a long-lived process
 * holding simulation state in typed arrays and ticking on a fixed interval,
 * which is the opposite of a request-scoped serverless function. Keeping it
 * separate also means the browser's connection survives Next.js hot reloads.
 *
 * Run with `npm run ws` (Node 24 executes the TypeScript directly).
 */

const PORT = Number(process.env.SENSOR_WS_PORT ?? 3101);
const TICK_MS = Number(process.env.SENSOR_TICK_MS ?? 100);
const SENSOR_SAMPLE_RATE_HZ = Number(process.env.SENSOR_RATE_HZ ?? 10);

/**
 * How often to ping clients. A sensor feed pushes continuously and never
 * expects a reply, so a peer that disappears without a TCP FIN — a sleeping
 * laptop, a dropped VPN, a browser tab the OS froze — looks exactly like a
 * healthy silent client. Without a heartbeat the server keeps serialising and
 * writing ~190 KB/s into a socket nobody is reading.
 */
const HEARTBEAT_MS = Number(process.env.SENSOR_HEARTBEAT_MS ?? 15_000);

type Client = {
  readonly socket: WebSocket;
  encoding: Encoding;
  paused: boolean;
  /** Frames per second this client wants; capped by the server tick rate. */
  rateHz: number;
  lastSentAt: number;
  needsSnapshot: boolean;
  /** Cleared before each ping, set again when the client's pong arrives. */
  alive: boolean;
};

const simulator = new SensorSimulator();
const allIndices = simulator.allIndices();
const clients = new Set<Client>();

/**
 * One scratch buffer, sized for a full snapshot, reused for every frame and
 * every client. Frames are written then copied out, so nothing is allocated
 * per tick in the steady state.
 */
const scratch = new ArrayBuffer(frameByteLength(simulator.count));
const scratchView = new DataView(scratch);

let seq = 0;

const server = new WebSocketServer({ port: PORT });

server.on("connection", (socket: WebSocket) => {
  const client: Client = {
    socket,
    encoding: "binary",
    paused: false,
    rateHz: SENSOR_SAMPLE_RATE_HZ,
    lastSentAt: 0,
    needsSnapshot: true,
    alive: true,
  };
  clients.add(client);

  socket.on("pong", () => {
    client.alive = true;
  });

  send(client, {
    type: "hello",
    sensorCount: simulator.count,
    tickMs: TICK_MS,
    sampleRateHz: SENSOR_SAMPLE_RATE_HZ,
    encoding: client.encoding,
    protocolVersion: PROTOCOL_VERSION,
  });

  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    handleControlMessage(client, raw.toString("utf8"));
  });

  socket.on("close", () => {
    clients.delete(client);
  });

  socket.on("error", (error: Error) => {
    console.error("[ws] client error:", error.message);
    clients.delete(client);
  });
});

server.on("listening", () => {
  console.log(
    `[ws] sensor feed on ws://localhost:${PORT} — ` +
      `${simulator.count} sensors, ${SENSOR_SAMPLE_RATE_HZ} Hz, tick ${TICK_MS}ms, ` +
      `heartbeat ${HEARTBEAT_MS}ms`,
  );
});

server.on("error", (error: Error) => {
  console.error("[ws] server error:", error.message);
  process.exitCode = 1;
});

setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      // Missed a full heartbeat window: drop it rather than keep paying to
      // serialise frames for a peer that is gone.
      console.log("[ws] terminating unresponsive client");
      clients.delete(client);
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
}, HEARTBEAT_MS);

setInterval(() => {
  const now = Date.now();
  simulator.tick(now);
  seq++;

  if (clients.size === 0) return;

  // Frames are identical for all clients sharing an encoding, so each encoding
  // is serialised at most once per tick no matter how many clients attach.
  let binaryDelta: ArrayBuffer | null = null;
  let binarySnapshot: ArrayBuffer | null = null;
  let jsonDelta: string | null = null;
  let jsonSnapshot: string | null = null;

  for (const client of clients) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    if (client.paused) continue;

    const minInterval = 1000 / Math.max(1, client.rateHz);
    if (!client.needsSnapshot && now - client.lastSentAt < minInterval - 1) {
      continue;
    }

    const snapshot = client.needsSnapshot;

    if (client.encoding === "binary") {
      if (snapshot) {
        binarySnapshot ??= encodeBinary(FrameKind.Snapshot, now, allIndices, simulator.count);
        client.socket.send(binarySnapshot);
      } else {
        if (simulator.changedCount === 0) continue;
        binaryDelta ??= encodeBinary(
          FrameKind.Delta,
          now,
          simulator.changed,
          simulator.changedCount,
        );
        client.socket.send(binaryDelta);
      }
    } else {
      if (snapshot) {
        jsonSnapshot ??= encodeJsonFrame(
          { kind: FrameKind.Snapshot, seq, timestamp: now, count: simulator.count },
          allIndices,
          simulator.values,
          simulator.statuses,
        );
        client.socket.send(jsonSnapshot);
      } else {
        if (simulator.changedCount === 0) continue;
        jsonDelta ??= encodeJsonFrame(
          { kind: FrameKind.Delta, seq, timestamp: now, count: simulator.changedCount },
          simulator.changed,
          simulator.values,
          simulator.statuses,
        );
        client.socket.send(jsonDelta);
      }
    }

    client.needsSnapshot = false;
    client.lastSentAt = now;
  }
}, TICK_MS);

function encodeBinary(
  kind: typeof FrameKind.Snapshot | typeof FrameKind.Delta,
  timestamp: number,
  indices: Uint16Array,
  count: number,
): ArrayBuffer {
  const byteLength = writeBinaryFrame(
    scratchView,
    { kind, seq, timestamp, count },
    indices,
    simulator.values,
    simulator.statuses,
  );
  // `ws` keeps a reference until the write drains, so hand it a copy rather
  // than the scratch buffer the next tick will overwrite.
  return scratch.slice(0, byteLength);
}

function handleControlMessage(client: Client, text: string): void {
  let message: ClientControlMessage;
  try {
    message = JSON.parse(text) as ClientControlMessage;
  } catch {
    console.warn("[ws] ignoring unparseable control message");
    return;
  }

  switch (message.type) {
    case "setEncoding":
      if (message.encoding !== "binary" && message.encoding !== "json") return;
      client.encoding = message.encoding;
      // Re-send everything: the client resets its decode metrics when the
      // encoding changes, and a snapshot gives the new encoding a clean start.
      client.needsSnapshot = true;
      break;
    case "setPaused":
      client.paused = Boolean(message.paused);
      if (!client.paused) client.needsSnapshot = true;
      break;
    case "setRateHz": {
      const rate = Number(message.rateHz);
      if (!Number.isFinite(rate) || rate <= 0) return;
      client.rateHz = Math.min(SENSOR_SAMPLE_RATE_HZ, Math.max(1, rate));
      break;
    }
    default:
      return;
  }

  send(client, {
    type: "ack",
    encoding: client.encoding,
    paused: client.paused,
    rateHz: client.rateHz,
  });
}

function send(client: Client, message: ServerControlMessage): void {
  if (client.socket.readyState !== client.socket.OPEN) return;
  client.socket.send(JSON.stringify(message));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[ws] ${signal} — closing ${clients.size} client(s)`);
    server.close(() => process.exit(0));
  });
}

if (simulator.count !== SENSOR_COUNT) {
  console.warn(
    `[ws] simulator running with ${simulator.count} sensors, ` +
      `catalog default is ${SENSOR_COUNT}`,
  );
}
