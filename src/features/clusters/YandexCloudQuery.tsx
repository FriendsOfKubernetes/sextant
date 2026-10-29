import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type CloudAccounts, type CloudQuery } from "../../api";
import { Button, ErrorState } from "../../components";
import { CloudProblemView } from "./CloudProblemView";

const MANUAL_FOLDER = "__manual";
const ENDPOINTS = ["external", "internal"] as const;

interface Props {
  busy: boolean;
  searching: boolean;
  onFind: (query: CloudQuery) => Promise<void>;
  onChange: (preserveAdded?: boolean) => void;
  onTerminalOpened?: () => void;
}

function useYandexQuery(onChange: Props["onChange"]) {
  const [scope, setScope] = useState<{ profile?: string; cloudId?: string }>({});
  const [data, setData] = useState<CloudAccounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [{ folder, manual }, setSelection] = useState({ folder: "", manual: false });
  const loadedScope = useRef<typeof scope | null>(null);
  const [revision, setRevision] = useState(0);
  const [endpoint, setEndpoint] = useState<"external" | "internal">("external");

  useEffect(() => {
    let live = true;
    api.cloud.accounts("yandex", scope).then(found => {
      if (!live) return;
      setData(found);
      const preserve = loadedScope.current === scope;
      loadedScope.current = scope;
      setSelection(current => preserve && (current.manual || found.accounts.some(a => a.id === current.folder)) ? current : {
        folder: (found.accounts.find(a => a.isDefault) ?? found.accounts[0])?.id ?? "",
        manual: found.accounts.length === 0,
      });
    }).catch(err => live && setError(err)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [scope, reload]);

  const changed = (preserveAdded = false) => { onChange(preserveAdded); setRevision(n => n + 1); };
  const changeScope = (value: typeof scope) => {
    changed();
    setLoading(true);
    setError(null);
    setScope(value);
  };
  const retry = () => { changed(true); setLoading(true); setError(null); setReload(n => n + 1); };
  const setFolder = (folder: string) => setSelection(current => ({ ...current, folder }));
  const setManual = (manual: boolean) => setSelection(current => ({ ...current, manual }));
  return { data, loading, error, scope, folder, setFolder, manual, setManual, endpoint, setEndpoint, changeScope, retry, changed, revision };
}

function YandexFolder({ query, onChange }: { query: ReturnType<typeof useYandexQuery>; onChange: Props["onChange"] }) {
  const { t } = useTranslation();
  const { data, loading, folder, setFolder, manual, setManual } = query;
  if (!data) return null;
  const label = (a: { id: string; name: string }) => a.id === a.name ? a.id : t("clusters:cloud.accountOption", a);
  return <>
        {!!data.accounts.length && <label className="cloud-field cloud-yandex-field">
          <span>{t("clusters:cloud.account.yandex")}</span>
          <select className="cloud-yandex-control" disabled={loading} value={manual ? MANUAL_FOLDER : folder} onChange={e => {
            onChange(); setManual(e.target.value === MANUAL_FOLDER); setFolder(e.target.value === MANUAL_FOLDER ? "" : e.target.value);
          }}>
            {data.accounts.map(f => <option key={f.id} value={f.id}>{label(f)}</option>)}
            <option value={MANUAL_FOLDER}>{t("clusters:cloud.yandex.enterFolder")}</option>
          </select>
        </label>}
        {manual && <label className="cloud-field cloud-yandex-field">
          <span>{t("clusters:cloud.yandex.folderId")}</span>
          <input className="cloud-yandex-control" disabled={loading} value={folder} onChange={e => { onChange(); setFolder(e.target.value); }} />
        </label>}
  </>;
}

function YandexFields({ query, onChange }: { query: ReturnType<typeof useYandexQuery>; onChange: Props["onChange"] }) {
  const { t } = useTranslation();
  const { data, loading, scope, endpoint, setEndpoint, changeScope } = query;
  const discovery = data?.yandex;
  if (!discovery) return null;
  const profile = discovery.profile ?? "";
  const label = (a: { id: string; name: string }) => a.id === a.name ? a.id : t("clusters:cloud.accountOption", a);
  return (
    <>
        <label className="cloud-field cloud-yandex-field">
          <span>{t("clusters:cloud.account.aws")}</span>
          <select className="cloud-yandex-control" value={scope.profile ?? profile} onChange={e => changeScope({ profile: e.target.value })}>
            {!profile && <option value="">{t("clusters:cloud.yandex.chooseProfile")}</option>}
            {discovery.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="cloud-field cloud-yandex-field">
          <span>{t("clusters:cloud.yandex.cloud")}</span>
          <select className="cloud-yandex-control" disabled={loading || !discovery.clouds.length} value={scope.cloudId ?? discovery.cloudId ?? ""}
            onChange={e => changeScope({ profile, cloudId: e.target.value })}>
            {!discovery.clouds.length && <option value="">{t("clusters:cloud.yandex.noClouds")}</option>}
            {discovery.clouds.map(c => <option key={c.id} value={c.id}>{label(c)}</option>)}
          </select>
        </label>
        <YandexFolder query={query} onChange={onChange} />
        <label className="cloud-field cloud-yandex-field">
          <span>{t("clusters:cloud.yandex.endpoint")}</span>
          <select className="cloud-yandex-control" value={endpoint} onChange={e => { onChange(); setEndpoint(e.target.value as typeof endpoint); }}>
            {ENDPOINTS.map(value => <option key={value} value={value}>{t(`clusters:cloud.yandex.${value}`)}</option>)}
          </select>
        </label>
        <p className="clusters-hint">{t("clusters:cloud.yandex.endpointHint")}</p>
      </>
  );
}

/** YC scopes are loaded only for the selected profile/cloud. Folder IDs also work without list permission. */
export function YandexCloudQuery({ busy, searching, onFind, onChange, onTerminalOpened }: Props) {
  const { t } = useTranslation();
  const query = useYandexQuery(onChange);
  const { data, loading, error, folder, endpoint, retry } = query;
  const discovery = data?.yandex;
  const profile = discovery?.profile ?? "";
  const canFind = !loading && !error && !data?.problem && !!profile && !!folder.trim() && !busy;
  const lastRequest = useRef("");
  const key = JSON.stringify([profile, folder.trim(), endpoint, query.revision]);
  useEffect(() => {
    if (!canFind || lastRequest.current === key) return;
    const find = () => {
      lastRequest.current = key;
      void onFind({ provider: "yandex", account: folder.trim(), regions: [], yandex: { profile, endpoint } });
    };
    if (!query.manual) { find(); return; }
    const timer = setTimeout(find, 300);
    return () => clearTimeout(timer);
  }, [canFind, key, onFind, folder, profile, endpoint, query.manual]);
  return (
    <div className="cloud-query cloud-query--yandex">
      <YandexFields query={query} onChange={query.changed} />
      {loading && <p role="status">{t("clusters:cloud.loadingAccounts")}</p>}
      {searching && <p role="status">{t("clusters:cloud.finding")}</p>}
      {error != null && <ErrorState error={error} onRetry={retry} className="clusters-error" />}
      {data?.problem && <CloudProblemView problem={data.problem} onTerminalOpened={onTerminalOpened} />}
      {discovery?.problems.map((problem, index) => <CloudProblemView key={index} problem={problem} onTerminalOpened={onTerminalOpened} />)}
      {discovery && <div className="clusters-buttons cloud-query__buttons">
        <Button disabled={loading || busy} onClick={retry}>{t("clusters:cloud.yandex.reload")}</Button>
      </div>}
    </div>
  );
}
