// The details section `membership` of Pods and workloads (#155), untitled at the built-in "Service mesh" section's
// place (order 28: after the kind's own fields, before the conditions), drawn as the built-in `MembershipSection.tsx`:
// whether the object is in the Istio or Linkerd mesh (and how: sidecar, native sidecar, ambient; revision; injection),
// its Istio mTLS mode by PeerAuthentication precedence, and "Who may call this workload?" from AuthorizationPolicies.
// Shown only when the cluster serves Istio or Linkerd kinds, or the pod carries a proxy (`startHidden` until then).
// The namespace is read with one field-selected watch while one of the shown blocks is open (the last one read stays
// in use while all are closed); the policies come from the shared Istio configuration (store.ts) while the mTLS or
// "Who may call" block is open; whether linkerd-viz is installed, from one Namespace by name.
import { ui, type KindRef, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { block, BlockMemory, batched, el, errorText, fieldsOf, line, links, meshLink, muted, redraw, table, type Blocks } from "./dom";
import { followShown } from "./details";
import { whoMayCall, type AuthzDecision, type Caller } from "./engine/authz";
import { AUTHORIZATION_POLICY, LINKERD_SERVER, PEER_AUTHENTICATION, SERVICE_PROFILE, VIRTUAL_SERVICE } from "./engine/kinds";
import {
  istioMembership,
  linkerdMembership,
  namespaceShape,
  podShape,
  type IstioMembership,
  type LinkerdMembership,
  type NamespaceShape,
  type PodShape,
} from "./engine/membership";
import { mtlsModeFor } from "./engine/mtls";
import { t } from "./i18n";
import { Discovery, Lists, meshConfig, type ListState, type MeshConfig } from "./store";

/** The kinds that get the section: pods and what owns a pod template. */
export function hasMeshSection(kind: Pick<KindRef, "group" | "kind">): boolean {
  return (kind.group === "" && kind.kind === "Pod") || (kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(kind.kind));
}

/** Whether Sextant's "Requests" section is on these details (Pods and the workloads whose pods the core can name). */
export function requestHealthApplies(kind: Pick<KindRef, "group" | "kind">): boolean {
  if (kind.group === "") return kind.kind === "Pod";
  return kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(kind.kind);
}

export const BLOCKS = { istio: "istioMembership", mtls: "mtls", authz: "whoMayCall", linkerd: "linkerdMembership" } as const;

const DECISION_TONE: Record<AuthzDecision, "success" | "danger" | "warning"> = { allowed: "success", denied: "danger", unknown: "warning", external: "warning" };

const oneNamespace = (name: string) => ({ kind: { group: "", version: "v1", kind: "Namespace" }, fieldSelector: `metadata.name=${name}` });

function istioBlock(m: IstioMembership, template: boolean): UiContent[] {
  const sentence = template ? (m.injection ? "membership.istio.injectedPods" : m.mode === "ambient" ? "membership.istio.ambient" : "membership.istio.noInjection") : `membership.istio.${m.mode}`;
  return [
    line(t(sentence)),
    m.optedOut ? line(t("membership.istio.optedOut")) : null,
    m.restartNeeded ? line(t("membership.istio.restart"), true) : null,
    fieldsOf([
      ["revision", m.revision],
      ["injection", m.injection && m.via ? t(`membership.via.${m.via}`) : null],
      ["proxyImage", m.proxyImage],
    ]),
  ];
}

function linkerdBlock(sextant: Sextant, m: LinkerdMembership, template: boolean, viz: ListState | undefined): UiContent[] {
  const on = m.inject === "enabled" || m.inject === "ingress";
  const sentence = template ? (on ? "membership.linkerd.injectedPods" : "membership.linkerd.noInjection") : `membership.linkerd.${m.mode}`;
  return [
    line(t(sentence)),
    m.restartNeeded ? line(t("membership.linkerd.restart"), true) : null,
    fieldsOf([
      ["linkerdInject", m.inject ? t(`membership.injectOn.${m.via ?? "pod"}`, { value: m.inject }) : null],
      ["controlPlane", m.controlPlane],
      ["proxyVersion", m.proxyVersion],
    ]),
    // Golden metrics (#212) are in Sextant's "Requests" section; here only linkerd-viz's presence is checked, to point
    // there.
    viz && viz.status === "ready" && viz.items.length > 0 ? el("p", "sx-muted mesh-muted", t("linkerdViz"), " ", showRequests(sextant)) : null,
  ];
}

/** The built-in "Show request metrics": opens, scrolls to and focuses Sextant's Requests section of the same panel. */
function showRequests(sextant: Sextant): HTMLButtonElement {
  const button = el("button", "sx-link", t("showRequests"));
  button.type = "button";
  button.addEventListener("click", () => void sextant.ui.revealSection("requestHealth").catch(() => undefined));
  return button;
}

function mtlsBlock(sextant: Sextant, config: MeshConfig, namespace: string, labels: Record<string, string>): UiContent[] {
  if (config.loading) return [muted(t("loading"))];
  const r = mtlsModeFor(namespace, labels, config.peerAuthentications);
  return [
    fieldsOf([["mtlsMode", r.mode]]),
    line(t(`mtls.meaning.${r.mode}`)),
    el("p", "mesh-line", r.policy ? t(`mtls.source.${r.source}`, { name: r.policy.name }) : t("mtls.source.default"), r.policy ? " " : null, r.policy ? meshLink(sextant, r.policy) : null),
    r.ports.length > 0 ? table([t("columns.port"), t("columns.mtlsMode")], r.ports.map((p) => ({ cells: [p.port, p.mode] }))) : null,
  ];
}

/** What the caller form holds (kept while the details show the object, as the built-in's component state). */
export interface CallerForm {
  namespace: string;
  serviceAccount: string;
  method: string;
  path: string;
  port: string;
  ip: string;
  remoteIp: string;
}

export const EMPTY_CALLER: CallerForm = { namespace: "", serviceAccount: "", method: "", path: "", port: "", ip: "", remoteIp: "" };

export function callerOf(form: CallerForm): Caller {
  return {
    namespace: form.namespace.trim() || undefined,
    serviceAccount: form.serviceAccount.trim() || undefined,
    method: form.method.trim() || undefined,
    path: form.path.trim() || undefined,
    port: /^\d+$/.test(form.port.trim()) ? Number(form.port.trim()) : undefined,
    ip: form.ip.trim() || undefined,
    remoteIp: form.remoteIp.trim() || undefined,
  };
}

function callerField(key: keyof CallerForm, form: CallerForm, onChange: (key: keyof CallerForm, value: string) => void): HTMLElement {
  const input = el("input", "");
  input.type = "text";
  input.value = form[key];
  input.spellcheck = false;
  input.autocomplete = "off";
  input.dataset.field = `caller.${key}`;
  input.addEventListener("input", () => onChange(key, input.value));
  return el("label", "gw-check__field", el("span", "gw-check__label", t(`authz.caller.${key}`)), input);
}

function whoMayCallBlock(
  sextant: Sextant,
  config: MeshConfig,
  namespace: string,
  labels: Record<string, string>,
  form: CallerForm,
  onChange: (key: keyof CallerForm, value: string) => void,
): UiContent[] {
  if (config.loading) return [muted(t("loading"))];
  const result = whoMayCall(namespace, labels, config.authorizationPolicies, callerOf(form));
  const keys: (keyof CallerForm)[] = ["namespace", "serviceAccount", "method", "path", "port", "ip", "remoteIp"];
  const decision = el(
    "div",
    "mesh-decision",
    ui.status(t(`authz.decision.${result.decision}`), DECISION_TONE[result.decision]),
    el("span", "mesh-line", t(`authz.reason.${result.reason}`, { name: result.by?.ref.name ?? "", rule: (result.by?.rule ?? 0) + 1 })),
  );
  decision.setAttribute("role", "status");
  return [
    muted(t("authz.callerHint")),
    el("div", "mesh-caller", keys.map((k) => callerField(k, form, onChange))),
    decision,
    result.verdicts.length > 0
      ? table(
          [t("columns.policy"), t("columns.action"), t("columns.matches"), t("columns.notEvaluated")],
          result.verdicts.map((v) => ({
            cells: [meshLink(sextant, v.ref, undefined, namespace), v.dryRun ? t("authz.dryRunAction", { action: v.action }) : v.action, t(`authz.match.${v.match}`), v.unknown.join(", ")],
          })),
        )
      : null,
    result.notEvaluated.length > 0
      ? el("p", "sx-muted mesh-muted", t("authz.targetRefSkipped"), " ", links(result.notEvaluated.map((r) => meshLink(sextant, r, undefined, namespace))))
      : null,
  ];
}

/** The served kinds the section asks about. */
export interface Served {
  istio: boolean;
  linkerd: boolean;
  authz: boolean;
}

/** Which blocks show: the same applicability decides the blocks drawn and whether the namespace is read. */
export function membershipView(pod: PodShape, ns: NamespaceShape | undefined, template: boolean, served: Served) {
  const istio = istioMembership(pod, ns, template);
  const linkerd = linkerdMembership(pod, ns, template);
  const showIstio = served.istio || istio.mode !== "none";
  const inIstio = istio.mode !== "none" || istio.injection;
  return {
    istio,
    linkerd,
    showIstio,
    showLinkerd: served.linkerd || linkerd.mode !== "none",
    showMtls: showIstio && served.istio && inIstio,
    showAuthz: showIstio && served.authz && inIstio,
  };
}

interface State {
  ref: ObjectRef;
  obj: KubeObject;
  /** The namespace as last read (used while every block is closed). */
  lastNamespace?: NamespaceShape;
  caller: CallerForm;
}

/** The section of the object as it is drawn now; `null` while it is not shown. */
function sectionView(sextant: Sextant, state: State, blocks: Blocks, lists: Lists, discovery: Discovery, onCaller: (key: keyof CallerForm, value: string) => void): UiContent[] | null {
  const { ref, obj } = state;
  const kinds = discovery.get();
  const served = (k: Pick<KindRef, "group" | "kind">) => discovery.served(k);
  const supported: Served = {
    istio: !!kinds && (served(PEER_AUTHENTICATION) || served(VIRTUAL_SERVICE)),
    linkerd: !!kinds && (served(LINKERD_SERVER) || served(SERVICE_PROFILE)),
    authz: !!kinds && served(AUTHORIZATION_POLICY),
  };
  const template = ref.kind.kind !== "Pod";
  const pod = podShape(obj, template);
  const hasProxy = [...pod.containers, ...pod.initContainers].some((c) => c.name === "istio-proxy" || c.name === "linkerd-proxy");
  if (!(supported.istio || supported.linkerd || hasProxy)) return null;
  const namespace = obj.metadata.namespace ?? "";
  // The namespace is watched while a block the last reading shows is open.
  const cached = membershipView(pod, state.lastNamespace, template, supported);
  const active = (
    [
      [cached.showIstio, BLOCKS.istio],
      [cached.showLinkerd, BLOCKS.linkerd],
      [cached.showMtls, BLOCKS.mtls],
      [cached.showAuthz, BLOCKS.authz],
    ] as const
  ).some(([visible, id]) => visible && blocks.peek(id));
  let ns = state.lastNamespace;
  if (active && namespace) {
    const watched = lists.get(oneNamespace(namespace));
    if (watched.status === "ready") {
      ns = namespaceShape(watched.items[0]);
      state.lastNamespace = ns;
    }
  }
  const view = membershipView(pod, ns, template, supported);
  const config = () => meshConfig(lists, kinds);
  const on = view.linkerd.inject === "enabled" || view.linkerd.inject === "ingress";
  const meshed = view.linkerd.mode !== "none" || (template && on);
  return [
    view.showIstio ? block(blocks, BLOCKS.istio, t("blocks.istioMembership"), () => istioBlock(view.istio, template)) : null,
    view.showMtls ? block(blocks, BLOCKS.mtls, t("blocks.mtls"), () => mtlsBlock(sextant, config(), namespace, pod.labels)) : null,
    view.showAuthz ? block(blocks, BLOCKS.authz, t("blocks.whoMayCall"), () => whoMayCallBlock(sextant, config(), namespace, pod.labels, state.caller, onCaller)) : null,
    view.showLinkerd
      ? block(blocks, BLOCKS.linkerd, t("blocks.linkerdMembership"), () =>
          linkerdBlock(sextant, view.linkerd, template, meshed && requestHealthApplies(ref.kind) ? lists.get(oneNamespace("linkerd-viz")) : undefined),
        )
      : null,
  ];
}

const nodesOf = (content: readonly UiContent[]): Node[] => {
  const out: Node[] = [];
  const add = (c: UiContent) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else out.push(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : (c as Node));
  };
  content.forEach(add);
  return out;
};

