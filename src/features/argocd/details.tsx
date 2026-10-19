// Fields of the Argo CD objects in the details panel (the "fields" section; conditions come from the generic
// conditions section). The resource tree and the sync history of an Application are sections of their own
// (ResourceTree.tsx, SyncHistory.tsx).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { chips, Fields, table, type FieldRow } from "../details";
import {
  APP_PROJECT,
  APPLICATION,
  applicationDestination,
  clusterOf,
  destinationText,
  generatedApplications,
  generatorTypes,
  healthStatus,
  healthTone,
  isInCluster,
  operationPhase,
  phaseTone,
  projectDestinations,
  projectSources,
  revisions,
  sourcesOf,
  syncStatus,
  syncTone,
  type Destination,
  type Source,
} from "./model";
import { inlineList, objectLink, statusWord, when, withMessage } from "./ui";

const { arr, get, str } = status;

const PROJECT_API = apiVersionOf(APP_PROJECT);
const APPLICATION_API = apiVersionOf(APPLICATION);
/** Labels of the fields: `argocd:fields.*`. */
const FIELD_LABELS = "argocd:fields";

/** The repository, path or chart and target revision of each source. */
function SourcesTable({ sources }: { sources: Source[] }) {
  const { t } = useTranslation();
  return table(
    "argocd.sources",
    [t("argocd:sources.repo"), t("argocd:sources.path"), t("argocd:sources.targetRevision")],
    sources.map((s) => [s.repoURL, s.path ?? s.chart, s.targetRevision]),
  );
}

function destinationNode(dest: Destination): ReactNode {
  const cluster = clusterOf(dest);
  if (!dest.namespace) return cluster;
  // The namespace opens only when it is in this cluster.
  const namespace = isInCluster(dest) ? objectLink("v1", "Namespace", dest.namespace, null) : dest.namespace;
  return inlineList([cluster, namespace]);
}

function syncPolicy(app: KubeObject, t: (key: string) => string): ReactNode {
  const automated = get(app, "spec", "syncPolicy", "automated");
  if (!automated || get(automated, "enabled") === false) return t("argocd:policy.manual");
  const flags = [
    t("argocd:policy.automated"),
    get(automated, "prune") === true ? t("argocd:policy.prune") : undefined,
    get(automated, "selfHeal") === true ? t("argocd:policy.selfHeal") : undefined,
  ];
  return chips(flags);
}

export function ApplicationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const projectNamespace = str(get(obj, "status", "controllerNamespace")) ?? obj.metadata?.namespace ?? null;
  const phase = operationPhase(obj);
  const sources = sourcesOf(obj);
  const rows: FieldRow[] = [
    ["project", objectLink(PROJECT_API, "AppProject", str(get(obj, "spec", "project")), projectNamespace)],
    ["sync", statusWord(syncStatus(obj), syncTone)],
    ["syncedRevision", chips(revisions(obj))],
    ["health", withMessage(statusWord(healthStatus(obj), healthTone), str(get(obj, "status", "health", "message")))],
    ["operation", withMessage(statusWord(phase, phaseTone), str(get(obj, "status", "operationState", "message")))],
    ["operationStarted", when(str(get(obj, "status", "operationState", "startedAt")))],
    ["operationFinished", when(str(get(obj, "status", "operationState", "finishedAt")))],
    ["sources", sources.length > 0 ? <SourcesTable sources={sources} /> : null],
    ["destination", destinationNode(applicationDestination(obj))],
    ["syncPolicy", syncPolicy(obj, t)],
    ["syncOptions", chips(arr(get(obj, "spec", "syncPolicy", "syncOptions")).map(str))],
    ["reconciledAt", when(str(get(obj, "status", "reconciledAt")))],
  ];
  return <Fields rows={rows} labelPrefix={FIELD_LABELS} />;
}

export function ApplicationSetDetails({ obj }: { obj: KubeObject }) {
  const template = get(obj, "spec", "template", "spec");
  const sources = sourcesOf({ spec: template } as KubeObject);
  const apps = generatedApplications(obj).map((a) => objectLink(APPLICATION_API, "Application", a.name, a.namespace));
  const rows: FieldRow[] = [
    ["generators", chips(generatorTypes(obj))],
    ["health", withMessage(statusWord(str(get(obj, "status", "health", "status")), healthTone), undefined)],
    ["project", str(get(template, "project"))],
    ["sources", sources.length > 0 ? <SourcesTable sources={sources} /> : null],
    ["destination", destinationText(applicationDestination({ spec: template } as KubeObject)) || null],
    ["applications", inlineList(apps)],
  ];
  return <Fields rows={rows} labelPrefix={FIELD_LABELS} />;
}

export function AppProjectDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const kinds = (field: string) =>
    chips(
      arr(get(obj, "spec", field)).map((k) => {
        const group = str(get(k, "group"));
        return `${group ? `${group}/` : ""}${str(get(k, "kind")) ?? ""}`;
      }),
    );
  const destinations = projectDestinations(obj);
  const rows: FieldRow[] = [
    ["description", str(get(obj, "spec", "description"))],
    ["sourceRepos", chips(projectSources(obj))],
    [
      "destinations",
      table(
        "argocd.destinations",
        [t("argocd:destinations.cluster"), t("argocd:destinations.namespace")],
        destinations.map((d) => [clusterOf(d), d.namespace]),
      ),
    ],
    ["clusterResourceWhitelist", kinds("clusterResourceWhitelist")],
    ["clusterResourceBlacklist", kinds("clusterResourceBlacklist")],
    ["namespaceResourceWhitelist", kinds("namespaceResourceWhitelist")],
    ["namespaceResourceBlacklist", kinds("namespaceResourceBlacklist")],
    ["roles", chips(arr(get(obj, "spec", "roles")).map((r) => str(get(r, "name"))))],
  ];
  return <Fields rows={rows} labelPrefix={FIELD_LABELS} />;
}
