// The "Upgrade readiness" page of the Cluster section (#142): before upgrading Kubernetes, which API versions in use
// are deprecated or removed in a chosen target version (like pluto / kubent), where each use comes from (live objects'
// last applied configuration and field managers, Helm release manifests, Argo CD Applications, Flux Kustomizations),
// the deprecated API versions the cluster still serves, and version skew between kubelets, control-plane components
// and the target. Read-only: one scan (`api.upgrade.scan`) when the page is first opened and on "Scan again"; the
// target and the filters only re-evaluate it. The report is copied as Markdown or CSV.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SourceReport, UpgradeScan } from "../../api";
import { Badge, Button, Checkbox, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { formatDateTime, formatList } from "../../i18n/format";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import {
  countByStatus,
  defaultTarget,
  evaluate,
  filterFindings,
  servedFindings,
  SOURCE_TYPES,
  targetChoices,
  type Finding,
  type SourceType,
} from "./evaluate";
import { csvReport, markdownReport, originText, replacementText, servedText, skewText, statusText } from "./report";
import { kubeletVersions, skewIssues } from "./skew";
import { runScan, useUpgradeState, useUpgradeStore } from "./state";
import { DEPRECATION_SOURCE, minorText, parseMinor, REVIEWED_FOR } from "./table";
import "./upgrade.css";
import { ResizableTable } from "../../components/Table";

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <span className="upgrade__copy">
      <Button size="compact" icon="copy" onClick={() => void copy()}>
        {label}
      </Button>
      {state !== "idle" && (
        <span className="upgrade__copy-state" role="status">
          {state === "copied" ? t("upgrade:copied") : t("upgrade:copyFailed")}
        </span>
      )}
    </span>
  );
}

/** What a source skipped, as texts: Helm namespaces that could not be listed and releases that could not be read
 * apart; kinds or group versions of the other sources. */
function skippedNotes(s: SourceReport): { key: string; names: string[] }[] {
  if (s.skipped.length === 0) return [];
  if (s.source !== "helm") {
    return [{ key: "upgrade:sources.skippedKinds", names: s.skipped.map((k) => k.kind || `${k.group}/${k.version}`) }];
  }
  const namespaces = s.skipped.filter((k) => !k.kind).map((k) => k.group);
  const releases = s.skipped.filter((k) => k.kind).map((k) => `${k.group}/${k.kind}`);
  return [
    ...(namespaces.length > 0 ? [{ key: "upgrade:sources.skippedHelmNamespaces", names: namespaces }] : []),
    ...(releases.length > 0 ? [{ key: "upgrade:sources.skippedReleases", names: releases }] : []),
  ];
}

