// What the views draw, as Sextant's former built-in views drew it (src/features/dra/details.tsx, nodePod.tsx, ui.tsx,
// DevicesPage.tsx), with the SDK's UI kit:
//   ResourceClaim         — its state in words, the node its devices are bound to (or the node selector), who reserved
//                           it, the pod it was made for, its requests (CEL selectors as text) and the devices allocated;
//                           a pending claim lists the namespace's Pending pods that use it with the scheduler's words;
//   ResourceClaimTemplate — the requests its claims will have;
//   DeviceClass           — its CEL selectors as text, the drivers' configuration, the extended resource name;
//   ResourceSlice         — driver, pool, where its devices are, and each device with the claim that holds it;
//   Pod ("Devices")       — each claim it uses: the claim or template, its state and devices, the containers using it,
//                           and, while the pod waits for a node, the scheduler's DRA reasons;
//   Node ("DRA devices")  — the devices of the node's ResourceSlices with the claims that hold them;
//   the "Devices" page    — every device the slices publish, by node, with the claim that holds it, and the totals.
// Pure functions of the objects and the watched lists. Read-only: nothing here changes the cluster. CEL is never
// evaluated.
import { ui, type KubeObject, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { dateTime, element, link, message, note, remark, table } from "./dom";
import { t } from "./i18n";
import { complete, MAX_ALL_CLAIMS, MAX_NAMESPACE_CLAIMS, MAX_NAMESPACE_PENDING, MAX_SLICES, type Live, type Spec } from "./live";
import {
  allocatedDevicesOf,
  allocatedNodeOf,
  allocationIndex,
  claimSpecOf,
  claimState,
  classConfigOf,
  classSelectorsOf,
  deviceKey,
  draReasonsIn,
  extendedResourceOf,
  generatedFor,
  get,
  isAllocated,
  isUnscheduled,
  kindAt,
  NODE,
  nodeSelectorText,
  num,
  POD,
  podClaimsOf,
  podUsesClaim,
  productOf,
  requestsOf,
  reservedForOf,
  RESOURCE_CLAIM,
  RESOURCE_SLICE,
  schedulingCondition,
  sliceDevicesOf,
  sliceDriver,
  slicePool,
  sliceScope,
  STATE_TONE,
  str,
  type Allocation,
  type DraReason,
  type Request,
} from "./model";

const CLAIMS = { group: RESOURCE_CLAIM.group, kind: RESOURCE_CLAIM.kind };
const SLICES = { group: RESOURCE_SLICE.group, kind: RESOURCE_SLICE.kind };

/** Device rows a claim's or a slice's details draw at most. */
export const DEVICE_ROWS = 200;
/** Device rows a node's details draw at most. */
export const NODE_DEVICE_ROWS = 200;
/** Device rows the "Devices" page draws at most. */
export const MAX_SHOWN = 1000;

const present = (nodes: UiContent[]): UiContent[] => nodes.filter((n) => n !== null && n !== undefined && n !== false);

/** The ids of the blocks, in Sextant's memory of the details sections. */
export const BLOCKS = {
  requests: "requests",
  results: "results",
  waiting: "waiting",
  selectors: "selectors",
  config: "config",
  devices: "devices",
  pod: "pod",
  node: "node",
} as const;

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered (the views drawn on their own). */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

/**
 * A titled block as the built-in view's: open unless the user closed it, closable with its title; its content is drawn
 * only while it is open (`content` is asked for then), as the built-in block mounted its body.
 */
function block(blocks: Blocks, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = blocks.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (now) => blocks.toggle(id, now) });
  node.dataset.block = id;
  return node;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** A claim's state word in its tone. */
export function claimStateWord(claim: KubeObject): HTMLElement {
  const state = claimState(claim);
  return ui.status(t(`state.${state}`), STATE_TONE[state]);
}

/** The allocation index of a list read in full; `undefined` (not known) while it loads or when it failed. */
export const allocationOf = (claims: Live | undefined): Map<string, Allocation[]> | undefined => (complete(claims) ? allocationIndex(claims.items) : undefined);

// ---------- Shared pieces ----------

