// What the NVIDIA GPU Operator extension reads (ADR-0116), from the operator's own types and manifests
// (github.com/NVIDIA/gpu-operator) — Sextant's former built-in model, ported unchanged:
//
//   ClusterPolicy (nvidia.com/v1, api/nvidia/v1/clusterpolicy_types.go): `status.state` ready / notReady / ignored /
//     disabled, `status.namespace` (where the operands run) and `status.conditions` (Ready, Error); one spec block per
//     component with `enabled`, each defaulting as its `IsEnabled()` does; `spec.mig.strategy` none / single / mixed;
//   NVIDIADriver (nvidia.com/v1alpha1, api/nvidia/v1alpha1/nvidiadriver_types.go): the same status; its DaemonSets are
//     owned by it (internal/state/driver.go names them per OS and hash), so they are found by owner, not by name;
//   the component DaemonSets: `metadata.name` of each `assets/state-*/…daemonset.yaml`; the driver's gets a suffix
//     per kernel and OS for precompiled drivers and per RHCOS version on OpenShift (controllers/object_controls.go
//     `transformPrecompiledDriverDaemonset`, `transformOpenShiftDriverToolkitContainer`), so it is matched by prefix;
//   node labels the operator, GPU Feature Discovery and the MIG manager write: `nvidia.com/gpu.present`,
//     `gpu.product`, `gpu.count`, `gpu.memory`, `mig.config`, `mig.config.state` (pending, rebooting, success, failed);
//   node capacity and allocatable: `nvidia.com/gpu` and, with the mixed MIG strategy, `nvidia.com/mig-<profile>`.
// Pure functions. Read-only. The problem detector at the end (`gpuProblems`) is the former built-in one, kept as the
// reference the manifest's rules are tested against.
import type { KubeObject, UiTone } from "@sextant/extension-sdk";

export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

export const NVIDIA_GROUP = "nvidia.com";
export const CLUSTER_POLICY: KindOf = { group: NVIDIA_GROUP, version: "v1", kind: "ClusterPolicy" };
export const NVIDIA_DRIVER: KindOf = { group: NVIDIA_GROUP, version: "v1alpha1", kind: "NVIDIADriver" };
export const DAEMONSET: KindOf = { group: "apps", version: "v1", kind: "DaemonSet" };
export const NODE: KindOf = { group: "", version: "v1", kind: "Node" };

export const isKind = (a: { group: string; kind: string }, b: { group: string; kind: string }): boolean => a.group === b.group && a.kind === b.kind;

// ---------- Field access ----------

export const get = (value: unknown, ...path: (string | number)[]): unknown => {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// ---------- State ----------

export type OperatorState = "ready" | "notReady" | "ignored" | "disabled" | "unknown";
export const OPERATOR_STATES: OperatorState[] = ["ready", "notReady", "ignored", "disabled", "unknown"];

export const STATE_TONE: Record<OperatorState, UiTone> = {
  ready: "success",
  notReady: "warning",
  ignored: "muted",
  disabled: "muted",
  unknown: "muted",
};

export function stateOf(obj: KubeObject): OperatorState {
  const s = str(get(obj, "status", "state"));
  return s === "ready" || s === "notReady" || s === "ignored" || s === "disabled" ? s : "unknown";
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export function conditionOf(obj: KubeObject, type: string): Condition | undefined {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === type);
  if (!c) return undefined;
  return {
    type,
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")) || undefined,
    message: str(get(c, "message")) || undefined,
    since: str(get(c, "lastTransitionTime")),
  };
}

/** Why it is not ready, in the operator's words: the Error condition when True, else a False Ready condition. */
export function failureOf(obj: KubeObject): Condition | undefined {
  const error = conditionOf(obj, "Error");
  if (error?.status === "True") return error;
  const ready = conditionOf(obj, "Ready");
  return ready?.status === "False" ? ready : undefined;
}

/** The namespace the operands run in (`status.namespace`). */
export const operandNamespaceOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "namespace")) || undefined;

