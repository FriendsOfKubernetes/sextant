// The "CRUSH and OSDs" tab of a CephCluster: the CRUSH tree Rook placed its OSDs in (crush.ts), each OSD's state and
// what Rook lets change about it, the cluster's storage switches and device sets, and the purge Jobs of removed OSDs.
// Removing follows Rook's documentation (ceph-osd-mgmt.md "Remove an OSD"): stop the OSD (its Deployment scaled to 0
// with Rook's do-not-reconcile label, so the operator does not start it again), check the placement groups, then run
// Rook's purge Job, never forced, which refuses an OSD that is not safe to destroy. With Rook's toolbox, Ceph itself is
// asked too (commands.ts): `ceph osd ok-to-stop` before an OSD is stopped and `ceph osd safe-to-destroy` before it is
// removed, and an OSD can be marked out or in and reweighted — each such command confirmed by Sextant.
import type { KubeObject, MetricAnswer, ObjectRef, Sextant } from "@sextant/extension-sdk";
import {
  asYaml,
  autoRemovePatch,
  daemonReconcilePatch,
  deviceSetCountPatch,
  purgeJobName,
  purgeJobObject,
  replaceOsdPatch,
  storagePatch,
} from "./changes";
import { outputOf, run, verdictOf, WEIGHTS, type CommandId } from "./commands";
import { crushTree, osdMetrics, osdOf, type CrushNode, type Osd, type OsdMetrics } from "./crush";
import { badge, element, errorBox, formatBytes, formatPercent, objectLink, richText } from "./dom";
import { t } from "./i18n";
import { kindKey, servedKinds, watchLists, type LiveList } from "./live";
import { POD, type CephCluster } from "./rook";
import { changeButton, checkbox, field, numberInput, preview, readCount, select, showPreview, textInput } from "./ui";

export const DEPLOYMENT = { group: "apps", kind: "Deployment" };
export const JOB = { group: "batch", kind: "Job" };

type Job = KubeObject<Record<string, unknown>, { succeeded?: number; failed?: number; active?: number }>;

interface StorageSpec {
  useAllNodes?: boolean;
  useAllDevices?: boolean;
  deviceFilter?: string;
  allowDeviceClassUpdate?: boolean;
  allowOsdCrushWeightUpdate?: boolean;
  storageClassDeviceSets?: { name?: string; count?: number }[];
}

const deploymentRef = (namespace: string, name: string): ObjectRef => ({
  kind: { group: "apps", version: "v1", kind: "Deployment" },
  namespace,
  name,
});

