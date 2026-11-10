// The details section `openshift` (the manifest's `contributes.detailsSections`) on the six OpenShift kinds, as Sextant's
// former built-in section (`src/features/openshift/details.tsx` with routeView, dcView, buildViews, otherViews):
//   Route            — whether a router admitted it (and why not, in the router's words), where it answers, its TLS
//                      termination with only whether each inline certificate field is set (the private key never
//                      reaches the extension: Sextant blanks it and names it in `sextant.dev/values-hidden`), its
//                      backends — each Service with its weight, its share of the requests and its pods ready, from the
//                      namespace's Services and pods watched while the details are open — and what each router says;
//   DeploymentConfig — its rollout state and why, replicas, latest version and its causes, strategy, selector, its
//                      triggers (an ImageChange trigger's ImageStreamTag linked to its ImageStream) and its rollouts:
//                      the ReplicationControllers labelled with its name, watched while that block is open (at most
//                      `MAX_RCS`), newest first, the first `MAX_LISTED`;
//   BuildConfig      — strategy and builder image, source (a Git URI without userinfo, query or fragment; an inline
//                      Dockerfile only as "set"; the source Secret by name), output, run policy, triggers by type (a
//                      webhook's secret never read) and its builds — labelled with its name, watched while that block
//                      is open (at most `MAX_BUILDS`), newest number first, the first `MAX_LISTED_BUILDS`;
//   Build            — its phase and why it failed, its BuildConfig, source revision, what started it, times and
//                      duration, output image, the build pod (`openshift.io/build.pod-name`, else the name the build
//                      controller gives it) with a "Build logs" button while it exists, and the controller's log snippet;
//   ImageStream      — its repositories, the lookup policy and its tags with the import errors;
//   Project          — its display name, description, requester, node selector and phase, and its Namespace.
// The section has no heading of its own, as the built-in one had none; its blocks open and close in Sextant's own
// memory of details sections (the context's `blocks`, `ui.setBlockOpen`). The frame reads the shown object again
// whenever its resourceVersion changes. Conditions, events and YAML are Sextant's own sections. The two actions are the
// manifest's (actions.ts).
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { code, dateTime, durationText, errorText, note, remark } from "./dom";
import { i18n, t } from "./i18n";
import {
  arr,
  BC_LABEL,
  bcPaused,
  bcTriggers,
  BUILD,
  BUILD_CONFIG,
  BUILD_TONE,
  buildConfigOf,
  buildDurationMs,
  buildNumber,
  buildOutput,
  buildPhase,
  buildPodName,
  buildReason,
  buildsOf,
  buildSource,
  buildStrategy,
  DC_NAME_LABEL,
  DC_TONE,
  dcCauses,
  dcReason,
  dcReplicas,
  dcState,
  dcStrategy,
  dcTriggers,
  DEPLOYMENT_CONFIG,
  failedImports,
  get,
  IMAGE_STREAM,
  imageStreamOf,
  isFailedBuild,
  isKind,
  labelValue,
  latestVersionOf,
  num,
  PHASE_TONE,
  PROJECT,
  projectInfo,
  record,
  REPLICATION_CONTROLLER,
  ROUTE,
  ROUTE_TONE,
  routeAdmissions,
  routeBackends,
  routeReason,
  routeState,
  routeTargetPort,
  routeTls,
  routeUrl,
  rolloutsOf,
  str,
  streamRepositories,
  streamTags,
  triggeredBy,
  type KindRef,
  type Ref,
  type RouteBackend,
} from "./model";
import { cleanText } from "./uri";

/** Rollouts listed in one view; the rest are counted. */
export const MAX_LISTED = 20;
/** Builds listed in one view; the rest are counted. */
export const MAX_LISTED_BUILDS = 20;
/** ReplicationControllers one DeploymentConfig's watch keeps (`revisionHistoryLimit` is 10 by default). */
export const MAX_RCS = 200;
/** Builds one BuildConfig's watch keeps (the history limits keep 5 + 5 by default). */
export const MAX_BUILDS = 500;

const core = (kind: string): KindRef => ({ group: "", version: "v1", kind });
const SECRET = core("Secret");
const SERVICE = core("Service");
const POD = core("Pod");
const NAMESPACE = core("Namespace");

/** A list watched for the view: its objects, whether the first answer came, whether it failed or was cut. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  /** More objects than the watch keeps (`maxObjects`). */
  truncated: boolean;
}

