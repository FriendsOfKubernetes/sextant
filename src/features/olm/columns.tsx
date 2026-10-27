// Columns of the OLM tables. A Subscription: package, channel, catalog, approval, installed CSV and its state in words
// (the failing condition's message as the tooltip). A CSV: display name, version, phase (with the reason and message
// as the tooltip) and, for a copy OLM keeps in a target namespace, the namespace of the original. An InstallPlan: its
// CSVs, approval and phase. A CatalogSource: type, publisher, connection state. An OperatorGroup: target namespaces and
// upgrade strategy. An Operator: its components. OLM v1: a ClusterExtension's package, installed version and
// conditions; a ClusterCatalog's image and Serving condition.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { formatList } from "../../i18n";
import {
  catalogInfo,
  catalogV1Info,
  componentsOf,
  conditionOf,
  conditionText,
  connectionTone,
  copiedFrom,
  csvInfo,
  extensionInfo,
  installPlanInfo,
  operatorGroupInfo,
  phaseTone,
  planPhaseTone,
  subscriptionInfo,
  subscriptionState,
  SUBSCRIPTION_TONE,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `olm:columns.${id}`,
  value,
  ...options,
});

/** The condition behind a Subscription's state, for the tooltip. */
const STATE_CONDITION: Partial<Record<ReturnType<typeof subscriptionState>, string>> = {
  resolutionFailed: "ResolutionFailed",
  installPlanFailed: "InstallPlanFailed",
  waitingApproval: "InstallPlanPending",
};

export function SubscriptionStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = subscriptionState(obj);
  const type = STATE_CONDITION[state];
  const c = type ? conditionOf(obj, type) : undefined;
  return (
    <span title={c?.message || undefined}>
      <StatusText value={t(`olm:subscriptionState.${state}`)} tone={SUBSCRIPTION_TONE[state]} />
    </span>
  );
}

export function CsvPhaseText({ obj }: { obj: KubeObject }) {
  const info = csvInfo(obj);
  const title = [info.reason, info.message].filter(Boolean).join(": ");
  return info.phase ? (
    <span title={title || undefined}>
      <StatusText value={info.phase} tone={phaseTone(info.phase)} />
    </span>
  ) : null;
}

function ConditionCell({ obj, type }: { obj: KubeObject; type: string }) {
  const c = conditionText(obj, type);
  return c ? (
    <span title={c.title || undefined}>
      <StatusText value={c.text} tone={c.tone} />
    </span>
  ) : null;
}

function YesNo({ value }: { value: boolean }) {
  const { t } = useTranslation();
  return <>{value ? t("olm:yes") : t("olm:no")}</>;
}

function TargetsText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const info = operatorGroupInfo(obj);
  if (info.allNamespaces) return <>{t("olm:allNamespaces")}</>;
  const list = info.namespaces.length > 0 ? info.namespaces : info.targetNamespaces;
  return <>{formatList(list)}</>;
}

export const subscriptionColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("package", (o) => subscriptionInfo(o).packageName),
  col("channel", (o) => subscriptionInfo(o).channel, { width: "minmax(80px, 1fr)" }),
  col("source", (o) => subscriptionInfo(o).source),
  col("approval", (o) => subscriptionInfo(o).approval, { width: "100px" }),
  col("installed", (o) => subscriptionInfo(o).installedCSV, { width: "minmax(140px, 2fr)" }),
  col("state", subscriptionState, {
    width: "150px",
    render: (o) => <SubscriptionStateText obj={o} />,
  }),
  ageColumn,
];

export const csvColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("displayName", (o) => csvInfo(o).displayName),
  col("version", (o) => csvInfo(o).version, { width: "100px" }),
  col("phase", (o) => csvInfo(o).phase, { width: "120px", render: (o) => <CsvPhaseText obj={o} /> }),
  col("copiedFrom", (o) => copiedFrom(o), { width: "minmax(100px, 1fr)" }),
  ageColumn,
];

export const installPlanColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("csvs", (o) => installPlanInfo(o).csvNames.join(", "), { width: "minmax(160px, 3fr)" }),
  col("approval", (o) => installPlanInfo(o).approval, { width: "100px" }),
  col("approved", (o) => installPlanInfo(o).approved, {
    width: "90px",
    render: (o) => <YesNo value={installPlanInfo(o).approved} />,
  }),
  col("phase", (o) => installPlanInfo(o).phase, {
    width: "140px",
    render: (o) => {
      const phase = installPlanInfo(o).phase;
      return phase ? <StatusText value={phase} tone={planPhaseTone(phase)} /> : null;
    },
  }),
  ageColumn,
];

export const catalogSourceColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("displayName", (o) => catalogInfo(o).displayName),
  col("sourceType", (o) => catalogInfo(o).sourceType, { width: "100px" }),
  col("publisher", (o) => catalogInfo(o).publisher),
  col("connection", (o) => catalogInfo(o).state, {
    width: "160px",
    render: (o) => {
      const info = catalogInfo(o);
      return info.state ? (
        <span title={info.message || undefined}>
          <StatusText value={info.state} tone={connectionTone(info.state)} />
        </span>
      ) : null;
    },
  }),
  ageColumn,
];

export const operatorGroupColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col(
    "targets",
    (o) => {
      const info = operatorGroupInfo(o);
      return info.allNamespaces ? "*" : (info.namespaces.length > 0 ? info.namespaces : info.targetNamespaces).join(", ");
    },
    {
      width: "minmax(160px, 3fr)",
      render: (o) => <TargetsText obj={o} />,
    },
  ),
  col("upgradeStrategy", (o) => operatorGroupInfo(o).upgradeStrategy, { width: "140px" }),
  ageColumn,
];

export const operatorColumns: ColumnDef[] = [nameColumn, col("components", (o) => componentsOf(o).total, { width: "110px" }), ageColumn];

export const clusterExtensionColumns: ColumnDef[] = [
  nameColumn,
  col("package", (o) => extensionInfo(o).packageName),
  col("installedVersion", (o) => extensionInfo(o).installedVersion, { width: "120px" }),
  col("installedCondition", (o) => conditionOf(o, "Installed")?.status, { width: "140px", render: (o) => <ConditionCell obj={o} type="Installed" /> }),
  col("progressing", (o) => conditionOf(o, "Progressing")?.reason, { width: "180px", render: (o) => <ConditionCell obj={o} type="Progressing" /> }),
  ageColumn,
];

export const clusterCatalogColumns: ColumnDef[] = [
  nameColumn,
  col("image", (o) => catalogV1Info(o).image, { width: "minmax(180px, 3fr)" }),
  col("serving", (o) => conditionOf(o, "Serving")?.status, { width: "160px", render: (o) => <ConditionCell obj={o} type="Serving" /> }),
  col(
    "lastUnpacked",
    (o) => {
      const at = catalogV1Info(o).lastUnpacked;
      const ms = at ? Date.parse(at) : NaN;
      return Number.isNaN(ms) ? undefined : -ms;
    },
    { width: "110px", render: (o, ctx) => <Age timestamp={catalogV1Info(o).lastUnpacked} now={ctx.now} /> },
  ),
  ageColumn,
];
