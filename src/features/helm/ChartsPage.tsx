// Helm → Charts: chart repositories (add, remove, update), chart search, the default values of a chart and its
// installation into a namespace. Everything here runs `helm`; without it the page only explains how to get it.
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ChartHit, type HelmRepo } from "../../api";
import { ErrorState } from "../../components";
import type { PageProps } from "../../layout/pages";
import { YamlViewer } from "../details";
import { useSelectedNamespaces } from "../namespaces";
import { InstallDialog, RemoveRepoDialog } from "./dialogs";
import { HelmMissing } from "./HelmMissing";
import { useHelmStatus, useLoad } from "./hooks";
import "./helm.css";

const DEFAULT_NAMESPACE = "default";

export function ChartsPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const helm = useHelmStatus();
  const available = helm?.available ?? false;
  const namespaces = useSelectedNamespaces(clusterId);
  const [hits, setHits] = useState<ChartHit[] | null>(null);
  const [selected, setSelected] = useState<ChartHit | null>(null);

  return (
    <div className="helm-page">
      <header className="helm-page__header">
        <h2>{t("helm:charts.title")}</h2>
      </header>
      {helm === null && (
        <div className="helm-muted" role="status">
          {t("helm:status.loading")}
        </div>
      )}
      {helm && !helm.available && <HelmMissing />}
      <div className="helm-charts">
        <Repositories available={available} />
        <ChartSearch
          available={available}
          hits={hits}
          onHits={(h) => {
            setHits(h);
            setSelected(null);
          }}
          selected={selected}
          onSelect={setSelected}
        />
        {selected && (
          <ChartDetails
            key={`${selected.name}@${selected.version}`}
            clusterId={clusterId}
            chart={selected}
            available={available}
            defaultNamespace={namespaces?.[0] ?? DEFAULT_NAMESPACE}
          />
        )}
      </div>
    </div>
  );
}

