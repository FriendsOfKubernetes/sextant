// Helm → Releases: the latest revision of every release in the selected namespaces, read natively from the
// cluster and refreshed on every change of the release Secrets. A row opens the release's details beside the list.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HelmRelease } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { Age, Badge, EmptyState, ErrorState } from "../../components";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { HelmMissing } from "./HelmMissing";
import { useHelmReleases, useHelmStatus } from "./hooks";
import { ReleaseDetails } from "./ReleaseDetails";
import { StatusBadge } from "./StatusBadge";
import "./helm.css";

const keyOf = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;

function matches(r: HelmRelease, search: string, unreadableText: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const fields = [r.name, r.namespace, r.chart, r.chartVersion, r.appVersion, r.status];
  if (r.unreadableRevision !== null) fields.push(unreadableText);
  return fields.some((v) => v.toLowerCase().includes(q));
}

export function ReleasesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  const search = useClusterView(clusterId).search;
  const setSearch = useAppStore((s) => s.setSearch);
  const helm = useHelmStatus();
  const { releases, loading, error, refresh } = useHelmReleases(clusterId, namespaces);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      releases
        .filter((r) => matches(r, search, t("helm:releases.unreadable")))
        .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
    [releases, search, t],
  );
  const selected = releases.find((r) => keyOf(r) === selectedKey) ?? null;

  return (
    <div className="helm-page">
      <header className="helm-page__header">
        <h2>{t("helm:releases.title")}</h2>
        <NamespaceFilter clusterId={clusterId} />
        <input
          className="main__search"
          type="search"
          value={search}
          placeholder={t("helm:releases.searchPlaceholder")}
          aria-label={t("helm:releases.search")}
          onChange={(e) => setSearch(clusterId, e.target.value)}
        />
      </header>
      {helm && !helm.available && <HelmMissing />}
      {error && <ErrorState error={error} onRetry={refresh} />}
      <div className="helm-page__body">
        <div className="helm-page__list">
          {loading && releases.length === 0 && !error ? (
            <div className="helm-muted" role="status">
              {t("helm:releases.loading")}
            </div>
          ) : releases.length === 0 && !error ? (
            <EmptyState title={t("helm:releases.empty")} text={t("helm:releases.emptyText")} />
          ) : shown.length === 0 && !error ? (
            <EmptyState title={t("helm:releases.noMatch")} />
          ) : (
            <ReleaseTable releases={shown} selectedKey={selectedKey} onSelect={setSelectedKey} />
          )}
        </div>
        {selected && (
          <ReleaseDetails
            key={keyOf(selected)}
            clusterId={clusterId}
            release={selected}
            helmAvailable={helm?.available ?? false}
            onClose={() => setSelectedKey(null)}
            onChanged={refresh}
          />
        )}
      </div>
    </div>
  );
}

function ReleaseTable({
  releases,
  selectedKey,
  onSelect,
}: {
  releases: HelmRelease[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <table className="helm-table" aria-label={t("helm:releases.title")}>
      <thead>
        <tr>
          <th>{t("helm:columns.name")}</th>
          <th>{t("helm:columns.namespace")}</th>
          <th>{t("helm:columns.chart")}</th>
          <th>{t("helm:columns.version")}</th>
          <th>{t("helm:columns.appVersion")}</th>
          <th>{t("helm:columns.status")}</th>
          <th>{t("helm:columns.updated")}</th>
        </tr>
      </thead>
      <tbody>
        {releases.map((r) => {
          const key = keyOf(r);
          return (
            <tr
              key={key}
              data-release={key}
              aria-selected={key === selectedKey}
              className={key === selectedKey ? "helm-row helm-row--selected" : "helm-row"}
              onClick={() => onSelect(key)}
            >
              <td>
                <button
                  type="button"
                  className="helm-link"
                  aria-label={t("helm:releases.open", { name: r.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(key);
                  }}
                >
                  {r.name}
                </button>
              </td>
              <td>{r.namespace}</td>
              <td>{r.chart}</td>
              <td>{r.chartVersion}</td>
              <td>{r.appVersion}</td>
              <td>
                <span className="helm-status">
                  {!r.unreadable && <StatusBadge status={r.status} />}
                  {r.unreadableRevision !== null && (
                    <Badge tone="danger">{t("helm:releases.unreadableRevision", { revision: r.unreadableRevision })}</Badge>
                  )}
                </span>
              </td>
              <td>
                <Age timestamp={r.updated} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
