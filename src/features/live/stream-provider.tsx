"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  decodeBinaryFrame,
  decodeJsonFrame,
  isServerControlMessage,
  type ClientControlMessage,
  type Encoding,
  type FrameHeader,
} from "@/lib/protocol";
import { SENSOR_COUNT } from "@/lib/sensors";
import { MetricsStore, type MetricsSnapshot } from "@/features/telemetry/metrics-store";
import { SensorStore } from "./sensor-store";

/**
 * Owns the WebSocket connection and wires it to the two stores.
 *
 * The pipeline per frame is: decode straight into typed arrays, close the
 * frame, then notify React once on the next animation frame. Decoding and
 * rendering are deliberately decoupled — the socket can deliver bursts without
 * forcing a React commit per burst, and a slow commit cannot stall the reader.
 */

const DEFAULT_WS_URL = "ws://localhost:3101";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

export type StreamControls = {
  readonly encoding: Encoding;
  readonly paused: boolean;
  readonly rateHz: number;
  setEncoding: (encoding: Encoding) => void;
  setPaused: (paused: boolean) => void;
  setRateHz: (rateHz: number) => void;
};

type StreamContextValue = {
  readonly sensorStore: SensorStore;
  readonly metricsStore: MetricsStore;
  readonly controls: StreamControls;
};

const StreamContext = createContext<StreamContextValue | null>(null);

