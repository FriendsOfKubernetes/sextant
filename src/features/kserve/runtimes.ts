// Which serving runtime KServe picks for an InferenceService's predictor, computed as KServe computes it
// (github.com/kserve/kserve, pkg/apis/serving/v1beta1/predictor_model.go `GetSupportingRuntimes`,
// `RuntimeSupportsModel`, `sortServingRuntimeList`, `sortSupportedRuntimeByPriority`; pkg/controller/v1beta1/
// inferenceservice/components/predictor.go and utils.go `GetServingRuntime`):
//   - a runtime named in `model.runtime` is looked up as a ServingRuntime of the namespace, then as a
//     ClusterServingRuntime; it must not be disabled, must speak the model's protocol when the predictor sets one
//     (`reconcileModel` checks `IsProtocolVersionSupported` only when `ProtocolVersion != nil`, then defaults it from
//     the runtime) and list its format;
//   - otherwise the candidates are the namespace's ServingRuntimes, then the ClusterServingRuntimes, each list kept
//     if not disabled, single-model (ModelMesh runtimes only in ModelMesh mode), multi-node exactly when the predictor
//     has a `workerSpec`, speaking the model's protocol (`v1` when not set) and listing the format with `autoSelect`;
//     each list is sorted by its lowest protocol version, then newest first, then by name, then stably by the format's
//     `priority` (higher first; one with a priority before one without); the first candidate is chosen.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import type { ComponentSpec } from "./model";

const { arr, get, num, str } = status;

export interface RuntimeFormat {
  name: string;
  version?: string;
  autoSelect: boolean;
  priority?: number;
}

export const formatsOf = (rt: KubeObject): RuntimeFormat[] =>
  arr(get(rt, "spec", "supportedModelFormats")).map((f) => ({
    name: str(get(f, "name")) ?? "",
    version: str(get(f, "version")),
    autoSelect: get(f, "autoSelect") === true,
    priority: num(get(f, "priority")),
  }));

export const protocolsOf = (rt: KubeObject): string[] => arr(get(rt, "spec", "protocolVersions")).map(String);
export const isDisabled = (rt: KubeObject): boolean => get(rt, "spec", "disabled") === true;
export const isMultiModel = (rt: KubeObject): boolean => get(rt, "spec", "multiModel") === true;
export const isMultiNode = (rt: KubeObject): boolean => get(rt, "spec", "workerSpec") !== undefined && get(rt, "spec", "workerSpec") !== null;

/** `GetProtocolVersionInt`: v1 < v2 < grpc-v1 < grpc-v2 < anything else; a runtime without protocols counts as unknown. */
const PROTOCOL_RANK: Record<string, number> = { v1: 1, v2: 2, "grpc-v1": 3, "grpc-v2": 4 };
const UNKNOWN_RANK = 5;
const protocolRank = (rt: KubeObject): number => {
  const ranks = protocolsOf(rt).map((p) => PROTOCOL_RANK[p] ?? UNKNOWN_RANK);
  return ranks.length === 0 ? UNKNOWN_RANK : Math.min(...ranks);
};

const created = (rt: KubeObject): number => {
  const t = Date.parse(str(rt.metadata?.creationTimestamp) ?? "");
  return Number.isNaN(t) ? 0 : t;
};

