// "Add cluster → From cloud": the cloud CLIs found on this machine (`aws`, `gcloud`, `az`, `yc`), an account of the chosen
// one (and the regions for AWS), the clusters it lists, and "Add". Sextant never signs in: when a CLI is signed out or
// a plugin is missing, the problem shows the command the user runs (copied with one click, or typed — not run — into a
// local terminal in the dock) or the install guide.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  toApiError,
  type ApiError,
  type ClusterId,
  type CloudAccount,
  type CloudAccounts,
  type CloudCliStatus,
  type CloudCluster,
  type CloudImport,
  type CloudProblem,
  type CloudProvider,
  type CloudQuery,
  type CloudSearch,
} from "../../api";
import { Button, Checkbox, ErrorState, Radio } from "../../components";
import { dotSeparator } from "../../i18n";
import { refreshClusters } from "./clustersStore";
import { YandexCloudQuery } from "./YandexCloudQuery";
import { YandexClusterStatus } from "./YandexClusterStatus";
import { CloudProblemView, CommandLine } from "./CloudProblemView";
export { CloudProblemView } from "./CloudProblemView";

/** Below a failed connection: how to sign in again with the cluster's cloud CLI, if it signs in through one. */
export function CloudLoginHint({ clusterId }: { clusterId: ClusterId }) {
  const [hint, setHint] = useState<CloudProblem | null>(null);
  useEffect(() => {
    let live = true;
    api.cloud
      .loginHint(clusterId)
      .then((found) => live && setHint(found))
      .catch(() => live && setHint(null));
    return () => {
      live = false;
    };
  }, [clusterId]);
  return hint ? <CloudProblemView problem={hint} /> : null;
}

function StatusLine({ status }: { status: CloudCliStatus }) {
  const { t } = useTranslation();
  const cli = t(`clusters:cloud.cli.${status.provider}`);
  return (
    <span className="cloud-provider__status">
      {status.available
        ? t("clusters:cloud.version", { cli, version: status.version ?? t("clusters:cloud.unknownVersion") })
        : t("clusters:cloud.notInstalled", { cli })}
    </span>
  );
}

/** "Not installed" with the install guide, or the missing credential plugin with its install command. */
function ProviderHints({ status, onTerminalOpened }: { status: CloudCliStatus; onTerminalOpened?: () => void }) {
  const { t } = useTranslation();
  if (!status.available) {
    return (
      <div className="cloud-provider__hint">
        <Button size="compact" onClick={() => void api.shell.openUrl(status.installUrl)}>
          {t("clusters:cloud.installGuide")}
        </Button>
      </div>
    );
  }
  if (status.plugin && !status.plugin.available) {
    return (
      <div className="cloud-provider__hint">
        <p className="clusters-hint">{t("clusters:cloud.pluginMissing", { plugin: status.plugin.name })}</p>
        <CommandLine command={status.plugin.installCommand} onTerminalOpened={onTerminalOpened} />
      </div>
    );
  }
  return null;
}

function clusterKey(cluster: CloudCluster): string {
  return `${cluster.provider}:${cluster.context}`;
}

function canImport(cluster: CloudCluster): boolean {
  return cluster.provider !== "yandex" || !!(cluster.endpoint && cluster.certificateAuthority);
}