function storageView(sextant: Sextant, ref: ObjectRef, cluster: CephCluster): HTMLElement {
  const spec = (cluster.spec ?? {}) as { storage?: StorageSpec; removeOSDsIfOutAndSafeToRemove?: boolean };
  const storage = spec.storage ?? {};
  const boxes = {
    useAllNodes: checkbox(t("osds.useAllNodes"), storage.useAllNodes ?? false),
    useAllDevices: checkbox(t("osds.useAllDevices"), storage.useAllDevices ?? false),
    allowDeviceClassUpdate: checkbox(t("osds.allowDeviceClassUpdate"), storage.allowDeviceClassUpdate ?? false),
    allowOsdCrushWeightUpdate: checkbox(t("osds.allowOsdCrushWeightUpdate"), storage.allowOsdCrushWeightUpdate ?? false),
  };
  const autoRemove = checkbox(t("osds.autoRemove"), spec.removeOSDsIfOutAndSafeToRemove ?? false);
  const filter = textInput(storage.deviceFilter, "^sd[b-z]");
  const build = () => {
    const switches: Record<string, unknown> = {};
    for (const [key, box] of Object.entries(boxes)) {
      if (box.input.checked !== ((storage as Record<string, unknown>)[key] ?? false)) switches[key] = box.input.checked;
    }
    const filterValue = filter.value.trim();
    if (filterValue !== (storage.deviceFilter ?? "")) switches.deviceFilter = filterValue === "" ? null : filterValue;
    const patch: Record<string, unknown> = Object.keys(switches).length ? { ...storagePatch(switches) } : { spec: {} };
    if (autoRemove.input.checked !== (spec.removeOSDsIfOutAndSafeToRemove ?? false)) {
      Object.assign(patch.spec as object, autoRemovePatch(autoRemove.input.checked).spec as object);
    }
    return Object.keys(patch.spec as object).length ? { ...patch, metadata: { resourceVersion: cluster.metadata.resourceVersion } } : null;
  };
  const previewSlot = element("div", {});
  const { button, status } = changeButton(t("change.apply"), async () => {
    const patch = build();
    if (!patch) throw new Error(t("change.nothing"));
    await sextant.resources.patch({ ref, patch: patch as never, patchType: "merge" });
  }, { primary: true });
  const form = element(
    "div",
    { className: "form" },
    element("p", { className: "muted", textContent: t("osds.storageIntro") }),
    boxes.useAllNodes.row,
    boxes.useAllDevices.row,
    field(t("osds.deviceFilter"), filter, t("osds.deviceFilterHint")),
    boxes.allowDeviceClassUpdate.row,
    element("p", { className: "muted hint", textContent: t("osds.allowDeviceClassUpdateHint") }),
    boxes.allowOsdCrushWeightUpdate.row,
    autoRemove.row,
    element("p", { className: "muted hint", textContent: t("osds.autoRemoveHint") }),
  );
  const refresh = () => {
    const patch = build();
    showPreview(previewSlot, patch ?? null);
    button.disabled = !patch;
  };
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  refresh();
  const sets = (storage.storageClassDeviceSets ?? []).map((set, index) => {
    const count = numberInput(set.count ?? 0, 0, 1000);
    const name = set.name ?? "";
    const change = changeButton(t("change.apply"), () => {
      const value = readCount(count, 0, 1000);
      if (value === null) throw new Error(t("osds.badCount"));
      return sextant.resources.patch({ ref, patch: deviceSetCountPatch(index, name, value) as never, patchType: "json" });
    });
    return element("div", { className: "row" }, field(t("osds.deviceSetCount", { name }), count), change.button, change.status);
  });
  return element(
    "section",
    {},
    element("h3", { textContent: t("osds.storageTitle") }),
    form,
    previewSlot,
    element("div", { className: "actions" }, status, button),
    sets.length ? element("h3", { textContent: t("osds.deviceSets") }) : null,
    sets.length ? element("p", { className: "muted", textContent: t("osds.deviceSetsHint") }) : null,
    ...sets,
  );
}

interface OsdContext {
  sextant: Sextant;
  namespace: string;
  metrics: Map<number, OsdMetrics> | null;
  pgsClean: boolean | null;
  rookImage: string | null;
  jobs: Job[];
  /** OSDs whose "Remove" box is open: kept open across redraws. */
  open: Set<number>;
  /** OSDs whose "ceph" box is open, and the weight chosen in it: kept across redraws. */
  cephOpen: Set<number>;
  weights: Map<number, string>;
  /** What `ceph osd safe-to-destroy` said per OSD (`null`: it could not be asked), kept across redraws. */
  safe: Map<number, { verdict: boolean | null; text: string } | "asking">;
  /** Draws the tab again (after a check answered). */
  redraw: () => void;
}

/** Runs a changing ceph command for one OSD; Sextant asks first. A non-zero exit fails with Ceph's own words. */
async function cephChange(c: OsdContext, id: CommandId, params: Record<string, string>): Promise<void> {
  const outcome = await run(c.sextant, c.namespace, id, params);
  if (outcome.kind === "noToolbox") throw new Error(t("commands.noToolboxShort"));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.result.exitCode !== 0 || outcome.result.timedOut) throw new Error(outputOf(outcome.result) || t("commands.timedOut"));
}

/**
 * Stops an OSD only when Ceph does not say stopping it would make data unavailable (`ceph osd ok-to-stop`). When Ceph
 * cannot be asked (no toolbox), the OSD is stopped as before: Rook's guide stops it the same way.
 */
