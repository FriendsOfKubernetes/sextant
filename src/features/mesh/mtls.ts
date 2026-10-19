// The mTLS mode of a workload from Istio's PeerAuthentications (#155), by Istio's precedence:
//   a policy with a workload selector in the workload's namespace (the oldest of several)
//   > the namespace-wide policy (no selector) of the namespace
//   > the mesh-wide policy (no selector) of the root namespace
//   > PERMISSIVE (Istio's default).
// A mode left UNSET (or missing) inherits from the level above; `portLevelMtls` (only on a policy with a selector)
// overrides the mode for the listed container ports. A selector policy in the root namespace applies to the root
// namespace's own workloads only.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { olderFirst, refOf, ROOT_NAMESPACE, type Ref } from "./istio";
import { PEER_AUTHENTICATION } from "./kinds";

const { get, record, str } = status;

export type MtlsMode = "STRICT" | "PERMISSIVE" | "DISABLE";

export interface PeerAuthInfo {
  obj: KubeObject;
  ref: Ref;
  namespace: string;
  /** `matchLabels`; `undefined` for a namespace- or mesh-wide policy. */
  selector?: Record<string, string>;
  /** `undefined` for UNSET or missing (inherits). */
  mode?: MtlsMode;
  ports: { port: number; mode?: MtlsMode }[];
}

function modeOf(value: unknown): MtlsMode | undefined {
  const mode = str(value);
  return mode === "STRICT" || mode === "PERMISSIVE" || mode === "DISABLE" ? mode : undefined;
}

export function parsePeerAuthentication(obj: KubeObject): PeerAuthInfo {
  const labels = record(get(obj, "spec", "selector", "matchLabels"));
  return {
    obj,
    ref: refOf(PEER_AUTHENTICATION, obj),
    namespace: obj.metadata?.namespace ?? "",
    selector: Object.keys(labels).length > 0 ? Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, String(v)])) : undefined,
    mode: modeOf(get(obj, "spec", "mtls", "mode")),
    ports: Object.entries(record(get(obj, "spec", "portLevelMtls"))).flatMap(([port, v]) => {
      const n = Number(port);
      return Number.isInteger(n) ? [{ port: n, mode: modeOf(get(v, "mode")) }] : [];
    }),
  };
}

export type MtlsSource = "workload" | "namespace" | "mesh" | "default";

export interface MtlsResult {
  mode: MtlsMode;
  source: MtlsSource;
  /** The policy that set the mode. */
  policy?: Ref;
  /** The policies of each level that apply (the mode may come from a higher one). */
  workload?: Ref;
  namespace?: Ref;
  mesh?: Ref;
  ports: { port: number; mode: MtlsMode }[];
}

const selects = (selector: Record<string, string>, labels: Record<string, string>) =>
  Object.entries(selector).every(([k, v]) => labels[k] === v);

/** The mTLS mode of a workload in `namespace` with `labels`. */
export function mtlsModeFor(
  namespace: string,
  labels: Record<string, string>,
  policies: readonly PeerAuthInfo[],
  rootNamespace = ROOT_NAMESPACE,
): MtlsResult {
  const oldest = (list: PeerAuthInfo[]) => list.sort(olderFirst)[0];
  const mesh = oldest(policies.filter((p) => p.namespace === rootNamespace && !p.selector));
  const ns = namespace === rootNamespace ? undefined : oldest(policies.filter((p) => p.namespace === namespace && !p.selector));
  const workload = oldest(policies.filter((p) => p.namespace === namespace && p.selector && selects(p.selector, labels)));
  let mode: MtlsMode = "PERMISSIVE";
  let source: MtlsSource = "default";
  let policy: Ref | undefined;
  for (const [level, p] of [
    ["mesh", mesh],
    ["namespace", ns],
    ["workload", workload],
  ] as const) {
    if (p?.mode) {
      mode = p.mode;
      source = level;
      policy = p.ref;
    }
  }
  return {
    mode,
    source,
    policy,
    workload: workload?.ref,
    namespace: ns?.ref,
    mesh: mesh?.ref,
    ports: (workload?.ports ?? []).map((p) => ({ port: p.port, mode: p.mode ?? mode })),
  };
}