// ---------- Components ----------

export interface ComponentDef {
  /** Key under `component.` and the spec field. */
  id: string;
  /** The spec field when it is not the id. */
  field?: string;
  /** The DaemonSet's name in the operator's manifests. */
  daemonSet: string;
  /** The name gets suffixes (the driver's per kernel/OS). */
  prefix?: boolean;
  /** What `IsEnabled()` answers when `enabled` is not set; `always` has no switch (the validator). */
  defaultEnabled: boolean | "always";
  /** Only where `sandboxWorkloads.enabled` is true. */
  sandbox?: boolean;
  /**
   * Only in this `sandboxWorkloads.mode`, when the policy names one (the CRD defaults it to `kubevirt`; a ClusterPolicy
   * of an operator from before the field names none, and that operator does not look at a mode).
   */
  mode?: "kubevirt" | "kata";
  /**
   * No current operator deploys it (`isStateEnabled` answers false whatever the policy says): never counted as on,
   * shown only while a DaemonSet an older operator made is left, in that DaemonSet's state.
   */
  retired?: boolean;
}

export const COMPONENTS: ComponentDef[] = [
  { id: "driver", daemonSet: "nvidia-driver-daemonset", prefix: true, defaultEnabled: true },
  { id: "toolkit", daemonSet: "nvidia-container-toolkit-daemonset", defaultEnabled: true },
  { id: "devicePlugin", daemonSet: "nvidia-device-plugin-daemonset", defaultEnabled: true },
  { id: "dcgm", daemonSet: "nvidia-dcgm", defaultEnabled: true },
  { id: "dcgmExporter", daemonSet: "nvidia-dcgm-exporter", defaultEnabled: true },
  { id: "gfd", daemonSet: "gpu-feature-discovery", defaultEnabled: true },
  { id: "migManager", daemonSet: "nvidia-mig-manager", defaultEnabled: true },
  { id: "nodeStatusExporter", daemonSet: "nvidia-node-status-exporter", defaultEnabled: false },
  { id: "validator", daemonSet: "nvidia-operator-validator", defaultEnabled: "always" },
  { id: "vgpuManager", daemonSet: "nvidia-vgpu-manager-daemonset", defaultEnabled: false, sandbox: true },
  { id: "vgpuDeviceManager", daemonSet: "nvidia-vgpu-device-manager", defaultEnabled: false, sandbox: true },
  { id: "vfioManager", daemonSet: "nvidia-vfio-manager", defaultEnabled: false, sandbox: true },
  // `isStateEnabled` in controllers/state_manager.go (v26.7.2): the sandbox device plugin in `kubevirt` mode, the Kata
  // one and the CC manager in `kata` mode.
  { id: "sandboxDevicePlugin", daemonSet: "nvidia-sandbox-device-plugin-daemonset", defaultEnabled: false, sandbox: true, mode: "kubevirt" },
  // assets/state-kata-device-plugin/0500_daemonset.yaml; `KataDevicePluginSpec.IsEnabled` is false when not set.
  { id: "kataSandboxDevicePlugin", daemonSet: "nvidia-kata-sandbox-device-plugin-daemonset", defaultEnabled: false, sandbox: true, mode: "kata" },
  // assets/state-sandbox-validation/0500_daemonset.yaml; `isStateEnabled` runs it whenever sandbox workloads are on.
  { id: "sandboxValidator", daemonSet: "nvidia-sandbox-validator", defaultEnabled: "always", sandbox: true },
  // `isStateEnabled("state-kata-manager")` returns false: the Kata manager "stands deprecated" (#260).
  { id: "kataManager", daemonSet: "nvidia-kata-manager", defaultEnabled: false, sandbox: true, retired: true },
  { id: "ccManager", daemonSet: "nvidia-cc-manager", defaultEnabled: false, sandbox: true, mode: "kata" },
];