async function stopChecked(c: OsdContext, osd: Osd, stop: () => Promise<unknown>): Promise<unknown> {
  const outcome = await run(c.sextant, c.namespace, "osd-ok-to-stop", { osd: String(osd.id) });
  if (verdictOf(outcome) === false && outcome.kind === "ran") {
    throw new Error(t("osds.notOkToStop", { id: osd.id, reason: outputOf(outcome.result) }));
  }
  return stop();
}

function osdState(osd: Osd, m: OsdMetrics | undefined): HTMLElement {
  const parts: (HTMLElement | string)[] = [];
  const stopped = (osd.deployment.spec?.replicas ?? 1) === 0;
  if (stopped) parts.push(badge(t("osds.stopped"), "warning"));
  else parts.push(osd.ready ? badge(t("daemons.ready"), "ok") : badge(t("osds.notReady"), "error"));
  if (m?.up !== undefined) parts.push(badge(m.up ? "up" : "down", m.up ? "ok" : "error"));
  if (m?.in !== undefined) parts.push(badge(m.in ? "in" : "out", m.in ? "ok" : "warning"));
  if (osd.replace !== "none") parts.push(badge(t(`osds.replace.${osd.replace}`), "warning"));
  if (osd.reconcilePaused && !stopped) parts.push(badge(t("manage.paused"), "warning"));
  return element("span", {}, ...parts);
}

function osdActions(c: OsdContext, osd: Osd): HTMLElement {
  const ref = deploymentRef(c.namespace, osd.deployment.metadata.name);
  const version = osd.deployment.metadata.resourceVersion;
  const controls: HTMLElement[] = [];
  const add = (label: string, send: () => Promise<unknown>, danger = false) => {
    const { button, status } = changeButton(label, send, { danger });
    button.setAttribute("aria-label", `${label} osd.${osd.id}`);
    controls.push(button, status);
  };
  const patch = (body: unknown) => c.sextant.resources.patch({ ref, patch: body as never, patchType: "merge" });
  const stopped = (osd.deployment.spec?.replicas ?? 1) === 0;
  if (!osd.onPvc && osd.replace === "none") add(t("osds.replaceStart"), () => patch(replaceOsdPatch(osd.id, true, version)));
  if (osd.replace === "requested" || osd.replace === "inProgress") add(t("osds.replaceCancel"), () => patch(replaceOsdPatch(osd.id, false, version)));
  if (osd.replace === "none") {
    if (stopped) {
      add(t("osds.start"), () => patch({ ...daemonReconcilePatch(false, version), spec: { replicas: 1 } }));
    } else {
      add(t("osds.stop"), () => stopChecked(c, osd, () => patch({ ...daemonReconcilePatch(true, version), spec: { replicas: 0 } })));
      add(t(osd.reconcilePaused ? "manage.resume" : "manage.pause"), () => patch(daemonReconcilePatch(!osd.reconcilePaused, version)));
    }
  }
  const job = c.jobs.find((j) => j.metadata.name === purgeJobName(osd.id));
  if (stopped && !job) controls.push(removeControl(c, osd));
  controls.push(cephControls(c, osd));
  return element("span", { className: "inline-change" }, ...controls);
}

