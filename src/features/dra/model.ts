// What the Dynamic Resource Allocation section reads from resource.k8s.io objects (#244, ADR-0116), in every shape
// the API has had (kubernetes/kubernetes staging/src/k8s.io/api/resource/<version>/types.go):
//
//   v1alpha3 (1.31) and v1beta1 (1.32): a request names its class itself (`requests[].deviceClassName`, `selectors`,
//     `allocationMode`, `count`; v1beta1 since 1.33 also `firstAvailable`); a slice's device keeps its fields under
//     `basic`; a capacity is a quantity in v1alpha3 and `{value}` in v1beta1;
//   v1beta2 (1.33) and v1 (1.34): a request is `exactly` one class or a `firstAvailable` list of sub-requests; a
//     device's fields sit on the device; a capacity is `{value}`.
//
// The version is the one discovery serves; each object is read by the fields it has, never by its apiVersion. Device
// selectors are CEL expressions: shown as text, never evaluated. Pure functions, no React. Read-only.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const DRA_GROUP = "resource.k8s.io";

const k = (kind: string): KindRef => ({ group: DRA_GROUP, version: "v1", kind });

export const DEVICE_CLASS = k("DeviceClass");
export const RESOURCE_CLAIM = k("ResourceClaim");
export const RESOURCE_CLAIM_TEMPLATE = k("ResourceClaimTemplate");
export const RESOURCE_SLICE = k("ResourceSlice");
export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
export const NODE: KindRef = { group: "", version: "v1", kind: "Node" };

