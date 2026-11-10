// The details section `fields` of the Argo CD kinds: what the built-in view's fields said about an Application, an
// ApplicationSet or an AppProject (conditions come from Sextant's generic conditions section), drawn with the SDK's
// UI kit as Sextant's own details are.
import { ui, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
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
import { statusWord, when, withMessage } from "./dom";
import { arr, get, str } from "./fields";
import { t } from "./i18n";
import { followShown } from "./shown";

type Row = [field: string, value: Node | string | null | undefined];

/** The rows with a value, as Sextant's fields labelled by `fields.<id>`. */
function fieldList(rows: readonly Row[]): HTMLElement {
  return ui.fields(rows.map(([id, value]) => [t(`fields.${id}`), value] as const));
}

/** Links (or anything inline) side by side; nothing when there are none. */
function inlineList(nodes: readonly (Node | string | null)[]): HTMLElement | null {
  const shown = nodes.filter((n): n is Node | string => n !== null && n !== "");
  return shown.length > 0 ? ui.inline(shown) : null;
}

function sourcesTable(sextant: Sextant, sources: readonly Source[]): HTMLElement | null {
  if (sources.length === 0) return null;
  return ui.table(
    [t("sources.repo"), t("sources.path"), t("sources.targetRevision")],
    sources.map((s) => [s.repoURL, s.path ?? s.chart, s.targetRevision]),
    { id: "sources", sextant },
  );
}

function destinationNode(sextant: Sextant, dest: Destination): Node | string {
  const cluster = clusterOf(dest);
  if (!dest.namespace) return cluster;
  // The namespace opens only when it is in this cluster.
  const namespace = isInCluster(dest)
    ? ui.objectLink(sextant, { kind: { group: "", version: "v1", kind: "Namespace" }, namespace: null, name: dest.namespace })
    : dest.namespace;
  return inlineList([cluster, namespace]) ?? cluster;
}

function syncPolicy(app: KubeObject): Node | string {
  const automated = get(app, "spec", "syncPolicy", "automated");
  if (!automated || get(automated, "enabled") === false) return t("policy.manual");
  return (
    ui.chips([
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
    ["project", project ? ui.objectLink(sextant, { kind: APP_PROJECT, namespace: projectNamespace, name: project }) : null],
    ["sync", statusWord(syncStatus(app), syncTone)],
    ["syncedRevision", ui.chips(revisions(app))],
    ["health", withMessage(statusWord(healthStatus(app), healthTone), str(get(app, "status", "health", "message")))],
    ["operation", withMessage(statusWord(operationPhase(app), phaseTone), str(get(app, "status", "operationState", "message")))],
    ["operationStarted", when(str(get(app, "status", "operationState", "startedAt")))],
    ["operationFinished", when(str(get(app, "status", "operationState", "finishedAt")))],
    ["sources", sourcesTable(sextant, sourcesOf(app))],
    ["destination", destinationNode(sextant, applicationDestination(app))],
    ["syncPolicy", syncPolicy(app)],
    ["syncOptions", ui.chips(arr(get(app, "spec", "syncPolicy", "syncOptions")).map(str))],
    ["reconciledAt", when(str(get(app, "status", "reconciledAt")))],
  ]);
}

export function applicationSetFields(sextant: Sextant, appSet: KubeObject): HTMLElement {
  const template = get(appSet, "spec", "template", "spec");
  const apps = generatedApplications(appSet).map((a) => ui.objectLink(sextant, { kind: APPLICATION, namespace: a.namespace, name: a.name }));
  return fieldList([
    ["generators", ui.chips(generatorTypes(appSet))],
    ["health", statusWord(str(get(appSet, "status", "health", "status")), healthTone)],
    ["project", str(get(template, "project"))],
    ["sources", sourcesTable(sextant, sourcesOf({ spec: template }))],
    ["destination", destinationText(applicationDestination({ metadata: { name: "" }, spec: template as Record<string, unknown> })) || null],
    ["applications", inlineList(apps)],
  ]);
}

export function appProjectFields(sextant: Sextant, project: KubeObject): HTMLElement {
  const kinds = (field: string) =>
    ui.chips(
      arr(get(project, "spec", field)).map((k) => {
        const group = str(get(k, "group"));
        return `${group ? `${group}/` : ""}${str(get(k, "kind")) ?? ""}`;
      }),
    );
  const destinations = projectDestinations(project);
  return fieldList([
    ["description", str(get(project, "spec", "description"))],
    ["sourceRepos", ui.chips(projectSources(project))],
    [
      "destinations",
      destinations.length > 0
        ? ui.table([t("destinations.cluster"), t("destinations.namespace")], destinations.map((d) => [clusterOf(d), d.namespace]), {
            id: "destinations",
            sextant,
          })
        : null,
    ],
    ["clusterResourceWhitelist", kinds("clusterResourceWhitelist")],
    ["clusterResourceBlacklist", kinds("clusterResourceBlacklist")],
    ["namespaceResourceWhitelist", kinds("namespaceResourceWhitelist")],
    ["namespaceResourceBlacklist", kinds("namespaceResourceBlacklist")],
    ["roles", ui.chips(arr(get(project, "spec", "roles")).map((r) => str(get(r, "name"))))],
  ]);
}

/** The fields of whichever Argo CD kind `ref` is. */
export function fieldsOf(sextant: Sextant, obj: KubeObject, ref: ObjectRef): HTMLElement {
  if (ref.kind.kind === "ApplicationSet") return applicationSetFields(sextant, obj);
  if (ref.kind.kind === "AppProject") return appProjectFields(sextant, obj);
  return applicationFields(sextant, obj);
}

export function startFields(sextant: Sextant, root: HTMLElement): () => void {
  return followShown(sextant, root, (obj, ref) => root.replaceChildren(fieldsOf(sextant, obj, ref)));
}