/** CEL expressions, each on its own line, as written: Sextant never evaluates them. */
export function cel(expressions: readonly string[]): HTMLElement | null {
  if (expressions.length === 0) return null;
  return element("div", { className: "dra-cel" }, ...expressions.map((e) => element("code", { className: "dra-cel__expr", textContent: e })));
}

/** The requests of a claim spec; a firstAvailable request lists its choices in order. */
export function requestsTable(sextant: Sextant, requests: readonly Request[], apiVersion: string | undefined): HTMLElement {
  const classKind = kindAt(apiVersion, "DeviceClass");
  const rows: UiContent[][] = requests.flatMap((r) =>
    r.alternatives.map((a, i) => {
      const name = r.firstAvailable ? t("requests.choice", { request: r.name, choice: a.name ?? "", n: i + 1 }) : r.name;
      const amount = a.allocationMode === "All" ? t("requests.all") : t("requests.count", { count: a.count });
      return [name, link(sextant, classKind, a.deviceClassName), cel(a.selectors), a.adminAccess ? t("requests.withAdminAccess", { amount }) : amount];
    }),
  );
  if (rows.length === 0) return remark(t("requests.none"));
  return table("dra-requests", ["request", "class", "selectors", "amount"].map((h) => t(`requests.${h}`)), rows, t("requests.title"));
}

/**
 * The devices of `slices`, one row each, with the claim(s) that hold them from `allocation` (`undefined`: not known —
 * the claims could not be read in full). `max` rows at most.
 */
export function devicesTable(sextant: Sextant, slices: readonly KubeObject[], allocation: Map<string, Allocation[]> | undefined, max: number): UiContent {
  const rows: UiContent[][] = [];
  let total = 0;
  const sorted = [...slices].sort((a, b) => {
    const na = sliceScope(a);
    const nb = sliceScope(b);
    const ka = na.type === "node" ? na.node : `~${na.type}`;
    const kb = nb.type === "node" ? nb.node : `~${nb.type}`;
    return ka.localeCompare(kb) || sliceDriver(a).localeCompare(sliceDriver(b)) || (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "");
  });
  for (const slice of sorted) {
    const scope = sliceScope(slice);
    const driver = sliceDriver(slice);
    const pool = slicePool(slice);
    for (const device of sliceDevicesOf(slice)) {
      total++;
      if (rows.length >= max) continue;
      const node = device.node ?? (scope.type === "node" ? scope.node : undefined);
      const holders = allocation?.get(deviceKey({ driver, pool, device: device.name })) ?? [];
      const held: UiContent =
        allocation === undefined
          ? t("devices.unknown")
          : holders.length === 0
            ? t("devices.free")
            : ui.inline(holders.map((h) => link(sextant, kindAt(h.apiVersion, "ResourceClaim"), h.claim, h.namespace, `${h.namespace}/${h.claim}`)));
      rows.push([
        node ? link(sextant, NODE, node) : t(`scope.${scope.type}`),
        driver,
        `${pool} / ${device.name}`,
        productOf(device) ?? "",
        ui.chips(device.capacity.map(([k, v]) => `${k}=${v}`)),
        held,
      ]);
    }
  }
  if (total === 0) return remark(t("devices.none"));
  return [
    table("dra-devices", ["node", "driver", "device", "product", "capacity", "allocatedTo"].map((h) => t(`devices.${h}`)), rows, t("devices.title")),
    total > rows.length && remark(t("devices.cut", { count: rows.length, total })),
  ];
}

/** The scheduler's DRA reasons in words, one line each. */
export const draReasons = (reasons: readonly DraReason[]): HTMLElement[] => reasons.map((r) => note(t(`reason.${r}`)));

// ---------- ResourceClaim ----------

function resultsTable(claim: KubeObject): HTMLElement {
  const rows = allocatedDevicesOf(claim).map((d) => {
    const notes: string[] = [];
    if (d.adminAccess) notes.push(t("results.adminAccess"));
    if (d.bindingFailed.length > 0) notes.push(t("results.bindingFailed", { conditions: d.bindingFailed.join(", ") }));
    if (d.bindingPending.length > 0) notes.push(t("results.bindingPending", { conditions: d.bindingPending.join(", ") }));
    return [d.request, d.driver, `${d.pool} / ${d.device}`, notes.join(" ")];
  });
  return table("dra-results", ["request", "driver", "device", "notes"].map((h) => t(`results.${h}`)), rows, t("results.title"));
}

