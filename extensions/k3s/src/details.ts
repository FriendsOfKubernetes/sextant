// The details sections (the manifest's `contributes.detailsSections`), as the built-in view drew them (ADR-0123):
//   `k3s` on a HelmChart        — the state with its Job (helm-controller's conditions, else the Job's outcome), what
//                                 it installs and where, the Addon that deployed it, its HelmChartConfig, the install
//                                 Job with its attempts and "Logs" (the pods labelled `helmcharts.helm.cattle.io/chart=
//                                 <name>`, in one merged tab), the Secrets its values come from (names and key names
//                                 only) and its values, masked (mask.ts) and folded;
//   `k3s` on a HelmChartConfig  — the HelmChart it overrides (the one of its name) and its values, masked and folded;
//   `k3s` on an Addon           — the manifest file and its checksum;
//   `k3s` on an ETCDSnapshotFile — node, storage, location without credentials, size, times, the error;
//   `k3s-node` on a Node        — the distribution, version, role, what told it, the addresses k3s recorded, and the
//                                 node's arguments. Sextant shows the section only on nodes a condition picks
//                                 (`when`); the frame hides it again where the node tells no distribution after all.
// Sextant gives an extension neither a node's `node-args` nor a HelmChart's `valuesContent` and `set`
// (`without_inline_secrets`, ADR-0123): the frame says so where the built-in view showed them masked, and masks what
// it does get (a HelmChart's `values`, a HelmChartConfig's `set`) with the built-in rules.
// The sections have no heading of their own (`heading: false`), as the built-in ones had none; their blocks open and
// close in Sextant's own memory of details sections (`context.blocks`, `ui.setBlockOpen`). A HelmChart's Jobs (≤
// `MAX_CHART_JOBS`, by the chart label in its namespace) and its HelmChartConfig, and a HelmChartConfig's HelmChart,
// are watched while the section shows, by name (`metadata.name=`), as the built-in view watched them. The frame reads
// the shown object again whenever its resourceVersion changes. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { stringify } from "yaml";
import { clip, dateTime, element, errorText, link, note, remark, sizeText } from "./dom";
import { t } from "./i18n";
import { hiddenPaths, maskedSet, maskedValuesContent, maskValues } from "./mask";
import {
  ADDON,
  addonChecksumOf,
  addonOwnerOf,
  addonSourceOf,
  CHART_LABEL,
  CHART_TONE,
  chartFailureOf,
  chartInfoOf,
  chartReferencesOf,
  chartStateOf,
  configTargetOf,
  ETCD_SNAPSHOT,
  HELM_CHART,
  HELM_CHART_CONFIG,
  isKind,
  JOB,
  jobInfoOf,
  jobOfChart,
  NODE,
  nodeDistributionOf,
  SNAPSHOT_TONE,
  snapshotOf,
  snapshotStateOf,
  valuesSecretsOf,
  type JobState,
  type KindRef,
} from "./model";

/** A chart's Jobs the watch keeps at most, as the built-in view's list. */
export const MAX_CHART_JOBS = 20;

export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
export const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
export const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };

/** The ids of the blocks, in Sextant's memory of the sections. */
export const JOB_BLOCK = "job";
export const SECRETS_BLOCK = "valuesSecrets";
export const VALUES_BLOCK = "values";
export const DISTRIBUTION_BLOCK = "distribution";
export const ARGS_BLOCK = "args";

/** A list watched while the section shows: its objects, whether the first answer came, whether it failed or was cut. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** The blocks of a section: whether one is open, and `toggle`, which remembers a change and draws again. */
export interface Blocks {
  isOpen(id: string): boolean;
  toggle(id: string, open: boolean): void;
}

/** Every block open, nothing remembered (the views drawn on their own). */
export const ALL_OPEN: Blocks = { isOpen: () => true, toggle: () => undefined };

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

