// Columns of the OpenShift tables: a Route's admission by the routers, where it answers, its backends with their
// shares and its TLS termination; a DeploymentConfig's rollout state, ready pods of desired, latest version and
// triggers; a BuildConfig's strategy, source, output and last build number; a Build's phase, BuildConfig and
// duration; an ImageStream's tags and the tags whose import fails; a Project's display name, phase and requester.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age, ageParts } from "../../components";
import { formatList, formatNumber } from "../../i18n";
import { ageColumn, ageSearchText, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { DurationText } from "../argo-workflows/columns";
import {
  bcTriggers,
  BUILD_TONE,
  buildConfigOf,
  buildDurationMs,
  buildOutput,
  buildPhase,
  buildReason,
  buildSource,
  buildStrategy,
  DC_TONE,
  dcReason,
  dcReplicas,
  dcState,
  dcTriggers,
  failedImports,
  latestVersionOf,
  projectInfo,
  ROUTE_TONE,
  routeBackends,
  routeHost,
  routeReason,
  routeState,
  routeTls,
  streamRepositories,
  streamTags,
  type RouteBackend,
} from "./model";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `openshift:columns.${id}`,
  value,
  ...options,
});

export function RouteStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = routeState(obj);
  return (
    <span title={routeReason(obj)}>
      <StatusText value={t(`openshift:routeState.${state}`)} tone={ROUTE_TONE[state]} />
    </span>
  );
}

export function DcStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = dcState(obj);
  return (
    <span title={dcReason(obj)}>
      <StatusText value={t(`openshift:dcState.${state}`)} tone={DC_TONE[state]} />
    </span>
  );
}

export function BuildPhaseText({ obj }: { obj: KubeObject }) {
  const phase = buildPhase(obj);
  return (
    <span title={buildReason(obj)}>
      <StatusText value={phase} tone={BUILD_TONE(phase)} />
    </span>
  );
}

/** A share of the requests in the UI language: "80%", "80 %", "%80". */
export function percentText(t: (key: string, o?: Record<string, unknown>) => string, percent: number): string {
  return t("openshift:percent", { value: formatNumber(percent, percent > 0 && percent < 1 ? 1 : 0) });
}

/** "frontend (80%), canary (20%)"; one backend alone is its name. */
export function backendsText(t: (key: string, o?: Record<string, unknown>) => string, backends: RouteBackend[]): string {
  if (backends.length === 1) return backends[0]!.name;
  return formatList(backends.map((b) => t("openshift:backendShare", { name: b.name, percent: percentText(t, b.percent) })));
}

function BackendsCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <>{backendsText(t, routeBackends(obj))}</>;
}

const hostAndPath = (o: KubeObject) => {
  const host = routeHost(o);
  return host ? `${host}${str(get(o, "spec", "path")) ?? ""}` : undefined;
};

export const routeColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", routeState, {
    width: "110px",
    render: (o) => <RouteStateText obj={o} />,
    searchText: (o, ctx) => ctx.t(`openshift:routeState.${routeState(o)}`),
  }),
  col("host", hostAndPath, { width: "minmax(180px, 2fr)" }),
  col(
    "services",
    (o) =>
      routeBackends(o)
        .map((b) => b.name)
        .join(", "),
    { width: "minmax(140px, 1.5fr)", render: (o) => <BackendsCell obj={o} />, searchText: (o, ctx) => backendsText(ctx.t, routeBackends(o)) },
  ),
  col("tls", (o) => routeTls(o)?.termination, { width: "100px" }),
  ageColumn,
];

export const dcColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", dcState, {
    width: "120px",
    render: (o) => <DcStateText obj={o} />,
    searchText: (o, ctx) => ctx.t(`openshift:dcState.${dcState(o)}`),
  }),
  col(
    "ready",
    (o) => {
      const r = dcReplicas(o);
      return `${r.ready}/${r.desired}`;
    },
    { width: "80px" },
  ),
  col("latestVersion", latestVersionOf, { width: "80px" }),
  col(
    "triggers",
    (o) =>
      dcTriggers(o)
        .map((tr) => tr.type)
        .join(", "),
    { width: "minmax(140px, 1fr)" },
  ),
  ageColumn,
];

export const bcColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("strategy", (o) => buildStrategy(o).type, { width: "110px" }),
  col("source", (o) => buildSource(o).uri ?? buildSource(o).type, { width: "minmax(180px, 2fr)" }),
  col("output", (o) => buildOutput(o)?.name, { width: "minmax(140px, 1fr)" }),
  col("lastVersion", (o) => num(get(o, "status", "lastVersion")), { width: "80px" }),
  col(
    "triggers",
    (o) =>
      bcTriggers(o)
        .map((tr) => tr.type)
        .join(", "),
    { width: "minmax(120px, 1fr)" },
  ),
  ageColumn,
];

const startedAt = (o: KubeObject) => str(get(o, "status", "startTimestamp"));

export const buildColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", buildPhase, { width: "100px", render: (o) => <BuildPhaseText obj={o} /> }),
  col("buildConfig", buildConfigOf, { width: "minmax(140px, 1fr)" }),
  col("strategy", (o) => buildStrategy(o).type, { width: "100px" }),
  col("duration", (o) => buildDurationMs(o), {
    width: "90px",
    render: (o, ctx) => <DurationText ms={buildDurationMs(o, ctx.now)} />,
    searchText: (o, ctx) => {
      const ms = buildDurationMs(o, ctx.now);
      if (ms === undefined) return undefined;
      const { unit, count } = ageParts(ms);
      return ctx.t(`common:age.${unit}`, { count });
    },
    searchTextTimed: true,
  }),
  col("started", startedAt, {
    width: "100px",
    render: (o, ctx) => <Age timestamp={startedAt(o)} now={ctx.now} />,
    ...ageSearchText(startedAt),
  }),
  ageColumn,
];

function FailedImportsCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const failed = failedImports(obj);
  return failed.length > 0 ? <StatusText value={t("openshift:importFailing", { count: failed.length })} tone="danger" /> : null;
}

export const imageStreamColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col(
    "tags",
    (o) =>
      streamTags(o)
        .map((tag) => tag.name)
        .join(", "),
    { width: "minmax(140px, 1.5fr)" },
  ),
  col("imports", (o) => failedImports(o).length, {
    width: "130px",
    render: (o) => <FailedImportsCell obj={o} />,
    searchText: (o, ctx) => {
      const count = failedImports(o).length;
      return count > 0 ? ctx.t("openshift:importFailing", { count }) : undefined;
    },
  }),
  col("repository", (o) => streamRepositories(o).internal, { width: "minmax(200px, 2fr)" }),
  ageColumn,
];

export const projectColumns: ColumnDef[] = [
  nameColumn,
  col("displayName", (o) => projectInfo(o).displayName, { width: "minmax(160px, 2fr)" }),
  col("status", (o) => projectInfo(o).phase, { width: "100px", render: (o) => <StatusText value={projectInfo(o).phase} /> }),
  col("requester", (o) => projectInfo(o).requester, { width: "minmax(120px, 1fr)" }),
  ageColumn,
];