/** The namespace's Pending pods that use a pending claim, with what the scheduler said. */
function waitingPods(sextant: Sextant, claim: KubeObject, pods: Live | undefined): UiContent {
  if (!pods || !pods.ready) return remark(t("loading"));
  const namespace = claim.metadata?.namespace ?? null;
  const name = claim.metadata?.name ?? "";
  const waiting = pods.items.filter((p) => podUsesClaim(p, name) && isUnscheduled(p));
  if (waiting.length === 0) return remark(t(pods.failed ? "waiting.unknown" : "waiting.none"));
  return waiting.map((pod) => {
    const said = schedulingCondition(pod).message;
    return element("div", { className: "dra-waiting" }, link(sextant, POD, pod.metadata?.name, namespace), said ? message(said) : null, ...draReasons(draReasonsIn(said)));
  });
}

/**
 * What a ResourceClaim's details watch besides it: the Pending pods of its namespace (at most 500) while it is not
 * allocated and its "Pods waiting" block is open.
 */
export function claimWatches(claim: KubeObject, isOpen: (id: string) => boolean = () => true): Record<string, Spec | null> {
  const ns = claim.metadata?.namespace;
  const wanted = ns && !isAllocated(claim) && isOpen(BLOCKS.waiting);
  return { pods: wanted ? { kind: POD, namespaces: [ns], fieldSelector: "status.phase=Pending", maxObjects: MAX_NAMESPACE_PENDING } : null };
}

export function claimView(sextant: Sextant, claim: KubeObject, pods: Live | undefined, blocks: Blocks = ALL_OPEN): UiContent[] {
  const ns = claim.metadata?.namespace ?? null;
  const node = allocatedNodeOf(claim);
  const selector = node ? [] : nodeSelectorText(get(claim, "status", "allocation", "nodeSelector"));
  const consumers = reservedForOf(claim).map((c) =>
    c.apiGroup === "" && c.resource === "pods" ? link(sextant, POD, c.name, ns) : `${c.resource}${c.apiGroup ? `.${c.apiGroup}` : ""}/${c.name}`,
  );
  const owner = generatedFor(claim);
  const state = claimState(claim);
  return present([
    fieldsOf([
      ["state", claimStateWord(claim)],
      ["node", node ? link(sextant, NODE, node) : null],
      ["nodeSelector", ui.chips(selector)],
      ["allocatedAt", dateTime(str(get(claim, "status", "allocation", "allocationTimestamp")))],
      ["madeFor", owner ? link(sextant, POD, owner, ns) : null],
      ["reservedFor", consumers.length > 0 ? ui.inline(consumers) : null],
    ]),
    state === "bindingFailed" ? message(t(`hint.${state}`)) : note(t(`hint.${state}`)),
    block(blocks, BLOCKS.requests, t("requests.title"), () => requestsTable(sextant, requestsOf(claimSpecOf(claim)), claim.apiVersion)),
    isAllocated(claim) && block(blocks, BLOCKS.results, t("results.title"), () => resultsTable(claim)),
    !isAllocated(claim) && block(blocks, BLOCKS.waiting, t("waiting.title"), () => waitingPods(sextant, claim, pods)),
  ]);
}

// ---------- ResourceClaimTemplate, DeviceClass, ResourceSlice ----------

export const templateView = (sextant: Sextant, template: KubeObject, blocks: Blocks = ALL_OPEN): UiContent[] => [
  block(blocks, BLOCKS.requests, t("requests.title"), () => requestsTable(sextant, requestsOf(claimSpecOf(template)), template.apiVersion)),
];