/** The blocks of the section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered. */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

/** A titled block as the built-in view's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent, actions?: HTMLElement[]): HTMLElement {
  const node = ui.block(title, content, { collapsible: true, collapsed: !blocks.isOpen(id), onToggle: (open) => blocks.toggle(id, open), actions });
  node.dataset.block = id;
  return node;
}

/** A link to an object's details in Sextant's panel; nothing without a name. */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null | undefined, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace: namespace ?? null, name }, text);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

const chips = (values: readonly (string | undefined)[]): HTMLElement | null => ui.chips(values);

/** A map's `key=value` pairs as chips (a selector). */
const mapChips = (value: unknown): HTMLElement | null => chips(Object.entries(record(value)).map(([k, v]) => `${k}=${String(v)}`));

/** A reference as text: `ImageStreamTag frontend:latest`, `DockerImage quay.io/…`. */
export const refText = (ref: Ref | undefined): string | undefined => (ref ? (ref.kind ? `${ref.kind} ${ref.name}` : ref.name) : undefined);

/** An ImageStreamTag reference as a link to its ImageStream; another reference as text. */
function imageRef(sextant: Sextant, ref: Ref | undefined, ns: string | null): UiContent {
  const stream = imageStreamOf(ref);
  return stream ? link(sextant, IMAGE_STREAM, stream, ref?.namespace ?? ns, ref?.name) : refText(ref);
}

/** A table as the built-in view's: none without rows (the block's own remark says why). */
/** A table whose columns resize and are remembered under `id` (the built-in table's own word), `nowrap` marking the columns kept on one line. */
const tableOf = (sextant: Sextant, id: string, nowrap: boolean[], headers: string[], rows: UiContent[][], label: string): HTMLElement | null =>
  rows.length === 0 ? null : ui.table(headers, rows, { label, id, sextant, nowrap });

const yes = (value: boolean): string => (value ? t("yes") : t("no"));
const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

// ---------- States ----------

/** A Route's admission in its tone, why no router admitted it on hover. */
export function routeStateText(obj: KubeObject): HTMLElement {
  const state = routeState(obj);
  const node = ui.status(t(`routeState.${state}`), ROUTE_TONE[state]);
  const why = routeReason(obj);
  if (why) node.title = why;
  return node;
}

/** A DeploymentConfig's rollout state in its tone, why on hover. */
export function dcStateText(obj: KubeObject): HTMLElement {
  const state = dcState(obj);
  const node = ui.status(t(`dcState.${state}`), DC_TONE[state]);
  const why = dcReason(obj);
  if (why) node.title = why;
  return node;
}

/** A Build's phase in its tone, why it failed on hover. */
export function buildPhaseText(obj: KubeObject): HTMLElement {
  const phase = buildPhase(obj);
  const node = ui.status(phase, BUILD_TONE(phase));
  const why = buildReason(obj);
  if (why) node.title = why;
  return node;
}

/** A share of the requests in the UI language: "80%", "80 %", "%80"; one decimal below 1%. */
export function percentText(percent: number): string {
  const digits = percent > 0 && percent < 1 ? 1 : 0;
  return t("percent", { value: i18n().formatNumber(percent, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }) });
}

/** "frontend (80%), canary (20%)" joined in the UI language; one backend alone is its name. */
export function backendsText(backends: RouteBackend[]): string {
  if (backends.length === 1) return backends[0]!.name;
  return backends.map((b) => t("backendShare", { name: b.name, percent: percentText(b.percent) })).join(t("list.separator"));
}

// ---------- Route ----------

const servicePods = (svc: KubeObject, pods: readonly KubeObject[], ns: string): KubeObject[] => {
  // A Service selects the pods of its namespace whose labels hold every pair of its selector; none without one (and an
  // ExternalName Service none), as Sextant's own `serviceInfo` and `selectPods` read it.
  const selector = str(get(svc, "spec", "type")) === "ExternalName" ? {} : record(get(svc, "spec", "selector"));
  const pairs = Object.entries(selector).map(([k, v]) => [k, String(v)] as const);
  if (pairs.length === 0) return [];
  return pods.filter((p) => p.metadata.namespace === ns && pairs.every(([k, v]) => record(p.metadata.labels)[k] === v));
};

