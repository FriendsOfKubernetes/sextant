// Pure parts of the "Requests" details section (#212): which target a details object is, how values read, and when
// CPU throttling points at the CPU limit. The numbers come from the core (`metrics_request_health`), which builds every
// query itself; nothing here becomes a query.
import type { TFunction } from "i18next";
import type { ContainerThrottling, KubeObject, ObjectRef, RequestSourceKind, RequestTarget } from "../../api";
import { formatNumber } from "../../i18n";
import type { ContainerAmounts } from "../metrics/requests";
import { containerAmountsOf } from "../rightsizing/group";
import { THROTTLED_SHARE } from "../rightsizing/recommend";

/** The workload kinds whose pods the core can name (`HISTORY_WORKLOAD_KINDS`). */
export const WORKLOAD_KINDS: ReadonlySet<string> = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/** The section applies to these kinds. */
export function requestHealthApplies(kind: { group: string; kind: string }): boolean {
  if (kind.group === "") return kind.kind === "Pod";
  return kind.group === "apps" && WORKLOAD_KINDS.has(kind.kind);
}

/** The target of a details object; `null` without a namespace or for another kind. */
export function targetOf(ref: ObjectRef): RequestTarget | null {
  const namespace = ref.namespace;
  if (!namespace) return null;
  if (ref.kind.group === "" && ref.kind.kind === "Pod") return { type: "pod", namespace, name: ref.name };
  if (ref.kind.group === "apps" && WORKLOAD_KINDS.has(ref.kind.kind))
    return { type: "workload", namespace, kind: ref.kind.kind, name: ref.name };
  return null;
}

/** The i18n key part of a source (`requesthealth:source.<key>`). */
export const SOURCE_KEY: Record<RequestSourceKind, string> = {
  istio: "istio",
  linkerd: "linkerd",
  ingressNginx: "ingressNginx",
  beyla: "beyla",
  hubble: "hubble",
};

/** Requests per second: two decimals below 10, one below 100, none above. */
export function formatRate(t: TFunction, value: number): string {
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return t("requesthealth:value.rate", { value: formatNumber(value, digits) });
}

/** A share (0–1) as a percentage: two decimals below 1 %, one above. */
export function formatShare(t: TFunction, share: number, key = "requesthealth:value.percent"): string {
  const percent = share * 100;
  const digits = percent === 0 ? 0 : percent < 1 ? 2 : 1;
  return t(key, { value: formatNumber(percent, digits) });
}

/** Milliseconds; a second or more in seconds. `null` reads "unknown". */
export function formatLatency(t: TFunction, ms: number | null): string {
  if (ms === null) return t("requesthealth:value.unknown");
  if (ms >= 1000) return t("requesthealth:value.seconds", { value: formatNumber(ms / 1000, 2) });
  return t("requesthealth:value.ms", { value: formatNumber(ms, ms < 10 ? 1 : 0) });
}

/** Requests and limits per container: a pod's own, a workload's pod template's. */
export function containerAmounts(obj: KubeObject | null, isPod: boolean): Map<string, ContainerAmounts> {
  if (!obj) return new Map();
  if (isPod) return containerAmountsOf(obj);
  const spec = obj.spec as { template?: { spec?: unknown } } | undefined;
  return containerAmountsOf({ spec: spec?.template?.spec ?? {} } as KubeObject);
}

export interface ThrottleRow {
  container: string;
  ratio: number;
  /** The container's CPU limit (millicores) when it has one. */
  limit?: number;
  /** Throttled at least as much as right-sizing calls throttled, with a CPU limit set: the limit is the likely cause. */
  limitIsCause: boolean;
}

/** The containers' throttling against their CPU limits (CFS throttling happens only under a CPU limit). */
export function throttleRows(list: ContainerThrottling[], amounts: Map<string, ContainerAmounts>): ThrottleRow[] {
  return list.map(({ container, throttledRatio }) => {
    const limit = amounts.get(container)?.cpu.limit;
    return {
      container,
      ratio: throttledRatio,
      limit,
      limitIsCause: limit !== undefined && throttledRatio >= THROTTLED_SHARE,
    };
  });
}