export function deviceClassView(obj: KubeObject, blocks: Blocks = ALL_OPEN): UiContent[] {
  const selectors = classSelectorsOf(obj);
  const config = classConfigOf(obj);
  return present([
    fieldsOf([["extendedResource", extendedResourceOf(obj) ?? null]]),
    block(blocks, BLOCKS.selectors, t("class.selectors"), () => [selectors.length > 0 ? cel(selectors) : remark(t("class.noSelectors")), remark(t("class.celNote"))]),
    config.length > 0 &&
      block(blocks, BLOCKS.config, t("class.config"), () =>
        config.map((c) => element("div", { className: "dra-config" }, element("strong", { textContent: c.driver }), c.parameters ? ui.pre(c.parameters) : null)),
      ),
  ]);
}

/** What a ResourceSlice's details watch besides it: every ResourceClaim (at most 5000) while its "Devices" block is open. */
export function sliceWatches(isOpen: (id: string) => boolean = () => true): Record<string, Spec | null> {
  return { claims: isOpen(BLOCKS.devices) ? { kind: CLAIMS, maxObjects: MAX_ALL_CLAIMS } : null };
}

export function sliceView(sextant: Sextant, slice: KubeObject, claims: Live | undefined, blocks: Blocks = ALL_OPEN): UiContent[] {
  const scope = sliceScope(slice);
  return present([
    fieldsOf([
      ["driver", sliceDriver(slice)],
      ["pool", slicePool(slice)],
      ["poolGeneration", String(num(get(slice, "spec", "pool", "generation")) ?? "")],
      ["poolSlices", String(num(get(slice, "spec", "pool", "resourceSliceCount")) ?? "")],
      ["reach", scope.type === "node" ? link(sextant, NODE, scope.node) : t(`scope.${scope.type}`)],
      ["nodeSelector", scope.type === "selector" ? ui.chips(scope.text) : null],
    ]),
    block(blocks, BLOCKS.devices, t("devices.title"), () => devicesTable(sextant, [slice], allocationOf(claims), DEVICE_ROWS)),
  ]);
}

// ---------- Pod ----------

/**
 * What a Pod's "Devices" block watches: the ResourceClaims of its namespace (at most 1000) while the block is open and
 * the cluster serves them (`served`; `undefined`: not known yet, nothing watched).
 */
export function podWatches(pod: KubeObject, served: boolean | undefined, isOpen: (id: string) => boolean = () => true): Record<string, Spec | null> {
  const ns = pod.metadata?.namespace;
  return { claims: served && ns && isOpen(BLOCKS.pod) ? { kind: CLAIMS, namespaces: [ns], maxObjects: MAX_NAMESPACE_CLAIMS } : null };
}

/**
 * A pod's claims, in its "Devices" block. `claims` — the ResourceClaims of its namespace (`undefined` where the cluster
 * serves none: nothing is watched); `served` — whether the cluster serves ResourceClaims (`undefined`: not known).
 */
export function podView(sextant: Sextant, pod: KubeObject, claims: Live | undefined, served: boolean | undefined, blocks: Blocks = ALL_OPEN): UiContent[] {
  return [block(blocks, BLOCKS.pod, t("pod.title"), () => podContent(sextant, pod, claims, served))];
}

function podContent(sextant: Sextant, pod: KubeObject, claims: Live | undefined, served: boolean | undefined): UiContent[] {
  const namespace = pod.metadata?.namespace ?? null;
  const loading = served === undefined || (claims !== undefined && !claims.ready);
  // A list cut at its cap cannot tell that a claim is missing, as the built-in one.
  const known = complete(claims);
  const byName = new Map((claims?.items ?? []).map((c) => [c.metadata?.name ?? "", c]));
  const rows: UiContent[][] = podClaimsOf(pod).map((c) => {
    const claim = c.claimName ? byName.get(c.claimName) : undefined;
    let source: UiContent;
    let state: UiContent;
    if (c.notNeeded) {
      source = t("pod.notNeeded", { template: c.template ?? "" });
      state = null;
    } else if (!c.claimName) {
      source = t("pod.fromTemplate", { template: c.template ?? "" });
      state = ui.status(t("pod.notCreated"), "warning");
    } else {
      source = link(sextant, kindAt(claim?.apiVersion, "ResourceClaim"), c.claimName, namespace);
      if (claim) state = claimStateWord(claim);
      else state = known ? ui.status(t("pod.missing"), "danger") : loading ? t("loading") : t("pod.unknown");
    }
    const devices = claim ? ui.chips(allocatedDevicesOf(claim).map((d) => deviceKey(d))) : null;
    return [c.name, source, state, devices, c.containers.join(", ")];
  });
  const waiting = isUnscheduled(pod);
  const said = waiting ? schedulingCondition(pod).message : undefined;
  const reasons = draReasonsIn(said);
  return present([
    table("dra-pod-claims", ["name", "claim", "state", "devices", "containers"].map((h) => t(`pod.${h}`)), rows, t("pod.title")),
    waiting && reasons.length > 0 && said ? message(said) : null,
    ...(waiting ? draReasons(reasons) : []),
    served === false && remark(t("pod.notServed")),
  ]);
}