/** Whether the ClusterPolicy turns a component on, as the component's `IsEnabled()` does. */
export function isEnabled(policy: KubeObject, def: ComponentDef): boolean {
  if (def.retired) return false;
  if (def.sandbox && get(policy, "spec", "sandboxWorkloads", "enabled") !== true) return false;
  const mode = get(policy, "spec", "sandboxWorkloads", "mode");
  if (def.mode && typeof mode === "string" && mode !== def.mode) return false;
  if (def.defaultEnabled === "always") return true;
  const value = get(policy, "spec", def.field ?? def.id, "enabled");
  return typeof value === "boolean" ? value : def.defaultEnabled;
}

/** The driver is managed by NVIDIADriver objects, not by the ClusterPolicy (`driver.useNvidiaDriverCRD`). */
export const driverByCrd = (policy: KubeObject): boolean => get(policy, "spec", "driver", "useNvidiaDriverCRD") === true;

/** Whether `name` is the DaemonSet of `def`. */
export const isComponentDaemonSet = (def: ComponentDef, name: string): boolean =>
  name === def.daemonSet || (def.prefix === true && name.startsWith(`${def.daemonSet}-`));

export interface Rollout {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  updated: number;
  available: number;
}

export function rolloutOf(ds: KubeObject): Rollout {
  const n = (field: string) => num(get(ds, "status", field)) ?? 0;
  return {
    name: ds.metadata.name ?? "",
    namespace: ds.metadata.namespace ?? "",
    desired: n("desiredNumberScheduled"),
    ready: n("numberReady"),
    updated: n("updatedNumberScheduled"),
    available: n("numberAvailable"),
  };
}

/** Rolled out: every scheduled pod ready and updated (a DaemonSet that schedules no pod is rolled out too). */
export const isRolledOut = (r: Rollout): boolean => r.ready >= r.desired && r.updated >= r.desired;

// ---------- MIG ----------

/**
 * `spec.mig.strategy`: none, single or mixed; `undefined` when not set, which leaves it to the device plugin and GFD
 * (their default is none; controllers/object_controls.go `applyMIGConfiguration`).
 */
export const migStrategyOf = (policy: KubeObject): string | undefined => str(get(policy, "spec", "mig", "strategy")) || undefined;

// ---------- Nodes ----------

export const LABEL_PRESENT = "nvidia.com/gpu.present";
export const LABEL_PRODUCT = "nvidia.com/gpu.product";
export const LABEL_COUNT = "nvidia.com/gpu.count";
export const LABEL_MEMORY = "nvidia.com/gpu.memory";
export const LABEL_MIG_CONFIG = "nvidia.com/mig.config";
export const LABEL_MIG_STATE = "nvidia.com/mig.config.state";
export const GPU_RESOURCE = "nvidia.com/gpu";
export const MIG_PREFIX = "nvidia.com/mig-";

export interface GpuAmount {
  resource: string;
  capacity?: string;
  allocatable?: string;
}

export interface GpuNode {
  name: string;
  present: boolean;
  product?: string;
  count?: string;
  /** Memory per GPU in MiB, as GFD labels it. */
  memory?: string;
  migConfig?: string;
  migState?: string;
  /** `nvidia.com/gpu` and the MIG resources, capacity and allocatable, `nvidia.com/gpu` first. */
  amounts: GpuAmount[];
}

const labelOf = (node: KubeObject, key: string): string | undefined => str(record(get(node, "metadata", "labels"))[key]) || undefined;