/** Mark out or in (by what the metrics say; both when they cannot tell) and reweight, as ceph commands. */
function cephControls(c: OsdContext, osd: Osd): HTMLElement {
  const m = c.metrics?.get(osd.id);
  const id = { osd: String(osd.id) };
  const parts: HTMLElement[] = [];
  const add = (label: string, command: CommandId, params: () => Record<string, string>) => {
    const { button, status } = changeButton(label, () => cephChange(c, command, params()));
    button.setAttribute("aria-label", `${label} osd.${osd.id}`);
    parts.push(button, status);
  };
  if (m?.in !== 0) add(t("osds.markOut"), "osd-out", () => id);
  if (m?.in !== 1) add(t("osds.markIn"), "osd-in", () => id);
  const current = m?.reweight !== undefined ? WEIGHTS.find((w) => Number(w) === m.reweight) : undefined;
  const weight = select(WEIGHTS.map((w) => ({ value: w, label: w })), c.weights.get(osd.id) ?? current ?? "1.0");
  weight.setAttribute("aria-label", t("osds.reweightTo", { id: osd.id }));
  weight.addEventListener("change", () => c.weights.set(osd.id, weight.value));
  add(t("osds.reweightApply"), "osd-reweight", () => ({ ...id, weight: weight.value }));
  // The weight sits right before its button.
  parts.splice(parts.length - 2, 0, weight);
  const box = element(
    "details",
    { className: "ceph-osd" },
    element("summary", { textContent: t("osds.cephActions") }),
    element("p", { className: "muted" }, ...richText(t("osds.cephActionsHint"))),
    element("p", {}, ...parts),
  );
  box.open = c.cephOpen.has(osd.id);
  box.addEventListener("toggle", () => (box.open ? c.cephOpen.add(osd.id) : c.cephOpen.delete(osd.id)));
  return box;
}

/** Asks `ceph osd safe-to-destroy` once per opening of the Remove box; the answer is kept for the redraws. */
function askSafe(c: OsdContext, osd: Osd): void {
  if (c.safe.has(osd.id)) return;
  c.safe.set(osd.id, "asking");
  void run(c.sextant, c.namespace, "osd-safe-to-destroy", { osd: String(osd.id) }).then((outcome) => {
    c.safe.set(osd.id, { verdict: verdictOf(outcome), text: outcome.kind === "ran" ? outputOf(outcome.result) : "" });
    c.redraw();
  });
}

/** Remove a stopped OSD with Rook's purge Job, after the checks Rook's documentation asks for. */
function removeControl(c: OsdContext, osd: Osd): HTMLElement {
  const box = element("details", { className: "remove-osd" }, element("summary", { textContent: t("osds.remove") }));
  box.open = c.open.has(osd.id);
  box.addEventListener("toggle", () => {
    if (box.open) {
      c.open.add(osd.id);
      askSafe(c, osd);
    } else {
      c.open.delete(osd.id);
      // Asked again on the next opening: the answer is Ceph's of that moment.
      c.safe.delete(osd.id);
    }
  });
  if (box.open) askSafe(c, osd);
  const checks: string[] = [];
  if (c.pgsClean === false) checks.push(t("osds.pgsNotClean"));
  if (c.pgsClean === null) checks.push(t("osds.pgsUnknown"));
  const safe = c.safe.get(osd.id);
  const safeLine =
    safe === undefined || safe === "asking"
      ? element("p", { className: "muted", textContent: t("osds.safeAsking", { id: osd.id }) })
      : safe.verdict === true
        ? element("p", { className: "ok-text", textContent: t("osds.safeYes", { id: osd.id }) })
        : safe.verdict === false
          ? element("p", { className: "warning-text", textContent: t("osds.safeNo", { id: osd.id, reason: safe.text }) })
          : element("p", { className: "warning-text" }, ...richText(t("osds.safeUnknown")));
  if (!c.rookImage) checks.push(t("osds.noRookImage"));
  const job = c.rookImage ? purgeJobObject(c.namespace, osd.id, c.rookImage) : null;
  const removal = changeButton(t("osds.removeRun", { id: osd.id }), async () => {
    if (!job) throw new Error(t("osds.noRookImage"));
    await c.sextant.resources.apply({ yaml: asYaml([job]) });
  }, { danger: true });
  // Not clean is refused; not known only warns, and Rook's Job (not forced) still refuses an OSD unsafe to destroy.
  if (!job || c.pgsClean === false || (safe !== undefined && safe !== "asking" && safe.verdict === false)) removal.button.disabled = true;
  box.append(
    element("p", {}, ...richText(t("osds.removeIntro", { id: osd.id }))),
    element("p", { className: "warning-text", textContent: t(osd.onPvc ? "osds.removePvc" : "osds.removeHost") }),
    ...checks.map((text) => element("p", { className: "warning-text" }, ...richText(text))),
    safeLine,
    ...(job ? [preview(asYaml([job]))] : []),
    element("p", {}, removal.button, removal.status),
  );
  return box;
}

