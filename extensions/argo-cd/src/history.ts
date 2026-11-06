// The details section `history` of an Application: its sync history (`status.history`, newest first) — when each
// revision was deployed, from which source, and who started the sync (a user, or the controller for automated syncs).
import type { KubeObject, Sextant } from "@sextant/extension-sdk";
import { shortRevision, syncHistory } from "./argo";
import { element, table, when } from "./dom";
import { t } from "./i18n";
import { followShown } from "./shown";

export function historyView(app: KubeObject): HTMLElement {
  const entries = syncHistory(app);
  if (entries.length === 0) return element("p", { className: "muted", textContent: t("history.empty") });
  const rows = entries.map((e) => [
    e.id === undefined ? null : String(e.id),
    element("span", { className: "revision", title: e.revisions.join(", "), textContent: e.revisions.map(shortRevision).join(", ") }),
    when(e.deployedAt),
    e.initiatedBy === null ? t("history.automated") : (e.initiatedBy ?? null),
    e.sources.map((s) => [s.repoURL, s.path ?? s.chart].filter(Boolean).join(" ")).join(", "),
  ]);
  return table(
    [t("history.id"), t("history.revision"), t("history.deployedAt"), t("history.initiatedBy"), t("history.source")],
    rows,
    t("history.title"),
  );
}

export function startHistory(sextant: Sextant, root: HTMLElement): () => void {
  return followShown(sextant, root, (app) => root.replaceChildren(historyView(app)));
}
