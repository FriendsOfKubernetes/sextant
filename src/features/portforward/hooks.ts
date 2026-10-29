import { useSyncExternalStore } from "react";
import { api, events, toApiError, type ApiError, type ForwardInfo, type ForwardTarget, type ClusterId } from "../../api";
import { isInternal } from "./model";

export interface PortForwards {
  forwards: ForwardInfo[];
  loaded: boolean;
  error: ApiError | null;
  pending: ReadonlySet<string>;
}

const listeners = new Set<() => void>();
const operations = new Map<string, Promise<unknown>>();
const empty = (): PortForwards => ({ forwards: [], loaded: false, error: null, pending: new Set(operations.keys()) });
let state = empty();
let revision = 0;
let eventRevision = 0;
let disconnect: (() => void) | undefined;

function publish(next: PortForwards) {
  state = next;
  for (const listener of listeners) listener();
}

function connect() {
  let active = true;
  let requestRevision = revision;
  const unlisten = events.onPortForwards((forwards) => {
    if (!active) return;
    revision++;
    eventRevision++;
    publish({ ...state, forwards, loaded: true, error: null });
  });
  const failed = (err: unknown) => {
    if (active && revision === requestRevision) publish({ ...state, loaded: true, error: toApiError(err) });
  };
  void unlisten.then(async () => {
    if (!active) return;
    requestRevision = revision;
    const forwards = await api.portForward.list();
    if (active && revision === requestRevision) publish({ ...state, forwards, loaded: true, error: null });
  }).catch(failed);
  return () => {
    active = false;
    void unlisten.then((stop) => stop()).catch(() => undefined);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) disconnect = connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      disconnect?.();
      disconnect = undefined;
      state = empty();
    }
  };
}

/** One list and event listener while any page, details section or dialog is mounted. No polling or idle cache. */
export function usePortForwards(): PortForwards {
  return useSyncExternalStore(subscribe, () => state);
}

/** A command spanning multiple awaits must consult the latest event snapshot, not a render's closure. */
export function getPortForwards(): PortForwards {
  return state;
}

export async function startForward(cluster: ClusterId, target: ForwardTarget, remote: number, local: number | null) {
  const before = eventRevision;
  const info = await api.portForward.start(cluster, target, remote, local);
  revision++;
  if (listeners.size > 0 && eventRevision === before && !state.forwards.some((f) => f.id === info.id)) {
    publish({ ...state, loaded: true, error: null, forwards: [...state.forwards, info] });
  }
  return info;
}

async function remove(id: string, allowMissing = false) {
  try {
    await api.portForward.stop(id);
  } catch (err) {
    if (!allowMissing || toApiError(err).code !== "notFound") throw err;
  }
  revision++;
  if (listeners.size > 0) publish({ ...state, forwards: state.forwards.filter((f) => f.id !== id) });
}

/** Deduplicate commands across independently mounted surfaces and expose their pending IDs. */
function once<T>(id: string, run: () => Promise<T>): Promise<T> {
  const existing = operations.get(id);
  if (existing) return existing as Promise<T>;
  const task = Promise.resolve().then(run).finally(() => {
    operations.delete(id);
    publish({ ...state, pending: new Set(operations.keys()) });
  });
  operations.set(id, task);
  publish({ ...state, pending: new Set(operations.keys()) });
  return task;
}

export function stopForward(id: string, allowMissing = false): Promise<void> {
  return once(id, () => remove(id, allowMissing));
}

export function restartForward(forward: ForwardInfo): Promise<ForwardInfo> {
  if (isInternal(forward)) return Promise.reject(toApiError({ code: "denied", message: "Internal forwards cannot be restarted here." }));
  return once(forward.id, async () => {
    // Stop waits for the old listener to release its local port, including failed forwards.
    await remove(forward.id, true);
    return startForward(forward.cluster, forward.target, forward.remotePort, forward.localPort);
  });
}
