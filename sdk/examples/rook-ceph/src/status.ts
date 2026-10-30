// The "Ceph status" section of a CephCluster's details: health and its checks in plain words, capacity, versions,
// when Rook last looked, and the toolbox. The page shows the same summary per cluster (`statusSummary`).
import type { ObjectRef, Sextant } from "@sextant/extension-sdk";
import { wordsOf } from "./checks";
import { TOOLBOX_APP } from "./components";
import { badge, element, errorBox, formatAgo, formatBytes, formatPercent, formatTime, objectLink, richText } from "./dom";
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
    badge(health === "unknown" ? "Health unknown" : health, healthTone(health)),
    phase ? badge(phase, phaseTone(phase)) : null,
    cluster.spec?.external?.enable ? badge("External", "neutral") : null,
  );
}

export function freshness(cluster: CephCluster, now: number, language: string): HTMLElement | null {
  const { checked, stale } = freshnessOf(cluster, now);
  if (checked === null) return element("p", { className: "muted", textContent: "Rook has not checked Ceph's health yet." });
  const text = `Rook checked Ceph's health ${formatAgo(checked, now, language)} (${formatTime(checked, language)}).`;
  if (!stale) return element("p", { className: "muted", textContent: text });
  return element(
    "p",
    { className: "warning-text" },
    badge("Stale", "warning"),
    ` ${text} Rook checks every minute by default, so for more than ${STALE_MINUTES} minutes this status has not been refreshed: the Rook operator may not be running.`,
  );
}

export function checksList(cluster: CephCluster): HTMLElement {
  const checks = healthChecks(cluster);
  if (checks.length === 0) {
    const health = healthOf(cluster);
    return element("p", {
      className: "muted",
      textContent: health === "HEALTH_OK" ? "Ceph reports no health checks." : "Rook has not reported any health checks.",
    });
  }
  return element(
    "ul",
    { className: "checks" },
    ...checks.map((check) => {
      const words = wordsOf(check.code);
      const severity = check.severity === "other" ? "Info" : check.severity === "HEALTH_ERR" ? "Error" : "Warning";
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

export function capacityView(cluster: CephCluster, language: string): HTMLElement {
  const capacity = capacityOf(cluster);
  if (!capacity) return element("p", { className: "muted", textContent: "Rook has not reported the capacity." });
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
  bar.setAttribute("aria-label", "Raw capacity used");
  return element(
    "div",
    { className: "capacity" },
    bar,
    element("p", {
      textContent: `${formatBytes(capacity.used, language)} used of ${formatBytes(capacity.total, language)} raw (${formatPercent(fraction, language)}), ${formatBytes(capacity.available, language)} available.`,
    }),
  );
}

export function versionsView(cluster: CephCluster): HTMLElement {
  const versions = versionsOf(cluster);
  const rows: [string, string][] = [];
  if (versions.version) rows.push(["Ceph", versions.version]);
  if (versions.image) rows.push(["Image", versions.image]);
  const list = element("dl", {}, ...rows.flatMap(([k, v]) => [element("dt", { textContent: k }), element("dd", { textContent: v })]));
  if (versions.running.length < 2) return list;
  return element(
    "div",
    {},
    list,
    element("p", {
      className: "warning-text",
      textContent: `The daemons run ${versions.running.length} Ceph versions (${versions.running
        .map((r) => `${r.version}: ${r.daemons}`)
        .join("; ")}): an upgrade is under way, or stuck.`,
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
      ...richText(
        "No toolbox runs here. Rook's `deploy/examples/toolbox.yaml` starts one; then Shell on its pod runs `ceph status`, `ceph health detail` and the like. This extension runs no commands itself.",
      ),
    );
  }
  return element(
    "p",
    {},
    "Toolbox: ",
    objectLink(sextant, refOf(pod, POD)),
    ...richText(". Shell on its pod runs `ceph status`, `ceph health detail` and the like; this extension runs no commands itself."),
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return element("section", {}, element("h3", { textContent: title }), ...children);
}

/** The whole status of one cluster (the details section). */
export function statusView(cluster: CephCluster, now: number, language: string): HTMLElement {
  return element(
    "div",
    { className: "status" },
    headline(cluster),
    cluster.status?.message ? element("p", { textContent: cluster.status.message }) : null,
    freshness(cluster, now, language),
    section("Health checks", checksList(cluster)),
    section("Capacity", capacityView(cluster, language)),
    section("Versions", versionsView(cluster)),
  );
}

/** Starts the details section of the CephCluster in the context; reads it again whenever it changes. */
export function startStatus(sextant: Sextant, root: HTMLElement): () => void {
  let shown: string | null | undefined;
  let reading = 0;
  const toolbox = element("section", {}, element("h3", { textContent: "Toolbox" }));
  let cluster: CephCluster | null = null;
  const render = () => {
    if (cluster) root.replaceChildren(statusView(cluster, Date.now(), sextant.context.language), toolbox);
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
      toolbox.replaceChildren(element("h3", { textContent: "Toolbox" }), await toolboxView(sextant, namespace));
    } catch (err) {
      toolbox.replaceChildren(element("h3", { textContent: "Toolbox" }), errorBox(err));
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(element("p", { className: "muted", textContent: "No CephCluster." }));
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