export interface DraKind {
  kind: KindRef;
  order: number;
  /** Key under `dra:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const DRA_KINDS: DraKind[] = [
  { kind: RESOURCE_CLAIM, order: 10, label: "claims", namespaced: true },
  { kind: RESOURCE_CLAIM_TEMPLATE, order: 11, label: "templates", namespaced: true },
  { kind: DEVICE_CLASS, order: 20, label: "deviceClasses", namespaced: false },
  { kind: RESOURCE_SLICE, order: 21, label: "slices", namespaced: false },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">): boolean =>
  a.group === b.group && a.kind === b.kind;
export const draKind = (kind: Pick<KindRef, "group" | "kind">): DraKind | undefined => DRA_KINDS.find((d) => isKind(kind, d.kind));

/** The object's `apiVersion` split, for links to objects of the same group and version. */
export function typeOf(obj: KubeObject, kind: string): { apiVersion: string; kind: string } {
  return { apiVersion: obj.apiVersion ?? `${DRA_GROUP}/v1`, kind };
}

// ---------- Requests ----------

/** One way to satisfy a request: a device class, CEL selectors (text), how many. */
export interface Alternative {
  /** The sub-request's name (`firstAvailable`), else undefined. */
  name?: string;
  deviceClassName?: string;
  /** CEL expressions as written. */
  selectors: string[];
  /** `ExactCount` (default) or `All`. */
  allocationMode: string;
  count: number;
  adminAccess: boolean;
}

export interface Request {
  name: string;
  /** One entry for an exact request; the ordered choices of `firstAvailable` otherwise. */
  alternatives: Alternative[];
  firstAvailable: boolean;
}

export const celOf = (selectors: unknown): string[] =>
  arr(selectors).flatMap((s) => {
    const expression = str(get(s, "cel", "expression"));
    return expression ? [expression] : [];
  });

function alternative(spec: unknown, name?: string): Alternative {
  const mode = str(get(spec, "allocationMode")) || "ExactCount";
  return {
    ...(name ? { name } : {}),
    deviceClassName: str(get(spec, "deviceClassName")) || undefined,
    selectors: celOf(get(spec, "selectors")),
    allocationMode: mode,
    count: mode === "All" ? 0 : (num(get(spec, "count")) ?? 1),
    adminAccess: get(spec, "adminAccess") === true,
  };
}

/** The requests of a claim's `spec.devices` (a ResourceClaim's `spec`, a template's `spec.spec`). */
export function requestsOf(claimSpec: unknown): Request[] {
  return arr(get(claimSpec, "devices", "requests")).flatMap((r): Request[] => {
    const name = str(get(r, "name"));
    if (!name) return [];
    const first = arr(get(r, "firstAvailable"));
    if (first.length > 0) {
      return [{ name, firstAvailable: true, alternatives: first.map((s) => alternative(s, str(get(s, "name")))) }];
    }
    // v1beta2 and v1: `exactly`; older versions: the fields on the request itself.
    const exactly = get(r, "exactly");
    return [{ name, firstAvailable: false, alternatives: [alternative(exactly ?? r)] }];
  });
}

/** The device classes a claim spec asks for, each once. */
export const classesOf = (claimSpec: unknown): string[] => [
  ...new Set(requestsOf(claimSpec).flatMap((r) => r.alternatives.flatMap((a) => (a.deviceClassName ? [a.deviceClassName] : [])))),
];

/** A ResourceClaim's spec; a ResourceClaimTemplate keeps it under `spec.spec`. */
export const claimSpecOf = (obj: KubeObject): unknown => (obj.kind === "ResourceClaimTemplate" ? get(obj, "spec", "spec") : get(obj, "spec"));

// ---------- Allocation ----------

export interface AllocatedDevice {
  /** The request it satisfies: `<request>` or `<request>/<sub-request>` (firstAvailable). */
  request: string;
  driver: string;
  pool: string;
  device: string;
  adminAccess: boolean;
  /** Conditions of the device's status (`status.devices[]`) whose being True means binding failed. */
  bindingFailed: string[];
  /** Conditions the scheduler waits for before binding (`bindingConditions`) not yet True. */
  bindingPending: string[];
}

/** `driver/pool/device`: how a device is named across slices and claims. */
export const deviceKey = (d: { driver: string; pool: string; device: string }): string => `${d.driver}/${d.pool}/${d.device}`;

/** The conditions the driver reported for one allocated device (`status.devices[]`). */
function deviceConditions(claim: KubeObject, d: { driver: string; pool: string; device: string }): Map<string, string> {
  const entry = arr(get(claim, "status", "devices")).find(
    (x) => str(get(x, "driver")) === d.driver && str(get(x, "pool")) === d.pool && str(get(x, "device")) === d.device,
  );
  return new Map(arr(get(entry, "conditions")).map((c) => [str(get(c, "type")) ?? "", str(get(c, "status")) ?? ""]));
}

export function allocatedDevicesOf(claim: KubeObject): AllocatedDevice[] {
  return arr(get(claim, "status", "allocation", "devices", "results")).flatMap((r) => {
    const driver = str(get(r, "driver"));
    const pool = str(get(r, "pool"));
    const device = str(get(r, "device"));
    if (!driver || !pool || !device) return [];
    const conditions = deviceConditions(claim, { driver, pool, device });
    const names = (field: string) => arr(get(r, field)).flatMap((c) => (typeof c === "string" ? [c] : []));
    return [
      {
        request: str(get(r, "request")) ?? "",
        driver,
        pool,
        device,
        adminAccess: get(r, "adminAccess") === true,
        // ResourceClaim API: "If any of these conditions is true, binding failed" (bindingFailureConditions).
        bindingFailed: names("bindingFailureConditions").filter((c) => conditions.get(c) === "True"),
        bindingPending: names("bindingConditions").filter((c) => conditions.get(c) !== "True"),
      },
    ];
  });
}

export const isAllocated = (claim: KubeObject): boolean => get(claim, "status", "allocation") !== undefined && get(claim, "status", "allocation") !== null;

export interface Consumer {
  apiGroup: string;
  resource: string;
  name: string;
  uid?: string;
}

/** `status.reservedFor`: who may use the allocated devices (pods, or a higher-level controller's object). */
export function reservedForOf(claim: KubeObject): Consumer[] {
  return arr(get(claim, "status", "reservedFor")).flatMap((c) => {
    const name = str(get(c, "name"));
    const resource = str(get(c, "resource"));
    if (!name || !resource) return [];
    return [{ apiGroup: str(get(c, "apiGroup")) ?? "", resource, name, uid: str(get(c, "uid")) }];
  });
}

/** The pods of `status.reservedFor`. */
export const reservingPods = (claim: KubeObject): string[] =>
  reservedForOf(claim)
    .filter((c) => c.apiGroup === "" && c.resource === "pods")
    .map((c) => c.name);

/**
 * The node an allocation is bound to, when its node selector names one node (`matchFields metadata.name In [node]`,
 * what the scheduler writes for node-local devices); `undefined` for devices reachable from several nodes.
 */
export function allocatedNodeOf(claim: KubeObject): string | undefined {
  const terms = arr(get(claim, "status", "allocation", "nodeSelector", "nodeSelectorTerms"));
  if (terms.length !== 1) return undefined;
  const fields = arr(get(terms[0], "matchFields"));
  if (fields.length !== 1 || arr(get(terms[0], "matchExpressions")).length > 0) return undefined;
  const f = fields[0];
  const values = arr(get(f, "values"));
  if (str(get(f, "key")) !== "metadata.name" || str(get(f, "operator")) !== "In" || values.length !== 1) return undefined;
  return str(values[0]);
}

/** A node selector in words-free text (`key op values`), one line per term, for a selector that is not one node. */
export function nodeSelectorText(selector: unknown): string[] {
  return arr(get(selector, "nodeSelectorTerms")).map((term) => {
    const parts = [...arr(get(term, "matchExpressions")), ...arr(get(term, "matchFields"))].map((e) => {
      const values = arr(get(e, "values")).flatMap((v) => (typeof v === "string" ? [v] : []));
      return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values.length ? ` ${values.join(",")}` : ""}`;
    });
    return parts.join("; ");
  });
}

// ---------- The state of a claim ----------

/** `inUse`: allocated and reserved; `allocated`: allocated, nobody reserved it; `pending`: not allocated yet. */
export type ClaimState = "inUse" | "allocated" | "pending" | "bindingFailed" | "deleting";

export const STATE_TONE: Record<ClaimState, Tone> = {
  inUse: "success",
  allocated: "success",
  pending: "warning",
  bindingFailed: "danger",
  deleting: "muted",
};

/** The health the issue's status column speaks of: ready / progressing / failed. */
export const HEALTH_OF: Record<ClaimState, "ready" | "progressing" | "failed"> = {
  inUse: "ready",
  allocated: "ready",
  pending: "progressing",
  bindingFailed: "failed",
  deleting: "progressing",
};

export function claimState(claim: KubeObject): ClaimState {
  if (str(get(claim, "metadata", "deletionTimestamp"))) return "deleting";
  if (!isAllocated(claim)) return "pending";
  if (allocatedDevicesOf(claim).some((d) => d.bindingFailed.length > 0)) return "bindingFailed";
  return reservedForOf(claim).length > 0 ? "inUse" : "allocated";
}

/** The annotation the resource claim controller sets on a claim it made from a template: the pod's claim name. */
export const POD_CLAIM_NAME_ANNOTATION = "resource.kubernetes.io/pod-claim-name";

/** The pod a claim was generated for (its controlling owner), when it was. */
export function generatedFor(claim: KubeObject): string | undefined {
  const owner = arr(get(claim, "metadata", "ownerReferences")).find((o) => str(get(o, "kind")) === "Pod" && get(o, "controller") === true);
  return str(get(owner, "name"));
}

// ---------- Slices ----------

/** Where a slice's devices are reachable: one node, every node, nodes a selector picks, or set per device. */
export type SliceScope = { type: "node"; node: string } | { type: "allNodes" } | { type: "selector"; text: string[] } | { type: "perDevice" } | { type: "unknown" };

export function sliceScope(slice: KubeObject): SliceScope {
  const node = str(get(slice, "spec", "nodeName"));
  if (node) return { type: "node", node };
  if (get(slice, "spec", "allNodes") === true) return { type: "allNodes" };
  const selector = get(slice, "spec", "nodeSelector");
  if (selector) return { type: "selector", text: nodeSelectorText(selector) };
  if (get(slice, "spec", "perDeviceNodeSelection") === true) return { type: "perDevice" };
  return { type: "unknown" };
}

export interface SliceDevice {
  name: string;
  /** Attributes as `[name, value]` text, sorted by name. */
  attributes: [string, string][];
  /** Capacities as `[name, quantity]`, sorted by name. */
  capacity: [string, string][];
  /** The device's own node (per-device node selection), when it names one. */
  node?: string;
}

/** A device attribute's value as text: exactly one of int, bool, string, version (or their lists) is set. */
export function attributeText(value: unknown): string {
  for (const field of ["string", "int", "bool", "version"]) {
    const v = get(value, field);
    if (v !== undefined && v !== null) return String(v);
  }
  for (const field of ["strings", "ints", "bools", "versions"]) {
    const v = arr(get(value, field));
    if (v.length > 0) return v.map(String).join(", ");
  }
  return "";
}

/** A capacity as a quantity: a plain quantity in v1alpha3, `{value}` from v1beta1 on. */
export function capacityText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const v = get(value, "value");
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

const sortedPairs = (map: Record<string, unknown>, text: (v: unknown) => string): [string, string][] =>
  Object.keys(map)
    .sort()
    .map((key) => [key, text(map[key])] as [string, string]);

export function sliceDevicesOf(slice: KubeObject): SliceDevice[] {
  return arr(get(slice, "spec", "devices")).flatMap((d) => {
    const name = str(get(d, "name"));
    if (!name) return [];
    // v1alpha3 and v1beta1 keep the device's fields under `basic`.
    const body = get(d, "basic") ?? d;
    const node = str(get(body, "nodeName"));
    return [
      {
        name,
        attributes: sortedPairs(record(get(body, "attributes")), attributeText),
        capacity: sortedPairs(record(get(body, "capacity")), capacityText),
        ...(node ? { node } : {}),
      },
    ];
  });
}

export const sliceDriver = (slice: KubeObject): string => str(get(slice, "spec", "driver")) ?? "";
export const slicePool = (slice: KubeObject): string => str(get(slice, "spec", "pool", "name")) ?? "";

/** The attribute that names a device best for a person: a product or model name when the driver gives one. */
export function productOf(device: SliceDevice): string | undefined {
  for (const [key, value] of device.attributes) {
    const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
    if (["productName", "product", "model", "type"].includes(bare) && value) return value;
  }
  return undefined;
}

// ---------- Device classes ----------

export interface ClassConfig {
  driver: string;
  /** The opaque parameters as JSON text. */
  parameters: string;
}

export const classSelectorsOf = (deviceClass: KubeObject): string[] => celOf(get(deviceClass, "spec", "selectors"));

export function classConfigOf(deviceClass: KubeObject): ClassConfig[] {
  return arr(get(deviceClass, "spec", "config")).flatMap((c) => {
    const driver = str(get(c, "opaque", "driver"));
    if (!driver) return [];
    const parameters = get(c, "opaque", "parameters");
    return [{ driver, parameters: parameters === undefined ? "" : JSON.stringify(parameters, null, 2) }];
  });
}

/** v1beta1+ (1.34): the extended resource name pods may request instead of a claim. */
export const extendedResourceOf = (deviceClass: KubeObject): string | undefined => str(get(deviceClass, "spec", "extendedResourceName")) || undefined;

// ---------- Pods ----------

export interface PodClaim {
  /** The name in `pod.spec.resourceClaims`. */
  name: string;
  /** The ResourceClaim: named in the spec, or the one made from the template (`status.resourceClaimStatuses`). */
  claimName?: string;
  template?: string;
  /** A template's claim that has not been made yet (no entry in `status.resourceClaimStatuses`). */
  notCreated: boolean;
  /** The pod needs no claim for this entry (the template's claim was not needed: an entry without a name). */
  notNeeded: boolean;
  /** Containers that use it, with the request when they name one. */
  containers: string[];
}

/** The claims a pod uses (`spec.resourceClaims`; the `source` of 1.26–1.30 is read too). */
export function podClaimsOf(pod: KubeObject): PodClaim[] {
  const statuses = new Map(
    arr(get(pod, "status", "resourceClaimStatuses")).map((s) => [str(get(s, "name")) ?? "", { found: true, name: str(get(s, "resourceClaimName")) }]),
  );
  const containers = [...arr(get(pod, "spec", "initContainers")), ...arr(get(pod, "spec", "containers"))];
  return arr(get(pod, "spec", "resourceClaims")).flatMap((c) => {
    const name = str(get(c, "name"));
    if (!name) return [];
    const named = str(get(c, "resourceClaimName")) ?? str(get(c, "source", "resourceClaimName"));
    const template = str(get(c, "resourceClaimTemplateName")) ?? str(get(c, "source", "resourceClaimTemplateName"));
    const generated = statuses.get(name);
    const users = containers.flatMap((ct) =>
      arr(get(ct, "resources", "claims")).flatMap((u) => {
        if (str(get(u, "name")) !== name) return [];
        const request = str(get(u, "request"));
        const container = str(get(ct, "name")) ?? "";
        return [request ? `${container} (${request})` : container];
      }),
    );
    if (named) return [{ name, claimName: named, notCreated: false, notNeeded: false, containers: users }];
    return [
      {
        name,
        ...(template ? { template } : {}),
        ...(generated?.name ? { claimName: generated.name } : {}),
        notCreated: !generated,
        // The resource claim controller records an entry without a claim name when it made none.
        notNeeded: Boolean(generated && !generated.name),
        containers: users,
      },
    ];
  });
}

export const usesClaims = (pod: KubeObject): boolean => arr(get(pod, "spec", "resourceClaims")).length > 0;

/** Whether a pod uses the claim `name` of its namespace. */
export const podUsesClaim = (pod: KubeObject, name: string): boolean => podClaimsOf(pod).some((c) => c.claimName === name);

// ---------- Why a pod waits ----------

/**
 * A reason the scheduler's DRA plugin gives (kubernetes pkg/scheduler/framework/plugins/dynamicresources and
 * staging/src/k8s.io/dynamic-resource-allocation/resourceclaim), recognised in its message; `undefined` for others.
 */
export type DraReason =
  | "notCreated"
  | "notFound"
  | "deleting"
  | "inUse"
  | "noClass"
  | "cannotAllocate"
  | "notOnNode"
  | "allocating"
  | "notOwner";

const DRA_REASONS: [RegExp, DraReason][] = [
  [/ResourceClaim not created yet|waiting for dynamic resource controller to create the resourceclaim/i, "notCreated"],
  [/resourceclaims?(\.resource\.k8s\.io)? "[^"]*" not found/i, "notFound"],
  [/resourceclaim "[^"]*" is being deleted/i, "deleting"],
  [/resourceclaim in use/i, "inUse"],
  [/device class \S+ does not exist/i, "noClass"],
  [/cannot allocate all claims/i, "cannotAllocate"],
  [/resourceclaim not available on the node/i, "notOnNode"],
  [/is in the process of being allocated/i, "allocating"],
  [/was not created for Pod/i, "notOwner"],
];

/** The DRA reasons in a scheduler message, each once, in the order of `DRA_REASONS`. */
export function draReasonsIn(message: string | undefined): DraReason[] {
  if (!message) return [];
  return DRA_REASONS.filter(([re]) => re.test(message)).map(([, reason]) => reason);
}
