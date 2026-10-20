// Details of External Secrets objects (one section, `externalSecrets`, for every kind of the section):
//   ExternalSecret        — Ready with the last error, the store and whether it is ready, the target Secret (a link;
//                           never its data), refresh interval and last sync, the keys by name and remote key;
//   ClusterExternalSecret — Ready, the ExternalSecret name it makes, the namespaces it reached and failed in;
//   SecretStore/ClusterSecretStore — Ready (validation) with its reason, provider, capabilities;
//   PushSecret            — Ready, the source Secret, the stores and the remote keys it writes.
// Conditions and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatDateTime } from "../../i18n";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ReadyCell } from "./columns";
import { useNamedObject } from "./hooks";
import {
  CLUSTER_EXTERNAL_SECRET,
  CLUSTER_SECRET_STORE,
  creationPolicyOf,
  dataFromOf,
  ESO_GROUP,
  esoKind,
  EXTERNAL_SECRET,
  failedNamespaces,
  isKind,
  lastSyncOf,
  provisionedNamespaces,
  providerOf,
  capabilitiesOf,
  PUSH_SECRET,
  pushKeysOf,
  pushSourceSecret,
  pushStoreRefs,
  readinessOf,
  READY_TONE,
  refreshIntervalOf,
  remoteKeysOf,
  SECRET_STORE,
  storeRefOf,
  targetSecretName,
  type RemoteKey,
  type StoreRef,
} from "./model";

const { get, str } = status;
const LABELS = "externalsecrets:fields";
const API = `${ESO_GROUP}/v1`;

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

function storeLink(ref: StoreRef, namespace: string | null): ReactNode {
  const cluster = ref.kind === "ClusterSecretStore";
  return link(
    { apiVersion: API, kind: cluster ? "ClusterSecretStore" : "SecretStore" },
    ref.name,
    cluster ? null : namespace,
    `${ref.kind}/${ref.name}`,
  );
}

/** The failing condition's message, from the cluster, under the fields. */
function LastError({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const r = readinessOf(obj);
  if (r.state !== "failed" || !r.message) return null;
  return (
    <Block title={t("externalsecrets:lastError")}>
      <p className="eso-message">{r.message}</p>
    </Block>
  );
}

/** Whether the store an ExternalSecret reads from is ready (it is watched by name while the details are open). */
function StoreState({ clusterId, ref, namespace }: { clusterId: ClusterId; ref: StoreRef; namespace: string | null }) {
  const { t } = useTranslation();
  const cluster = ref.kind === "ClusterSecretStore";
  const { obj, notServed } = useNamedObject(
    clusterId,
    cluster ? CLUSTER_SECRET_STORE : SECRET_STORE,
    cluster ? null : namespace,
    ref.name,
  );
  if (notServed) return null;
  if (obj === undefined) return <span className="eso-muted">{t("externalsecrets:loading")}</span>;
  if (obj === null) return <StatusText value={t("externalsecrets:storeMissing")} tone="danger" />;
  return <ReadyCell obj={obj} />;
}

const KEYS_WRAP: ColumnWrap[] = ["nowrap", undefined, undefined];
const NAMESPACES_WRAP: ColumnWrap[] = ["nowrap", undefined];

/** The keys by name: the Secret's key, the remote key and its property. */
function useKeysTable(id: string, keys: RemoteKey[]): ReactNode {
  const { t } = useTranslation();
  const headers = [t("externalsecrets:keys.secretKey"), t("externalsecrets:keys.remoteKey"), t("externalsecrets:keys.property")];
  return table(
    id,
    headers,
    keys.map((k) => [k.secretKey, k.remoteKey, k.property ?? ""]),
    KEYS_WRAP,
  );
}

function ExternalSecretView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const ref = storeRefOf(obj);
  const interval = refreshIntervalOf(obj);
  const rows: FieldRow[] = [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["store", ref ? storeLink(ref, ns) : null],
    ["storeStatus", ref ? <StoreState key="st" clusterId={clusterId} ref={ref} namespace={ns} /> : null],
    ["target", link(KINDS.secret, targetSecretName(obj), ns)],
    ["creationPolicy", creationPolicyOf(obj)],
    ["refreshInterval", interval === "0" || interval === "0s" ? t("externalsecrets:refreshOnce") : interval],
    ["lastSync", date(lastSyncOf(obj))],
  ];
  const keys = remoteKeysOf(obj);
  const bulk = dataFromOf(obj).map((d) => {
    if (d.how === "extract") return t("externalsecrets:dataFrom.extract", { key: d.what ?? "" });
    if (d.how === "find")
      return d.what ? t("externalsecrets:dataFrom.find", { what: d.what }) : t("externalsecrets:dataFrom.findAll");
    if (d.how === "generator") return t("externalsecrets:dataFrom.generator", { name: d.what ?? "" });
    return t("externalsecrets:dataFrom.other");
  });
  const keysTable = useKeysTable("esoKeys", keys);
  const bulkRows: FieldRow[] = [["dataFrom", chips(bulk)]];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <LastError obj={obj} />
      {(keys.length > 0 || bulk.length > 0) && (
        <Block title={t("externalsecrets:keys.title")}>
          <p className="eso-muted">{t("externalsecrets:keys.namesOnly")}</p>
          {keysTable}
          <Fields rows={bulkRows} labelPrefix={LABELS} />
        </Block>
      )}
    </>
  );
}