export function gpuNodeOf(node: KubeObject): GpuNode {
  const capacity = record(get(node, "status", "capacity"));
  const allocatable = record(get(node, "status", "allocatable"));
  const names = [...new Set([...Object.keys(capacity), ...Object.keys(allocatable)])]
    .filter((r) => r === GPU_RESOURCE || r.startsWith(MIG_PREFIX))
    .sort((a, b) => (a === GPU_RESOURCE ? -1 : b === GPU_RESOURCE ? 1 : a.localeCompare(b)));
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
  const out: GpuNode = {
    name: node.metadata.name ?? "",
    present: labelOf(node, LABEL_PRESENT) === "true",
    amounts: names.map((resource) => {
      const c = text(capacity[resource]);
      const a = text(allocatable[resource]);
      return { resource, ...(c !== undefined ? { capacity: c } : {}), ...(a !== undefined ? { allocatable: a } : {}) };
    }),
  };
  const set = (field: "product" | "count" | "memory" | "migConfig" | "migState", key: string) => {
    const v = labelOf(node, key);
    if (v) out[field] = v;
  };
  set("product", LABEL_PRODUCT);
  set("count", LABEL_COUNT);
  set("memory", LABEL_MEMORY);
  set("migConfig", LABEL_MIG_CONFIG);
  set("migState", LABEL_MIG_STATE);
  return out;
}

/** Whether a node shows anything of NVIDIA GPUs (labels or resources). */
export const hasGpu = (n: GpuNode): boolean => n.present || n.amounts.length > 0 || Boolean(n.product || n.migConfig || n.migState);

export const MIG_STATE_TONE: Record<string, UiTone> = { success: "success", pending: "warning", rebooting: "warning", failed: "danger" };
export const migStateTone = (state: string | undefined): UiTone => (state ? (MIG_STATE_TONE[state] ?? "neutral") : "muted");

// ---------- Components against their DaemonSets ----------

/** `off`: not enabled; `managedByDriver`: the driver comes from NVIDIADriver objects; `missing`: enabled, no DaemonSet. */
export type ComponentState = "ready" | "rollingOut" | "missing" | "off" | "managedByDriver";
export const COMPONENT_STATES: ComponentState[] = ["ready", "rollingOut", "missing", "off", "managedByDriver"];

export const COMPONENT_TONE: Record<ComponentState, UiTone> = {
  ready: "success",
  rollingOut: "warning",
  missing: "warning",
  off: "muted",
  managedByDriver: "muted",
};

export interface ComponentRow {
  def: ComponentDef;
  enabled: boolean;
  state: ComponentState;
  daemonSets: Rollout[];
}

/** Each component of a ClusterPolicy with its DaemonSets among `daemonSets` (those of the operand namespace). */
export function componentsOf(policy: KubeObject, daemonSets: readonly KubeObject[]): ComponentRow[] {
  const rollouts = daemonSets.map(rolloutOf);
  return COMPONENTS.map((def) => {
    const enabled = isEnabled(policy, def);
    const own = rollouts.filter((r) => isComponentDaemonSet(def, r.name)).sort((a, b) => a.name.localeCompare(b.name));
    let state: ComponentState;
    if (def.id === "driver" && enabled && driverByCrd(policy)) state = "managedByDriver";
    else if (def.retired && own.length > 0) state = own.every(isRolledOut) ? "ready" : "rollingOut";
    else if (!enabled) state = "off";
    else if (own.length === 0) state = "missing";
    else state = own.every(isRolledOut) ? "ready" : "rollingOut";
    return { def, enabled, state, daemonSets: own };
  });
}

/** Whether a component row is worth showing: on, or off with a DaemonSet left (sandbox ones only when on). */
export const shownComponent = (row: ComponentRow): boolean => row.enabled || row.daemonSets.length > 0 || !row.def.sandbox;

/** The DaemonSets an NVIDIADriver owns (by its uid). */
export function ownedDaemonSets(driver: KubeObject, daemonSets: readonly KubeObject[]): Rollout[] {
  const uid = driver.metadata.uid;
  if (!uid) return [];
  return daemonSets
    .filter((ds) => arr(get(ds, "metadata", "ownerReferences")).some((o) => str(get(o, "uid")) === uid))
    .map(rolloutOf)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const driverTypeOf = (driver: KubeObject): string => str(get(driver, "spec", "driverType")) || "gpu";
export const driverVersionOf = (driver: KubeObject): string | undefined => str(get(driver, "spec", "version")) || undefined;
export const driverNodeSelectorOf = (driver: KubeObject): Record<string, string> =>
  Object.fromEntries(Object.entries(record(get(driver, "spec", "nodeSelector"))).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));