function SourceNotes({ scan }: { scan: UpgradeScan }) {
  const { t } = useTranslation();
  const notes = scan.sources.filter((s) => s.outcome !== "notInstalled" && (s.outcome === "failed" || s.truncated || s.skipped.length > 0));
  return (
    <>
      {notes.map((s: SourceReport) =>
        s.outcome === "failed" ? (
          <ErrorState key={s.source} className="upgrade__error" title={t(`upgrade:sources.failed.${s.source}`)} error={s.error} />
        ) : (
          <div key={s.source}>
            {s.truncated && <p className="upgrade__note upgrade__note--warning">{t(`upgrade:sources.truncated.${s.source}`)}</p>}
            {skippedNotes(s).map((note) => (
              <ErrorState key={note.key} className="upgrade__error" title={t(note.key, { names: formatList(note.names) })} error={s.error} />
            ))}
          </div>
        ),
      )}
      {scan.usagesTruncated && <p className="upgrade__note upgrade__note--warning">{t("upgrade:sources.usagesTruncated")}</p>}
    </>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td>
        <Badge tone={f.status === "removed" ? "danger" : "warning"}>{statusText(t, f.status)}</Badge>
      </td>
      <td>{f.kind}</td>
      <td>{f.namespace ?? t("upgrade:clusterScoped")}</td>
      <td className="upgrade__name">{f.name}</td>
      <td>
        <code>{f.apiVersion}</code>
        {f.alreadyRemoved && <div className="upgrade__hint">{t("upgrade:usages.alreadyRemoved")}</div>}
      </td>
      <td>
        {f.status === "removed"
          ? t("upgrade:usages.removedIn", { version: minorText(f.deprecation.removedIn) })
          : t("upgrade:usages.deprecatedIn", {
              version: minorText(f.deprecation.deprecatedIn),
              removed: minorText(f.deprecation.removedIn),
            })}
      </td>
      <td>{f.replacement ? <code>{f.replacement}</code> : replacementText(t, f)}</td>
      <td>
        <ul className="upgrade__origins">
          {f.origins.map((o, i) => (
            <li key={i}>{originText(t, o)}</li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

const SOURCE_LABELS: Record<SourceType, string> = {
  live: "upgrade:filters.live",
  helm: "upgrade:filters.helm",
  argoCd: "upgrade:filters.argoCd",
  flux: "upgrade:filters.flux",
};

export function UpgradePage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const state = useUpgradeState(clusterId);
  const { patch } = useUpgradeStore.getState();
  const namespaces = useSelectedNamespaces(clusterId);

  useEffect(() => {
    const s = useUpgradeStore.getState().clusters[clusterId];
    if (!s?.scan && !s?.loading && !s?.error) void runScan(clusterId);
  }, [clusterId]);

  const scan = state.scan;
  const gitVersion = scan?.version?.gitVersion ?? null;
  const current = parseMinor(gitVersion);
  const target = state.target ?? defaultTarget(current, REVIEWED_FOR);
  const choices = targetChoices(current, REVIEWED_FOR);
  if (!choices.includes(target)) choices.push(target);

  const findings = useMemo(() => (scan ? evaluate(scan, current, target) : []), [scan, current, target]);
  const sources = useMemo(() => new Set(state.sources), [state.sources]);
  const shown = filterFindings(findings, { sources, namespaces: namespaces ?? null, history: state.history });
  const served = useMemo(() => (scan ? servedFindings(scan, target) : []), [scan, target]);
  const skew = useMemo(() => (scan ? skewIssues(current, target, scan.nodes, scan.components) : []), [scan, current, target]);
  const counts = countByStatus(shown);
  const servedCounts = countByStatus(served);
  const hidden = findings.length - shown.length;
  const installed = new Set(
    (scan?.sources ?? []).filter((s) => s.outcome !== "notInstalled").map((s) => s.source as string),
  );

  const toggleSource = (source: SourceType, on: boolean) =>
    patch(clusterId, { sources: on ? [...state.sources, source] : state.sources.filter((s) => s !== source) });

  const report = () => markdownReport(t, { clusterVersion: gitVersion, target, findings: shown, served, skew });

  return (
    <div className="upgrade">
      <h2 className="upgrade__title">{t("upgrade:title")}</h2>
      <p className="upgrade__intro">{t("upgrade:intro")}</p>
      <p className="upgrade__muted">{t("upgrade:clientsNote")}</p>
      <div className="upgrade__toolbar">
        <span>{gitVersion ? t("upgrade:currentVersion", { version: gitVersion }) : t("upgrade:currentUnknown")}</span>
        <label className="upgrade__choice">
          {t("upgrade:target")}
          <select
            className="upgrade__select"
            value={target}
            onChange={(e) => patch(clusterId, { target: Number(e.target.value) })}
          >
            {choices.map((m) => (
              <option key={m} value={m}>
                {minorText(m)}
              </option>
            ))}
          </select>
        </label>
        <Button size="compact" icon="refresh" disabled={state.loading} onClick={() => void runScan(clusterId)}>
          {t("upgrade:rescan")}
        </Button>
        {scan && (
          <>
            <CopyButton label={t("upgrade:copyMarkdown")} text={report} />
            <CopyButton label={t("upgrade:copyCsv")} text={() => csvReport(t, shown)} />
          </>
        )}
      </div>

      {scan && (
        <div className="upgrade__counts" role="status">
          <Badge tone={counts.removed > 0 ? "danger" : "success"}>{t("upgrade:counts.removed", { count: counts.removed })}</Badge>
          <Badge tone={counts.deprecated > 0 ? "warning" : "neutral"}>{t("upgrade:counts.deprecated", { count: counts.deprecated })}</Badge>
          <Badge tone={servedCounts.removed > 0 ? "warning" : "neutral"}>{t("upgrade:counts.served", { count: served.length })}</Badge>
          <Badge tone={skew.length > 0 ? "warning" : "neutral"}>{t("upgrade:counts.skew", { count: skew.length })}</Badge>
          {state.scannedAt !== null && (
            <span className="upgrade__muted">{t("upgrade:scannedAt", { time: formatDateTime(state.scannedAt) })}</span>
          )}
        </div>
      )}

      {state.error && <ErrorState className="upgrade__error" title={t("upgrade:scanFailed")} error={state.error} onRetry={() => void runScan(clusterId)} />}
      {state.loading && <LoadingIndicator className="upgrade__loading" text={t("upgrade:scanning")} />}

      {scan && (
        <>
          <SourceNotes scan={scan} />
          <section className="upgrade__section" aria-label={t("upgrade:usages.title")}>
            <h3 className="upgrade__heading">{t("upgrade:usages.title")}</h3>
            <div className="upgrade__filters">
              <NamespaceFilter clusterId={clusterId} />
              {SOURCE_TYPES.filter((s) => s === "live" || installed.has(s)).map((s) => (
                <label key={s} className="upgrade__choice">
                  <Checkbox checked={sources.has(s)} onChange={(e) => toggleSource(s, e.target.checked)} />
                  {t(SOURCE_LABELS[s])}
                </label>
              ))}
              <label className="upgrade__choice">
                <Checkbox checked={state.history} onChange={(e) => patch(clusterId, { history: e.target.checked })} />
                {t("upgrade:filters.history")}
              </label>
            </div>
            {shown.length === 0 ? (
              <EmptyState title={findings.length === 0 ? t("upgrade:usages.none") : t("upgrade:usages.noneShown")} />
            ) : (
              <div className="upgrade__table-wrap">
                <ResizableTable tableId="upgrade.findings" className="upgrade__table">
                  <thead>
                    <tr>
                      <th>{t("upgrade:columns.status")}</th>
                      <th>{t("upgrade:columns.kind")}</th>
                      <th>{t("upgrade:columns.namespace")}</th>
                      <th>{t("upgrade:columns.name")}</th>
                      <th>{t("upgrade:columns.apiVersion")}</th>
                      <th>{t("upgrade:columns.when")}</th>
                      <th>{t("upgrade:columns.replacement")}</th>
                      <th>{t("upgrade:columns.source")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((f) => (
                      <FindingRow key={f.key} f={f} />
                    ))}
                  </tbody>
                </ResizableTable>
              </div>
            )}
            {hidden > 0 && <p className="upgrade__muted">{t("upgrade:usages.hidden", { count: hidden })}</p>}
          </section>

          <section className="upgrade__section" aria-label={t("upgrade:served.title")}>
            <h3 className="upgrade__heading">{t("upgrade:served.title")}</h3>
            <p className="upgrade__muted">{t("upgrade:served.hint")}</p>
            {served.length === 0 ? (
              <p className="upgrade__muted">{t("upgrade:served.none")}</p>
            ) : (
              <ul className="upgrade__list">
                {served.map((s) => (
                  <li key={`${s.apiVersion}|${s.api.kind}`}>
                    <Badge tone={s.status === "removed" ? "danger" : "warning"}>{statusText(t, s.status)}</Badge>{" "}
                    <code>{s.apiVersion}</code> {s.api.kind} <span className="upgrade__muted">{servedText(t, s)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="upgrade__section" aria-label={t("upgrade:skew.title")}>
            <h3 className="upgrade__heading">{t("upgrade:skew.title")}</h3>
            {skew.length === 0 ? (
              <p className="upgrade__muted">{t("upgrade:skew.none")}</p>
            ) : (
              <ul className="upgrade__list">
                {skew.map((issue, i) => (
                  <li key={i}>{skewText(t, issue)}</li>
                ))}
              </ul>
            )}
            {scan.nodes.length > 0 && (
              <p className="upgrade__muted">
                {t("upgrade:skew.kubelets", {
                  versions: formatList(
                    kubeletVersions(scan.nodes).map((v) =>
                      t("upgrade:skew.kubeletVersion", { version: v.version || "?", count: v.count }),
                    ),
                  ),
                })}
              </p>
            )}
            <p className="upgrade__muted">
              {scan.components.length > 0
                ? t("upgrade:skew.components", {
                    components: formatList(scan.components.map((c) => `${c.component} ${c.version || "?"}`)),
                  })
                : t("upgrade:skew.noComponents")}
            </p>
          </section>

          <p className="upgrade__muted">{t("upgrade:tableSource", { version: minorText(REVIEWED_FOR), url: DEPRECATION_SOURCE })}</p>
        </>
      )}
    </div>
  );
}
