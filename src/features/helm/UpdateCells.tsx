// Newer chart versions on the Releases page (#209): the "Latest chart" cell of a release and the bar above the list
// (Refresh, Update repositories, repositories Helm could not read).
import { useTranslation } from "react-i18next";
import type { ChartUpdate, HelmRelease, VersionStep } from "../../api";
import { Badge, Button, ErrorState, type BadgeTone } from "../../components";
import { formatList } from "../../i18n/format";
import type { UpgradeTarget } from "./ReleaseDetails";
import type { ChartUpdatesState } from "./updates";

const STEP_TONES: Record<VersionStep, BadgeTone> = { patch: "info", minor: "warning", major: "danger" };

export function LatestChart({
  release,
  update,
  checking,
  onUpgrade,
}: {
  release: HelmRelease;
  update: ChartUpdate | undefined;
  checking: boolean;
  onUpgrade: (target: UpgradeTarget) => void;
}) {
  const { t } = useTranslation();
  if (!update) return <span className="helm-muted">{checking ? t("helm:updates.checking") : t("helm:updates.unknown")}</span>;
  if (update.error) {
    return (
      <span className="helm-muted" title={update.error.message}>
        {t("helm:updates.failed")}
      </span>
    );
  }
  const { latest, chartRef, step } = update;
  if (step && latest && chartRef) {
    const others = update.otherRepos.length > 0 ? t("helm:updates.alsoIn", { repos: formatList(update.otherRepos) }) : undefined;
    return (
      <span className="helm-latest" title={others}>
        <span>{latest}</span>
        <Badge tone={STEP_TONES[step]}>{t(`helm:updates.step.${step}`)}</Badge>
        <Button
          size="compact"
          aria-label={t("helm:updates.upgradeLabel", { name: release.name, version: latest })}
          title={t("helm:updates.from", { chartRef })}
          onClick={(e) => {
            e.stopPropagation();
            onUpgrade({ chartRef, version: latest });
          }}
        >
          {t("helm:updates.upgrade")}
        </Button>
      </span>
    );
  }
  if (update.upToDate) return <span className="helm-muted">{t("helm:updates.upToDate")}</span>;
  if (latest) return <span>{latest}</span>;
  return (
    <span className="helm-muted" title={t("helm:updates.unknownHint")}>
      {t("helm:updates.unknown")}
    </span>
  );
}

export function UpdatesBar({ state }: { state: ChartUpdatesState }) {
  const { t } = useTranslation();
  const busy = state.loading || state.updatingRepos;
  return (
    <div className="helm-updates" role="group" aria-label={t("helm:updates.label")}>
      <Button size="compact" icon="refresh" disabled={busy} onClick={state.refresh}>
        {state.loading ? t("helm:updates.checking") : t("helm:updates.refresh")}
      </Button>
      <Button size="compact" disabled={busy} onClick={state.updateRepos}>
        {state.updatingRepos ? t("helm:charts.updating") : t("helm:charts.update")}
      </Button>
      {state.repos === 0 && <span className="helm-muted">{t("helm:updates.noRepos")}</span>}
      {state.skipped > 0 && <span className="helm-muted">{t("helm:updates.skipped", { count: state.skipped })}</span>}
      {state.problems.map((p) => (
        <span key={p.repo} className="helm-warning" title={p.message}>
          {t("helm:updates.repoProblem", { repo: p.repo })}
        </span>
      ))}
      {state.error && state.error.code !== "helmMissing" && <ErrorState error={state.error} title={t("helm:updates.error")} />}
    </div>
  );
}