/** A titled block as the built-in view's: open unless the user closed it, closable with its title. */
function block(blocks: Blocks, id: string, title: string, content: UiContent, actions?: HTMLElement[]): HTMLElement {
  const node = ui.block(title, content, {
    collapsible: true,
    collapsed: !blocks.isOpen(id),
    onToggle: (open) => blocks.toggle(id, open),
    ...(actions ? { actions } : {}),
  });
  node.dataset.block = id;
  return node;
}

/** `ui.fields` labelled from `fields.<key>`. */
const fieldsOf = (rows: readonly (readonly [string, UiContent])[]): HTMLElement => ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));

/** A small table, or nothing without rows (as the built-in `table`). */
/** A table whose columns resize and are remembered under `id` (the built-in table's own word), `nowrap` marking the columns kept on one line; nothing without rows. */
const tableOf = (sextant: Sextant, id: string, nowrap: boolean[], headers: string[], rows: UiContent[][], label: string): HTMLElement | null =>
  rows.length > 0 ? ui.table(headers, rows, { label, id, sextant, nowrap }) : null;

const JOB_TONE: Record<JobState, "success" | "warning" | "danger" | "muted"> = { complete: "success", running: "warning", failed: "danger", pending: "muted" };

/** A HelmChart's state in words, coloured; helm-controller's message as its tooltip. */
export function chartStateText(chart: KubeObject, job?: KubeObject): HTMLElement {
  const state = chartStateOf(chart, job);
  const node = ui.status(t(`chartState.${state}`), CHART_TONE[state]);
  const failure = chartFailureOf(chart, job);
  if (failure) node.title = failure;
  return node;
}

/** What the views read of a list watched while the section shows (the built-in `Listed`). */
interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
}

const listedOf = (live: Live | undefined): Listed =>
  live ? { items: live.items, loading: !live.ready, unavailable: live.failed } : { items: [], loading: false, unavailable: true };

/** A HelmChart's or HelmChartConfig's values (`valuesContent`, `values`, `set`), masked, folded behind a toggle. */
function valuesBlock(obj: KubeObject, blocks: Blocks): HTMLElement {
  const spec = (obj.spec ?? {}) as Record<string, unknown>;
  const hidden = hiddenPaths(obj);
  const contentHidden = hidden.includes("spec.valuesContent");
  const setHidden = hidden.includes("spec.set");
  const content = contentHidden ? "" : typeof spec.valuesContent === "string" ? maskedValuesContent(spec.valuesContent) : "";
  const values = spec.values && typeof spec.values === "object" && !Array.isArray(spec.values) ? stringify(maskValues(spec.values), { lineWidth: 0 }) : "";
  const set = setHidden ? [] : maskedSet(spec.set);
  const nothing = content === "" && values === "" && set.length === 0 && !contentHidden && !setHidden;
  const folded = (summary: string, text: string) =>
    element("details", { className: "k3s-values" }, element("summary", { textContent: summary }), element("pre", { className: "k3s-pre", textContent: clip(text) }));
  const body = nothing
    ? [remark(t("values.none"))]
    : present([
        remark(t("values.note")),
        content === undefined && remark(t("values.unreadable")),
        contentHidden && remark(t("values.contentHidden")),
        Boolean(content) && folded(t("values.showContent"), content!),
        values !== "" && folded(t("values.showValues"), values),
        setHidden && remark(t("values.setHidden")),
        set.length > 0 && folded(t("values.showSet"), set.join("\n")),
      ]);
  return block(blocks, VALUES_BLOCK, t("values.title"), body);
}

/** The Secrets `valuesSecrets` names, with the keys read from each (never a value); `id` the table whose widths Sextant keeps. */
function valuesSecrets(sextant: Sextant, id: string, obj: KubeObject, blocks: Blocks): HTMLElement | null {
  const ns = obj.metadata.namespace ?? null;
  const rows = valuesSecretsOf(obj).map((s) => [link(sextant, SECRET, s.name, ns), ui.chips(s.keys) ?? t("values.allKeys")]);
  if (rows.length === 0) return null;
  return block(blocks, SECRETS_BLOCK, t("values.secrets"), tableOf(sextant, id, [true, false], [t("values.secret"), t("values.keys")], rows, t("values.secrets")));
}