/** Starts the details section `membership` on the object in the context. */
export function startMembership(sextant: Sextant, root: HTMLElement): () => void {
  let state: State | null = null;
  let stopped = false;
  let hidden: boolean | undefined;
  const schedule = batched(() => render());
  const memory = new BlockMemory(sextant, schedule);
  const lists = new Lists(sextant, schedule);
  const discovery = new Discovery(sextant, schedule);
  const setHidden = (value: boolean) => {
    if (hidden === value) return;
    hidden = value;
    void sextant.ui.setHidden(value).catch(() => undefined);
  };
  const onCaller = (key: keyof CallerForm, value: string) => {
    if (!state) return;
    state.caller = { ...state.caller, [key]: value };
    schedule();
  };
  function render(): void {
    if (stopped || !state) return;
    lists.begin();
    const content = sectionView(sextant, state, memory, lists, discovery, onCaller);
    lists.end();
    if (content === null) {
      root.replaceChildren();
      setHidden(true);
      return;
    }
    redraw(root, nodesOf(content));
    setHidden(false);
  }
  const stopFollowing = followShown(
    sextant,
    (ref, obj) => {
      const same = state && state.ref.kind.kind === ref.kind.kind && state.ref.namespace === ref.namespace && state.ref.name === ref.name;
      if (!same) {
        memory.reset();
        state = { ref, obj, caller: EMPTY_CALLER };
      } else state = { ...state!, ref, obj };
      render();
    },
    (err) => {
      state = null;
      lists.stop();
      root.replaceChildren(ui.errorState(errorText(err)));
      setHidden(false);
    },
    () => {
      state = null;
      lists.stop();
      root.replaceChildren();
      setHidden(true);
    },
  );
  const offBlocks = sextant.onContextChange(() => {
    const kindsMoved = discovery.follow();
    if (memory.follow() || kindsMoved) schedule();
  });
  return () => {
    stopped = true;
    stopFollowing();
    offBlocks();
    lists.stop();
  };
}
