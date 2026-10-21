// Details of Argo Workflows objects (one section, `argoWorkflows`, for every kind of the section):
//   Workflow          — phase, progress, times and duration, the failed step and its message, the CronWorkflow and
//                       template it came from; the node tree (at most `MAX_TREE_NODES` rows, collapsed below the root),
//                       each pod node linked to its pod with its logs one click away (the logs dock tab);
//   CronWorkflow      — the schedules, time zone, concurrency, suspension, last run, the active Workflows, counts;
//   (Cluster)WorkflowTemplate — the entrypoint and the templates.
// The actions live in ./actions.tsx; a failed Workflow says how to retry it outside Sextant. Conditions and YAML are
// the panel's own sections.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type KubeObject } from "../../api";
import { Age, Button, ErrorState } from "../../components";
import { formatDateTime } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { useNow } from "../problems/hooks";
import { Block, breakable, chips, Fields, KINDS, link, type FieldRow } from "../details";
import { openLogsTab } from "../logs";
import { cronOf, DurationText, PhaseText, templateRefOf } from "./columns";
import {
  activeWorkflows,
  CLUSTER_WORKFLOW_TEMPLATE,
  CRON_WORKFLOW,
  cronCounts,
  cronSuspended,
  durationOf,
  failedNode,
  failureMessage,
  isKind,
  isWorkflowsKind,
  lastScheduled,
  MAX_TREE_NODES,
  nodesElsewhere,
  nodesOf,
  pathTo,
  podNameOf,
  progressOf,
  rootOf,
  schedulesOf,
  templateSummary,
  treeRows,
  WORKFLOW,
  WORKFLOW_TEMPLATE,
  workflowDuration,
  workflowPhase,
  type WorkflowNode,
} from "./model";
import "./argo-workflows.css";

const { get, str } = status;

const FIELDS = "argoworkflows:fields";
const API = "argoproj.io/v1alpha1";
const typeOf = (kind: KindRef) => ({ apiVersion: API, kind: kind.kind });
const POD_KIND: KindRef = { group: "", version: "v1", kind: "Pod" };

const date = (value: string | undefined) => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

function WorkflowFields({ wf }: { wf: KubeObject }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const ns = wf.metadata?.namespace ?? null;
  const phase = workflowPhase(wf);
  const failed = phase === "Failed" || phase === "Error" ? failedNode(wf) : undefined;
  const template = templateRefOf(wf);
  const rows: FieldRow[] = [
    ["phase", <PhaseText key="p" phase={phase} />],
    ["progress", progressOf(wf)],
    ["startedAt", date(str(get(wf, "status", "startedAt")))],
    ["finishedAt", date(str(get(wf, "status", "finishedAt")))],
    ["duration", <DurationText key="d" ms={workflowDuration(wf, now)} />],
    ["message", str(get(wf, "status", "message"))],
    ["failedStep", failed?.displayName],
    ["failedMessage", failed ? failureMessage(wf, failed) : undefined],
    ["cronWorkflow", link(typeOf(CRON_WORKFLOW), cronOf(wf), ns)],
    [
      "workflowTemplate",
      template ? link(typeOf(template.cluster ? CLUSTER_WORKFLOW_TEMPLATE : WORKFLOW_TEMPLATE), template.name, template.cluster ? null : ns) : null,
    ],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={FIELDS} />
      {/* Retry is not an action (ADR-0097): it rebuilds the node tree and deletes pods, as only Argo does. */}
      {phase === "Failed" || phase === "Error" ? (
        <p className="aw-muted">{t("argoworkflows:retryHint", { name: wf.metadata?.name ?? "", namespace: ns ?? "" })}</p>
      ) : null}
    </>
  );
}