function jobBlock(sextant: Sextant, chart: KubeObject, jobs: Listed, blocks: Blocks): HTMLElement {
  const ns = chart.metadata.namespace ?? undefined;
  const name = chart.metadata.name || undefined;
  const job = jobOfChart(chart, jobs.items);
  const info = job ? jobInfoOf(job) : undefined;
  const jobName = chartInfoOf(chart).jobName;
  const selector = `${CHART_LABEL}=${name ?? ""}`;
  const logs =
    ns && name
      ? [ui.button(t("job.logs"), () => void sextant.ui.openLogs({ namespace: ns, labelSelector: selector, title: jobName }).catch(() => undefined), { icon: "logs" })]
      : undefined;
  const content = info
    ? fieldsOf([
        ["job", link(sextant, JOB, info.name, info.namespace)],
        ["jobState", ui.status(t(`jobState.${info.state}`), JOB_TONE[info.state])],
        ["failedPods", info.failed > 0 ? String(info.failed) : null],
        ["started", dateTime(info.startedAt)],
        ["completed", dateTime(info.completedAt)],
        ["failedAt", dateTime(info.failedAt)],
      ])
    : jobs.loading
      ? remark(t("loading"))
      : remark(t("job.none", { job: jobName }));
  return block(blocks, JOB_BLOCK, t("job.title"), [content, jobs.unavailable && !jobs.loading && remark(t("job.unavailable"))], logs);
}

export function chartView(sextant: Sextant, chart: KubeObject, jobsLive: Live | undefined, configLive: Live | undefined, blocks: Blocks = ALL_OPEN): Node[] {
  const ns = chart.metadata.namespace ?? null;
  const name = chart.metadata.name || undefined;
  const jobs = listedOf(jobsLive);
  const job = jobOfChart(chart, jobs.items);
  const config = configLive?.items[0];
  const info = chartInfoOf(chart);
  const refs = chartReferencesOf(chart);
  const owner = addonOwnerOf(chart);
  const state = chartStateOf(chart, job);
  const failure = chartFailureOf(chart, job);
  return present([
    state === "failed" && Boolean(failure) && note(clip(failure!), "danger"),
    state === "retrying" && note(t("hint.retrying"), "warning"),
    state === "applied" && remark(t("hint.applied")),
    state === "unknown" && remark(t("hint.unknown")),
    fieldsOf([
      ["state", chartStateText(chart, job)],
      ["chart", info.chart ?? null],
      ["repo", info.repo ?? null],
      ["version", info.version ?? null],
      ["targetNamespace", link(sextant, NAMESPACE, info.targetNamespace, null)],
      ["createNamespace", info.createNamespace ? t("yes") : null],
      ["bootstrap", info.bootstrap ? t("yes") : null],
      ["failurePolicy", info.failurePolicy ?? null],
      ["backOffLimit", String(info.backOffLimit)],
      ["timeout", info.timeout ?? null],
      ["jobImage", info.jobImage ?? null],
      ["authSecret", link(sextant, SECRET, refs.authSecret, ns)],
      ["repoCA", link(sextant, CONFIG_MAP, refs.repoCaConfigMap, ns)],
      ["registrySecret", link(sextant, SECRET, refs.registrySecret, ns)],
      ["addon", owner ? link(sextant, ADDON, owner.name, owner.namespace) : null],
      ["helmChartConfig", config ? link(sextant, HELM_CHART_CONFIG, name, ns) : null],
    ]),
    owner && remark(t("hint.bundled", { addon: owner.name })),
    jobBlock(sextant, chart, jobs, blocks),
    valuesSecrets(sextant, "chartValuesSecrets", chart, blocks),
    valuesBlock(chart, blocks),
  ]);
}