const isReady = (pod: KubeObject): boolean => arr(get(pod, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");

function routeView(sextant: Sextant, obj: KubeObject, related: Related, blocks: Blocks): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const state = routeState(obj);
  const reason = routeReason(obj);
  const tls = routeTls(obj);
  const target = routeTargetPort(obj);
  const set = (value: boolean) => (value ? t("set") : null);
  const services = related.services;
  const pods = related.pods;
  const rows: [string, UiContent][] = [
    ["status", routeStateText(obj)],
    ["url", routeUrl(obj)],
    ["path", str(get(obj, "spec", "path"))],
    ["wildcardPolicy", str(get(obj, "spec", "wildcardPolicy"))],
    ["targetPort", target === undefined ? t("allPorts") : String(target)],
    ["termination", tls ? tls.termination : t("noTls")],
    ["insecure", tls ? (tls.insecure ?? t("insecureDefault")) : null],
    ["certificate", tls ? set(tls.certificate) : null],
    ["key", tls ? set(tls.key) : null],
    ["caCertificate", tls ? set(tls.caCertificate) : null],
    ["destinationCACertificate", tls ? set(tls.destinationCACertificate) : null],
    ["externalCertificate", tls ? link(sextant, SECRET, tls.externalCertificate, ns) : null],
  ];
  const backends = routeBackends(obj).map((b): UiContent[] => {
    const svc = services?.items.find((s) => s.metadata.name === b.name);
    let ready = "";
    if (svc && ns && pods?.ready && !pods.failed) {
      const selected = servicePods(svc, pods.items, ns);
      ready = t("podsReady", { ready: selected.filter(isReady).length, total: selected.length });
    } else if (services?.ready && !services.failed && !svc) ready = t("serviceMissing");
    return [link(sextant, SERVICE, b.name, ns), String(b.weight), percentText(b.percent), ready];
  });
  const routers = routeAdmissions(obj).map((a): UiContent[] => [
    a.routerName,
    a.host ?? "",
    ui.status(t(`admitted.${a.admitted === "True" ? "yes" : a.admitted === "False" ? "no" : "unknown"}`), a.admitted === "True" ? "success" : a.admitted === "False" ? "danger" : "warning"),
    a.message || a.reason || "",
    dateTime(a.since),
  ]);
  const backendHeads = ["service", "weight", "share", "pods"].map((h) => t(`backends.${h}`));
  const routerHeads = ["router", "host", "admitted", "message", "since"].map((h) => t(`routers.${h}`));
  return present([
    state === "rejected" && reason ? note(reason, "danger") : null,
    state === "pending" ? note(t("routePending"), "warning") : null,
    fieldsOf(rows),
    tls?.key ? remark(t("keyHidden")) : null,
    block(blocks, "backends", t("backends.title"), [tableOf(sextant, "routeBackends", [true, true, true, true], backendHeads, backends, t("backends.title")), backends.length === 0 && remark(t("backends.none"))]),
    block(blocks, "routers", t("routers.title"), [tableOf(sextant, "routers", [true, false, true, false, true], routerHeads, routers, t("routers.title")), routers.length === 0 && remark(t("routers.none"))]),
  ]);
}

// ---------- DeploymentConfig ----------

function dcView(sextant: Sextant, obj: KubeObject, related: Related, blocks: Blocks): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const state = dcState(obj);
  const reason = dcReason(obj);
  const replicas = dcReplicas(obj);
  const strategy = dcStrategy(obj);
  const optional = (value: boolean | undefined) => (value === undefined ? "" : yes(value));
  const rows: [string, UiContent][] = [
    ["status", dcStateText(obj)],
    ["replicas", t("readyOfDesired", { ready: replicas.ready, desired: replicas.desired })],
    ["updated", String(replicas.updated)],
    ["available", String(replicas.available)],
    ["latestVersion", String(latestVersionOf(obj))],
    ["causes", chips(dcCauses(obj))],
    ["strategy", strategy.type],
    ["maxSurge", strategy.maxSurge],
    ["maxUnavailable", strategy.maxUnavailable],
    ["timeoutSeconds", strategy.timeoutSeconds?.toString()],
    ["hooks", chips(strategy.hooks)],
    ["selector", mapChips(get(obj, "spec", "selector"))],
  ];
  const triggers = dcTriggers(obj).map((tr): UiContent[] => {
    const stream = imageStreamOf(tr.from);
    const fromNs = tr.from?.namespace ?? ns;
    return [
      tr.type,
      stream ? link(sextant, IMAGE_STREAM, stream, fromNs, tr.from?.name) : (refText(tr.from) ?? ""),
      optional(tr.automatic),
      [tr.containers.join(", "), tr.lastTriggeredImage].filter(Boolean).join("\n"),
    ];
  });
  const rcs = related.rcs;
  const rollouts = rolloutsOf(obj, rcs?.items ?? []);
  const listed = rollouts.slice(0, MAX_LISTED).map((r): UiContent[] => [
    link(sextant, REPLICATION_CONTROLLER, r.name, ns),
    r.version === undefined ? "" : String(r.version),
    r.phase ? ui.status(r.phase, PHASE_TONE(r.phase)) : "",
    t("podsReady", { ready: r.ready, total: r.replicas }),
    r.reason ?? "",
    dateTime(r.created),
  ]);
  const loading = rcs !== undefined && !rcs.ready;
  const failed = rcs?.failed === true;
  const triggerHeads = ["type", "image", "automatic", "containers"].map((h) => t(`triggers.${h}`));
  const rolloutHeads = ["controller", "version", "phase", "pods", "reason", "created"].map((h) => t(`rollouts.${h}`));
  return present([
    state === "failed" && reason ? note(reason, "danger") : null,
    (state === "progressing" || state === "unavailable") && reason ? note(reason, "warning") : null,
    state === "paused" ? remark(t("pausedNote")) : null,
    fieldsOf(rows),
    block(blocks, "triggers", t("triggers.title"), [tableOf(sextant, "dcTriggers", [true, false, true, false], triggerHeads, triggers, t("triggers.title")), triggers.length === 0 && remark(t("triggers.none"))]),
    block(blocks, "rollouts", t("rollouts.title"), [
      loading && remark(t("loading")),
      failed && remark(t("listError")),
      tableOf(sextant, "rollouts", [true, true, true, true, false, true], rolloutHeads, listed, t("rollouts.title")),
      rcs !== undefined && !loading && !failed && rollouts.length === 0 && remark(t("rollouts.none")),
      rollouts.length > MAX_LISTED && remark(t("more", { count: rollouts.length - MAX_LISTED })),
      rcs?.truncated === true && remark(t("truncated")),
    ]),
  ]);
}