/** `sortServingRuntimeList`: lowest protocol version first, then the newest, then by name. */
function sortList(runtimes: KubeObject[]): KubeObject[] {
  return [...runtimes].sort((a, b) => {
    const p = protocolRank(a) - protocolRank(b);
    if (p !== 0) return p;
    const c = created(b) - created(a);
    if (c !== 0) return c;
    const an = a.metadata?.name ?? "";
    const bn = b.metadata?.name ?? "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

const priorityOf = (rt: KubeObject, format: string): number | undefined => formatsOf(rt).find((f) => f.name === format)?.priority;

/** `sortSupportedRuntimeByPriority`: stable; a priority before none; higher first. */
function sortByPriority(runtimes: KubeObject[], format: string): KubeObject[] {
  return runtimes
    .map((rt, i) => ({ rt, i, p: priorityOf(rt, format) }))
    .sort((a, b) => {
      if (a.p === undefined && b.p === undefined) return a.i - b.i;
      if (a.p === undefined) return 1;
      if (b.p === undefined) return -1;
      return b.p - a.p || a.i - b.i;
    })
    .map((x) => x.rt);
}

/** `RuntimeSupportsModel`: the format (and version) among the runtime's labels; only auto-selectable ones unless named. */
export function supportsModel(rt: KubeObject, format: { name: string; version?: string }, named: boolean): boolean {
  const labels = new Set<string>();
  for (const f of formatsOf(rt)) {
    if (!named && !f.autoSelect) continue;
    labels.add(`mt:${f.name}`);
    if (f.version !== undefined) labels.add(`mt:${f.name}:${f.version}`);
  }
  return labels.has(format.version !== undefined ? `mt:${format.name}:${format.version}` : `mt:${format.name}`);
}

/** `IsProtocolVersionSupported`: a runtime without protocols speaks any. */
export const speaks = (rt: KubeObject, protocol: string): boolean => {
  const list = protocolsOf(rt);
  return !protocol || list.length === 0 || list.includes(protocol);
};

export interface RuntimeRef {
  name: string;
  cluster: boolean;
}

export type Choice =
  | { kind: "chosen"; runtime: RuntimeRef; named: boolean; candidates: RuntimeRef[] }
  | { kind: "none"; candidates: [] }
  | { kind: "namedMissing" | "namedDisabled" | "namedProtocol" | "namedFormat"; runtime: RuntimeRef | { name: string; cluster?: undefined } }
  | { kind: "noFormat" };

/**
 * The runtime KServe would choose now for `predictor` from `namespaced` (ServingRuntimes of the InferenceService's
 * namespace) and `clusterWide` (ClusterServingRuntimes). `modelMesh`: the deployment mode is ModelMesh.
 */
export function chooseRuntime(predictor: ComponentSpec, namespaced: KubeObject[], clusterWide: KubeObject[], modelMesh = false): Choice {
  const format = predictor.format;
  if (!format) return { kind: "noFormat" };
  if (predictor.runtime) {
    const name = predictor.runtime;
    const local = namespaced.find((r) => r.metadata?.name === name);
    const global = local ? undefined : clusterWide.find((r) => r.metadata?.name === name);
    const rt = local ?? global;
    if (!rt) return { kind: "namedMissing", runtime: { name } };
    const ref = { name, cluster: !local };
    if (isDisabled(rt)) return { kind: "namedDisabled", runtime: ref };
    if (predictor.protocolVersion && !speaks(rt, predictor.protocolVersion)) return { kind: "namedProtocol", runtime: ref };
    if (!supportsModel(rt, format, true)) return { kind: "namedFormat", runtime: ref };
    return { kind: "chosen", runtime: ref, named: true, candidates: [ref] };
  }
  // Auto-selection: `GetSupportingRuntimes` asks for the predictor's protocol, `v1` when it sets none.
  const protocol = predictor.protocolVersion ?? "v1";
  const fits = (rt: KubeObject) =>
    !isDisabled(rt) && isMultiModel(rt) === modelMesh && supportsModel(rt, format, false) && speaks(rt, protocol) && isMultiNode(rt) === predictor.workers;
  const local = sortByPriority(sortList(namespaced).filter(fits), format.name).map((r) => ({ name: r.metadata?.name ?? "", cluster: false }));
  const global = sortByPriority(sortList(clusterWide).filter(fits), format.name).map((r) => ({ name: r.metadata?.name ?? "", cluster: true }));
  const candidates = [...local, ...global];
  if (candidates.length === 0) return { kind: "none", candidates: [] };
  return { kind: "chosen", runtime: candidates[0]!, named: false, candidates };
}