export function configView(sextant: Sextant, config: KubeObject, chartLive: Live | undefined, blocks: Blocks = ALL_OPEN): Node[] {
  const target = configTargetOf(config);
  const chart = chartLive?.items[0];
  const loading = chartLive !== undefined && !chartLive.ready;
  const spec = (config.spec ?? {}) as Record<string, unknown>;
  const failurePolicy = typeof spec.failurePolicy === "string" && spec.failurePolicy !== "" ? spec.failurePolicy : null;
  return present([
    fieldsOf([
      ["helmChart", chart ? link(sextant, HELM_CHART, target.name, target.namespace) : null],
      ["failurePolicy", failurePolicy],
    ]),
    !loading && !chart && note(t("config.noChart", { name: target.name, namespace: target.namespace }), "warning"),
    remark(t("config.hint")),
    valuesSecrets(sextant, "configValuesSecrets", config, blocks),
    valuesBlock(config, blocks),
  ]);
}

export function addonView(addon: KubeObject): Node[] {
  return [
    fieldsOf([
      ["source", addonSourceOf(addon) ?? null],
      ["checksum", addonChecksumOf(addon) ?? null],
    ]),
    remark(t("addon.hint")),
  ];
}

export function snapshotView(sextant: Sextant, obj: KubeObject): Node[] {
  const s = snapshotOf(obj);
  const state = snapshotStateOf(s);
  return present([
    Boolean(s.error) && note(clip(s.error!), "danger"),
    fieldsOf([
      ["snapshotState", ui.status(t(`snapshotState.${state}`), SNAPSHOT_TONE[state])],
      ["snapshotName", s.snapshotName ?? null],
      ["node", link(sextant, NODE, s.node, null)],
      ["storage", t(`storage.${s.storage}`)],
      ["bucket", s.bucket ?? null],
      ["location", s.location ?? null],
      ["size", sizeText(s.size) || null],
      ["created", dateTime(s.createdAt)],
      ["errorAt", dateTime(s.errorAt)],
    ]),
  ]);
}

/** Whether Sextant kept the node's arguments from the extension (they arrive as "", named in its annotation). */
export const argsHiddenByHost = (node: KubeObject, distribution: string): boolean =>
  hiddenPaths(node).includes(`metadata.annotations[${JSON.stringify(`${distribution}.io/node-args`)}]`);

/** A node's arguments: flag and value, a hidden one as "hidden"; what Sextant keeps from the extension, said so. */
function argsContent(sextant: Sextant, node: KubeObject, distribution: string): Node[] {
  if (argsHiddenByHost(node, distribution)) return [remark(t("node.argsHidden"))];
  const d = nodeDistributionOf(node);
  if (d.args === undefined) return [];
  if (d.args === null) return [remark(t("node.argsUnreadable"))];
  const rows = d.args.map((a) => [a.flag ?? "", a.hidden ? element("span", { className: "k3s-muted", textContent: t("node.hidden") }) : (a.value ?? "")]);
  return present([tableOf(sextant, "nodeArgs", [true, false], [t("node.flag"), t("node.value")], rows, t("node.args")), remark(t("node.argsNote"))]);
}

