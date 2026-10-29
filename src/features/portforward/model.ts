// What can be forwarded and how it is addressed. No React here.
import type { ForwardInfo, ForwardTarget, KindRef, KubeObject, ObjectRef } from "../../api";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

export const PORT_FORWARD_PAGE = "portforward";

/** Internal connections must not be stopped as part of a bulk user action. */
export function isInternal(forward: ForwardInfo): boolean {
  return forward.source === "vcluster" || forward.source === "argoCd";
}

/** Pods and Services of the core group are the only things that can be forwarded to. */
export function isForwardable(kind: KindRef): boolean {
  return kind.group === "" && (kind.kind === "Pod" || kind.kind === "Service");
}

/**
 * The TCP ports an object offers: container ports of a pod, ports of a service (the service port, not its
 * `targetPort`). Sorted and without duplicates.
 */
export function portsOf(obj: KubeObject, kind: KindRef): number[] {
  if (!isForwardable(kind)) return [];
  const spec = isRecord(obj.spec) ? obj.spec : {};
  const entries =
    kind.kind === "Pod"
      ? list(spec.containers).flatMap((c) => list(c.ports).map((p) => ({ port: p.containerPort, protocol: p.protocol })))
      : list(spec.ports).map((p) => ({ port: p.port, protocol: p.protocol }));
  const ports = entries
    .filter((e) => (e.protocol ?? "TCP") === "TCP")
    .map((e) => e.port)
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535);
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function targetOf(ref: ObjectRef): ForwardTarget {
  const namespace = ref.namespace ?? "";
  return ref.kind.kind === "Service" ? { type: "service", namespace, name: ref.name } : { type: "pod", namespace, name: ref.name };
}

export function sameTarget(a: ForwardTarget, b: ForwardTarget): boolean {
  return a.type === b.type && a.namespace === b.namespace && a.name === b.name;
}

/** "demo/web" */
export function targetName(target: ForwardTarget): string {
  return `${target.namespace}/${target.name}`;
}

/** How a browser talks to the forwarded port: plain HTTP, or HTTPS for a server with its own TLS (argocd-server). */
export type UrlScheme = "http" | "https";

/** The address a browser opens for a forward. */
export function urlOf(forward: Pick<ForwardInfo, "localPort">, scheme: UrlScheme = "http"): string {
  return `${scheme}://localhost:${forward.localPort}`;
}

/** A valid local port typed by the user (1–65535), or `null`. */
export function parseLocalPort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}
