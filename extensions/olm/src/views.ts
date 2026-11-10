// Details of the other OLM kinds: a CatalogSource's registry (type, image or address, poll interval, connection state,
// registry Service), an OperatorGroup's target namespaces and upgrade strategy, an Operator's components, and OLM v1's
// ClusterExtension (package, installed bundle, Installed and Progressing) and ClusterCatalog (image, Serving). Read-only.
import { ui, type KubeObject, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { dateTime, note, remark } from "./dom";
import { t } from "./i18n";
import {
  catalogInfo,
  catalogV1Info,
  componentsOf,
  conditionText,
  CONFIG_MAP,
  connectionTone,
  extensionInfo,
  MAX_COMPONENTS,
  NAMESPACE,
  operatorGroupInfo,
  selectorChips,
  SERVICE,
  SERVICE_ACCOUNT,
  type KindOf,
} from "./model";

/** A link to an object's details in Sextant's panel, named by its name (or `text`); nothing without a name. */
export function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null = null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** A kind from an `apiVersion` (`apps/v1`, `v1`) and a kind. */
export function kindFrom(apiVersion: string, kind: string): KindOf {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion, kind } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

/** `ui.fields` labelled from `fields.<key>`, or nothing when no row has a value. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
  return list.childElementCount > 0 ? list : null;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

function condition(obj: KubeObject, type: string): HTMLElement | null {
  const c = conditionText(obj, type);
  if (!c) return null;
  const node = ui.status(c.text, c.tone);
  if (c.title) node.title = c.title;
  return node;
}

export function catalogSourceView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const info = catalogInfo(obj);
  const service = info.registryService;
  const failing = info.state !== undefined && info.state !== "READY" && info.state !== "IDLE";
  return present([
    failing && note(t("catalogNotReady", { state: info.state ?? "" }), "warning"),
    !info.state && info.sourceType === "grpc" && remark(t("catalogNoState")),
    fieldsOf([
      ["connection", info.state ? ui.status(info.state, connectionTone(info.state)) : null],
      ["displayName", info.displayName],
      ["publisher", info.publisher],
      ["sourceType", info.sourceType],
      ["image", info.image],
      ["address", info.address],
      ["configMap", link(sextant, CONFIG_MAP, info.configMap, ns)],
      ["priority", info.priority?.toString()],
      ["pollInterval", info.pollInterval],
      ["connectedAddress", info.connectedAddress],
      ["lastConnect", dateTime(info.lastConnect)],
      ["latestPoll", dateTime(info.latestPoll)],
      ["registryService", service?.name ? link(sextant, SERVICE, service.name, service.namespace ?? ns) : null],
      ["port", service?.port],
      ["reason", info.reason],
      ["message", info.message],
    ]),
  ]);
}

export function operatorGroupView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const info = operatorGroupInfo(obj);
  return present([
    info.upgradeStrategy === "TechPreviewUnsafeFailForward" && note(t("unsafeFailForward"), "warning"),
    fieldsOf([
      ["targets", info.allNamespaces ? t("allNamespaces") : ui.chips(info.namespaces)],
      ["targetNamespaces", ui.chips(info.targetNamespaces)],
      ["selector", info.targetNamespaces.length === 0 ? ui.chips(selectorChips(info.selector)) : null],
      ["upgradeStrategy", info.upgradeStrategy],
      ["serviceAccount", link(sextant, SERVICE_ACCOUNT, info.serviceAccountName, ns)],
      ["staticProvidedAPIs", info.staticProvidedAPIs ? t("yes") : null],
      ["providedAPIs", ui.chips(info.providedAPIs)],
      ["lastUpdated", dateTime(info.lastUpdated)],
    ]),
  ]);
}

export function operatorView(sextant: Sextant, obj: KubeObject, blocks: { block(id: string, title: string, content: UiContent): HTMLElement }): Node[] {
  const { refs, total } = componentsOf(obj);
  const rows = refs.map((r) => [r.kind, link(sextant, kindFrom(r.apiVersion, r.kind), r.name, r.namespace ?? null), r.namespace ?? "", ui.chips(r.conditions)]);
  const headers = ["kind", "name", "namespace", "conditions"].map((h) => t(`components.${h}`));
  return [
    blocks.block("components", t("components.title"), [
      rows.length > 0 ? ui.table(headers, rows, { label: t("components.title"), id: "operatorComponents", sextant, nowrap: [true, false, true, false] }) : remark(t("noComponents")),
      total > refs.length ? remark(t("moreComponents", { shown: refs.length, total, max: MAX_COMPONENTS })) : null,
    ]),
  ];
}

export function clusterExtensionView(sextant: Sextant, obj: KubeObject): Node[] {
  const info = extensionInfo(obj);
  const progressing = conditionText(obj, "Progressing");
  return present([
    progressing?.tone === "warning" && progressing.title ? note(progressing.title, "warning") : null,
    fieldsOf([
      ["installedCondition", condition(obj, "Installed")],
      ["progressing", condition(obj, "Progressing")],
      ["package", info.packageName],
      ["versionRange", info.version],
      ["channels", ui.chips(info.channels)],
      ["upgradeConstraintPolicy", info.upgradeConstraintPolicy],
      ["installNamespace", link(sextant, NAMESPACE, info.namespace)],
      ["serviceAccount", link(sextant, SERVICE_ACCOUNT, info.serviceAccount, info.namespace ?? null)],
      ["installedBundle", info.installedBundle],
      ["installedVersion", info.installedVersion],
    ]),
  ]);
}

export function clusterCatalogView(obj: KubeObject): Node[] {
  const info = catalogV1Info(obj);
  return present([
    fieldsOf([
      ["serving", condition(obj, "Serving")],
      ["progressing", condition(obj, "Progressing")],
      ["sourceType", info.sourceType],
      ["image", info.image],
      ["resolvedImage", info.resolvedImage],
      ["pollIntervalMinutes", info.pollIntervalMinutes?.toString()],
      ["priority", info.priority?.toString()],
      ["availabilityMode", info.availabilityMode],
      ["baseUrl", info.baseUrl],
      ["lastUnpacked", dateTime(info.lastUnpacked)],
    ]),
  ]);
}
