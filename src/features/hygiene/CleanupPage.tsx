// The "Cleanup" page (#147) of the Cluster section: objects that look unused or left over in the namespaces in view
// (and PersistentVolumes cluster-wide), grouped by rule, each with why it looks unused, its age and what deleting it
// would touch (the resource map's impact lines). Objects a tool manages are listed apart and never offered. Selected
// candidates are deleted only after a confirmation that lists every one of them (`CleanupDeleteDialog`). Bounded by
// the namespace filter like the map and the security page: with "All namespaces" it asks for a choice, and only the
// first `MAX_CLEANUP_NAMESPACES` chosen namespaces are watched, only while the page is open.
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import { ageParts, Button, Checkbox, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { formatList } from "../../i18n/format";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { impactText } from "../resource-map/RelatedTab";
import { CleanupDeleteDialog } from "./CleanupDeleteDialog";
import { CleanupSettingsDialog } from "./CleanupSettingsDialog";
import { MAX_CLEANUP_NAMESPACES, useCleanup } from "./hooks";
import type { Manager } from "./managed";
import { objectName, type Candidate, type RuleId } from "./rules";
import "./hygiene.css";

export const CLEANUP_PAGE_ID = "cleanup";
/** At most this many rows are drawn (candidates and managed objects together). */
export const MAX_RENDERED = 500;

const RULE_ORDER: RuleId[] = ["pod", "job", "replicaSet", "configMap", "secret", "service", "claim", "volume", "namespace"];

export function CleanupPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="cln-page">
      <h2 className="cln-page__title">{t("hygiene:title")}</h2>
      <p className="cln-note">{t("hygiene:intro")}</p>
      {settingsOpen && <CleanupSettingsDialog close={() => setSettingsOpen(false)} />}
      {selected === undefined ? (
        <LoadingIndicator className="cln-loading" text={t("hygiene:loading")} />
      ) : selected === null || selected.length === 0 ? (
        <>
          <Toolbar clusterId={clusterId} openSettings={() => setSettingsOpen(true)} />
          <EmptyState title={t("hygiene:chooseNamespace")} text={t("hygiene:chooseNamespaceText")} />
        </>
      ) : (
        <CleanupView clusterId={clusterId} selected={selected} openSettings={() => setSettingsOpen(true)} />
      )}
    </div>
  );
}

function Toolbar({ clusterId, openSettings, children }: { clusterId: ClusterId; openSettings: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="cln-toolbar">
      <NamespaceFilter clusterId={clusterId} />
      <Button onClick={openSettings}>{t("hygiene:settings.button")}</Button>
      {children}
    </div>
  );
}

