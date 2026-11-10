// The details section `clusterApi` (the manifest's `contributes.detailsSections`), as the built-in view drew it
// (ADR-0113; `src/features/cluster-api/clusterView.tsx` and `machineViews.tsx` before the move):
//   Cluster            — its state in words, class, version and endpoint, the control plane and infrastructure objects
//                        (read by name: kind, name, ready), the Machine counts its status keeps, the workload cluster
//                        when Sextant has it, and the chain of its Machines: the control plane's, each
//                        MachineDeployment → MachineSet → Machines, then any other Machines;
//   Machine            — phase, owner, version, provider ID, the bootstrap and infrastructure objects (read by name,
//                        with a few fields of Docker, AWS, Azure and vSphere machines) and the Node, which opens in the
//                        workload cluster when Sextant has it; whether its Cluster is paused;
//   MachineDeployment, MachineSet, KubeadmControlPlane — replica counts, templates and their Machines (by the selector
//                        their controller uses);
//   MachineHealthCheck — what it checks, healthy of expected, remediations allowed and why they are blocked.
// The section has no heading of its own, as the built-in one had none; its blocks ("<Kind>", "Machines") open and
// close as the built-in panel's did, in Sextant's own memory of details sections (the context's `blocks`,
// `ui.setBlockOpen`). What a block reads is read only while it is open, as the built-in view's: the objects a reference
// names (at most 50, again when the object shown changes, never of a kind the cluster does not serve) while the first
// block is open; the label-selected lists of Machines, MachineSets and MachineDeployments (at most 5000 each, saying
// when a list was cut) while "Machines" is open. A workload cluster opens only on a click, in Sextant's own dialog
// (`ui.openCluster`). Conditions, events and YAML are Sextant's own sections. Read-only.
import { trackObjects, ui, type ClusterSummary, type KubeObject, type ObjectRef, type ResourceKind, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { planChain, type SetPlan } from "./chain";
import { dateTime, errorText } from "./dom";
import { t, tCount } from "./i18n";
import {
  addressesOf,
  arr,
  availableOf,
  bootstrapRefOf,
  CAPI_CLUSTER,
  CAPI_GROUP,
  classOf,
  CLUSTER_CLASS,
  CLUSTER_NAME_LABEL,
  clusterNameOf,
  clusterReplicasOf,
  clusterState,
  conditionsOf,
  controllerOf,
  controlPlaneRefOf,
  endpointOf,
  failureOf,
  firstFailing,
  get,
  healthCheckSpecOf,
  healthCheckState,
  healthCountsOf,
  infrastructureRefOf,
  isKind,
  isLegacy,
  isPaused,
  kcpInitialized,
  kcpTemplateRefOf,
  KUBEADM_CONTROL_PLANE,
  MACHINE,
  MACHINE_DEPLOYMENT,
  MACHINE_HEALTH_CHECK,
  MACHINE_SET,
  machineSelectorOf,
  machineState,
  nodeNameOf,
  num,
  phaseOf,
  providerFailureOf,
  providerFields,
  providerReady,
  readyText,
  record,
  refFrom,
  remediationBlocked,
  replicasOf,
  scalableState,
  serverMatches,
  STATE_TONE,
  str,
  type CapiRef,
  type ClusterState,
  type Endpoint,
  type HealthCheckState,
  type KindRef,
  type MachineState,
  type Replicas,
  type ScalableState,
  type UnhealthyCondition,
} from "./model";
import { isReadable } from "./permitted";

/** Objects a reference names, read at most per view (the built-in `MAX_READS`). */
export const MAX_READS = 50;
/** Machines (and owners) listed in one details view. */
export const MAX_LISTED = 50;
/** Objects one chain watch keeps at most (the built-in `MAX_CHAIN_OBJECTS`, the problems store's cap). */
export const MAX_CHAIN_OBJECTS = 5000;
/** The version of Cluster API's kinds a link names when no object of them is at hand (Sextant opens the one served). */
const DEFAULT_VERSION = "v1beta2";

/** What a referenced object says, or why it says nothing. */
export type Fetched = { obj: KubeObject } | { error: { code: string } } | { notServed: true };

type AnyState = ClusterState | MachineState | ScalableState | HealthCheckState;

/** A list watched while its block is open. */
interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** A list as a view draws it (the built-in `useListed`). */
interface Listed {
  items: KubeObject[];
  loading: boolean;
  /** The kind is not served, or the list could not be read. */
  unavailable: boolean;
  /** More objects match than the watch keeps: the list is incomplete. */
  truncated: boolean;
}

/** The blocks of the section: whether one is open, and `toggle`, which remembers a change and draws again. */
interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Everything a view draws with, besides the object. */
interface View {
  sextant: Sextant;
  blocks: Blocks;
  /** The served kind of `kind`; `null` when not served; `undefined` while Sextant has not told. */
  served(kind: Pick<KindRef, "group" | "kind">): KindRef | null | undefined;
  /** What each reference read says, by `refKey`, and whether the reading is still under way. */
  read(refs: readonly CapiRef[]): Map<string, Fetched>;
  /** A label-selected list of a served kind in one namespace, watched while the caller's block is open. */
  listed(kind: KindRef, namespace: string | null, selector: string | undefined): Listed;
  /** Sextant's clusters, for the workload cluster's buttons; `null` until they are known. */
  clusters: ClusterSummary[] | null;
}

export const refKey = (ref: CapiRef): string => `${ref.group}/${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;
const nsOf = (obj: KubeObject): string | null => obj.metadata.namespace ?? null;
const count = (n: number | undefined) => (n === undefined ? undefined : String(n));

function kindOfApiVersion(apiVersion: string | undefined, kind: string): KindRef {
  const [group, version] = (apiVersion ?? "").includes("/") ? (apiVersion ?? "").split("/") : ["", apiVersion ?? ""];
  return { group: group ?? "", version: version || DEFAULT_VERSION, kind };
}

// ---------- Pieces ----------

/** A link to an object's details in Sextant's panel; nothing without a name. */
function link(view: View, kind: KindRef, name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(view.sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** A link to the object a reference names, at the version the cluster serves. */
function refLink(view: View, ref: CapiRef | undefined, text?: string): HTMLElement | null {
  if (!ref) return null;
  const served = view.served(ref);
  const kind = served ?? { group: ref.group, version: ref.version ?? DEFAULT_VERSION, kind: ref.kind };
  return link(view, kind, ref.name, ref.namespace, text ?? `${ref.kind}/${ref.name}`);
}

const extra = (text: string): HTMLElement => Object.assign(document.createElement("span"), { className: "capi-chain__extra", textContent: text });
const kindLabel = (text: string): HTMLElement => Object.assign(document.createElement("span"), { className: "capi-chain__kind", textContent: text });
function row(...items: UiContent[]): HTMLElement {
  const span = document.createElement("span");
  span.className = "capi-chain__row";
  for (const item of items) appendContent(span, item);
  return span;
}
function appendContent(parent: Node, content: UiContent): void {
  if (content === null || content === undefined || content === false) return;
  if (Array.isArray(content)) {
    for (const item of content as readonly UiContent[]) appendContent(parent, item);
    return;
  }
  parent.appendChild(typeof content === "string" || typeof content === "number" ? document.createTextNode(String(content)) : (content as Node));
}

/** A state in words; the hover is the phase and the first failing condition's message. */
export function stateText(obj: KubeObject, state: AnyState): HTMLElement {
  const failing = firstFailing(obj);
  const tip = [phaseOf(obj), failing?.message ?? failing?.reason].filter(Boolean).join(": ");
  const node = ui.status(t(`state.${state}`), STATE_TONE[state]);
  if (tip) node.title = tip;
  return node;
}

/** What a referenced object says of itself: ready, not ready, missing, unreadable, not served. */
function refStatus(fetched: Fetched | undefined): HTMLElement | null {
  if (!fetched) return null;
  if ("notServed" in fetched) return extra(t("ref.notServed"));
  if ("error" in fetched) return fetched.error.code === "notFound" ? ui.status(t("ref.missing"), "danger") : extra(t("ref.unreadable"));
  const ready = providerReady(fetched.obj);
  if (ready === undefined) return ui.status(t("ref.unknown"), "muted");
  return ready ? ui.status(t("ref.ready"), "success") : ui.status(t("ref.notReady"), "warning");
}

/** A reference as a field value: the link, what the object says, and its terminal error when it has one. */
function refValue(view: View, ref: CapiRef | undefined, fetched: Fetched | undefined): HTMLElement | null {
  if (!ref) return null;
  const failure = fetched && "obj" in fetched ? providerFailureOf(fetched.obj) : undefined;
  return row(refLink(view, ref), refStatus(fetched), failure ? extra(failure) : null);
}

/**
 * The configured clusters whose API server is `endpoint`, each with a button: "Open cluster …", or, with `node`,
 * "Open Node … in …". A click asks Sextant to open it (connected first when it is not, never before); no cluster
 * matching is said in words.
 */
function workloadClusters(view: View, endpoint: Endpoint, node?: string): HTMLElement | null {
  if (!view.clusters) return null;
  const address = `${endpoint.host}:${endpoint.port}`;
  const matching = view.clusters.filter((c) => serverMatches(c.server, endpoint));
  if (matching.length === 0) return extra(t("workload.none", { address }));
  const span = document.createElement("span");
  span.className = "capi-actions";
  for (const c of matching) {
    const label = node ? t("workload.openNode", { node, context: c.context }) : t("workload.open", { context: c.context });
    const target = { host: endpoint.host, port: endpoint.port, ...(node ? { node } : {}) };
    span.append(ui.button(label, () => void view.sextant.ui.openCluster(target).catch(() => undefined)));
  }
  return span;
}

/** A plain-language note on the object's state; `danger` for failures. */
function explain(text: string | undefined, danger = false): HTMLElement | null {
  if (!text) return null;
  return Object.assign(document.createElement("p"), { className: danger ? "capi-explain capi-explain--danger" : "capi-explain", textContent: text });
}

/** The message from the cluster that explains a failure, shown under the note. */
const message = (text: string | undefined): HTMLElement | null =>
  text ? Object.assign(document.createElement("p"), { className: "capi-message", textContent: text }) : null;
const muted = (text: string): HTMLElement => Object.assign(document.createElement("p"), { className: "capi-muted", textContent: text });

/** `ui.fields` labelled from `fields.<key>`, rows without a value left out. */
function fields(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

/** A titled block, open unless the user closed it; its content is built only while it is open. */
function block(view: View, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = view.blocks.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (o) => view.blocks.toggle(id, o) });
  node.dataset.block = id;
  return node;
}

/** A label selector as chips: `key=value` and `key Operator (values)`. */
function labelSelector(selector: unknown): HTMLElement | null {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`);
  const expressions = arr(get(selector, "matchExpressions")).map((e) => {
    const values = arr(get(e, "values")).map(String).join(", ");
    return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values ? ` (${values})` : ""}`;
  });
  return ui.chips([...labels, ...expressions]);
}

function ownerLink(view: View, obj: KubeObject): HTMLElement | null {
  const owner = controllerOf(obj);
  return owner ? link(view, kindOfApiVersion(owner.apiVersion, owner.kind), owner.name, nsOf(obj), `${owner.kind}/${owner.name}`) : null;
}

const CLUSTER_KIND: KindRef = { group: CAPI_GROUP, version: DEFAULT_VERSION, kind: CAPI_CLUSTER.kind };
const clusterLink = (view: View, obj: KubeObject) => link(view, view.served(CAPI_CLUSTER) ?? CLUSTER_KIND, clusterNameOf(obj), nsOf(obj));

const clusterRefOf = (obj: KubeObject): CapiRef | undefined => {
  const name = clusterNameOf(obj);
  return name ? { group: CAPI_GROUP, kind: CAPI_CLUSTER.kind, name, namespace: nsOf(obj) } : undefined;
};

/**
 * Whether the object's Cluster is paused (read by name): its controllers then change nothing in the object, which may
 * not say so itself. `unread`: the Cluster could not be read and the object has no new conditions.
 */
function clusterPause(obj: KubeObject, fetched: Fetched | undefined): { paused: boolean; unread: boolean } {
  if (fetched && "obj" in fetched) return { paused: isPaused(fetched.obj), unread: false };
  return { paused: false, unread: fetched !== undefined && conditionsOf(obj).length === 0 };
}

function clusterPauseNote(name: string | undefined, pause: { paused: boolean; unread: boolean }): HTMLElement | null {
  if (!name || (!pause.paused && !pause.unread)) return null;
  return muted(t(pause.paused ? "explain.clusterPaused" : "explain.clusterUnread", { name }));
}

const countText = (r: Replicas | undefined): string | undefined =>
  r && (r.ready !== undefined || r.desired !== undefined) ? t("readyOf", { ready: String(r.ready ?? 0), desired: String(r.desired ?? r.current ?? 0) }) : undefined;

// ---------- Cluster ----------

function clusterView(view: View, obj: KubeObject): HTMLElement[] {
  const state = clusterState(obj);
  const controlPlane = controlPlaneRefOf(obj);
  const infrastructure = infrastructureRefOf(obj);
  const fieldsBlock = block(view, "fields", obj.kind ?? CAPI_CLUSTER.kind, () => {
    const read = view.read([controlPlane, infrastructure].filter((r): r is CapiRef => r !== undefined));
    const endpoint = endpointOf(obj);
    const cls = classOf(obj);
    const counts = clusterReplicasOf(obj);
    const failure = failureOf(obj);
    const available = availableOf(obj);
    const note =
      state === "failed" || state === "notAvailable" || state === "provisioning" || state === "paused" || state === "deleting"
        ? t(`explain.cluster.${state}`)
        : undefined;
    return [
      explain(note, state === "failed" || state === "notAvailable"),
      message(failure?.message ?? (state === "notAvailable" || state === "provisioning" ? available?.message : undefined)),
      fields([
        ["state", stateText(obj, state)],
        ["phase", phaseOf(obj)],
        ["class", cls ? link(view, view.served(CLUSTER_CLASS) ?? { ...CLUSTER_CLASS, version: DEFAULT_VERSION }, cls.name, cls.namespace) : undefined],
        ["version", str(get(obj, "spec", "topology", "version"))],
        ["endpoint", endpoint ? `${endpoint.host}:${endpoint.port}` : undefined],
        ["controlPlane", refValue(view, controlPlane, controlPlane && read.get(refKey(controlPlane)))],
        ["infrastructure", refValue(view, infrastructure, infrastructure && read.get(refKey(infrastructure)))],
        ["controlPlaneMachines", countText(counts.controlPlane)],
        ["workerMachines", countText(counts.workers)],
        ["workloadCluster", endpoint ? workloadClusters(view, endpoint) : undefined],
      ]),
    ];
  });
  return [fieldsBlock, machineChain(view, obj)];
}

function groupRow(view: View, obj: KubeObject, kind: KindRef): HTMLElement {
  const r = readyText(replicasOf(obj));
  return row(
    kindLabel(kind.kind),
    link(view, kindOfApiVersion(obj.apiVersion ?? `${kind.group}/${kind.version}`, kind.kind), obj.metadata.name, nsOf(obj)),
    stateText(obj, scalableState(obj)),
    r ? extra(t("chain.ready", { ready: r })) : null,
  );
}

function machineRow(view: View, obj: KubeObject): HTMLElement {
  const node = nodeNameOf(obj);
  const infra = infrastructureRefOf(obj);
  return row(
    kindLabel(MACHINE.kind),
    link(view, kindOfApiVersion(obj.apiVersion ?? `${CAPI_GROUP}/${DEFAULT_VERSION}`, MACHINE.kind), obj.metadata.name, nsOf(obj)),
    stateText(obj, machineState(obj)),
    node ? extra(t("chain.node", { node })) : null,
    infra ? extra(`${infra.kind}/${infra.name}`) : null,
  );
}

const li = (...content: UiContent[]): HTMLElement => {
  const item = document.createElement("li");
  item.className = "capi-chain__item";
  for (const c of content) appendContent(item, c);
  return item;
};
const ul = (items: HTMLElement[], className?: string): HTMLElement => {
  const list = document.createElement("ul");
  if (className) list.className = className;
  list.append(...items);
  return list;
};
const machineItems = (view: View, machines: KubeObject[]): HTMLElement | null =>
  machines.length === 0 ? null : ul(machines.map((m) => li(machineRow(view, m))));

/** The Cluster's Machines and what owns them: label-selected watches of its namespace (served kinds only). */
function machineChain(view: View, cluster: KubeObject): HTMLElement {
  return block(view, "chain", t("chain.title"), () => {
    const ns = nsOf(cluster);
    const selector = cluster.metadata.name ? `${CLUSTER_NAME_LABEL}=${cluster.metadata.name}` : undefined;
    const deployments = view.listed(MACHINE_DEPLOYMENT, ns, selector);
    const sets = view.listed(MACHINE_SET, ns, selector);
    const machines = view.listed(MACHINE, ns, selector);
    const loading = deployments.loading || sets.loading || machines.loading;
    const plan = planChain(deployments.items, sets.items, machines.items, MAX_LISTED);
    const setItem = ({ set, machines: mine }: SetPlan) => li(groupRow(view, set, MACHINE_SET), machineItems(view, mine));
    const empty = plan.controlPlane.length + plan.deployments.length + plan.sets.length + plan.others.length === 0;
    const items: HTMLElement[] = [];
    if (plan.controlPlane.length > 0) items.push(li(row(t("chain.controlPlane")), machineItems(view, plan.controlPlane)));
    for (const { deployment, sets: own } of plan.deployments) {
      items.push(li(groupRow(view, deployment, MACHINE_DEPLOYMENT), own.length > 0 ? ul(own.map(setItem)) : null));
    }
    for (const set of plan.sets) items.push(setItem(set));
    if (plan.others.length > 0) items.push(li(row(t("chain.others")), machineItems(view, plan.others)));
    return [
      machines.unavailable ? muted(t("chain.unavailable")) : null,
      empty && !machines.unavailable ? muted(loading ? t("chain.loading") : t("chain.none")) : null,
      ul(items, "capi-chain"),
      plan.hidden > 0 ? muted(tCount("chain.more", plan.hidden)) : null,
      deployments.truncated || sets.truncated || machines.truncated ? muted(tCount("chain.truncated", MAX_CHAIN_OBJECTS)) : null,
    ];
  });
}

// ---------- Machine ----------

function machineView(view: View, obj: KubeObject): HTMLElement[] {
  return [
    block(view, "fields", obj.kind ?? MACHINE.kind, () => {
      const clusterName = clusterNameOf(obj);
      const clusterRef = clusterRefOf(obj);
      const bootstrap = bootstrapRefOf(obj);
      const infrastructure = infrastructureRefOf(obj);
      const read = view.read([clusterRef, bootstrap, infrastructure].filter((r): r is CapiRef => r !== undefined));
      const fetchedCluster = clusterRef ? read.get(refKey(clusterRef)) : undefined;
      const pause = clusterPause(obj, fetchedCluster);
      const own = machineState(obj);
      const state = pause.paused && own !== "deleting" && own !== "failed" ? "paused" : own;
      const infraFetched = infrastructure ? read.get(refKey(infrastructure)) : undefined;
      const infraObj = infraFetched && "obj" in infraFetched ? infraFetched.obj : undefined;
      const node = nodeNameOf(obj);
      const endpoint = fetchedCluster && "obj" in fetchedCluster ? endpointOf(fetchedCluster.obj) : undefined;
      const dataSecret = str(get(obj, "spec", "bootstrap", "dataSecretName"));
      const note =
        state === "failed" || state === "provisioning" || state === "notReady" || state === "paused" || state === "deleting"
          ? t(`explain.machine.${state}`, { phase: phaseOf(obj) ?? "" })
          : undefined;
      const failing = firstFailing(obj);
      return [
        explain(note, state === "failed" || state === "notReady"),
        clusterPauseNote(clusterName, pause),
        message(failureOf(obj)?.message ?? (state !== "running" ? failing?.message : undefined)),
        fields([
          ["state", stateText(obj, state)],
          ["phase", phaseOf(obj)],
          ["cluster", clusterLink(view, obj)],
          ["owner", ownerLink(view, obj)],
          ["version", str(get(obj, "spec", "version"))],
          ["providerID", str(get(obj, "spec", "providerID"))],
          ["failureDomain", str(get(obj, "spec", "failureDomain")) ?? str(get(obj, "status", "failureDomain"))],
          ["node", node],
          ["workloadCluster", node && endpoint ? workloadClusters(view, endpoint, node) : undefined],
          ["addresses", ui.chips(addressesOf(obj))],
          ["bootstrap", refValue(view, bootstrap, bootstrap && read.get(refKey(bootstrap)))],
          ["dataSecret", link(view, { group: "", version: "v1", kind: "Secret" }, dataSecret, nsOf(obj))],
          ["infrastructure", refValue(view, infrastructure, infraFetched)],
          ...(infraObj ? providerFields(infraObj).map(([key, value]) => [`provider.${key}`, value] as const) : []),
          ["lastUpdated", dateTime(str(get(obj, "status", "lastUpdated")))],
        ]),
      ];
    }),
  ];
}

// ---------- MachineDeployment, MachineSet, KubeadmControlPlane ----------

/** The Machines a selector picks in the object's namespace (≤ `MAX_LISTED`). */
function machineList(view: View, namespace: string | null, selector: string | undefined): HTMLElement | null {
  if (!selector) return null;
  return block(view, "machines", t("machines.title"), () => {
    const listed = view.listed(MACHINE, namespace, selector);
    const shown = listed.items.slice(0, MAX_LISTED);
    const rows = shown.map((m) => [
      link(view, kindOfApiVersion(m.apiVersion ?? `${CAPI_GROUP}/${DEFAULT_VERSION}`, MACHINE.kind), m.metadata.name, namespace),
      stateText(m, machineState(m)),
      nodeNameOf(m) ?? "",
    ]);
    return [
      listed.unavailable ? muted(t("chain.unavailable")) : null,
      shown.length === 0 && !listed.unavailable ? muted(listed.loading ? t("chain.loading") : t("machines.none")) : null,
      shown.length > 0 ? ui.table([t("machines.name"), t("machines.state"), t("machines.node")], rows, { label: t("machines.title") }) : null,
      listed.items.length > MAX_LISTED ? muted(tCount("chain.more", listed.items.length - MAX_LISTED)) : null,
      listed.truncated ? muted(tCount("chain.truncated", MAX_CHAIN_OBJECTS)) : null,
    ];
  });
}

/** The terminal failure, or why the object is not available, as the cluster words it. */
const whyNot = (obj: KubeObject, state: string) => failureOf(obj)?.message ?? (state === "notAvailable" ? availableOf(obj)?.message : undefined);

function replicaRows(obj: KubeObject): [string, UiContent][] {
  const r = replicasOf(obj);
  return [
    ["desired", count(r.desired)],
    ["current", count(r.current)],
    ["ready", count(r.ready)],
    ["available", count(r.available)],
    ["upToDate", count(r.upToDate)],
  ];
}

const groupNote = (state: string) =>
  state === "failed" || state === "notAvailable" || state === "rollingOut" || state === "scaling" || state === "paused" || state === "provisioning" ? state : undefined;

function machineGroupView(view: View, obj: KubeObject): HTMLElement[] {
  const state = scalableState(obj);
  const fieldsBlock = block(view, "fields", obj.kind ?? "", () => {
    const template = get(obj, "spec", "template", "spec");
    const strategy = str(get(obj, "spec", "rollout", "strategy", "type")) ?? str(get(obj, "spec", "strategy", "type"));
    const key = groupNote(state);
    return [
      explain(key ? t(`explain.group.${key}`) : undefined, state === "failed" || state === "notAvailable"),
      message(whyNot(obj, state)),
      fields([
        ["state", stateText(obj, state)],
        ["phase", phaseOf(obj)],
        ["cluster", clusterLink(view, obj)],
        ["owner", ownerLink(view, obj)],
        ...replicaRows(obj),
        ["version", str(get(template, "version"))],
        ["strategy", strategy],
        ["bootstrapTemplate", refLink(view, refFrom(get(template, "bootstrap", "configRef"), nsOf(obj)))],
        ["infrastructureTemplate", refLink(view, refFrom(get(template, "infrastructureRef"), nsOf(obj)))],
      ]),
    ];
  });
  return [fieldsBlock, machineList(view, nsOf(obj), machineSelectorOf(obj))].filter((n): n is HTMLElement => n !== null);
}

function controlPlaneView(view: View, obj: KubeObject): HTMLElement[] {
  const fieldsBlock = block(view, "fields", obj.kind ?? KUBEADM_CONTROL_PLANE.kind, () => {
    const clusterRef = clusterRefOf(obj);
    const read = view.read(clusterRef ? [clusterRef] : []);
    const pause = clusterPause(obj, clusterRef ? read.get(refKey(clusterRef)) : undefined);
    const own = scalableState(obj);
    const state = pause.paused && own !== "deleting" && own !== "failed" ? "paused" : own;
    const initialized = kcpInitialized(obj);
    const last = get(obj, "status", "lastRemediation");
    const key = groupNote(state);
    return [
      explain(key ? t(`explain.group.${key}`) : undefined, state === "failed" || state === "notAvailable"),
      clusterPauseNote(clusterRef?.name, pause),
      message(whyNot(obj, state)),
      fields([
        ["state", stateText(obj, state)],
        ["cluster", clusterLink(view, obj)],
        ["version", str(get(obj, "spec", "version"))],
        ["initialized", initialized === undefined ? undefined : initialized ? t("yes") : t("no")],
        ...replicaRows(obj),
        ["infrastructureTemplate", refLink(view, kcpTemplateRefOf(obj))],
        ["lastRemediation", str(get(last, "machine"))],
        ["lastRemediationTime", dateTime(str(get(last, "time")) ?? str(get(last, "timestamp")))],
        ["retryCount", count(num(get(last, "retryCount")))],
      ]),
    ];
  });
  return [fieldsBlock, machineList(view, nsOf(obj), machineSelectorOf(obj))].filter((n): n is HTMLElement => n !== null);
}

// ---------- MachineHealthCheck ----------

function healthCheckView(view: View, obj: KubeObject): HTMLElement[] {
  return [
    block(view, "fields", obj.kind ?? MACHINE_HEALTH_CHECK.kind, () => {
      const state = healthCheckState(obj);
      const spec = healthCheckSpecOf(obj);
      const counts = healthCountsOf(obj);
      const blocked = remediationBlocked(obj);
      const targets = arr(get(obj, "status", "targets")).map(String);
      const conditionTable = (label: string, list: UnhealthyCondition[]) =>
        list.length > 0
          ? ui.table([t("healthCheck.type"), t("healthCheck.status"), t("healthCheck.timeout")], list.map((c) => [c.type, c.status, c.timeout ?? ""]), { label })
          : null;
      const note =
        state === "blocked" || state === "remediating" ? t(`explain.healthCheck.${state}`, { healthy: String(counts.healthy ?? 0), expected: String(counts.expected ?? 0) }) : undefined;
      return [
        explain(note, state === "blocked"),
        message(blocked?.message),
        fields([
          ["state", stateText(obj, state)],
          ["cluster", clusterLink(view, obj)],
          ["selector", labelSelector(get(obj, "spec", "selector"))],
          ["expected", count(counts.expected)],
          ["healthy", count(counts.healthy)],
          ["remediationsAllowed", count(counts.allowed)],
          ["maxUnhealthy", spec.maxUnhealthy],
          ["unhealthyRange", spec.unhealthyRange],
          ["nodeStartupTimeout", spec.nodeStartupTimeout],
          ["unhealthyNodeConditions", conditionTable(t("fields.unhealthyNodeConditions"), spec.nodeConditions)],
          ["unhealthyMachineConditions", conditionTable(t("fields.unhealthyMachineConditions"), spec.machineConditions)],
          ["targets", targets.length > 0 ? targetLinks(view, obj, targets) : undefined],
        ]),
      ];
    }),
  ];
}

function targetLinks(view: View, obj: KubeObject, names: string[]): HTMLElement {
  const version = isLegacy(obj) ? "v1beta1" : "v1beta2";
  const links: UiContent[] = names.slice(0, MAX_LISTED).map((name) => link(view, { group: CAPI_GROUP, version, kind: MACHINE.kind }, name, nsOf(obj)));
  if (names.length > MAX_LISTED) links.push(extra(tCount("chain.more", names.length - MAX_LISTED)));
  return ui.inline(links);
}

/** The section's blocks for `obj` of `kind`; nothing for the kinds it has nothing for. */
export function sectionView(view: View, kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): HTMLElement[] | null {
  if (isKind(kind, CAPI_CLUSTER)) return clusterView(view, obj);
  if (isKind(kind, MACHINE)) return machineView(view, obj);
  if (isKind(kind, MACHINE_DEPLOYMENT, MACHINE_SET)) return machineGroupView(view, obj);
  if (isKind(kind, KUBEADM_CONTROL_PLANE)) return controlPlaneView(view, obj);
  if (isKind(kind, MACHINE_HEALTH_CHECK)) return healthCheckView(view, obj);
  return null;
}

// ---------- Reading ----------

/** The watches the views want, by spec: started when first wanted, stopped when no view wants them. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  private wanted = new Set<string>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** Starts collecting what one drawing wants. */
  begin(): void {
    this.wanted = new Set();
  }

  get(spec: Omit<WatchParams, "clusterId">): Live {
    const key = JSON.stringify(spec);
    this.wanted.add(key);
    return (this.open.get(key) ?? this.start(key, spec)).live;
  }

  /** Stops the watches the last drawing did not want. */
  end(): void {
    for (const [key, entry] of this.open) {
      if (this.wanted.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, failed: false, truncated: false };
    const settle = (failed: boolean) => {
      live.ready = true;
      live.failed = failed;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          // By name, as the built-in view sorted its lists.
          live.items = [...items].sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
          settle(false);
        },
        (other) => {
          if (other.type === "error" || other.type === "forbidden") settle(true);
        },
      ),
      onError: () => settle(true),
      onCapped: (total) => {
        live.truncated = total > (spec.maxObjects ?? Infinity);
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.begin();
    this.end();
  }
}

/** Reads referenced objects: at most `MAX_READS`, again when the object shown changes, only kinds the cluster serves. */
class Reads {
  private key = "";
  private found = new Map<string, Fetched>();
  private attempt = 0;
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** What `refs` say as read for `stamp` (the shown object's version); the previous reading stays until this one lands. */
  get(refs: readonly CapiRef[], stamp: string, served: (kind: Pick<KindRef, "group" | "kind">) => KindRef | null | undefined, kindsKnown: boolean): Map<string, Fetched> {
    // Nothing is read before Sextant has said which kinds are served.
    if (!kindsKnown) return this.found;
    const wanted = refs.slice(0, MAX_READS);
    const key = JSON.stringify([wanted.map(refKey), stamp]);
    if (key === this.key) return this.found;
    this.key = key;
    const attempt = ++this.attempt;
    const found = new Map<string, Fetched>();
    const queue: { key: string; ref: ObjectRef }[] = [];
    for (const ref of wanted) {
      const kind = served(ref);
      if (kind) queue.push({ key: refKey(ref), ref: { kind, namespace: ref.namespace, name: ref.name } });
      // A kind the extension may read but the cluster does not serve; a provider kind it may not read is unreadable.
      else found.set(refKey(ref), isReadable(ref) ? { notServed: true } : { error: { code: "denied" } });
    }
    if (queue.length === 0) {
      this.found = found;
      return found;
    }
    this.sextant.resources.getMany({ refs: queue.map((q) => q.ref) }).then(
      (answer) => {
        if (attempt !== this.attempt) return;
        answer.items.forEach((item, i) => found.set(queue[i]!.key, "object" in item ? { obj: item.object } : { error: { code: item.error.code } }));
        this.found = found;
        this.changed();
      },
      (err: unknown) => {
        if (attempt !== this.attempt) return;
        const code = (err as { code?: unknown }).code;
        for (const q of queue) found.set(q.key, { error: { code: typeof code === "string" ? code : "failed" } });
        this.found = found;
        this.changed();
      },
    );
    return this.found;
  }

  reset(): void {
    this.key = "";
    this.found = new Map();
    this.attempt++;
  }
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; what it
 * lists besides read while the block that shows it is open, and drawn again as that changes.
 */
export function startDetails(sextant: Sextant, root: HTMLElement): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
  let kinds: ResourceKind[] | null | "failed" = null;
  let clusters: ClusterSummary[] | null = null;
  let scheduled = false;
  let stopped = false;
  // The blocks' choices as Sextant remembers them (`context.blocks`); a choice made here counts until the context that
  // carries it (or any other change of the remembered choices, "Collapse all" among them) comes back.
  const choices = new Map<string, boolean>();
  let rememberedBlocks = JSON.stringify(sextant.context.blocks ?? {});
  const blocks: Blocks = {
    isOpen: (id) => choices.get(id) ?? ui.blockOpen(sextant.context.blocks, id, true),
    toggle: (id, open) => {
      choices.set(id, open);
      void sextant.ui.setBlockOpen(id, open).catch(() => undefined);
      schedule();
    },
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const watches = new Watches(sextant, schedule);
  const reads = new Reads(sextant, schedule);

  const served = (k: Pick<KindRef, "group" | "kind">): KindRef | null | undefined => {
    if (kinds === null) return undefined;
    if (kinds === "failed") return null;
    return kinds.find((r) => isKind(r.kindRef, k))?.kindRef ?? null;
  };

  const render = () => {
    if (!object || !kind || stopped) return;
    const obj = object;
    watches.begin();
    const view: View = {
      sextant,
      blocks,
      served,
      read: (refs) => reads.get(refs, obj.metadata.resourceVersion ?? "", served, kinds !== null),
      listed: (k, namespace, selector) => {
        const kindServed = served(k);
        const live = kindServed && namespace && selector ? watches.get({ kind: kindServed, namespaces: [namespace], labelSelector: selector, maxObjects: MAX_CHAIN_OBJECTS }) : null;
        return {
          items: live?.items ?? [],
          loading: kindServed === undefined || (live !== null && !live.ready),
          unavailable: kindServed === null || Boolean(live?.failed),
          truncated: Boolean(live?.truncated),
        };
      },
      clusters,
    };
    const nodes = sectionView(view, kind, obj);
    watches.end();
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(...(nodes ?? [ui.empty(t("common.nothingToShow", { view: "details" }))]));
    if (focused && onToggle) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
      kind = ref.kind;
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  const follow = () => {
    const nowRemembered = JSON.stringify(sextant.context.blocks ?? {});
    if (nowRemembered !== rememberedBlocks) {
      rememberedBlocks = nowRemembered;
      choices.clear();
      schedule();
    }
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(ui.empty(t("common.nothingSelected")));
      return;
    }
    const key = JSON.stringify([sextant.context.clusterId, ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      kinds = null;
      clusters = null;
      watches.stop();
      reads.reset();
      root.replaceChildren(ui.loading(t("loading")));
      // Which kinds the cluster serves (and the extension may read), and Sextant's clusters for the workload cluster.
      const current = key;
      sextant.kinds().then(
        (list) => {
          if (shownRef !== current) return;
          kinds = list;
          schedule();
        },
        () => {
          if (shownRef !== current) return;
          kinds = "failed";
          schedule();
        },
      );
      sextant.clusters.list().then(
        (list) => {
          if (shownRef !== current) return;
          clusters = list;
          schedule();
        },
        // Without the list no button is offered (as no cluster could be told apart).
        () => undefined,
      );
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) return;
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    stopFollow();
    watches.stop();
  };
}