// ---------- BuildConfig and Build ----------

function buildConfigView(sextant: Sextant, obj: KubeObject, related: Related, blocks: Blocks): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const source = buildSource(obj);
  const strategy = buildStrategy(obj);
  const listed = related.builds;
  const builds = buildsOf(obj, listed?.items ?? []);
  const rows: [string, UiContent][] = [
    ["strategy", strategy.type],
    ["builderImage", imageRef(sextant, strategy.from, ns)],
    ["sourceType", source.type],
    ["gitUri", source.uri],
    ["gitRef", source.ref],
    ["contextDir", source.contextDir],
    ["dockerfile", source.dockerfile ? t("set") : null],
    ["sourceSecret", link(sextant, SECRET, source.secret, ns)],
    ["output", imageRef(sextant, buildOutput(obj), ns)],
    ["runPolicy", str(get(obj, "spec", "runPolicy"))],
    ["lastVersion", num(get(obj, "status", "lastVersion"))?.toString()],
    ["triggers", chips(bcTriggers(obj).map((tr) => (tr.from ? `${tr.type}: ${tr.from.name}` : tr.type)))],
  ];
  const buildRows = builds.slice(0, MAX_LISTED_BUILDS).map((b): UiContent[] => [
    link(sextant, BUILD, b.metadata.name, ns),
    buildPhaseText(b),
    durationText(buildDurationMs(b)),
    dateTime(str(get(b, "status", "startTimestamp"))),
    isFailedBuild(b) ? (buildReason(b) ?? "") : "",
  ]);
  const loading = listed !== undefined && !listed.ready;
  const failed = listed?.failed === true;
  const heads = ["name", "phase", "duration", "started", "reason"].map((h) => t(`builds.${h}`));
  return present([
    bcPaused(obj) ? remark(t("buildPausedNote")) : null,
    fieldsOf(rows),
    block(blocks, "builds", t("builds.title"), [
      loading && remark(t("loading")),
      failed && remark(t("listError")),
      tableOf(sextant, "builds", [true, true, true, true, false], heads, buildRows, t("builds.title")),
      listed !== undefined && !loading && !failed && builds.length === 0 && remark(t("builds.none")),
      builds.length > MAX_LISTED_BUILDS && remark(t("more", { count: builds.length - MAX_LISTED_BUILDS })),
      listed?.truncated === true && remark(t("truncated")),
    ]),
  ]);
}

