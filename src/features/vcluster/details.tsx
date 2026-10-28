import { useDisclosureProbe } from "../details/disclosureProbe";
import { useDetailsDisclosure } from "../../layout/details/disclosure";
// The "vcluster" section of a control plane's StatefulSet or Deployment (`app=vcluster`, `release=<name>`): the
// instance's state, its control-plane pods, whether its Service and kubeconfig Secret exist (looked up by name,
// metadata only), "Connect" (ADR-0122), and the synced objects — what the syncer copied from the virtual cluster into
// this namespace (`vcluster.loft.sh/managed-by=<name>`, metadata only, at most `MAX_SYNCED` per kind, the first
// `MAX_SHOWN` shown) with the virtual name and namespace each stands for.
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject, WatchSpec } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { Block, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { useSharedWatches } from "../resource-map/watches";
import { ConnectControls } from "./connect";
import { MAX_SYNCED, SYNCED_KINDS, useSynced } from "./hooks";
import { CONTROL_PLANE_SELECTOR, instanceOf, podsOf, podSummary, POD, RELEASE_LABEL, SECRET, secretName, SERVICE, syncedOf } from "./model";
import { Presence, StateCell } from "./VclusterPage";

const LABELS = "vcluster:fields";
/** Rows shown per kind of synced objects. */
export const MAX_SHOWN = 50;
const SYNCED_WRAP: ColumnWrap[] = [undefined, undefined, "nowrap"];

export function vclusterApplies(kind: KindRef): boolean {
  return kind.group === "apps" && (kind.kind === "StatefulSet" || kind.kind === "Deployment");
}

const byName = (kind: KindRef, namespace: string, name: string): WatchSpec => ({
  kind,
  namespaces: [namespace],
  labelSelector: null,
  fieldSelector: `metadata.name=${name}`,
  metadataOnly: true,
});

function SyncedKind({ clusterId, kind, namespace, name }: { clusterId: ClusterId; kind: KindRef; namespace: string; name: string }) {
  const { t } = useTranslation();
  const id = `synced.${kind.group}/${kind.kind}`;
  const { open, enabled, result, settle } = useDisclosureProbe(id);
  const list = useSynced(clusterId, kind, namespace, name, enabled);
  const [count, setCount] = useState(0);
  const answer = list.loading ? null : list.items.length > 0 ? "present" : list.unavailable || list.truncated ? "unknown" : "absent";
  useEffect(() => { if (enabled && answer) { settle(answer); if (answer !== "unknown") setCount(list.items.length); } }, [enabled, answer, list.items.length, settle]);
  const title = t("vcluster:synced.kind", { kind: kind.kind, number: result === "unknown" ? "?" : count });
  if (!open && result) return result === "absent" ? null : <Block id={id} title={title}>{null}</Block>;
  if (list.loading || list.items.length === 0) {
    return list.unavailable || (list.loading && result !== null && result !== "absent") ? <Block id={id} title={title}><p className="vc-muted">{list.unavailable ? t("vcluster:synced.unavailable", { kind: kind.kind }) : t("common:details.loading")}</p></Block> : null;
  }
  const synced = list.items
    .map((obj) => syncedOf(obj, name))
    .filter((s) => s !== undefined)
    .sort((a, b) => a.hostName.localeCompare(b.hostName));
  const type = { apiVersion: kind.group ? `${kind.group}/${kind.version}` : kind.version, kind: kind.kind };
  const rows: ReactNode[][] = synced.slice(0, MAX_SHOWN).map((s) => [
    link(type, s.hostName, namespace),
    s.virtualName ?? t("vcluster:synced.notSaid"),
    s.virtualNamespace ?? "",
  ]);
  return (
    <Block id={id} title={t("vcluster:synced.kind", { kind: kind.kind, number: synced.length })}>
      {table(
        `vclusterSynced${kind.kind}`,
        [t("vcluster:synced.columns.host"), t("vcluster:synced.columns.virtualName"), t("vcluster:synced.columns.virtualNamespace")],
        rows,
        SYNCED_WRAP,
      )}
      {synced.length > MAX_SHOWN && <p className="vc-muted">{t("vcluster:synced.more", { count: synced.length - MAX_SHOWN })}</p>}
      {list.truncated && <p className="vc-muted">{t("vcluster:synced.truncated", { max: MAX_SYNCED })}</p>}
    </Block>
  );
}

function InstanceDetails({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const instance = instanceOf(obj);
  const namespace = instance?.namespace ?? "";
  const name = instance?.name ?? "";
  const found = instance !== undefined;
  const specs = useMemo(
    (): WatchSpec[] =>
      found
        ? [
            byName(SERVICE, namespace, name),
            byName(SECRET, namespace, secretName(name)),
            { kind: POD, namespaces: [namespace], labelSelector: `${CONTROL_PLANE_SELECTOR},${RELEASE_LABEL}=${name}`, fieldSelector: null },
          ]
        : [],
    [found, namespace, name],
  );
  const open = useDetailsDisclosure("vcluster:section.title")?.open ?? true;
  const [service, secret, pods] = useSharedWatches(clusterId, open ? specs : []);
  if (!instance) return null;
  const known = (s: typeof service): boolean | undefined =>
    !s || s.status === "loading" || s.status === "error" || (s.forbidden ?? []).length > 0 ? undefined : s.items.size > 0;
  const summary = pods && pods.status !== "loading" && pods.status !== "error" ? podSummary(podsOf(instance, pods.items.values())) : undefined;
  const rows: FieldRow[] = [
    ["name", name],
    ["version", instance.version ?? ""],
    ["state", <StateCell key="s" instance={instance} />],
    ["pods", summary ? t("vcluster:pods.ready", { ready: summary.ready, total: summary.total }) : t("vcluster:presence.unknown")],
    ["service", <Presence key="svc" value={known(service)} />],
    ["secret", <span key="sec">{secretName(name)} <Presence value={known(secret)} /></span>],
    ["connection", <ConnectControls key="c" clusterId={clusterId} namespace={namespace} name={name} />],
  ];
  return (
    <>
      <Block id="vcluster:section.title" title={t("vcluster:section.title")}>
        <Fields rows={rows} labelPrefix={LABELS} />
        <p className="vc-muted">{t("vcluster:page.lifetime")}</p>
      </Block>
      <Block id="vcluster:synced.title" title={t("vcluster:synced.title")}>
        <p className="vc-muted">{t("vcluster:synced.hint", { name })}</p>
        {SYNCED_KINDS.map((kind) => (
          <SyncedKind key={kind.kind} clusterId={clusterId} kind={kind} namespace={namespace} name={name} />
        ))}
      </Block>
    </>
  );
}

export function VclusterSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj || !instanceOf(obj)) return null;
  return <InstanceDetails clusterId={clusterId} obj={obj} />;
}