function ClusterExternalSecretView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const failed = failedNamespaces(obj);
  const rows: FieldRow[] = [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["externalSecretName", str(get(obj, "spec", "externalSecretName")) ?? obj.metadata?.name],
    ["refreshInterval", str(get(obj, "spec", "refreshTime"))],
    ["provisioned", chips(provisionedNamespaces(obj))],
  ];
  const failedTable = table(
    "esoFailedNamespaces",
    [t("externalsecrets:failedNamespaces.namespace"), t("externalsecrets:failedNamespaces.reason")],
    failed.map((f) => [f.namespace, f.reason ?? ""]),
    NAMESPACES_WRAP,
  );
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <LastError obj={obj} />
      {failed.length > 0 && <Block title={t("externalsecrets:failedNamespaces.title")}>{failedTable}</Block>}
    </>
  );
}

function StoreView({ obj }: { obj: KubeObject }) {
  const r = readinessOf(obj);
  const rows: FieldRow[] = [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["reason", r.reason ? <StatusText key="r" value={r.reason} tone={READY_TONE[r.state]} /> : null],
    ["provider", providerOf(obj)],
    ["capabilities", capabilitiesOf(obj)],
    ["refreshInterval", str(get(obj, "spec", "refreshInterval"))],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <LastError obj={obj} />
    </>
  );
}

function PushSecretView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const keys = pushKeysOf(obj);
  const rows: FieldRow[] = [
    ["status", <ReadyCell key="s" obj={obj} />],
    ["source", link(KINDS.secret, pushSourceSecret(obj), ns)],
    [
      "stores",
      pushStoreRefs(obj).length > 0 ? <span className="dt-links">{pushStoreRefs(obj).map((r) => storeLink(r, ns))}</span> : null,
    ],
    ["refreshInterval", refreshIntervalOf(obj)],
    ["lastSync", date(lastSyncOf(obj))],
  ];
  const keysTable = useKeysTable("esoPushKeys", keys);
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <LastError obj={obj} />
      {keys.length > 0 && <Block title={t("externalsecrets:keys.pushTitle")}>{keysTable}</Block>}
    </>
  );
}

export function ExternalSecretsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, EXTERNAL_SECRET)) return <ExternalSecretView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, CLUSTER_EXTERNAL_SECRET)) return <ClusterExternalSecretView obj={obj} />;
  if (isKind(kind, SECRET_STORE, CLUSTER_SECRET_STORE)) return <StoreView obj={obj} />;
  if (isKind(kind, PUSH_SECRET)) return <PushSecretView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof esoKind>[0]): boolean => esoKind(kind) !== undefined;
