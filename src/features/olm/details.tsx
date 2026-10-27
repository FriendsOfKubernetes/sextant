// Details of OLM objects (one section, `olm`): a Subscription's package, channel, catalog, approval, installed and
// current CSV with its InstallPlan (both read while open) and the catalogs' health; a CSV's phase, requirements, owned
// and required CRDs, the Deployments of its install strategy (read while open) and install modes — a copy in a target
// namespace says it is one and links its original; an InstallPlan's approval and steps. The other kinds are in
// otherViews.tsx. Conditions, events and YAML are the panel's own sections. Read-only: nothing is approved or changed.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { CsvPhaseText, SubscriptionStateText } from "./columns";
import { MAX_DEPLOYMENTS, useCsvDeployments, useNamed, useSubscriptions } from "./hooks";
import {
  bundleLookupsOf,
  catalogHealthOf,
  conditionOf,
  copiedFrom,
  crdsOf,
  CSV,
  csvInfo,
  INSTALL_PLAN,
  installModesOf,
  installPlanInfo,
  isCopy,
  MAX_STEPS,
  olmKind,
  planPhaseTone,
  requirementsOf,
  requirementTone,
  stepsOf,
  stepTone,
  strategyDeployments,
  subscriptionInfo,
  subscriptionState,
  unmetRequirements,
  deploymentSelector,
  type CrdDescription,
} from "./model";
import { CatalogSourceView, ClusterCatalogView, ClusterExtensionView, OperatorGroupView, OperatorView } from "./otherViews";
import { date, Muted, Note, reasonText, TYPES } from "./ui";

const LABELS = "olm:fields";

// ---------- Subscription ----------

const HEALTH_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

function SubscriptionView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace;
  const info = subscriptionInfo(obj);
  const state = subscriptionState(obj);
  const plan = useNamed(clusterId, INSTALL_PLAN, info.installPlan?.namespace, info.installPlan?.name).items[0];
  const installed = useNamed(clusterId, CSV, ns, info.installedCSV).items[0];
  const planPhase = plan ? installPlanInfo(plan).phase : undefined;
  const resolution = conditionOf(obj, "ResolutionFailed");
  const planFailed = conditionOf(obj, "InstallPlanFailed");
  const rows: FieldRow[] = [
    ["state", <SubscriptionStateText key="s" obj={obj} />],
    ["package", info.packageName],
    ["channel", info.channel],
    ["catalogSource", link(TYPES.catalogSource, info.source, info.sourceNamespace ?? null)],
    ["approval", info.approval],
    ["startingCSV", info.startingCSV],
    ["installedCSV", link(TYPES.csv, info.installedCSV, ns ?? null)],
    ["installedPhase", installed ? <CsvPhaseText key="p" obj={installed} /> : null],
    ["currentCSV", info.currentCSV && info.currentCSV !== info.installedCSV ? link(TYPES.csv, info.currentCSV, ns ?? null) : info.currentCSV],
    ["installPlan", link(TYPES.installPlan, info.installPlan?.name, info.installPlan?.namespace ?? null)],
    ["installPlanPhase", planPhase ? <StatusText key="ip" value={planPhase} tone={planPhaseTone(planPhase)} /> : null],
    ["subscriptionState", info.state],
    ["lastUpdated", date(info.lastUpdated)],
  ];
  const health = catalogHealthOf(obj).map((h) => [
    link(TYPES.catalogSource, h.name, h.namespace ?? null),
    <StatusText key="h" value={h.healthy ? t("olm:healthy") : t("olm:unhealthy")} tone={h.healthy ? "success" : "danger"} />,
    date(h.lastUpdated),
  ]);
  const healthHeaders = ["catalog", "health", "lastUpdated"].map((h) => t(`olm:catalogHealth.${h}`));
  const healthTable = table("olmCatalogHealth", healthHeaders, health, HEALTH_WRAP);
  return (
    <>
      {state === "resolutionFailed" && <Note text={reasonText(resolution?.reason, resolution?.message) || t("olm:noReason")} tone="danger" />}
      {state === "installPlanFailed" && <Note text={reasonText(planFailed?.reason, planFailed?.message) || t("olm:noReason")} tone="danger" />}
      {state === "waitingApproval" && <Note text={t("olm:waitingApproval", { plan: info.installPlan?.name ?? "" })} tone="warning" />}
      {(state === "upgradePending" || state === "waitingApproval") && info.installedCSV && info.currentCSV && info.installedCSV !== info.currentCSV && (
        <Muted text={t("olm:upgradePending", { installed: info.installedCSV, current: info.currentCSV })} />
      )}
      <Fields rows={rows} labelPrefix={LABELS} />
      {health.length > 0 && <Block title={t("olm:catalogHealth.title")}>{healthTable}</Block>}
    </>
  );
}