export function StreamProvider({
  children,
  url = process.env.NEXT_PUBLIC_SENSOR_WS_URL ?? DEFAULT_WS_URL,
  sensorCount = SENSOR_COUNT,
}: {
  children: ReactNode;
  url?: string;
  sensorCount?: number;
}) {
  // One store instance for the lifetime of the provider. `useState` with an
  // initialiser rather than `useMemo`, which React may discard and recompute.
  const [sensorStore] = useState(() => new SensorStore(sensorCount));
  const [metricsStore] = useState(() => new MetricsStore());

  const [encoding, setEncodingState] = useState<Encoding>("binary");
  const [paused, setPausedState] = useState(false);
  const [rateHz, setRateHzState] = useState(10);

  const socketRef = useRef<WebSocket | null>(null);
  const frameRef = useRef(0);
  const pendingFlushRef = useRef(false);

  /**
   * Current control values, readable from the socket callbacks. The connection
   * effect must not re-run when a control changes — that would tear down a
   * healthy socket — but `onopen` still has to replay the latest values after
   * a reconnect, so they are read through a ref instead of the closure.
   */
  const controlsRef = useRef({ encoding, paused, rateHz });

  useEffect(() => {
    controlsRef.current = { encoding, paused, rateHz };
  }, [encoding, paused, rateHz]);

  /** Queues the single per-paint flush shared by every frame in this tick. */
  const scheduleFlush = useCallback(() => {
    if (pendingFlushRef.current) {
      // A frame already arrived this paint; the queued flush will cover it.
      metricsStore.recordCoalescedFrame();
      return;
    }
    pendingFlushRef.current = true;
  }, [metricsStore]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * The socket this effect instance owns.
     *
     * Tracked locally as well as in the ref because the ref is shared across
     * effect instances: under StrictMode (and on any remount) a second
     * connection exists while the first is still closing, and the first
     * socket's `onclose` would otherwise null out a ref that already points
     * at the newer socket — orphaning it with no way to close it. Cleanup
     * closes this one, whatever the ref happens to hold.
     */
    let active: WebSocket | null = null;

    const sendControl = (message: ClientControlMessage): void => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const handleFrame = (header: FrameHeader, byteLength: number, decodeMs: number): void => {
      sensorStore.commitFrame(header, Date.now());
      metricsStore.recordFrame(byteLength, header.count, decodeMs);
      scheduleFlush();
    };

    const connect = (): void => {
      if (cancelled) return;
      metricsStore.setConnection("connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        metricsStore.setConnection("error");
        scheduleReconnect();
        return;
      }
      socket.binaryType = "arraybuffer";
      active = socket;
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        metricsStore.setConnection("open");
        // Replay the current controls: the server defaults may differ, and on
        // a reconnect the user's choices must survive.
        const current = controlsRef.current;
        sendControl({ type: "setEncoding", encoding: current.encoding });
        sendControl({ type: "setRateHz", rateHz: current.rateHz });
        sendControl({ type: "setPaused", paused: current.paused });
      };

      socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        const started = performance.now();

        if (typeof event.data === "string") {
          const text = event.data;
          // Control messages share the socket with JSON frames; both are
          // objects, so dispatch on the discriminant.
          if (text.startsWith('{"type"')) {
            try {
              const parsed: unknown = JSON.parse(text);
              if (isServerControlMessage(parsed) && parsed.type === "hello") {
                metricsStore.setEncoding(parsed.encoding);
              }
            } catch {
              console.warn("[stream] unparseable control message");
            }
            return;
          }

          try {
            const header = decodeJsonFrame(text, sensorStore.writeSample);
            handleFrame(header, text.length * 2, performance.now() - started);
          } catch (error) {
            console.error("[stream] bad JSON frame:", error);
          }
          return;
        }

        try {
          const header = decodeBinaryFrame(event.data, sensorStore.writeSample);
          handleFrame(header, event.data.byteLength, performance.now() - started);
        } catch (error) {
          // A malformed frame means the store may hold partial data, so drop
          // the connection rather than render something inconsistent.
          console.error("[stream] bad binary frame:", error);
          socket.close();
        }
      };

      socket.onerror = () => {
        metricsStore.setConnection("error");
      };

      socket.onclose = () => {
        // Only clear the shared ref if it still points at *this* socket; a
        // newer connection may already have claimed it.
        if (socketRef.current === socket) socketRef.current = null;
        if (active === socket) active = null;
        if (cancelled) return;
        metricsStore.setConnection("closed");
        sensorStore.markAllStale();
        scheduleReconnect();
      };
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    const tick = (now: number): void => {
      if (pendingFlushRef.current) {
        pendingFlushRef.current = false;
        const started = performance.now();
        sensorStore.flush();
        metricsStore.recordFlush(performance.now() - started);
      }
      metricsStore.recordPaint();
      metricsStore.setSubscriberCount(sensorStore.subscriberCount);
      metricsStore.sample(now);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      cancelAnimationFrame(frameRef.current);

      const socket = active;
      active = null;
      if (socketRef.current === socket) socketRef.current = null;
      if (socket !== null) {
        // Detach first: the close is deliberate, so it must not be mistaken
        // for a dropped connection and trigger a reconnect.
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [url, sensorStore, metricsStore, scheduleFlush]);

  const controls = useMemo<StreamControls>(() => {
    const send = (message: ClientControlMessage): void => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    return {
      encoding,
      paused,
      rateHz,
      setEncoding: (next) => {
        setEncodingState(next);
        metricsStore.setEncoding(next);
        send({ type: "setEncoding", encoding: next });
      },
      setPaused: (next) => {
        setPausedState(next);
        send({ type: "setPaused", paused: next });
      },
      setRateHz: (next) => {
        setRateHzState(next);
        send({ type: "setRateHz", rateHz: next });
      },
    };
  }, [encoding, paused, rateHz, metricsStore]);

  const value = useMemo<StreamContextValue>(
    () => ({ sensorStore, metricsStore, controls }),
    [sensorStore, metricsStore, controls],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

function useStream(): StreamContextValue {
  const context = useContext(StreamContext);
  if (context === null) {
    throw new Error("useStream must be used inside <StreamProvider>");
  }
  return context;
}

export function useSensorStore(): SensorStore {
  return useStream().sensorStore;
}

export function useStreamControls(): StreamControls {
  return useStream().controls;
}

/**
 * Subscribes to one sensor. Returns its revision counter — a primitive, so a
 * frame that did not touch this sensor does not re-render the caller. Read the
 * actual value from the store during render.
 */
export function useSensorRevision(index: number): number {
  const store = useSensorStore();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeSensor(index, listener),
    [store, index],
  );
  const getSnapshot = useCallback(() => store.getRevision(index), [store, index]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAggregate() {
  const store = useSensorStore();
  return useSyncExternalStore(store.subscribeAggregate, store.getAggregate, store.getAggregate);
}

export function useFocusIndex(): number {
  const store = useSensorStore();
  return useSyncExternalStore(store.subscribeFocus, store.getFocusIndex, store.getFocusIndex);
}

/**
 * Counts this component's React commits into the metrics panel. Deliberately
 * an effect with no dependency array: that is precisely "after every commit",
 * which is the quantity the panel reports.
 */
export function useRowCommitCounter(): void {
  const { metricsStore } = useStream();
  useEffect(() => {
    metricsStore.recordRowCommit();
  });
}

export function useMetrics(): MetricsSnapshot {
  const { metricsStore } = useStream();
  return useSyncExternalStore(
    metricsStore.subscribe,
    metricsStore.getSnapshot,
    metricsStore.getSnapshot,
  );
}
