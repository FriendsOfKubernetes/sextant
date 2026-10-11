// Reading core/v1 Events: when they last happened, whether they are warnings, which object they are about.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { get, num, str } = status;

export const EVENT_KIND: KindRef = { group: "", version: "v1", kind: "Event" };

/** Last time the event happened (ms): `lastTimestamp`, else `eventTime`/series, else creation. */
export function eventTime(e: KubeObject): number | undefined {
  const candidates = [
    str(get(e, "lastTimestamp")),
    str(get(e, "series", "lastObservedTime")),
    str(get(e, "eventTime")),
    str(get(e, "firstTimestamp")),
    str(e.metadata?.creationTimestamp),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export function eventTimestamp(e: KubeObject): string | undefined {
  const t = eventTime(e);
  return t === undefined ? undefined : new Date(t).toISOString();
}

/** Newest first. */
export function byNewest(a: KubeObject, b: KubeObject): number {
  return (eventTime(b) ?? 0) - (eventTime(a) ?? 0);
}

export function isWarning(e: KubeObject): boolean {
  return str(get(e, "type")) === "Warning";
}

export function eventCount(e: KubeObject): number {
  return num(get(e, "count")) ?? num(get(e, "series", "count")) ?? 1;
}

/** "kubelet, node-1" — who reported the event. */
export function eventSource(e: KubeObject): string {
  const component = str(get(e, "source", "component")) ?? str(get(e, "reportingComponent"));
  const host = str(get(e, "source", "host"));
  return [component, host].filter(Boolean).join(", ");
}

export interface InvolvedObject {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  fieldPath?: string;
}

export function involvedObject(e: KubeObject): InvolvedObject | undefined {
  const o = get(e, "involvedObject");
  const kind = str(get(o, "kind"));
  const name = str(get(o, "name"));
  if (!kind || !name) return undefined;
  return {
    apiVersion: str(get(o, "apiVersion")) ?? "v1",
    kind,
    name,
    namespace: str(get(o, "namespace")) ?? null,
    fieldPath: str(get(o, "fieldPath")),
  };
}

/**
 * Field selector of the events about one object. Namespaced objects are matched by uid; node events are
 * reported with the node's name as uid, so cluster-scoped objects are matched by kind and name.
 */
export function eventSelectorFor(obj: KubeObject, kind: string): string | null {
  const uid = obj.metadata?.uid;
  const name = obj.metadata?.name;
  if (obj.metadata?.namespace && uid) return `involvedObject.uid=${uid}`;
  if (name) return `involvedObject.kind=${kind},involvedObject.name=${name}`;
  return null;
}