// ---------- Node ----------

/** Whether a node's section shows: its slices are there ("present"), cannot be read ("unknown"), or not ("absent"). */
export type NodeAnswer = "present" | "unknown" | "absent";

/** The answer once the node's slices are read; `null` while they load. */
export function nodeAnswer(slices: Live | undefined, served: boolean | undefined): NodeAnswer | null {
  if (served === false) return "absent";
  if (!slices || !slices.ready) return null;
  if (slices.items.length > 0) return "present";
  // Unreadable, or cut at the cap: absence is not proven.
  return slices.failed || slices.truncated ? "unknown" : "absent";
}

/** The node's slices (at most 500, by `spec.nodeName=<node>`) and, while they show, every claim (at most 5000). */
export function nodeWatches(node: string, slices: boolean, claims: boolean): Record<string, Spec | null> {
  return {
    slices: slices ? { kind: SLICES, fieldSelector: `spec.nodeName=${node}`, maxObjects: MAX_SLICES } : null,
    claims: claims ? { kind: CLAIMS, maxObjects: MAX_ALL_CLAIMS } : null,
  };
}

/**
 * The node's "DRA devices" block. `answer` — the slices' answer, kept while the block is closed (`null`: not read yet).
 */
export function nodeView(sextant: Sextant, slices: Live | undefined, claims: Live | undefined, answer: NodeAnswer | null, blocks: Blocks = ALL_OPEN): UiContent[] {
  return [
    block(blocks, BLOCKS.node, t("node.title"), () => [
      answer === null ? remark(t("loading")) : answer === "unknown" ? remark(t("devices.unknown")) : devicesTable(sextant, slices?.items ?? [], allocationOf(claims), NODE_DEVICE_ROWS),
      slices?.truncated === true && remark(t("node.truncated", { count: MAX_SLICES })),
    ]),
  ];
}

// ---------- The "Devices" page ----------

/** The page's lists: every slice (at most 500) and every claim (at most 5000). */
export const PAGE_WATCHES: Record<string, Spec> = {
  slices: { kind: SLICES, maxObjects: MAX_SLICES },
  claims: { kind: CLAIMS, maxObjects: MAX_ALL_CLAIMS },
};

export function pageView(sextant: Sextant, slices: Live | undefined, claims: Live | undefined): UiContent[] {
  const loading = !slices || !slices.ready;
  const allocation = allocationOf(claims);
  let devices = 0;
  let allocated = 0;
  for (const slice of slices?.items ?? []) {
    for (const d of sliceDevicesOf(slice)) {
      devices++;
      if (allocation?.has(deviceKey({ driver: sliceDriver(slice), pool: slicePool(slice), device: d.name }))) allocated++;
    }
  }
  const totals = element("p", {
    className: "dra-muted",
    textContent: allocation ? t("page.totals", { count: devices, allocated }) : t("page.total", { count: devices }),
  });
  totals.setAttribute("role", "status");
  return present([
    element("h2", { className: "dra-page__title", textContent: t("page.title") }),
    remark(t("page.hint")),
    loading && ui.loading(t("loading")),
    !loading && totals,
    slices?.truncated === true && remark(t("page.slicesTruncated", { count: MAX_SLICES })),
    !loading && allocation === undefined && claims?.ready === true && remark(t("page.claimsUnknown")),
    !loading && devicesTable(sextant, slices.items, allocation, MAX_SHOWN),
  ]);
}