function treeView(c: OsdContext, nodes: readonly CrushNode[], depth = 0): HTMLElement {
  return element(
    "ul",
    { className: depth ? "crush" : "crush crush-root" },
    ...nodes.map((node) =>
      element(
        "li",
        {},
        element(
          "div",
          { className: "crush-bucket" },
          element("span", { className: "muted", textContent: `${node.level} ` }),
          node.level === "host" && node.name !== "?"
            ? objectLink(c.sextant, { kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: node.name })
            : element("strong", { textContent: node.name }),
        ),
        node.children.length ? treeView(c, node.children, depth + 1) : null,
        node.osds.length
          ? element(
              "ul",
              { className: "crush" },
              ...node.osds.map((osd) => {
                const m = c.metrics?.get(osd.id);
                const usage = m?.bytes && m.used !== undefined ? `${formatBytes(m.used)} / ${formatBytes(m.bytes)} (${formatPercent(m.used / m.bytes)})` : "";
                return element(
                  "li",
                  { className: "crush-osd" },
                  element("strong", { textContent: `osd.${osd.id}` }),
                  " ",
                  osd.deviceClass ? element("span", { className: "muted", textContent: `${osd.deviceClass} ` }) : null,
                  osdState(osd, m),
                  usage ? element("span", { className: "muted", textContent: ` ${usage}` }) : null,
                  m?.reweight !== undefined && m.reweight !== 1 ? element("span", { className: "muted", textContent: ` ${t("osds.reweight", { value: m.reweight })}` }) : null,
                  " ",
                  osdActions(c, osd),
                );
              }),
            )
          : null,
      ),
    ),
  );
}

function jobsView(sextant: Sextant, namespace: string, jobs: Job[]): HTMLElement | null {
  if (!jobs.length) return null;
  return element(
    "section",
    {},
    element("h3", { textContent: t("osds.purgeJobs") }),
    ...jobs.map((job) => {
      const s = job.status ?? {};
      const state = s.succeeded ? badge(t("osds.jobDone"), "ok") : s.failed ? badge(t("osds.jobFailed"), "error") : badge(t("osds.jobRunning"), "warning");
      const ref: ObjectRef = { kind: { group: "batch", version: "v1", kind: "Job" }, namespace, name: job.metadata.name };
      const remove = changeButton(t("osds.jobDelete"), () => sextant.resources.delete({ ref }));
      return element("p", {}, objectLink(sextant, ref), " ", state, " ", s.active ? "" : remove.button, remove.status);
    }),
    element("p", { className: "muted", textContent: t("osds.jobHint") }),
  );
}

/** The tab; `storage` is the storage settings section, built once per version of the cluster so editing survives. */
export function osdsView(c: OsdContext, deployments: readonly KubeObject[], storage: HTMLElement): HTMLElement {
  const osds = deployments.map((d) => osdOf(d)).filter((o): o is Osd => o !== null);
  return element(
    "div",
    { className: "osds" },
    element("h3", { textContent: t("osds.treeTitle") }),
    element("p", { className: "muted" }, ...richText(t("osds.treeHint"))),
    osds.length ? treeView(c, crushTree(osds)) : element("p", { className: "muted", textContent: t("osds.none") }),
    c.metrics === null ? element("p", { className: "muted", textContent: t("osds.noMetrics") }) : null,
    jobsView(c.sextant, c.namespace, c.jobs),
    storage,
    element("p", { className: "muted" }, ...richText(t("osds.toolboxOnly"))),
  );
}

async function instant(sextant: Sextant, id: string, namespace: string): Promise<MetricAnswer | null> {
  try {
    return await sextant.metrics.query({ id, params: { namespace } });
  } catch {
    return null;
  }
}