function buildView(sextant: Sextant, obj: KubeObject, related: Related, blocks: Blocks): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const podName = buildPodName(obj);
  const pod = related.pod?.items.find((p) => p.metadata.name === podName);
  const podLoading = related.pod !== undefined && !related.pod.ready;
  const source = buildSource(obj);
  const reason = buildReason(obj);
  const snippet = cleanText(str(get(obj, "status", "logSnippet")));
  const rows: [string, UiContent][] = [
    ["status", buildPhaseText(obj)],
    ["reason", str(get(obj, "status", "reason"))],
    ["buildConfig", link(sextant, BUILD_CONFIG, buildConfigOf(obj), ns)],
    ["number", buildNumber(obj)?.toString()],
    ["strategy", buildStrategy(obj).type],
    ["gitUri", source.uri],
    ["commit", str(get(obj, "spec", "revision", "git", "commit"))],
    ["triggeredBy", chips(triggeredBy(obj))],
    ["started", dateTime(str(get(obj, "status", "startTimestamp")))],
    ["completed", dateTime(str(get(obj, "status", "completionTimestamp")))],
    ["duration", durationText(buildDurationMs(obj))],
    ["output", imageRef(sextant, buildOutput(obj), ns)],
    ["outputImage", str(get(obj, "status", "outputDockerImageReference"))],
    ["imageDigest", str(get(obj, "status", "output", "to", "imageDigest"))],
    ["buildPod", link(sextant, POD, podName, ns)],
  ];
  const phase = buildPhase(obj);
  const openLogs =
    pod && ns
      ? [ui.button(t("logs.open"), () => void sextant.ui.openLogs({ namespace: ns, pod: pod.metadata.name }).catch((err: unknown) => sextant.reportError(err)), { icon: "logs" })]
      : undefined;
  return present([
    isFailedBuild(obj) && reason ? note(reason, "danger") : null,
    fieldsOf(rows),
    block(
      blocks,
      "logs",
      t("logs.title"),
      [!pod && !podLoading && remark(phase === "New" ? t("logs.notYet") : t("logs.gone")), code(snippet)],
      openLogs,
    ),
  ]);
}

// ---------- ImageStream and Project ----------