function CloudClusterRow({ cluster, selected, alreadyAdded, onChange }: {
  cluster: CloudCluster; selected: boolean; alreadyAdded: boolean; onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const unavailable = !canImport(cluster);
  const details = [cluster.location, cluster.version, cluster.provider === "yandex" ? null : cluster.status].filter(Boolean).join(dotSeparator());
  return (
    <li className={`cloud-clusters__item${unavailable ? " cloud-clusters__item--unavailable" : ""}`}>
      <label className={cluster.provider === "yandex" ? "cloud-clusters__label cloud-yandex-row" : "cloud-clusters__label"}>
        <Checkbox
          className={alreadyAdded ? "cloud-clusters__check-added" : undefined}
          checked={alreadyAdded || selected}
          disabled={unavailable || alreadyAdded}
          onChange={e => onChange(e.target.checked)}
        />
        <span className="cloud-clusters__name">{cluster.name}</span>
        <span className="cloud-clusters__details">{details}</span>
        {cluster.provider === "yandex" && <YandexClusterStatus status={cluster.status} />}
        {unavailable && <span className="cloud-clusters__details">{t("clusters:cloud.yandex.unavailable")}</span>}
        {alreadyAdded && <span className="cloud-clusters__added">{t("clusters:cloud.alreadyAdded")}</span>}
      </label>
    </li>
  );
}

/** `onTerminalOpened`: a terminal tab was opened in the dock (the window around this view closes, so it is seen). */
export function CloudClusters({ onTerminalOpened }: { onTerminalOpened?: () => void }) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<CloudCliStatus[] | null>(null);
  const [provider, setProvider] = useState<CloudProvider | null>(null);
  const [accounts, setAccounts] = useState<CloudAccounts | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [search, setSearch] = useState<CloudSearch | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CloudImport | null>(null);
  const [busy, setBusy] = useState<"accounts" | "find" | "import" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const searchGeneration = useRef(0);
  const clearSearch = useCallback((preserveAdded = false) => {
    searchGeneration.current++;
    setSearch(null);
    setResult(null);
    setSelected(new Set());
    if (!preserveAdded) setAdded(new Set());
    setError(null);
    setBusy(current => current === "find" ? null : current);
  }, []);

  useEffect(() => {
    let live = true;
    api.cloud
      .status()
      .then((list) => {
        if (!live) return;
        setStatuses(list);
        setProvider(list.find((s) => s.available)?.provider ?? null);
      })
      .catch((err) => live && setError(toApiError(err)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    clearSearch();
    setAccounts(null);
    setAccount(null);
    setSearch(null);
    setResult(null);
    setError(null);
    if (!provider || provider === "yandex") { setBusy(null); return; }
    let live = true;
    setBusy("accounts");
    api.cloud
      .accounts(provider)
      .then((found) => {
        if (!live) return;
        setAccounts(found);
        const chosen = found.accounts.find((a) => a.isDefault) ?? found.accounts[0];
        setAccount(chosen?.id ?? null);
        setRegions(chosen?.region ? [chosen.region] : []);
      })
      .catch((err) => live && setError(toApiError(err)))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [provider, clearSearch]);

  const chooseAccount = (id: string) => {
    clearSearch();
    setAccount(id);
    const region = accounts?.accounts.find((a) => a.id === id)?.region;
    setRegions(region ? [region] : []);
    setSearch(null);
    setResult(null);
  };

  const toggleRegion = (region: string, on: boolean) =>
    setRegions((current) => (on ? [...current, region] : current.filter((r) => r !== region)));

  const find = async (request: CloudQuery) => {
    const generation = searchGeneration.current;
    setBusy("find");
    setError(null);
    setResult(null);
    try {
      const found = await api.cloud.find(request);
      if (generation !== searchGeneration.current) return;
      setSearch(found);
      setSelected(new Set(found.clusters.filter(c => canImport(c) && !added.has(clusterKey(c))).map(clusterKey)));
    } catch (err) {
      if (generation === searchGeneration.current) setError(toApiError(err));
    } finally {
      if (generation === searchGeneration.current) setBusy(null);
    }
  };

  const add = async () => {
    if (!search) return;
    const generation = searchGeneration.current;
    const chosen = search.clusters.filter((c) => selected.has(clusterKey(c)) && canImport(c));
    setBusy("import");
    setError(null);
    try {
      const imported = await api.cloud.importClusters(chosen);
      if (generation === searchGeneration.current) {
        setResult(imported);
        const contexts = new Set(imported.contexts);
        const completed = chosen.filter(c => contexts.has(c.context)).map(clusterKey);
        setAdded(current => new Set([...current, ...completed]));
        setSelected(current => {
          const next = new Set(current);
          completed.forEach(key => next.delete(key));
          return next;
        });
      }
      await refreshClusters();
    } catch (err) {
      if (generation === searchGeneration.current) setError(toApiError(err));
    } finally {
      setBusy(current => current === "import" ? null : current);
    }
  };

  if (!statuses) {
    return (
      <div className="cloud">
        {error ? <ErrorState error={error} className="clusters-error" /> : <p role="status">{t("clusters:cloud.detecting")}</p>}
      </div>
    );
  }

  const accountOption = (a: CloudAccount) => {
    if (a.id === "") return t("clusters:cloud.environmentCredentials");
    return a.name === a.id ? a.id : t("clusters:cloud.accountOption", { name: a.name, id: a.id });
  };
  const accountLabel = provider ? t(`clusters:cloud.account.${provider}`) : "";
  const canFind = busy === null && account !== null && (provider !== "aws" || regions.length > 0);
  const chosenCount = search?.clusters.filter((c) => selected.has(clusterKey(c))).length ?? 0;

  return (
    <div className="cloud">
      <p className="clusters-hint">{t("clusters:cloud.hint")}</p>
      <div className="cloud-providers" role="radiogroup" aria-label={t("clusters:cloud.providers")}>
        {statuses.map((status) => (
          <div key={status.provider} className="cloud-provider">
            <label className="cloud-provider__label">
              <Radio
                name="cloud-provider"
                checked={provider === status.provider}
                disabled={!status.available}
                onChange={() => setProvider(status.provider)}
              />
              <span className="cloud-provider__name">{t(`clusters:cloud.provider.${status.provider}`)}</span>
              <StatusLine status={status} />
            </label>
            <ProviderHints status={status} onTerminalOpened={onTerminalOpened} />
          </div>
        ))}
      </div>

      {provider && busy === "accounts" && <p role="status">{t("clusters:cloud.loadingAccounts")}</p>}
      {accounts?.problem && <CloudProblemView problem={accounts.problem} onTerminalOpened={onTerminalOpened} />}

      {provider === "yandex" && <YandexCloudQuery busy={busy === "find" || busy === "import"} searching={busy === "find"} onFind={find} onChange={clearSearch} onTerminalOpened={onTerminalOpened} />}
      {provider && provider !== "yandex" && accounts && accounts.accounts.length > 0 && (
        <div className="cloud-query">
          <label className="cloud-field">
            <span>{accountLabel}</span>
            <select value={account ?? ""} onChange={(e) => chooseAccount(e.target.value)}>
              {accounts.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountOption(a)}
                </option>
              ))}
            </select>
          </label>
          {provider === "aws" && (
            <fieldset className="cloud-regions">
              <legend>{t("clusters:cloud.regions")}</legend>
              <div className="cloud-regions__list">
                {accounts.regions.map((region) => (
                  <label key={region} className="cloud-regions__item">
                    <Checkbox
                      checked={regions.includes(region)}
                      onChange={(e) => toggleRegion(region, e.target.checked)}
                    />
                    <span>{region}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="clusters-buttons cloud-query__buttons">
            <Button variant="primary" disabled={!canFind} onClick={() => void find({ provider, account: account ?? "", regions: provider === "aws" ? regions : [] })}>
              {busy === "find" ? t("clusters:cloud.finding") : t("clusters:cloud.find")}
            </Button>
          </div>
        </div>
      )}

      {search && (
        <div className="cloud-results">
          {search.problems.map((problem, index) => (
            <CloudProblemView
              key={`${problem.kind}-${problem.scope ?? ""}-${index}`}
              problem={problem}
              onTerminalOpened={onTerminalOpened}
            />
          ))}
          {search.clusters.length === 0 ? (
            <p className="clusters-hint">{t("clusters:cloud.noClusters")}</p>
          ) : (
            <>
              <ul className="cloud-clusters" aria-label={t("clusters:cloud.found")}>
                {search.clusters.map(cluster => <CloudClusterRow key={clusterKey(cluster)} cluster={cluster}
                  selected={selected.has(clusterKey(cluster))} alreadyAdded={added.has(clusterKey(cluster))}
                  onChange={on => setSelected(current => {
                    const next = new Set(current);
                    if (on) next.add(clusterKey(cluster)); else next.delete(clusterKey(cluster));
                    return next;
                  })} />)}
              </ul>
              {(chosenCount > 0 || added.size === 0) && <div className="clusters-buttons">
                <Button variant="primary" disabled={busy !== null || chosenCount === 0} onClick={() => void add()}>
                  {t("clusters:cloud.add", { count: chosenCount })}
                </Button>
              </div>}
            </>
          )}
        </div>
      )}

      {result && (
        <div className="cloud-result">
          {result.contexts.length > 0 && (
            <p role="status">{t("clusters:cloud.added", { count: result.contexts.length })}</p>
          )}
          {result.problems.map((problem, index) => (
            <CloudProblemView
              key={`${problem.kind}-${problem.scope ?? ""}-${index}`}
              problem={problem}
              onTerminalOpened={onTerminalOpened}
            />
          ))}
        </div>
      )}
      {error && <ErrorState error={error} className="clusters-error" />}
    </div>
  );
}