/** Whether every placement group is active and clean, from the `pgs` query; `null` when it cannot be told. */
export function pgsClean(answer: MetricAnswer | null): boolean | null {
  if (!answer) return null;
  const value = (name: string) => answer.series.find((s) => s.labels.__name__ === name)?.points.at(-1)?.[1] ?? null;
  const total = value("ceph_pg_total");
  const active = value("ceph_pg_active");
  const clean = value("ceph_pg_clean");
  if (total === null || active === null || clean === null) return null;
  return active === total && clean === total;
}

export function startOsds(sextant: Sextant, root: HTMLElement): () => void {
  const ref = sextant.context.selection[0];
  const namespace = ref?.namespace;
  if (!ref || !namespace) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.noCluster") }));
    return () => undefined;
  }
  root.replaceChildren(element("p", { className: "muted", textContent: t("common.loading") }));
  let stopped = false;
  let stopWatches: () => void = () => undefined;
  let cluster: CephCluster | null = null;
  let lists: Record<"deployments" | "jobs", LiveList> | null = null;
  const context: OsdContext = {
    sextant,
    namespace,
    metrics: null,
    pgsClean: null,
    rookImage: null,
    jobs: [],
    open: new Set(),
    cephOpen: new Set(),
    weights: new Map(),
    safe: new Map(),
    redraw: () => render(),
  };
  let storage: { version: string | undefined; node: HTMLElement } | null = null;
  const render = () => {
    if (stopped || !cluster || !lists || !lists.deployments.ready) return;
    context.jobs = lists.jobs.items as Job[];
    const errors = [lists.deployments.error, lists.jobs.error].filter((e): e is string => e !== null);
    const settings =
      storage && storage.version === cluster.metadata.resourceVersion
        ? storage
        : { version: cluster.metadata.resourceVersion, node: storageView(sextant, ref, cluster) };
    storage = settings;
    root.replaceChildren(
      ...errors.map((e) => element("p", { className: "error", textContent: e })),
      osdsView(context, lists.deployments.items, settings.node),
    );
  };
  const readCluster = () =>
    sextant.resources
      .get({ ref })
      .then((object) => {
        cluster = object as CephCluster;
        render();
      })
      .catch((err: unknown) => root.replaceChildren(errorBox(err)));
  let shown = sextant.context.resourceVersion;
  const stopFollow = sextant.onContextChange((ctx) => {
    if (ctx.resourceVersion === shown) return;
    shown = ctx.resourceVersion;
    void readCluster();
  });
  void readCluster();
  void Promise.all([
    instant(sextant, "osd-usage", namespace),
    instant(sextant, "pgs", namespace),
    sextant.resources.list({ kind: POD, labelSelector: "app=rook-ceph-operator", limit: 5 }).catch(() => ({ items: [] as KubeObject[] })),
  ]).then(([usage, pgs, operators]) => {
    context.metrics = usage ? osdMetrics(usage.series) : null;
    context.pgsClean = pgsClean(pgs);
    const containers = ((operators.items[0]?.spec as { containers?: { image?: string }[] } | undefined)?.containers ?? []);
    context.rookImage = containers[0]?.image ?? null;
    render();
  });
  void servedKinds(sextant)
    .then((served) => {
      if (stopped) return;
      stopWatches = watchLists(
        sextant,
        served,
        {
          deployments: { kind: DEPLOYMENT, namespaces: [namespace], labelSelector: "app=rook-ceph-osd" },
          jobs: { kind: JOB, namespaces: [namespace], labelSelector: "app=rook-ceph-purge-osd" },
        },
        (watched) => {
          lists = watched;
          render();
        },
      );
      if (!served.has(kindKey(DEPLOYMENT))) root.replaceChildren(element("p", { className: "error", textContent: t("osds.noDeployments") }));
    })
    .catch((err: unknown) => root.replaceChildren(errorBox(err)));
  return () => {
    stopped = true;
    stopFollow();
    stopWatches();
  };
}