// ---------- ClusterServiceVersion ----------

const REQ_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined];
const CRD_WRAP: ColumnWrap[] = [undefined, "nowrap", "nowrap", undefined];
const DEP_WRAP: ColumnWrap[] = [undefined, "nowrap", "nowrap"];

function CrdTable({ id, title, crds }: { id: string; title: string; crds: CrdDescription[] }) {
  const { t } = useTranslation();
  if (crds.length === 0) return null;
  const rows = crds.map((c) => [link(TYPES.crd, c.name), c.kind ?? "", c.version ?? "", c.displayName ?? ""]);
  const headers = ["name", "kind", "version", "displayName"].map((h) => t(`olm:crds.${h}`));
  return <Block title={title}>{table(id, headers, rows, CRD_WRAP)}</Block>;
}

function DeploymentsBlock({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const names = strategyDeployments(obj);
  const deployments = useCsvDeployments(clusterId, names.length > 0 ? obj : null);
  if (names.length === 0) return null;
  const byName = new Map(deployments.items.map((d) => [d.metadata?.name ?? "", d]));
  const unknown = deployments.failed || deployments.truncated || !deploymentSelector(obj);
  const rows = names.map((name) => {
    const dep = byName.get(name);
    if (!dep) {
      const text = deployments.loading ? t("olm:loading") : unknown ? t("olm:cannotTell") : t("olm:deploymentMissing");
      return [link(TYPES.deployment, name, ns), "", <StatusText key="m" value={text} tone={deployments.loading || unknown ? "neutral" : "danger"} />];
    }
    const available = conditionOf(dep, "Available");
    const value = available?.status === "True" ? t("olm:available") : t("olm:notAvailable");
    return [
      link(TYPES.deployment, name, ns),
      status.readyOfDesired(dep),
      <span key="a" title={available?.message || undefined}>
        <StatusText value={value} tone={available?.status === "True" ? "success" : "warning"} />
      </span>,
    ];
  });
  const headers = ["name", "ready", "state"].map((h) => t(`olm:deployments.${h}`));
  const list = table("olmCsvDeployments", headers, rows, DEP_WRAP);
  return (
    <Block title={t("olm:deployments.title")}>
      {list}
      {deployments.truncated && <Muted text={t("olm:truncated", { max: MAX_DEPLOYMENTS })} />}
    </Block>
  );
}

/** The Subscription in the CSV's namespace that installed it, if any. */
function InstalledBy({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const ns = obj.metadata?.namespace;
  const subs = useSubscriptions(clusterId, ns);
  const sub = subs.items.find((s) => subscriptionInfo(s).installedCSV === obj.metadata?.name);
  return sub ? <>{link(TYPES.subscription, sub.metadata?.name, ns ?? null)}</> : null;
}

function CopyView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const from = copiedFrom(obj);
  const info = csvInfo(obj);
  const rows: FieldRow[] = [
    ["phase", <CsvPhaseText key="p" obj={obj} />],
    ["original", from ? link(TYPES.csv, obj.metadata?.name, from, `${from}/${obj.metadata?.name ?? ""}`) : null],
    ["displayName", info.displayName],
    ["version", info.version],
  ];
  return (
    <>
      <Muted text={from ? t("olm:copyOf", { namespace: from }) : t("olm:copy")} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function CsvView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = csvInfo(obj);
  const unmet = unmetRequirements(obj);
  const modes = installModesOf(obj);
  const rows: FieldRow[] = [
    ["phase", <CsvPhaseText key="p" obj={obj} />],
    ["reason", info.phase === "Failed" ? null : info.reason],
    ["message", info.phase === "Failed" ? null : info.message],
    ["since", date(info.since)],
    ["displayName", info.displayName],
    ["version", info.version],
    ["provider", info.provider],
    ["replaces", link(TYPES.csv, info.replaces, ns)],
    ["skips", chips(info.skips)],
    ["minKubeVersion", info.minKubeVersion],
    ["installedBy", <InstalledBy key="b" clusterId={clusterId} obj={obj} />],
    ["installModes", chips(modes.filter((m) => m.supported).map((m) => m.type))],
    ["unsupportedModes", chips(modes.filter((m) => !m.supported).map((m) => m.type))],
  ];
  const requirements = requirementsOf(obj).map((r) => [
    [r.group, r.version, r.kind].filter(Boolean).join("/"),
    r.name,
    <StatusText key="s" value={r.status} tone={requirementTone(r.status)} />,
    r.message ?? "",
  ]);
  const reqHeaders = ["kind", "name", "status", "message"].map((h) => t(`olm:requirements.${h}`));
  const reqTable = table("olmCsvRequirements", reqHeaders, requirements, REQ_WRAP);
  const owned = crdsOf(obj, "owned");
  const required = crdsOf(obj, "required");
  return (
    <>
      {info.phase === "Failed" && <Note text={reasonText(info.reason, info.message) || t("olm:noReason")} tone="danger" />}
      {unmet.length > 0 && <Note text={t("olm:requirementsUnmet", { count: unmet.length })} tone="warning" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {requirements.length > 0 && <Block title={t("olm:requirements.title")}>{reqTable}</Block>}
      <CrdTable id="olmOwnedCrds" title={t("olm:crds.owned")} crds={owned} />
      <CrdTable id="olmRequiredCrds" title={t("olm:crds.required")} crds={required} />
      <DeploymentsBlock clusterId={clusterId} obj={obj} />
    </>
  );
}

// ---------- InstallPlan ----------

const STEP_WRAP: ColumnWrap[] = [undefined, "nowrap", undefined, "nowrap"];
const LOOKUP_WRAP: ColumnWrap[] = [undefined, "nowrap", undefined];

function InstallPlanView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = installPlanInfo(obj);
  const { steps, total } = stepsOf(obj);
  const rows: FieldRow[] = [
    ["phase", info.phase ? <StatusText key="p" value={info.phase} tone={planPhaseTone(info.phase)} /> : null],
    ["approval", info.approval],
    ["approved", info.approved ? t("olm:yes") : t("olm:no")],
    ["csvs", info.csvNames.length > 0 ? <span className="dt-links">{info.csvNames.map((n) => link(TYPES.csv, n, ns))}</span> : null],
    ["catalogSource", link(TYPES.catalogSource, info.source, info.sourceNamespace ?? null)],
    ["startTime", date(info.startTime)],
  ];
  const stepRows = steps.map((s) => [
    s.resolving,
    [s.group, s.version, s.kind].filter(Boolean).join("/"),
    s.name,
    <StatusText key="s" value={s.status} tone={stepTone(s.status)} />,
  ]);
  const stepHeaders = ["resolving", "kind", "name", "status"].map((h) => t(`olm:steps.${h}`));
  const lookups = bundleLookupsOf(obj).map((b) => [
    b.path,
    b.identifier,
    b.condition ? <StatusText key="c" value={reasonText(b.condition.type, b.condition.message)} tone={b.condition.type === "BundleLookupFailed" ? "danger" : "warning"} /> : "",
  ]);
  const lookupHeaders = ["path", "identifier", "state"].map((h) => t(`olm:lookups.${h}`));
  const lookupTable = table("olmPlanLookups", lookupHeaders, lookups, LOOKUP_WRAP);
  const stepTable = table("olmPlanSteps", stepHeaders, stepRows, STEP_WRAP);
  const failure = info.failure ? reasonText(info.failure.reason, info.failure.message) : info.message;
  return (
    <>
      {info.phase === "RequiresApproval" && <Note text={t("olm:planNeedsApproval")} tone="warning" />}
      {info.phase === "Failed" && <Note text={failure || t("olm:noReason")} tone="danger" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {lookups.length > 0 && <Block title={t("olm:lookups.title")}>{lookupTable}</Block>}
      {stepRows.length > 0 && (
        <Block title={t("olm:steps.title")}>
          {stepTable}
          {total > steps.length && <Muted text={t("olm:moreSteps", { shown: steps.length, total, max: MAX_STEPS })} />}
        </Block>
      )}
    </>
  );
}

export function OlmSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const def = olmKind(objectRef.kind);
  if (!obj || !def) return null;
  switch (def.label) {
    case "subscriptions":
      return <SubscriptionView clusterId={clusterId} obj={obj} />;
    case "csvs":
      return isCopy(obj) ? <CopyView obj={obj} /> : <CsvView clusterId={clusterId} obj={obj} />;
    case "installPlans":
      return <InstallPlanView obj={obj} />;
    case "catalogSources":
      return <CatalogSourceView obj={obj} />;
    case "operatorGroups":
      return <OperatorGroupView obj={obj} />;
    case "operators":
      return <OperatorView obj={obj} />;
    case "clusterExtensions":
      return <ClusterExtensionView obj={obj} />;
    case "clusterCatalogs":
      return <ClusterCatalogView obj={obj} />;
    default:
      return null;
  }
}

export const appliesTo = (kind: Parameters<typeof olmKind>[0]): boolean => olmKind(kind) !== undefined;
