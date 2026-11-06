// The details section `fields` of the Argo CD kinds: what the built-in view's fields said about an Application, an
// ApplicationSet or an AppProject (conditions come from Sextant's generic conditions section).
import type { KubeObject, ObjectRef, Sextant } from "@sextant/extension-sdk";
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
} from "./argo";
import { chips, element, inlineList, objectLink, statusWord, table, when, withMessage } from "./dom";
import { arr, get, str } from "./fields";
import { t } from "./i18n";
import { followShown } from "./shown";

type Row = [field: string, value: Node | string | null | undefined];

/** The rows with a value, as a description list labelled by `fields.<id>`. */
function fieldList(rows: readonly Row[]): HTMLElement {
  const list = element("dl", { className: "fields" });
  for (const [id, value] of rows) {
    if (value === null || value === undefined || value === "") continue;
    list.append(element("dt", { textContent: t(`fields.${id}`) }), element("dd", {}, value));
  }
  return list;
}

function sourcesTable(sources: readonly Source[]): HTMLElement | null {
  if (sources.length === 0) return null;
  return table(
    [t("sources.repo"), t("sources.path"), t("sources.targetRevision")],
    sources.map((s) => [s.repoURL, s.path ?? s.chart, s.targetRevision]),
  );
}

function destinationNode(sextant: Sextant, dest: Destination): Node | string {
  const cluster = clusterOf(dest);
  if (!dest.namespace) return cluster;
  // The namespace opens only when it is in this cluster.
  const namespace = isInCluster(dest)
    ? objectLink(sextant, { kind: { group: "", version: "v1", kind: "Namespace" }, namespace: null, name: dest.namespace })
    : dest.namespace;
  return inlineList([cluster, namespace]) ?? cluster;
}

function syncPolicy(app: KubeObject): Node | string {
  const automated = get(app, "spec", "syncPolicy", "automated");
  if (!automated || get(automated, "enabled") === false) return t("policy.manual");
  return (
    chips([
      t("policy.automated"),
      get(automated, "prune") === true ? t("policy.prune") : undefined,
      get(automated, "selfHeal") === true ? t("policy.selfHeal") : undefined,
    ]) ?? t("policy.automated")
  );
}

export function applicationFields(sextant: Sextant, app: KubeObject): HTMLElement {
  const project = str(get(app, "spec", "project"));
  const projectNamespace = str(get(app, "status", "controllerNamespace")) ?? app.metadata.namespace ?? null;
  return fieldList([
    ["project", project ? objectLink(sextant, { kind: APP_PROJECT, namespace: projectNamespace, name: project }) : null],
    ["sync", statusWord(syncStatus(app), syncTone)],
    ["syncedRevision", chips(revisions(app))],
    ["health", withMessage(statusWord(healthStatus(app), healthTone), str(get(app, "status", "health", "message")))],
    ["operation", withMessage(statusWord(operationPhase(app), phaseTone), str(get(app, "status", "operationState", "message")))],
    ["operationStarted", when(str(get(app, "status", "operationState", "startedAt")))],
    ["operationFinished", when(str(get(app, "status", "operationState", "finishedAt")))],
    ["sources", sourcesTable(sourcesOf(app))],
    ["destination", destinationNode(sextant, applicationDestination(app))],
    ["syncPolicy", syncPolicy(app)],
    ["syncOptions", chips(arr(get(app, "spec", "syncPolicy", "syncOptions")).map(str))],
    ["reconciledAt", when(str(get(app, "status", "reconciledAt")))],
  ]);
}

export function applicationSetFields(sextant: Sextant, appSet: KubeObject): HTMLElement {
  const template = get(appSet, "spec", "template", "spec");
  const apps = generatedApplications(appSet).map((a) => objectLink(sextant, { kind: APPLICATION, namespace: a.namespace, name: a.name }));
  return fieldList([
    ["generators", chips(generatorTypes(appSet))],
    ["health", statusWord(str(get(appSet, "status", "health", "status")), healthTone)],
    ["project", str(get(template, "project"))],
    ["sources", sourcesTable(sourcesOf({ spec: template }))],
    ["destination", destinationText(applicationDestination({ metadata: { name: "" }, spec: template as Record<string, unknown> })) || null],
    ["applications", inlineList(apps)],
  ]);
}

export function appProjectFields(project: KubeObject): HTMLElement {
  const kinds = (field: string) =>
    chips(
      arr(get(project, "spec", field)).map((k) => {
        const group = str(get(k, "group"));
        return `${group ? `${group}/` : ""}${str(get(k, "kind")) ?? ""}`;
      }),
    );
  const destinations = projectDestinations(project);
  return fieldList([
    ["description", str(get(project, "spec", "description"))],
    ["sourceRepos", chips(projectSources(project))],
    [
      "destinations",
      destinations.length > 0
        ? table([t("destinations.cluster"), t("destinations.namespace")], destinations.map((d) => [clusterOf(d), d.namespace]))
        : null,
    ],
    ["clusterResourceWhitelist", kinds("clusterResourceWhitelist")],
    ["clusterResourceBlacklist", kinds("clusterResourceBlacklist")],
    ["namespaceResourceWhitelist", kinds("namespaceResourceWhitelist")],
    ["namespaceResourceBlacklist", kinds("namespaceResourceBlacklist")],
    ["roles", chips(arr(get(project, "spec", "roles")).map((r) => str(get(r, "name"))))],
  ]);
}

/** The fields of whichever Argo CD kind `ref` is. */
export function fieldsOf(sextant: Sextant, obj: KubeObject, ref: ObjectRef): HTMLElement {
  if (ref.kind.kind === "ApplicationSet") return applicationSetFields(sextant, obj);
  if (ref.kind.kind === "AppProject") return appProjectFields(obj);
  return applicationFields(sextant, obj);
}

export function startFields(sextant: Sextant, root: HTMLElement): () => void {
  return followShown(sextant, root, (obj, ref) => root.replaceChildren(fieldsOf(sextant, obj, ref)));
}