/** Opens the logs of the pod of a node; says so when the pod is gone (Argo deletes pods by its pod GC). */
function LogsButton({ clusterId, namespace, pod }: { clusterId: ClusterId; namespace: string; pod: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<ApiError | null>(null);
  const open = async () => {
    setError(null);
    try {
      openLogsTab(clusterId, await api.resources.get(clusterId, { kind: POD_KIND, namespace, name: pod }));
    } catch (err) {
      setError(toApiError(err));
    }
  };
  return (
    <>
      <Button size="compact" icon="logs" onClick={() => void open()} aria-label={t("argoworkflows:tree.logsOf", { name: pod })}>
        {t("argoworkflows:tree.logs")}
      </Button>
      {error && <ErrorState error={error} />}
    </>
  );
}

function NodeRow({
  clusterId,
  wf,
  node,
  pod,
  depth,
  hasChildren,
  open,
  toggle,
  now,
}: {
  clusterId: ClusterId;
  wf: KubeObject;
  node: WorkflowNode;
  /** The node's pod (`podNameOf`), if it has one. */
  pod: string | undefined;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  toggle: () => void;
  now: number;
}) {
  const { t } = useTranslation();
  const ns = wf.metadata?.namespace ?? "";
  const failed = node.phase === "Failed" || node.phase === "Error";
  return (
    <li className={`aw-node${failed ? " aw-node--failed" : ""}`} style={{ paddingLeft: `${depth * 1.25}rem` }}>
      <div className="aw-node__head">
        {hasChildren ? (
          <Button
            size="compact"
            iconOnly
            icon={open ? "chevronDown" : "chevronRight"}
            label={t(open ? "argoworkflows:tree.collapse" : "argoworkflows:tree.expand", { name: node.displayName })}
            aria-expanded={open}
            onClick={toggle}
          />
        ) : (
          <span className="aw-node__spacer" />
        )}
        <span className="aw-node__name">{node.displayName}</span>
        <span className="aw-node__type">{node.type}</span>
        <PhaseText phase={node.phase} />
        <span className="aw-node__time">
          <DurationText ms={durationOf(node.raw, now)} />
        </span>
        {pod && ns && (
          <>
            {link(KINDS.pod, pod, ns)}
            <LogsButton clusterId={clusterId} namespace={ns} pod={pod} />
          </>
        )}
      </div>
      {node.message && <div className="aw-node__message">{breakable(node.message)}</div>}
    </li>
  );
}

function NodeTree({ clusterId, wf }: { clusterId: ClusterId; wf: KubeObject }) {
  const { t } = useTranslation();
  // Durations of running steps tick; a tree of hundreds of rows is drawn again only every few seconds.
  const now = useNow(5000);
  const nodes = nodesOf(wf);
  const root = rootOf(wf, nodes);
  // Collapsed below the root by default.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(root ? [root.id] : []));
  const elsewhere = nodesElsewhere(wf);
  if (elsewhere) return <p className="aw-muted">{t(`argoworkflows:tree.${elsewhere}`)}</p>;
  if (!root) return <p className="aw-muted">{t("argoworkflows:tree.none")}</p>;
  const rows = treeRows(wf, nodes, expanded);
  const failed = failedNode(wf, nodes);
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <div className="aw-tree__tools">
        <span className="aw-muted">{t("argoworkflows:tree.count", { count: nodes.size })}</span>
        {failed && (
          <Button size="compact" onClick={() => setExpanded(new Set([...expanded, ...pathTo(wf, nodes, failed.id)]))}>
            {t("argoworkflows:tree.expandFailed")}
          </Button>
        )}
        <Button size="compact" onClick={() => setExpanded(new Set([root.id]))}>
          {t("argoworkflows:tree.collapseAll")}
        </Button>
      </div>
      <ul className="aw-tree">
        {rows.map((row) => (
          <NodeRow
            key={row.node.id}
            clusterId={clusterId}
            wf={wf}
            node={row.node}
            pod={podNameOf(wf, row.node, nodes)}
            depth={row.depth}
            hasChildren={row.hasChildren}
            open={expanded.has(row.node.id)}
            toggle={() => toggle(row.node.id)}
            now={now}
          />
        ))}
      </ul>
      {rows.length >= MAX_TREE_NODES && (
        <p className="aw-muted">{t("argoworkflows:tree.capped", { shown: MAX_TREE_NODES, count: nodes.size })}</p>
      )}
    </>
  );
}

function WorkflowView({ clusterId, wf }: { clusterId: ClusterId; wf: KubeObject }) {
  const { t } = useTranslation();
  return (
    <>
      <Block title={t("argoworkflows:sections.workflow")}>
        <WorkflowFields wf={wf} />
      </Block>
      <Block title={t("argoworkflows:sections.nodes")}>
        {/* A tree of its own per Workflow: what is expanded does not carry over to another one. */}
        <NodeTree key={wf.metadata?.uid ?? wf.metadata?.name} clusterId={clusterId} wf={wf} />
      </Block>
    </>
  );
}

function CronView({ cron }: { cron: KubeObject }) {
  const { t } = useTranslation();
  const ns = cron.metadata?.namespace ?? null;
  const counts = cronCounts(cron);
  const last = lastScheduled(cron);
  const active = activeWorkflows(cron).map((a) => link(typeOf(WORKFLOW), a.name, a.namespace ?? ns));
  const rows: FieldRow[] = [
    ["schedules", chips(schedulesOf(cron))],
    ["timezone", str(get(cron, "spec", "timezone"))],
    ["concurrencyPolicy", str(get(cron, "spec", "concurrencyPolicy"))],
    ["suspended", cronSuspended(cron) ? t("argoworkflows:yes") : undefined],
    ["lastScheduled", last ? <span key="l" className="aw-when">{date(last)}<Age timestamp={last} /></span> : null],
    ["active", active.length > 0 ? <span className="dt-links">{active}</span> : null],
    ["succeeded", counts.succeeded === undefined ? undefined : String(counts.succeeded)],
    ["failed", counts.failed === undefined ? undefined : String(counts.failed)],
    ["entrypoint", templateSummary(cron).entrypoint],
  ];
  return (
    <Block title={t("argoworkflows:sections.cron")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function TemplateView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const summary = templateSummary(obj);
  const rows: FieldRow[] = [
    ["entrypoint", summary.entrypoint],
    ["templates", chips(summary.templates)],
  ];
  return (
    <Block title={t("argoworkflows:sections.template")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

/** The section of every Argo Workflows kind. */
export function WorkflowsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isWorkflowsKind(objectRef.kind)) return null;
  if (isKind(objectRef.kind, WORKFLOW)) return <WorkflowView clusterId={clusterId} wf={obj} />;
  if (isKind(objectRef.kind, CRON_WORKFLOW)) return <CronView cron={obj} />;
  return <TemplateView obj={obj} />;
}
