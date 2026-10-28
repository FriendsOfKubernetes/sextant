// The cluster's Loki (found or named in the cluster settings) and reads of lines from it through `openStream`.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  openStream,
  toApiError,
  useSettings,
  type ApiError,
  type ClusterId,
  type LokiEntry,
  type LokiLogsQuery,
  type LokiSettings,
  type LokiStatus,
  type LokiUpdate,
} from "../../../api";
import { capText, withPage } from "./model";

/** How long a status answer is reused by every view of the cluster. */
const STATUS_TTL_MS = 60_000;

const statuses = new Map<string, { at: number; answer: Promise<LokiStatus> }>();

/** The cluster's Loki settings (`ClusterSettings.loki`), `null` while the settings load. */
export function useLokiSettings(clusterId: ClusterId): LokiSettings | null | undefined {
  const { settings, error } = useSettings();
  if (!settings && !error) return undefined;
  return settings?.clusters[clusterId]?.loki ?? null;
}

/** Forgets the remembered answers (tests, and after the settings change). */
export function resetLokiStatuses(): void {
  statuses.clear();
}

export interface LokiStatusState {
  status?: LokiStatus;
  error?: ApiError;
  loading: boolean;
}

/** Whether the cluster has a Loki; asked again when its Loki settings change (an answer is shared for a minute). */
export function useLokiStatus(clusterId: ClusterId, enabled = true): LokiStatusState {
  const settings = useLokiSettings(clusterId);
  const key = !enabled || settings === undefined ? null : `${clusterId}\u0000${JSON.stringify(settings)}`;
  const [state, setState] = useState<{ key: string | null; value: LokiStatusState }>({ key: null, value: { loading: true } });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const now = Date.now();
    let entry = statuses.get(key);
    if (!entry || now - entry.at > STATUS_TTL_MS) {
      entry = { at: now, answer: api.loki.status(clusterId) };
      statuses.set(key, entry);
      // A failed answer is not reused.
      entry.answer.catch(() => statuses.delete(key));
    }
    entry.answer.then(
      (status) => live && setState({ key, value: { status, loading: false } }),
      (err: unknown) => live && setState({ key, value: { error: toApiError(err), loading: false } }),
    );
    return () => {
      live = false;
    };
  }, [key, clusterId]);
  return state.key === key ? state.value : { loading: true };
}

export type LokiReadStatus = "idle" | "loading" | "done" | "error";

export interface LokiReadState {
  entries: LokiEntry[];
  status: LokiReadStatus;
  error?: ApiError;
  /** The read stopped at its line limit while Loki had more. */
  truncated: boolean;
  /** Lines left out to stay within the text limit. */
  dropped: number;
  /** Changes with every new read. */
  generation: number;
}

const IDLE: LokiReadState = { entries: [], status: "idle", truncated: false, dropped: 0, generation: 0 };

export interface UseLokiRead extends LokiReadState {
  load: (clusterId: ClusterId, query: LokiLogsQuery) => void;
  /** Stops a running read and keeps what came. */
  cancel: () => void;
  /** Stops a running read and forgets its lines. */
  clear: () => void;
}

/** One read at a time; a new one replaces the last; unmounting stops it. */
export function useLokiRead(): UseLokiRead {
  const [state, setState] = useState<LokiReadState>(IDLE);
  const stopRef = useRef<(() => void) | null>(null);
  const generation = useRef(0);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const load = useCallback(
    (clusterId: ClusterId, query: LokiLogsQuery) => {
      stop();
      const own = ++generation.current;
      setState({ ...IDLE, status: "loading", generation: own });
      const update = (fn: (s: LokiReadState) => LokiReadState) =>
        setState((s) => (s.generation === own ? fn(s) : s));
      stopRef.current = openStream<LokiUpdate>({
        start: (id, channel) => api.loki.start(clusterId, query, id, channel),
        stop: api.loki.stop,
        onEvent: (u) => {
          switch (u.type) {
            case "entries":
              update((s) => {
                const merged = capText(withPage(s.entries, u.entries, query.direction), query.direction);
                return { ...s, entries: merged.entries, dropped: s.dropped + merged.dropped };
              });
              break;
            case "ended":
              update((s) => ({ ...s, status: s.status === "error" ? s.status : "done", truncated: u.truncated }));
              break;
            case "error":
              update((s) => ({ ...s, status: "error", error: toApiError(u) }));
              break;
          }
        },
        onStartError: (err) => update((s) => ({ ...s, status: "error", error: toApiError(err) })),
      });
    },
    [stop],
  );

  const cancel = useCallback(() => {
    stop();
    setState((s) => (s.status === "loading" ? { ...s, status: "done" } : s));
  }, [stop]);

  const clear = useCallback(() => {
    stop();
    generation.current++;
    setState({ ...IDLE, generation: generation.current });
  }, [stop]);

  return { ...state, load, cancel, clear };
}
