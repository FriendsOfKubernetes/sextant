// The "Ceph status" section of a CephCluster's details: health and its checks in plain words, capacity, versions,
// when Rook last looked, and the toolbox. The page shows the same summary per cluster (`statusSummary`).
import type { ObjectRef, Sextant } from "@sextant/extension-sdk";
import { wordsOf } from "./checks";
import { TOOLBOX_APP } from "./components";
import {
  badge,
  element,
  errorBox,
  formatAgo,
  formatBytes,
  formatPercent,
  formatTime,
  LINK_MARK,
  objectLink,
  richText,
  withLinks,
} from "./dom";
import { DO_NOT_RECONCILE, MAX_MUTED, MUTE_CODE, mutedCodes, mutePatch, reconcilePatch, TOOLBOX_CONTAINER, toolboxImagePatch, toolboxYaml } from "./changes";
import { t } from "./i18n";
import { changeButton } from "./ui";
import {
  capacityOf,
  freshnessOf,
  healthChecks,
  healthOf,
  healthTone,
  phaseTone,
  POD,
  refOf,
  STALE_MINUTES,
  versionsOf,
  type CephCluster,
} from "./rook";

/** How often the section is drawn again without a change, for the time since Rook's last check. */
export const REDRAW_MS = 30_000;

/** Health, phase and whether the cluster is external, as badges. */
export function headline(cluster: CephCluster): HTMLElement {
  const health = healthOf(cluster);
  const phase = cluster.status?.phase;
  return element(
    "p",
    { className: "headline" },
    badge(health === "unknown" ? t("status.healthUnknown") : health, healthTone(health)),
    phase ? badge(phase, phaseTone(phase)) : null,
    cluster.spec?.external?.enable ? badge(t("status.external"), "neutral") : null,
  );
}

export function freshness(cluster: CephCluster, now: number): HTMLElement | null {
  const { checked, stale } = freshnessOf(cluster, now);
  if (checked === null) return element("p", { className: "muted", textContent: t("status.notChecked") });
  const text = t("status.checked", { ago: formatAgo(checked, now), time: formatTime(checked) });
  if (!stale) return element("p", { className: "muted", textContent: text });
  return element(
    "p",
    { className: "warning-text" },
    badge(t("status.stale"), "warning"),
    ` ${text} ${t("status.staleWhy", { count: STALE_MINUTES })}`,
  );
}

/** What the details section may change on its cluster (nothing on the page's cards). */
export interface Manage {
  sextant: Sextant;
  ref: ObjectRef;
}

/** Mute or unmute a health check (`muteHealthWarning`), within Rook's 10 codes. */
function muteButton(manage: Manage, cluster: CephCluster, code: string): HTMLElement | null {
  if (!MUTE_CODE.test(code)) return null;
  const { muted, entries } = mutedCodes(cluster.spec);
  const isMuted = muted.includes(code);
  const known = Object.hasOwn((cluster.spec as { healthCheck?: { muteHealthWarning?: object } } | undefined)?.healthCheck?.muteHealthWarning ?? {}, code);
  if (!isMuted && !known && entries >= MAX_MUTED) {
    return element("span", { className: "muted", textContent: t("manage.muteFull", { count: MAX_MUTED }) });
  }
  const { button, status } = changeButton(t(isMuted ? "manage.unmute" : "manage.mute"), () =>
    manage.sextant.resources.patch({
      ref: manage.ref,
      patch: mutePatch(code, !isMuted, cluster.metadata.resourceVersion) as never,
      patchType: "merge",
    }),
  );
  return element("span", { className: "inline-change" }, button, status);
}

