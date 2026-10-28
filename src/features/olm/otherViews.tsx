// Details of the other OLM kinds: a CatalogSource's registry (type, image or address, poll interval, connection state,
// registry Service), an OperatorGroup's target namespaces and upgrade strategy, an Operator's components, and OLM v1's
// ClusterExtension (package, installed bundle, Installed and Progressing) and ClusterCatalog (image, Serving). Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { labelSelector } from "../details/ui";
import {
  catalogInfo,
  catalogV1Info,
  componentsOf,
  conditionText,
  connectionTone,
  extensionInfo,
  MAX_COMPONENTS,
  operatorGroupInfo,
} from "./model";
import { date, Muted, Note } from "./ui";

const LABELS = "olm:fields";

function Condition({ obj, type }: { obj: KubeObject; type: string }) {
  const c = conditionText(obj, type);
  return c ? (
    <span title={c.title || undefined}>
      <StatusText value={c.text} tone={c.tone} />
    </span>
  ) : null;
}

export function CatalogSourceView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = catalogInfo(obj);
  const service = info.registryService;
  const rows: FieldRow[] = [
    ["connection", info.state ? <StatusText key="c" value={info.state} tone={connectionTone(info.state)} /> : null],
    ["displayName", info.displayName],
    ["publisher", info.publisher],
    ["sourceType", info.sourceType],
    ["image", info.image],
    ["address", info.address],
    ["configMap", link(KINDS.configMap, info.configMap, ns)],
    ["priority", info.priority?.toString()],
    ["pollInterval", info.pollInterval],
    ["connectedAddress", info.connectedAddress],
    ["lastConnect", date(info.lastConnect)],
    ["latestPoll", date(info.latestPoll)],
    ["registryService", service?.name ? link(KINDS.service, service.name, service.namespace ?? ns) : null],
    ["port", service?.port],
    ["reason", info.reason],
    ["message", info.message],
  ];
  const failing = info.state !== undefined && info.state !== "READY" && info.state !== "IDLE";
  return (
    <>
      {failing && <Note text={t("olm:catalogNotReady", { state: info.state })} tone="warning" />}
      {!info.state && info.sourceType === "grpc" && <Muted text={t("olm:catalogNoState")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

export function OperatorGroupView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = operatorGroupInfo(obj);
  const rows: FieldRow[] = [
    ["targets", info.allNamespaces ? t("olm:allNamespaces") : chips(info.namespaces)],
    ["targetNamespaces", chips(info.targetNamespaces)],
    ["selector", info.targetNamespaces.length === 0 ? labelSelector(info.selector) : null],
    ["upgradeStrategy", info.upgradeStrategy],
    ["serviceAccount", link(KINDS.serviceAccount, info.serviceAccountName, ns)],
    ["staticProvidedAPIs", info.staticProvidedAPIs ? t("olm:yes") : null],
    ["providedAPIs", chips(info.providedAPIs)],
    ["lastUpdated", date(info.lastUpdated)],
  ];
  return (
    <>
      {info.upgradeStrategy === "TechPreviewUnsafeFailForward" && <Note text={t("olm:unsafeFailForward")} tone="warning" />}
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

const COMPONENT_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined];

export function OperatorView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const { refs, total } = componentsOf(obj);
  const rows = refs.map((r) => [r.kind, link({ apiVersion: r.apiVersion, kind: r.kind }, r.name, r.namespace ?? null), r.namespace ?? "", chips(r.conditions)]);
  const headers = ["kind", "name", "namespace", "conditions"].map((h) => t(`olm:components.${h}`));
  const list = table("olmOperatorComponents", headers, rows, COMPONENT_WRAP);
  return (
    <Block id="olm:components.title" title={t("olm:components.title")}>
      {rows.length > 0 ? list : <Muted text={t("olm:noComponents")} />}
      {total > refs.length && <Muted text={t("olm:moreComponents", { shown: refs.length, total, max: MAX_COMPONENTS })} />}
    </Block>
  );
}

export function ClusterExtensionView({ obj }: { obj: KubeObject }) {
  const info = extensionInfo(obj);
  const progressing = conditionText(obj, "Progressing");
  const rows: FieldRow[] = [
    ["installedCondition", <Condition key="i" obj={obj} type="Installed" />],
    ["progressing", <Condition key="p" obj={obj} type="Progressing" />],
    ["package", info.packageName],
    ["versionRange", info.version],
    ["channels", chips(info.channels)],
    ["upgradeConstraintPolicy", info.upgradeConstraintPolicy],
    ["installNamespace", link(KINDS.namespace, info.namespace)],
    ["serviceAccount", link(KINDS.serviceAccount, info.serviceAccount, info.namespace ?? null)],
    ["installedBundle", info.installedBundle],
    ["installedVersion", info.installedVersion],
  ];
  return (
    <>
      {progressing?.tone === "warning" && progressing.title && <Note text={progressing.title} tone="warning" />}
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

export function ClusterCatalogView({ obj }: { obj: KubeObject }) {
  const info = catalogV1Info(obj);
  const rows: FieldRow[] = [
    ["serving", <Condition key="s" obj={obj} type="Serving" />],
    ["progressing", <Condition key="p" obj={obj} type="Progressing" />],
    ["sourceType", info.sourceType],
    ["image", info.image],
    ["resolvedImage", info.resolvedImage],
    ["pollIntervalMinutes", info.pollIntervalMinutes?.toString()],
    ["priority", info.priority?.toString()],
    ["availabilityMode", info.availabilityMode],
    ["baseUrl", info.baseUrl],
    ["lastUnpacked", date(info.lastUnpacked)],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}
