// Details section of an Application: its sync history (`status.history`, newest first) — when each revision was
// deployed, from which source, and who started the sync (a user, or the controller itself for automated syncs).
import { useTranslation } from "react-i18next";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { Block, table } from "../details";
import { shortRevision, syncHistory } from "./model";
import { when } from "./ui";

export function SyncHistorySection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const entries = syncHistory(obj);
  if (entries.length === 0) return null;
  const rows = entries.map((e) => [
    e.id === undefined ? null : String(e.id),
    <span key="r" className="argo-revision" title={e.revisions.join(", ")}>
      {e.revisions.map(shortRevision).join(", ")}
    </span>,
    when(e.deployedAt),
    e.initiatedBy === null ? t("argocd:history.automated") : (e.initiatedBy ?? null),
    e.sources.map((s) => [s.repoURL, s.path ?? s.chart].filter(Boolean).join(" ")).join(", "),
  ]);
  return (
    <Block title={t("argocd:history.title")}>
      {table(
        [
          t("argocd:history.id"),
          t("argocd:history.revision"),
          t("argocd:history.deployedAt"),
          t("argocd:history.initiatedBy"),
          t("argocd:history.source"),
        ],
        rows,
      )}
    </Block>
  );
}