export function checksList(cluster: CephCluster, manage?: Manage): HTMLElement {
  const checks = healthChecks(cluster);
  const muted = mutedCodes(cluster.spec).muted;
  const mutedList =
    manage && muted.length
      ? element(
          "div",
          { className: "muted-checks" },
          element("p", { className: "muted", textContent: t("manage.mutedList", { codes: muted.join(", ") }) }),
          ...muted.filter((code) => !checks.some((c) => c.code === code)).map((code) => element("p", {}, element("code", { textContent: code }), " ", muteButton(manage, cluster, code))),
        )
      : null;
  if (checks.length === 0) {
    if (mutedList) return mutedList;
    const health = healthOf(cluster);
    return element("p", {
      className: "muted",
      textContent: health === "HEALTH_OK" ? t("status.noChecks") : t("status.checksUnknown"),
    });
  }
  const list = element(
    "ul",
    { className: "checks" },
    ...checks.map((check) => {
      const words = wordsOf(check.code);
      const severity = t(check.severity === "other" ? "status.severity.info" : check.severity === "HEALTH_ERR" ? "status.severity.error" : "status.severity.warning");
      return element(
        "li",
        {},
        element(
          "div",
          { className: "check-head" },
          badge(severity, check.severity === "HEALTH_ERR" ? "error" : check.severity === "HEALTH_WARN" ? "warning" : "neutral"),
          element("code", { textContent: check.code }),
          check.message ? element("span", { textContent: check.message }) : null,
          manage ? muteButton(manage, cluster, check.code) : null,
        ),
        words ? element("p", {}, ...richText(words.meaning)) : null,
        words?.next ? element("p", { className: "muted" }, ...richText(words.next)) : null,
      );
    }),
  );
  return mutedList ? element("div", {}, list, mutedList) : list;
}

export function capacityView(cluster: CephCluster): HTMLElement {
  const capacity = capacityOf(cluster);
  if (!capacity) return element("p", { className: "muted", textContent: t("status.noCapacity") });
  const fraction = capacity.fraction ?? 0;
  // Ceph's default ratios (`mon_osd_nearfull_ratio` 0.85, `mon_osd_full_ratio` 0.95) are per OSD; the whole
  // cluster's fraction only hints at them, and Ceph's own OSD_NEARFULL/OSD_FULL checks are what count.
  const tone = fraction >= 0.95 ? "error" : fraction >= 0.85 ? "warning" : "ok";
  const bar = element("div", { className: `bar ${tone}` }, element("span", {}));
  (bar.firstChild as HTMLElement).style.width = `${(fraction * 100).toFixed(1)}%`;
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", (fraction * 100).toFixed(1));
  bar.setAttribute("aria-label", t("status.capacityLabel"));
  return element(
    "div",
    { className: "capacity" },
    bar,
    element("p", {
      textContent: t("status.capacity", {
        used: formatBytes(capacity.used),
        total: formatBytes(capacity.total),
        percent: formatPercent(fraction),
        available: formatBytes(capacity.available),
      }),
    }),
  );
}

export function versionsView(cluster: CephCluster): HTMLElement {
  const versions = versionsOf(cluster);
  const rows: [string, string][] = [];
  if (versions.version) rows.push([t("status.cephVersion"), versions.version]);
  if (versions.image) rows.push([t("status.image"), versions.image]);
  const list = element("dl", {}, ...rows.flatMap(([k, v]) => [element("dt", { textContent: k }), element("dd", { textContent: v })]));
  if (versions.running.length < 2) return list;
  return element(
    "div",
    {},
    list,
    element("p", {
      className: "warning-text",
      textContent: t("status.mixedVersions", {
        count: versions.running.length,
        versions: versions.running.map((r) => `${r.version}: ${r.daemons}`).join("; "),
      }),
    }),
  );
}

