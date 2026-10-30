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
import { t } from "./i18n";
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

export function checksList(cluster: CephCluster): HTMLElement {
  const checks = healthChecks(cluster);
  if (checks.length === 0) {
    const health = healthOf(cluster);
    return element("p", {
      className: "muted",
      textContent: health === "HEALTH_OK" ? t("status.noChecks") : t("status.checksUnknown"),
    });
  }
  return element(
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
        ),
        words ? element("p", {}, ...richText(words.meaning)) : null,
        words?.next ? element("p", { className: "muted" }, ...richText(words.next)) : null,
      );
    }),
  );
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
export async function toolboxView(sextant: Sextant, namespace: string): Promise<HTMLElement> {
  const { items } = await sextant.resources.list({ kind: POD, namespace, labelSelector: `app=${TOOLBOX_APP}`, limit: 5 });
  const pod = items.find((p) => (p.status as { phase?: string } | undefined)?.phase === "Running") ?? items[0];
  if (!pod) {
    return element(
      "p",
      { className: "muted" },
      ...richText(t("status.noToolbox")),
    );
  }
  const link = objectLink(sextant, refOf(pod, POD));
  return element(
    "p",
    {},
    ...richText(t("status.toolbox", { pod: LINK_MARK })).flatMap((node) =>
      node.nodeType === Node.TEXT_NODE ? withLinks(node.textContent ?? "", [link]) : [node],
    ),
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return element("section", {}, element("h3", { textContent: title }), ...children);
}

/** The whole status of one cluster (the details section). */
export function statusView(cluster: CephCluster, now: number): HTMLElement {
  return element(
    "div",
    { className: "status" },
    headline(cluster),
    cluster.status?.message ? element("p", { textContent: cluster.status.message }) : null,
    freshness(cluster, now),
    section(t("status.checksTitle"), checksList(cluster)),
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
    if (cluster) root.replaceChildren(statusView(cluster, Date.now()), toolbox);
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
      toolbox.replaceChildren(toolboxTitle(), await toolboxView(sextant, namespace));
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
    const first = shown === undefined;
    shown = version;
    void show(ref);
    if (first && ref.namespace) void showToolbox(ref.namespace);
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
