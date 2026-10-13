// "Add cluster → From cloud": the cloud CLIs found on this machine (`aws`, `gcloud`, `az`), an account of the chosen
// one (and the regions for AWS), the clusters it lists, and "Add". Sextant never signs in: when a CLI is signed out or
// a plugin is missing, the problem shows the command the user runs (copied with one click, or typed — not run — into a
// local terminal in the dock) or the install guide.
import { useEffect, useState } from "react";
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
  type CloudSearch,
} from "../../api";
import { Button, Checkbox, ErrorState, Radio } from "../../components";
// Not "../terminal": that feature imports the clusters store, and its index registers actions.
import { openCommandTerminalTab } from "../terminal/tabs";
import { refreshClusters } from "./clustersStore";

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("the clipboard is not available");
  await navigator.clipboard.writeText(text);
}

/**
 * A command for the user to run, with "Copy command" and "Open terminal" (a local terminal in the dock with the
 * command typed in; the user presses Enter).
 */
function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "opened" | null>(null);
  const copy = async () => {
    try {
      await writeClipboard(command);
      setFeedback("copied");
    } catch {
      setFeedback("copyFailed");
    }
  };
  const openTerminal = () => {
    openCommandTerminalTab(command);
    setFeedback("opened");
  };
  const feedbackKey = {
    copied: "clusters:cloud.copied",
    copyFailed: "clusters:cloud.copyFailed",
    opened: "terminal:local.openedWithCommand",
  } as const;
  return (
    <div className="cloud-command">
      <code className="cloud-command__text">{command}</code>
      <Button size="compact" onClick={() => void copy()}>
        {t("clusters:cloud.copyCommand")}
      </Button>
      <Button size="compact" onClick={openTerminal}>
        {t("terminal:local.openWithCommand")}
      </Button>
      {feedback && (
        <span className="cloud-command__feedback" role="status">
          {t(feedbackKey[feedback])}
        </span>
      )}
    </div>
  );
}

/** What went wrong with a cloud CLI and what to do about it. */
export function CloudProblemView({ problem }: { problem: CloudProblem }) {
  const { t } = useTranslation();
  const cli = t(`clusters:cloud.cli.${problem.provider}`);
  const scope = problem.scope ? t("clusters:cloud.scope", { scope: problem.scope }) : "";
  return (
    <div className="cloud-problem" role="note" data-kind={problem.kind}>
      <p className="cloud-problem__title">
        {t(`clusters:cloud.problem.${problem.kind}`, { cli, scope })}
      </p>
      {problem.command && (
        <>
          <p className="clusters-hint">{t(`clusters:cloud.problemHint.${problem.kind}`)}</p>
          <CommandLine command={problem.command} />
        </>
      )}
      {problem.url && (
        <Button size="compact" onClick={() => void api.shell.openUrl(problem.url!)}>
          {t("clusters:cloud.installGuide")}
        </Button>
      )}
      {problem.message && problem.kind !== "cliMissing" && problem.kind !== "pluginMissing" && (
        <p className="clusters-error__details">{t("common:error.details", { message: problem.message })}</p>
      )}
    </div>
  );
}

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
function ProviderHints({ status }: { status: CloudCliStatus }) {
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
        <CommandLine command={status.plugin.installCommand} />
      </div>
    );
  }
  return null;
}

function clusterKey(cluster: CloudCluster): string {
  return `${cluster.provider}:${cluster.context}`;
}

export function CloudClusters() {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<CloudCliStatus[] | null>(null);
  const [provider, setProvider] = useState<CloudProvider | null>(null);
  const [accounts, setAccounts] = useState<CloudAccounts | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [search, setSearch] = useState<CloudSearch | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CloudImport | null>(null);
  const [busy, setBusy] = useState<"accounts" | "find" | "import" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

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
    setAccounts(null);
    setAccount(null);
    setSearch(null);
    setResult(null);
    setError(null);
    if (!provider) return;
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
  }, [provider]);

  const chooseAccount = (id: string) => {
    setAccount(id);
    const region = accounts?.accounts.find((a) => a.id === id)?.region;
    setRegions(region ? [region] : []);
    setSearch(null);
    setResult(null);
  };

  const toggleRegion = (region: string, on: boolean) =>
    setRegions((current) => (on ? [...current, region] : current.filter((r) => r !== region)));

  const find = async () => {
    if (!provider || account === null) return;
    setBusy("find");
    setError(null);
    setResult(null);
    try {
      const found = await api.cloud.find({ provider, account, regions: provider === "aws" ? regions : [] });
      setSearch(found);
      setSelected(new Set(found.clusters.map(clusterKey)));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!search) return;
    const chosen = search.clusters.filter((c) => selected.has(clusterKey(c)));
    setBusy("import");
    setError(null);
    try {
      const imported = await api.cloud.importClusters(chosen);
      setResult(imported);
      await refreshClusters();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
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
            <ProviderHints status={status} />
          </div>
        ))}
      </div>

      {provider && busy === "accounts" && <p role="status">{t("clusters:cloud.loadingAccounts")}</p>}
      {accounts?.problem && <CloudProblemView problem={accounts.problem} />}

      {provider && accounts && accounts.accounts.length > 0 && (
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
            <Button variant="primary" disabled={!canFind} onClick={() => void find()}>
              {busy === "find" ? t("clusters:cloud.finding") : t("clusters:cloud.find")}
            </Button>
          </div>
        </div>
      )}

      {search && (
        <div className="cloud-results">
          {search.problems.map((problem, index) => (
            <CloudProblemView key={`${problem.kind}-${problem.scope ?? ""}-${index}`} problem={problem} />
          ))}
          {search.clusters.length === 0 ? (
            <p className="clusters-hint">{t("clusters:cloud.noClusters")}</p>
          ) : (
            <>
              <ul className="cloud-clusters" aria-label={t("clusters:cloud.found")}>
                {search.clusters.map((cluster) => {
                  const key = clusterKey(cluster);
                  const details = [cluster.location, cluster.version, cluster.status].filter(Boolean).join(t("clusters:cloud.separator"));
                  return (
                    <li key={key} className="cloud-clusters__item">
                      <label className="cloud-clusters__label">
                        <Checkbox
                          checked={selected.has(key)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                        <span className="cloud-clusters__name">{cluster.name}</span>
                        <span className="cloud-clusters__details">{details}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="clusters-buttons">
                <Button variant="primary" disabled={busy !== null || chosenCount === 0} onClick={() => void add()}>
                  {t("clusters:cloud.add", { count: chosenCount })}
                </Button>
              </div>
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
            <CloudProblemView key={`${problem.kind}-${problem.scope ?? ""}-${index}`} problem={problem} />
          ))}
        </div>
      )}
      {error && <ErrorState error={error} className="clusters-error" />}
    </div>
  );
}
