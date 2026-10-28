import { useEffect } from "react";
import { useClusterKinds } from "../../resources";
import { ErrorState } from "../../components";
import { UNKNOWN_DETAILS_SOURCE, useDisclosureProbe } from "../details/disclosureProbe";
// Details of Kyverno objects (#213):
//   ClusterPolicy / Policy — readiness in plain words, mode, background scans, the rules (type, mode, kinds) and a
//                            summary of the results in the reports (counts, the objects that fail, with links);
//   reports                — the object the report is about (a link) and its results;
//   any other object       — "Policy results": the results of its own report (failures first), when the cluster
//                            serves PolicyReports and Kyverno has reported on it.
// Read-only.
import { useTranslation } from "react-i18next";
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { apiVersionOf as refApiVersion } from "../../resources/refs";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { usePolicySummary, useObjectResults } from "./hooks";
import {
  apiVersionOf,
  backgroundScan,
  countResults,
  isPolicyKind,
  isReportKind,
  kyvernoKind,
  modeTone,
  policyMessage,
  policyMode,
  policyReady,
  policyRules,
  policyTarget,
  readyTone,
  reportResults,
  reportScope,
  RESULT_TONE,
  RESULT_VALUES,
  sortResults,
  type PolicyResult,
  type Summary,
} from "./model";
import { formatList } from "../../i18n";

const LABELS = "kyverno:fields";
const RESULTS_TABLE = "kyvernoResults";
const FAILURES_TABLE = "kyvernoFailures";
const RULES_TABLE = "kyvernoRules";
const RESULTS_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
const FAILURES_WRAP: ColumnWrap[] = ["nowrap", ...RESULTS_WRAP];
const RULES_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
/** Results and failing objects listed at most. */
export const MAX_LISTED = 50;

const typeOf = (kind: KindRef) => ({ apiVersion: apiVersionOf(kind), kind: kind.kind });

function objectLink(ref: ObjectRef) {
  return link({ apiVersion: refApiVersion(ref.kind), kind: ref.kind.kind }, ref.name, ref.namespace, `${ref.kind.kind}/${ref.name}`);
}

function policyLink(result: PolicyResult) {
  const target = policyTarget(result);
  return link(typeOf(target.kind), target.name, target.namespace, result.policy);
}

function ResultText({ value }: { value: PolicyResult["result"] }) {
  const { t } = useTranslation();
  return <StatusText value={t(`kyverno:result.${value}`)} tone={RESULT_TONE[value]} />;
}

function SummaryLine({ summary }: { summary: Summary }) {
  const { t } = useTranslation();
  const parts = RESULT_VALUES.filter((v) => summary[v] > 0).map((v) => t(`kyverno:summary.${v}`, { count: summary[v] }));
  return parts.length > 0 ? <p className="cm-muted">{formatList(parts)}</p> : null;
}

/** Results as a table: policy (a link), rule, result, message. */
function ResultsTable({ results, withObject }: { results: { result: PolicyResult; object?: ObjectRef }[]; withObject?: boolean }) {
  const { t } = useTranslation();
  const shown = results.slice(0, MAX_LISTED);
  const headers = [
    ...(withObject ? [t("kyverno:results.object")] : []),
    t("kyverno:results.policy"),
    t("kyverno:results.rule"),
    t("kyverno:results.result"),
    t("kyverno:results.message"),
  ];
  const rows = shown.map(({ result, object }) => [
    ...(withObject ? [object ? objectLink(object) : ""] : []),
    policyLink(result),
    result.rule ?? "",
    <ResultText key="r" value={result.result} />,
    result.message ?? "",
  ]);
  const body = table(withObject ? FAILURES_TABLE : RESULTS_TABLE, headers, rows, withObject ? FAILURES_WRAP : RESULTS_WRAP);
  return (
    <>
      {body}
      {results.length > shown.length && <p className="cm-muted">{t("kyverno:results.more", { count: results.length - shown.length })}</p>}
    </>
  );
}