/** `sha256:` and the first 12 hex digits of an image's digest. */
export const shortDigest = (image: string | undefined): string => (image ? image.replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1") : "");

function imageStreamView(sextant: Sextant, obj: KubeObject, blocks: Blocks): Node[] {
  const repos = streamRepositories(obj);
  const tags = streamTags(obj);
  const failed = failedImports(obj);
  const rows: [string, UiContent][] = [
    ["repository", repos.internal],
    ["publicRepository", repos.public],
    ["lookupLocal", yes(get(obj, "spec", "lookupPolicy", "local") === true)],
  ];
  const tagRows = tags.map((tag): UiContent[] => [
    tag.name,
    refText(tag.from) ?? "",
    tag.dockerImageReference ? shortDigest(tag.image) : "",
    dateTime(tag.created),
    yes(tag.scheduled),
    tag.importError ? (tag.importError.message ?? tag.importError.reason ?? "") : t("imagesHeld", { count: tag.history }),
  ]);
  const heads = ["tag", "from", "image", "created", "scheduled", "state"].map((h) => t(`tags.${h}`));
  return present([
    failed.length > 0 ? note(t("importFailingNote", { count: failed.length }), "danger") : null,
    fieldsOf(rows),
    block(blocks, "tags", t("tags.title"), [tableOf(sextant, "tags", [true, false, false, true, true, false], heads, tagRows, t("tags.title")), tags.length === 0 && remark(t("tags.none"))]),
  ]);
}

function projectView(sextant: Sextant, obj: KubeObject): Node[] {
  const info = projectInfo(obj);
  const rows: [string, UiContent][] = [
    ["displayName", info.displayName],
    ["description", info.description],
    ["requester", info.requester],
    ["nodeSelector", info.nodeSelector],
    ["phase", info.phase],
    ["namespace", link(sextant, NAMESPACE, obj.metadata.name, null)],
  ];
  return present([fieldsOf(rows)]);
}

// ---------- Related lists ----------

/** The lists a view reads besides its object. */
export interface Related {
  services?: Live;
  pods?: Live;
  rcs?: Live;
  builds?: Live;
  pod?: Live;
}

type Spec = Omit<WatchParams, "clusterId">;
const kindOf = (k: KindRef) => ({ group: k.group, version: k.version, kind: k.kind });

/**
 * What the view of `obj` watches, in the object's own namespace only, as the built-in view did: a Route's namespace's
 * Services and pods; a DeploymentConfig's ReplicationControllers (by its name label) while its Rollouts block is open; a
 * BuildConfig's Builds (by its name label, cut as the build controller cuts it) while its Builds block is open; a
 * Build's pod by name.
 */
export function relatedSpecs(kind: ObjectRef["kind"], obj: KubeObject, blocks: Blocks): Record<keyof Related, Spec | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  const none = { services: null, pods: null, rcs: null, builds: null, pod: null };
  if (!ns || !name) return none;
  if (isKind(kind, ROUTE)) return { ...none, services: { kind: kindOf(SERVICE), namespaces: [ns] }, pods: { kind: kindOf(POD), namespaces: [ns] } };
  if (isKind(kind, DEPLOYMENT_CONFIG))
    return {
      ...none,
      rcs: blocks.isOpen("rollouts") ? { kind: kindOf(REPLICATION_CONTROLLER), namespaces: [ns], labelSelector: `${DC_NAME_LABEL}=${labelValue(name)}`, maxObjects: MAX_RCS } : null,
    };
  if (isKind(kind, BUILD_CONFIG))
    return {
      ...none,
      builds: blocks.isOpen("builds") ? { kind: kindOf(BUILD), namespaces: [ns], labelSelector: `${BC_LABEL}=${labelValue(name)}`, maxObjects: MAX_BUILDS } : null,
    };
  if (isKind(kind, BUILD)) {
    const pod = buildPodName(obj);
    return { ...none, pod: pod ? { kind: kindOf(POD), namespaces: [ns], fieldSelector: `metadata.name=${pod}` } : null };
  }
  return none;
}

/** The view of `obj` of `kind`; `null` for a kind of no view here. */
export function sectionView(sextant: Sextant, kind: ObjectRef["kind"], obj: KubeObject, related: Related, blocks: Blocks): Node[] | null {
  if (isKind(kind, ROUTE)) return routeView(sextant, obj, related, blocks);
  if (isKind(kind, DEPLOYMENT_CONFIG)) return dcView(sextant, obj, related, blocks);
  if (isKind(kind, BUILD_CONFIG)) return buildConfigView(sextant, obj, related, blocks);
  if (isKind(kind, BUILD)) return buildView(sextant, obj, related, blocks);
  if (isKind(kind, IMAGE_STREAM)) return imageStreamView(sextant, obj, blocks);
  if (isKind(kind, PROJECT)) return projectView(sextant, obj);
  return null;
}

/** Watches by spec, each kept while it is wanted; a change of any calls `changed`. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Spec | null>): Record<string, Live | undefined> {
    const keep = new Set<string>();
    const related: Record<string, Live | undefined> = {};
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec) continue;
      const key = JSON.stringify(spec);
      keep.add(key);
      related[name] = (this.open.get(key) ?? this.start(key, spec)).live;
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return related;
  }

  private start(key: string, spec: Spec): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, failed: false, truncated: false };
    const settle = (failed: boolean) => {
      live.ready = true;
      live.failed = failed;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = [...items];
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
    this.want({});
  }
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes; what it
 * lists besides watched as `relatedSpecs` says, and drawn again as they change.
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let kind: ObjectRef["kind"] | null = null;
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

  const render = () => {
    if (!object || !kind || stopped) return;
    if (contribution !== "openshift") {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    const related = watches.want(relatedSpecs(kind, object, blocks)) as Related;
    const view = sectionView(sextant, kind, object, related, blocks);
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    root.replaceChildren(...(view ?? [ui.empty(t("common.nothingToShow", { view: contribution }))]));
    if (focused && onToggle) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
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
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      watches.stop();
      root.replaceChildren(ui.loading(t("loading")));
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