/** Rook's toolbox in the cluster's namespace, where `ceph` commands run (a Sextant terminal on its pod). */
export async function toolboxView(sextant: Sextant, namespace: string, cluster?: CephCluster | null): Promise<HTMLElement> {
  const { items } = await sextant.resources.list({ kind: POD, namespace, labelSelector: `app=${TOOLBOX_APP}`, limit: 5 });
  const pod = items.find((p) => (p.status as { phase?: string } | undefined)?.phase === "Running") ?? items[0];
  const image = cluster?.spec?.cephVersion?.image ?? cluster?.status?.version?.image;
  if (!pod) {
    const deploy = image
      ? changeButton(t("manage.deployToolbox"), () => sextant.resources.apply({ yaml: toolboxYaml(namespace, image) }), {
          doneText: t("manage.toolboxDeployed"),
        })
      : null;
    return element(
      "div",
      {},
      element("p", { className: "muted" }, ...richText(t("status.noToolbox"))),
      deploy ? element("p", {}, deploy.button, deploy.status) : null,
    );
  }
  const podImage = ((pod.spec as { containers?: { name?: string; image?: string }[] } | undefined)?.containers ?? []).find(
    (c) => c.name === "rook-ceph-tools",
  )?.image;
  const update =
    image && podImage && podImage !== image
      ? changeButton(t("manage.updateToolbox", { image }), async () => {
          const ref = { kind: { group: "apps", kind: "Deployment" }, namespace, name: "rook-ceph-tools" };
          const deployment = await sextant.resources.get({ ref });
          const containers = (deployment.spec as { template?: { spec?: { containers?: { name?: string }[] } } } | undefined)?.template?.spec?.containers ?? [];
          const index = containers.findIndex((c) => c.name === TOOLBOX_CONTAINER);
          if (index < 0) throw new Error(t("manage.toolboxNoContainer"));
          await sextant.resources.patch({ ref, patch: toolboxImagePatch(index, image) as never, patchType: "json" });
        })
      : null;
  const link = objectLink(sextant, refOf(pod, POD));
  const line = element(
    "p",
    {},
    ...richText(t("status.toolbox", { pod: LINK_MARK })).flatMap((node) =>
      node.nodeType === Node.TEXT_NODE ? withLinks(node.textContent ?? "", [link]) : [node],
    ),
  );
  if (!update) return line;
  return element(
    "div",
    {},
    line,
    element("p", { className: "warning-text" }, t("manage.toolboxOld", { image: podImage ?? "" }), " ", update.button, update.status),
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return element("section", {}, element("h3", { textContent: title }), ...children);
}

/** Pause or resume Rook's reconciling of the cluster (the label `ceph.rook.io/do-not-reconcile`). */
function reconcileControl(manage: Manage, cluster: CephCluster): HTMLElement {
  const paused = DO_NOT_RECONCILE in (cluster.metadata.labels ?? {});
  const { button, status } = changeButton(t(paused ? "manage.resume" : "manage.pause"), () =>
    manage.sextant.resources.patch({
      ref: manage.ref,
      patch: reconcilePatch(!paused, cluster.metadata.resourceVersion) as never,
      patchType: "merge",
    }),
  );
  return element(
    "p",
    { className: paused ? "warning-text" : "muted" },
    paused ? badge(t("manage.paused"), "warning") : null,
    t(paused ? "manage.pausedText" : "manage.pauseText"),
    " ",
    button,
    status,
  );
}

/** The whole status of one cluster (the details section, which may also change it). */
export function statusView(cluster: CephCluster, now: number, manage?: Manage): HTMLElement {
  return element(
    "div",
    { className: "status" },
    headline(cluster),
    manage ? reconcileControl(manage, cluster) : null,
    cluster.status?.message ? element("p", { textContent: cluster.status.message }) : null,
    freshness(cluster, now),
    section(t("status.checksTitle"), checksList(cluster, manage)),
    section(t("status.capacityTitle"), capacityView(cluster)),
    section(t("status.versionsTitle"), versionsView(cluster)),
  );
}

/** Starts the details section of the CephCluster in the context; reads it again whenever it changes. */
export function startStatus(sextant: Sextant, root: HTMLElement): () => void {
  let shown: string | null | undefined;
  let reading = 0;
  const toolboxTitle = () => element("h3", { textContent: t("status.toolboxTitle") });
  const toolbox = element("section", {}, toolboxTitle());
  let cluster: CephCluster | null = null;
  const render = () => {
    const ref = sextant.context.selection[0];
    if (cluster && ref) root.replaceChildren(statusView(cluster, Date.now(), { sextant, ref }), toolbox);
  };

  const show = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const read = (await sextant.resources.get({ ref })) as CephCluster;
      if (attempt !== reading) return;
      cluster = read;
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(errorBox(err));
    }
  };
  const showToolbox = async (namespace: string) => {
    try {
      toolbox.replaceChildren(toolboxTitle(), await toolboxView(sextant, namespace, cluster));
    } catch (err) {
      toolbox.replaceChildren(toolboxTitle(), errorBox(err));
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(element("p", { className: "muted", textContent: t("common.noCluster") }));
      return;
    }
    const version = sextant.context.resourceVersion;
    if (version === shown) return;
    shown = version;
    // The toolbox is looked up again with each new cluster object: its image is compared with the cluster's.
    void show(ref).then(() => {
      if (ref.namespace) void showToolbox(ref.namespace);
    });
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  // A status nobody refreshes changes no resourceVersion: draw again now and then so "Stale" shows up anyway.
  const timer = setInterval(render, REDRAW_MS);
  return () => {
    stopFollow();
    clearInterval(timer);
  };
}