function Repositories({ available }: { available: boolean }) {
  const { t } = useTranslation();
  const nameId = useId();
  const urlId = useId();
  const repos = useLoad(available ? "repos" : null, () => api.helm.repos());
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"add" | "update" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HelmRepo | null>(null);

  const run = async (kind: "add" | "update", action: () => Promise<void>, done?: string) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      repos.reload();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run("add", async () => {
      await api.helm.repoAdd(name.trim(), url.trim());
      setName("");
      setUrl("");
    });
  };

  const list = repos.data ?? [];
  return (
    <section className="helm-section" aria-label={t("helm:charts.repositories")}>
      <div className="helm-section__header">
        <h3>{t("helm:charts.repositories")}</h3>
        <button
          type="button"
          className="btn"
          disabled={!available || busy !== null || list.length === 0}
          title={available ? undefined : t("helm:missing.short")}
          onClick={() => void run("update", () => api.helm.repoUpdate(), t("helm:charts.updated"))}
        >
          {busy === "update" ? t("helm:charts.updating") : t("helm:charts.update")}
        </button>
      </div>
      {repos.error && <ErrorState error={repos.error} onRetry={repos.reload} />}
      {available && repos.data && list.length === 0 && <p className="helm-muted">{t("helm:charts.noRepos")}</p>}
      {list.length > 0 && (
        <table className="helm-table" aria-label={t("helm:charts.repositories")}>
          <thead>
            <tr>
              <th>{t("helm:charts.repoName")}</th>
              <th>{t("helm:charts.repoUrl")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.name} data-repo={r.name}>
                <td>{r.name}</td>
                <td className="helm-url">{r.url}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={!available}
                    aria-label={t("helm:charts.removeLabel", { name: r.name })}
                    onClick={() => setRemoving(r)}
                  >
                    {t("helm:charts.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="helm-form" onSubmit={add}>
        <label htmlFor={nameId}>{t("helm:charts.repoName")}</label>
        <input
          id={nameId}
          value={name}
          disabled={!available}
          spellCheck={false}
          placeholder={t("helm:charts.repoNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor={urlId}>{t("helm:charts.repoUrl")}</label>
        <input
          id={urlId}
          value={url}
          disabled={!available}
          spellCheck={false}
          placeholder={t("helm:charts.repoUrlPlaceholder")}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!available || busy !== null || name.trim() === "" || url.trim() === ""}
          title={available ? undefined : t("helm:missing.short")}
        >
          {busy === "add" ? t("helm:charts.adding") : t("helm:charts.add")}
        </button>
      </form>
      {error && <ErrorState error={error} />}
      {notice && (
        <p className="helm-muted" role="status">
          {notice}
        </p>
      )}
      {removing && (
        <RemoveRepoDialog
          repo={removing}
          close={() => setRemoving(null)}
          onDone={repos.reload}
        />
      )}
    </section>
  );
}

function ChartSearch({
  available,
  hits,
  onHits,
  selected,
  onSelect,
}: {
  available: boolean;
  hits: ChartHit[] | null;
  onHits: (hits: ChartHit[] | null) => void;
  selected: ChartHit | null;
  onSelect: (hit: ChartHit) => void;
}) {
  const { t } = useTranslation();
  const queryId = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onHits(await api.helm.search(query.trim()));
    } catch (err) {
      setError(toApiError(err));
      onHits(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="helm-section" aria-label={t("helm:charts.search")}>
      <h3>{t("helm:charts.search")}</h3>
      <form className="helm-form" onSubmit={(e) => void search(e)}>
        <label htmlFor={queryId} className="helm-visually-hidden">
          {t("helm:charts.search")}
        </label>
        <input
          id={queryId}
          type="search"
          value={query}
          disabled={!available}
          placeholder={t("helm:charts.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!available || busy}
          title={available ? undefined : t("helm:missing.short")}
        >
          {busy ? t("helm:charts.searching") : t("helm:charts.searchButton")}
        </button>
      </form>
      {error && <ErrorState error={error} />}
      {hits && hits.length === 0 && <p className="helm-muted">{t("helm:charts.noResults")}</p>}
      {hits && hits.length > 0 && (
        <table className="helm-table" aria-label={t("helm:charts.search")}>
          <thead>
            <tr>
              <th>{t("helm:columns.chart")}</th>
              <th>{t("helm:columns.version")}</th>
              <th>{t("helm:columns.appVersion")}</th>
              <th>{t("helm:charts.description")}</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr
                key={h.name}
                data-chart={h.name}
                aria-selected={selected?.name === h.name}
                className={selected?.name === h.name ? "helm-row helm-row--selected" : "helm-row"}
                onClick={() => onSelect(h)}
              >
                <td>
                  <button
                    type="button"
                    className="helm-link"
                    aria-label={t("helm:charts.select", { name: h.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(h);
                    }}
                  >
                    {h.name}
                  </button>
                </td>
                <td>{h.version}</td>
                <td>{h.appVersion}</td>
                <td className="helm-muted">{h.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ChartDetails({
  clusterId,
  chart,
  available,
  defaultNamespace,
}: {
  clusterId: string;
  chart: ChartHit;
  available: boolean;
  defaultNamespace: string;
}) {
  const { t } = useTranslation();
  const values = useLoad(available ? `${chart.name}@${chart.version}` : null, () =>
    api.helm.showValues(chart.name, chart.version || null),
  );
  const [installing, setInstalling] = useState(false);

  return (
    <section className="helm-section" aria-label={chart.name}>
      <div className="helm-section__header">
        <h3>{`${chart.name} ${chart.version}`}</h3>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!available || values.data === null}
          title={available ? undefined : t("helm:missing.short")}
          onClick={() => setInstalling(true)}
        >
          {t("helm:charts.install")}
        </button>
      </div>
      {chart.description && <p className="helm-muted">{chart.description}</p>}
      <h4>{t("helm:charts.defaultValues")}</h4>
      {values.loading && (
        <div className="helm-muted" role="status">
          {t("helm:charts.loadingValues")}
        </div>
      )}
      {values.error && <ErrorState error={values.error} onRetry={values.reload} />}
      {values.data !== null && (
        <YamlViewer
          text={values.data}
          label={t("helm:charts.defaultValuesLabel", { name: chart.name, version: chart.version })}
        />
      )}
      {installing && (
        <InstallDialog
          clusterId={clusterId}
          chart={chart.name}
          version={chart.version}
          defaultValues={values.data ?? ""}
          defaultNamespace={defaultNamespace}
          close={() => setInstalling(false)}
        />
      )}
    </section>
  );
}