/** The "k3s" / "RKE2" block of a node; nothing on a node that tells no distribution. */
export function nodeView(sextant: Sextant, node: KubeObject, blocks: Blocks = ALL_OPEN): Node[] {
  const d = nodeDistributionOf(node);
  if (!d.distribution) return [];
  const roles = d.roles.map((r) => t(`role.${r}`));
  const content = present([
    fieldsOf([
      ["distribution", t(`distribution.${d.distribution}`)],
      ["version", d.version ?? null],
      ["nodeRole", t(d.server ? "node.server" : "node.agent")],
      ["roles", ui.chips(roles)],
      ["signals", ui.chips(d.signals.map((s) => t(`signal.${s}`)))],
      ["hostname", d.hostname ?? null],
      ["internalIp", d.internalIp ?? null],
      ["externalIp", d.externalIp ?? null],
      ["etcdMember", d.etcdMember ?? null],
    ]),
    (d.args !== undefined || argsHiddenByHost(node, d.distribution)) && block(blocks, ARGS_BLOCK, t("node.args"), argsContent(sextant, node, d.distribution)),
  ]);
  return [block(blocks, DISTRIBUTION_BLOCK, t(`distribution.${d.distribution}`), content)];
}

/** What a section watches besides its object, by name: a HelmChart's Jobs and HelmChartConfig, a HelmChartConfig's HelmChart. */
export function relatedWatches(obj: KubeObject, kind: { group: string; kind: string }): Record<string, Omit<WatchParams, "clusterId"> | null> {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  if (!ns || !name) return {};
  const byName = (k: KindRef) => ({ kind: k, namespaces: [ns], fieldSelector: `metadata.name=${name}`, maxObjects: 1 });
  if (isKind(kind, HELM_CHART)) return { jobs: { kind: JOB, namespaces: [ns], labelSelector: `${CHART_LABEL}=${name}`, maxObjects: MAX_CHART_JOBS }, config: byName(HELM_CHART_CONFIG) };
  if (isKind(kind, HELM_CHART_CONFIG)) {
    const target = configTargetOf(obj);
    return { chart: { kind: HELM_CHART, namespaces: [target.namespace], fieldSelector: `metadata.name=${target.name}`, maxObjects: 1 } };
  }
  return {};
}

/** The watches a section holds, by what they watch: started when first wanted, stopped when no longer. */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Omit<WatchParams, "clusterId"> | null>): Record<string, Live | undefined> {
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
          live.items = items;
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

/** The view of `contribution` for the shown object; `null` when it does not apply, `[]` when it has nothing to show. */
function viewOf(sextant: Sextant, contribution: string, ref: ObjectRef, obj: KubeObject, related: Record<string, Live | undefined>, blocks: Blocks): Node[] | null {
  if (contribution === "k3s") {
    if (isKind(ref.kind, HELM_CHART)) return chartView(sextant, obj, related.jobs, related.config, blocks);
    if (isKind(ref.kind, HELM_CHART_CONFIG)) return configView(sextant, obj, related.chart, blocks);
    if (isKind(ref.kind, ADDON)) return addonView(obj);
    if (isKind(ref.kind, ETCD_SNAPSHOT)) return snapshotView(sextant, obj);
  }
  if (contribution === "k3s-node" && isKind(ref.kind, NODE)) return nodeView(sextant, obj, blocks);
  return null;
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; the objects it names watched while it shows, and drawn again as they change. A section with nothing to
 * show (a node that tells no distribution) hides itself (`ui.setHidden`).
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let scheduled = false;
  let stopped = false;
  let hidden: boolean | undefined;
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
  const setHidden = (value: boolean) => {
    if (hidden === value) return;
    hidden = value;
    void sextant.ui.setHidden(value).catch(() => undefined);
  };

  const render = () => {
    if (!object || stopped) return;
    const { ref, obj } = object;
    const related = watches.want(relatedWatches(obj, ref.kind));
    const view = viewOf(sextant, contribution, ref, obj, related, blocks);
    // Drawn again on every change: the focus stays on the toggle of the block it was on.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const onToggle = document.activeElement?.classList.contains("sx-block__toggle") ?? false;
    if (view === null) root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
    else root.replaceChildren(...view);
    setHidden(view !== null && view.length === 0);
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
      object = { ref, obj: fresh };
      render();
    } catch (err) {
      if (attempt !== reading) return;
      root.replaceChildren(ui.errorState(errorText(err)));
      setHidden(false);
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