function PolicySummaryBody({ clusterId, kind, obj }: { clusterId: string; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const summary = usePolicySummary(clusterId, kind, obj);
  if (!summary.served) return null;
  let body;
  if (summary.unlabelled) body = <p className="cm-muted">{t("kyverno:policySummary.unlabelled")}</p>;
  else if (summary.loading) body = <p className="cm-muted">{t("kyverno:policySummary.loading")}</p>;
  else if (summary.results.length === 0) body = <p className="cm-muted">{t("kyverno:policySummary.none")}</p>;
  else
    body = (
      <>
        <SummaryLine summary={countResults(summary.results)} />
        {summary.capped && <p className="cm-muted">{t("kyverno:policySummary.capped", { count: summary.results.length })}</p>}
        {summary.failed.length > 0 && <ResultsTable withObject results={summary.failed.map((f) => ({ result: f.result, object: f.object }))} />}
      </>
    );
  return <>{body}</>;
}

function PolicyView({ clusterId, kind, obj }: { clusterId: string; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const ready = policyReady(obj);
  const mode = policyMode(obj);
  const message = policyMessage(obj);
  const rules = policyRules(obj);
  const explanation =
    ready === "True" ? t("kyverno:explain.ready") : ready === "False" ? t("kyverno:explain.notReady") : ready === "Unknown" ? t("kyverno:explain.pending") : undefined;
  const rulesTable = table(
    RULES_TABLE,
    [t("kyverno:rules.name"), t("kyverno:rules.type"), t("kyverno:rules.mode"), t("kyverno:rules.kinds")],
    rules.map((r) => [r.name, r.type ? t(`kyverno:ruleType.${r.type}`) : "", r.mode ? t(`kyverno:mode.${r.mode}`) : "", chips(r.kinds)]),
    RULES_WRAP,
  );
  const rows: FieldRow[] = [
    ["ready", ready ? <StatusText key="r" value={t(`kyverno:ready.${ready}`)} tone={readyTone(ready)} /> : undefined],
    ["mode", mode ? <StatusText key="m" value={t(`kyverno:mode.${mode}`)} tone={modeTone(mode)} /> : undefined],
    ["background", backgroundScan(obj) ? t("kyverno:yes") : t("kyverno:no")],
  ];
  return (
    <>
      {explanation && <p className={ready === "False" ? "cm-explain cm-explain--danger" : "cm-explain"}>{explanation}</p>}
      {message && ready !== "True" && <p className="cm-message">{message}</p>}
      {mode && <p className="cm-muted">{t(`kyverno:modeHint.${mode}`)}</p>}
      <Fields rows={rows} labelPrefix={LABELS} />
      {rulesTable}
      <PolicySummaryBlock clusterId={clusterId} kind={kind} obj={obj} />
    </>
  );
}

function ReportView({ kind, obj }: { kind: KindRef; obj: KubeObject }) {
  const scope = reportScope(kind, obj);
  const results = sortResults(reportResults(kind, obj));
  const rows: FieldRow[] = [["object", scope ? objectLink(scope) : undefined]];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <SummaryLine summary={countResults(results)} />
      <ResultsTable results={results.map((result) => ({ result }))} />
    </>
  );
}

export function KyvernoSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = kyvernoKind(objectRef.kind);
  if (!obj || !def) return null;
  const view = isPolicyKind(def.kind) ? <PolicyView clusterId={clusterId} kind={def.kind} obj={obj} /> : <ReportView kind={def.kind} obj={obj} />;
  return <Block id="details:sections.fields" title={t("details:sections.fields", { kind: def.kind.kind })}>{view}</Block>;
}

/** "Policy results" of any object: its own report's results, failures first. */
export function PolicyResultsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { open, enabled, result, settle } = useDisclosureProbe("kyverno:objectResults.title");
  const discovery = useClusterKinds(clusterId);
  const { served, loading, results, unknown } = useObjectResults(clusterId, objectRef, obj?.metadata?.uid, enabled);
  const answer = loading ? null : results.length > 0 ? "present" : unknown || discovery.error ? "unknown" : "absent";
  useEffect(() => { if (enabled && answer) settle(answer); }, [enabled, answer, settle]);
  if (!open && result) return result === "absent" ? null : <Block id="kyverno:objectResults.title" title={t("kyverno:objectResults.title")}>{null}</Block>;
  if (loading && result !== null && result !== "absent") return <Block id="kyverno:objectResults.title" title={t("kyverno:objectResults.title")}><p className="cm-muted">{t("common:details.loading")}</p></Block>;
  if (!served || loading || results.length === 0) return unknown || discovery.error ? <Block id="kyverno:objectResults.title" title={t("kyverno:objectResults.title")}><ErrorState error={discovery.error ?? UNKNOWN_DETAILS_SOURCE} /></Block> : null;
  const sorted = sortResults(results);
  const failed = sorted.filter((r) => r.result === "fail").length;
  return (
    <Block id="kyverno:objectResults.title" title={t("kyverno:objectResults.title")}>
      <p className={failed > 0 ? "cm-explain cm-explain--danger" : "cm-muted"}>
        {failed > 0 ? t("kyverno:objectResults.failing", { count: failed, total: sorted.length }) : t("kyverno:objectResults.passing", { count: sorted.length })}
      </p>
      <ResultsTable results={sorted.map((result) => ({ result }))} />
    </Block>
  );
}

/** Every kind but Kyverno's own and Events. */
export const appliesToObjectResults = (kind: KindRef) => !kyvernoKind(kind) && !isReportKind(kind) && !(kind.group === "" && kind.kind === "Event");

function PolicySummaryBlock(props: Parameters<typeof PolicySummaryBody>[0]) {
  const { t } = useTranslation();
  const discovery = useClusterKinds(props.clusterId);
  if (!discovery.error && !discovery.kinds?.some(kind => kind.kindRef.kind === "PolicyReport" || kind.kindRef.kind === "ClusterPolicyReport")) return null;
  return <Block id="kyverno:policySummary.title" title={t("kyverno:policySummary.title")}>{discovery.error ? <ErrorState error={discovery.error} /> : <PolicySummaryBody {...props} />}</Block>;
}