function CleanupView({ clusterId, selected, openSettings }: { clusterId: ClusterId; selected: string[]; openSettings: () => void }) {
  const { t } = useTranslation();
  const data = useCleanup(clusterId, selected);
  const { result } = data;
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<Candidate[] | null>(null);

  const byKey = useMemo(() => new Map(result.candidates.map((c) => [c.key, c])), [result.candidates]);
  // A selection holds only what is still a candidate.
  const chosen = [...picked].filter((key) => byKey.has(key));

  const groups = useMemo(() => {
    const map = new Map<RuleId, { candidates: Candidate[]; managed: Candidate[]; kept: Candidate[] }>();
    for (const rule of RULE_ORDER) map.set(rule, { candidates: [], managed: [], kept: [] });
    for (const c of result.candidates) map.get(c.rule)!.candidates.push(c);
    for (const c of result.managed) map.get(c.rule)!.managed.push(c);
    for (const c of result.kept) map.get(c.rule)!.kept.push(c);
    return [...map.entries()].filter(([, g]) => g.candidates.length + g.managed.length + g.kept.length > 0);
  }, [result]);

  const toggle = (keys: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const uncheckedKinds = [...new Set(result.unchecked.flatMap((u) => u.kinds))].sort();
  let budget = MAX_RENDERED;
  const total = result.candidates.length + result.managed.length + result.kept.length;

  return (
    <>
      <Toolbar clusterId={clusterId} openSettings={openSettings}>
        <Button icon="refresh" onClick={data.resample}>
          {t("hygiene:checkAgain")}
        </Button>
        <Button
          variant="danger"
          icon="delete"
          disabled={chosen.length === 0}
          onClick={() => setConfirming(chosen.map((key) => byKey.get(key)!))}
        >
          {t("hygiene:deleteSelected", { count: chosen.length })}
        </Button>
      </Toolbar>
      {selected.length > MAX_CLEANUP_NAMESPACES && (
        <p className="cln-note cln-note--warning" role="status">
          {t("hygiene:firstNamespaces", { count: MAX_CLEANUP_NAMESPACES })}
        </p>
      )}
      {data.skipped.length > 0 && <p className="cln-note">{t("hygiene:excludedInView", { names: formatList(data.skipped) })}</p>}
      {data.rules.configMaps || data.rules.secrets ? (
        <p className="cln-note cln-note--warning">{t("hygiene:configsWarning")}</p>
      ) : (
        <p className="cln-note">{t("hygiene:configsOff")}</p>
      )}
      {data.sampleFailed.map((ns) => (
        <p key={ns} className="cln-note cln-note--warning">
          {t("hygiene:sampleFailed", { namespace: ns })}
        </p>
      ))}
      {result.unavailableGroups.length > 0 && (
        <p className="cln-note cln-note--warning">{t("hygiene:unavailableGroups", { groups: formatList(result.unavailableGroups) })}</p>
      )}
      {data.clusterFailed && <p className="cln-note cln-note--warning">{t("hygiene:clusterFailed")}</p>}
      {result.clusterUnread.length > 0 && (
        <p className="cln-note cln-note--warning">{t("hygiene:clusterUnread", { kinds: formatList(result.clusterUnread) })}</p>
      )}
      {result.blocked.map((b) => (
        <p key={b.namespace} className="cln-note">
          {t("hygiene:blocked", { namespace: b.namespace, kinds: formatList(b.kinds) })}
        </p>
      ))}
      {data.failures.map((f) =>
        f.error ? (
          <ErrorState key={f.kind} className="cln-error" title={t("hygiene:watchFailed", { kind: f.kind })} error={f.error} />
        ) : (
          <p key={f.kind} className="cln-note cln-note--warning">
            {t("hygiene:forbidden", { kind: f.kind, names: formatList(f.forbidden ?? []) })}
          </p>
        ),
      )}
      {!data.loading && uncheckedKinds.length > 0 && (
        <p className="cln-note cln-note--warning">{t("hygiene:unchecked", { kinds: formatList(uncheckedKinds) })}</p>
      )}
      {total > MAX_RENDERED && (
        <p className="cln-note cln-note--warning" role="status">
          {t("hygiene:truncated", { count: MAX_RENDERED })}
        </p>
      )}

      {data.checked.length === 0 && data.skipped.length > 0 && result.candidates.length === 0 ? (
        <p className="cln-note">{t("hygiene:nothingChecked")}</p>
      ) : data.loading && total === 0 ? (
        <LoadingIndicator className="cln-loading" text={t("hygiene:loading")} />
      ) : total === 0 ? (
        <p className="cln-note">{t("hygiene:none")}</p>
      ) : (
        groups.map(([rule, group]) => {
          const shown = group.candidates.slice(0, Math.max(0, budget));
          budget -= shown.length;
          const shownManaged = group.managed.slice(0, Math.max(0, budget));
          budget -= shownManaged.length;
          const shownKept = group.kept.slice(0, Math.max(0, budget));
          budget -= shownKept.length;
          const keys = group.candidates.map((c) => c.key);
          const all = keys.length > 0 && keys.every((k) => picked.has(k));
          const heading = t(`hygiene:rule.${rule}`);
          return (
            <section key={rule} className="cln-group" aria-label={heading}>
              <h3 className="cln-group__heading">
                {keys.length > 0 && (
                  <Checkbox
                    checked={all}
                    aria-label={t("hygiene:selectGroup", { group: heading })}
                    onChange={(e) => toggle(keys, e.target.checked)}
                  />
                )}
                <span>{heading}</span>
                <span className="cln-muted">{group.candidates.length + group.managed.length + group.kept.length}</span>
              </h3>
              {shown.length > 0 && (
                <CandidateTable rows={shown} picked={picked} onToggle={(key, on) => toggle([key], on)} />
              )}
              {shownManaged.length > 0 && (
                <>
                  <h4 className="cln-managed__title">{t("hygiene:managed.title")}</h4>
                  <p className="cln-note">{t("hygiene:managed.text")}</p>
                  <CandidateTable rows={shownManaged} />
                </>
              )}
              {shownKept.length > 0 && (
                <>
                  <h4 className="cln-managed__title">{t("hygiene:kept.title")}</h4>
                  <CandidateTable rows={shownKept} />
                </>
              )}
            </section>
          );
        })
      )}
      {confirming && (
        <CleanupDeleteDialog
          clusterId={clusterId}
          items={confirming}
          current={data.evaluate}
          recheck={data.recheck}
          close={(deleted) => {
            setConfirming(null);
            if (deleted.length > 0) toggle(deleted, false);
          }}
        />
      )}
    </>
  );
}

function sinceText(c: Candidate, t: ReturnType<typeof useTranslation>["t"]): string {
  const { unit, count } = ageParts(Math.max(0, Date.now() - c.since));
  return t(`hygiene:since.${c.sinceKind}`, { age: t(`common:age.${unit}`, { count }) });
}

function managerText(manager: Manager, t: ReturnType<typeof useTranslation>["t"]): string {
  if (manager.tool === "helm") return manager.name ? t("hygiene:managed.helm", { name: manager.name }) : t("hygiene:managed.helmUnnamed");
  return t(`hygiene:managed.${manager.tool}`, { name: manager.name });
}

export function reasonText(c: Candidate, t: ReturnType<typeof useTranslation>["t"]): string {
  return t(`hygiene:reason.${c.reason.id}`, c.reason.values ?? {});
}

function CandidateTable({
  rows,
  picked,
  onToggle,
}: {
  rows: Candidate[];
  /** Without it the rows cannot be selected (managed objects). */
  picked?: ReadonlySet<string>;
  onToggle?: (key: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const managed = !picked;
  return (
    <table className="cln-table">
      <thead>
        <tr>
          {!managed && <th className="cln-table__check" />}
          <th>{t("hygiene:column.object")}</th>
          <th>{t("hygiene:column.reason")}</th>
          <th>{t("hygiene:column.age")}</th>
          <th>{managed ? t("hygiene:column.manager") : t("hygiene:column.impact")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.key} data-key={c.key}>
            {!managed && (
              <td className="cln-table__check">
                <Checkbox
                  checked={picked.has(c.key)}
                  aria-label={t("hygiene:select", { kind: c.kind.kind, name: objectName(c) })}
                  onChange={(e) => onToggle?.(c.key, e.target.checked)}
                />
              </td>
            )}
            <td>
              <button
                type="button"
                className="rt-link cln-object"
                aria-label={t("hygiene:open", { kind: c.kind.kind, name: objectName(c) })}
                onClick={() => openDetails({ kind: c.kind, namespace: c.namespace, name: c.name })}
              >
                <span className="cln-muted">{c.kind.kind}</span>
                <span>{objectName(c)}</span>
              </button>
            </td>
            <td className="cln-reason">{reasonText(c, t)}</td>
            <td className="cln-age">
              <time dateTime={new Date(c.since).toISOString()} title={new Date(c.since).toISOString()}>
                {sinceText(c, t)}
              </time>
            </td>
            <td className="cln-impact">
              {managed ? (
                c.managedBy ? managerText(c.managedBy, t) : t("hygiene:kept.retain")
              ) : c.impact.length + c.notes.length > 0 ? (
                <ul className="cln-impact__list">
                  {c.notes.map((note) => (
                    <li key={note.id} className={note.id === "reclaimDelete" ? "cln-note--warning" : undefined}>
                      {t(`hygiene:note.${note.id}`, note.values ?? {})}
                    </li>
                  ))}
                  {c.impact.map((line) => (
                    <li key={line.id}>{impactText(line, t)}</li>
                  ))}
                </ul>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