// ---------- The former built-in problems (the reference) ----------

/** The built-in category's graces. */
export const NOT_READY_GRACE_MS = 10 * 60_000;
export const ROLLOUT_GRACE_MS = 10 * 60_000;
export const MIG_GRACE_MS = 2 * 60_000;
export const MIG_FAILED_SELECTOR = `${LABEL_MIG_STATE}=failed`;

/** A problem as the built-in provider found it (`toProblems`), with the problem's object. */
export interface BuiltInProblem {
  object: { kind: string; name: string };
  reason: "NotReady" | "ComponentNotReady" | "MigConfigFailed";
  /** The operator's message, else the English text of the built-in message key with its parameters. */
  message: string;
  /** For a component: the DaemonSet. */
  daemonSet?: string;
  since?: string;
  /** When it starts to count: the start (else first seen) plus the grace. */
  activeAt: number;
}

const time = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * The built-in category's problems (`provider.ts` `toProblems`), every one first seen at `firstSeen`: ClusterPolicies
 * and NVIDIADrivers not ready, their components' DaemonSets in the operand namespace not rolled out, nodes whose MIG
 * configuration failed. English messages.
 */
export function gpuProblems(
  input: { policies: KubeObject[]; drivers: KubeObject[]; daemonSets: KubeObject[]; failedNodes: KubeObject[] },
  firstSeen: number,
): BuiltInProblem[] {
  const out: BuiltInProblem[] = [];
  const judge = (obj: KubeObject, rollouts: (ds: KubeObject[]) => Rollout[]) => {
    if (obj.metadata.deletionTimestamp) return;
    const state = stateOf(obj);
    if (state === "ignored" || state === "disabled") return;
    const object = { kind: obj.kind ?? "", name: obj.metadata.name ?? "" };
    if (state === "notReady") {
      const ready = conditionOf(obj, "Ready");
      const failure = failureOf(obj);
      out.push({
        object,
        reason: "NotReady",
        message: failure?.message ?? "The NVIDIA GPU Operator reports it not ready.",
        ...(ready?.since ? { since: ready.since } : {}),
        activeAt: ((ready?.status === "False" ? time(ready.since) : undefined) ?? firstSeen) + NOT_READY_GRACE_MS,
      });
    }
    const namespace = operandNamespaceOf(obj);
    if (!namespace) return;
    const inNamespace = input.daemonSets.filter((d) => d.metadata.namespace === namespace);
    for (const r of rollouts(inNamespace)) {
      if (isRolledOut(r)) continue;
      out.push({
        object,
        reason: "ComponentNotReady",
        message: `DaemonSet ${r.name}: ${r.ready} of ${r.desired} Pods ready, ${r.updated} updated.`,
        daemonSet: r.name,
        activeAt: firstSeen + ROLLOUT_GRACE_MS,
      });
    }
  };
  for (const policy of input.policies) {
    judge(policy, (ds) =>
      componentsOf(policy, ds)
        .filter((row) => row.enabled && row.state !== "managedByDriver")
        .flatMap((row) => row.daemonSets),
    );
  }
  for (const driver of input.drivers) judge(driver, (ds) => ownedDaemonSets(driver, ds));
  for (const node of input.failedNodes) {
    const labels = record(get(node, "metadata", "labels"));
    if (labels[LABEL_MIG_STATE] !== "failed") continue;
    out.push({
      object: { kind: "Node", name: node.metadata.name ?? "" },
      reason: "MigConfigFailed",
      message: `The MIG manager could not apply the MIG configuration ${str(labels[LABEL_MIG_CONFIG]) ?? ""} on this node.`,
      activeAt: firstSeen + MIG_GRACE_MS,
    });
  }
  return out;
}
