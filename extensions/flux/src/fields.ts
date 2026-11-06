// The "Flux" section of every Flux object's details: Ready with its reason and message, the revision, interval and
// timeout, the source and HelmChart as links, the kind's own fields (URL, reference, path, chart, image, provider, …)
// and the last reconcile request — the fields Sextant's built-in Flux view showed. A field without a value is left
// out. The object is read again whenever Sextant says it changed (the context's `resourceVersion`).
import type { KubeObject, ObjectRef, Sextant } from "@sextant/extension-sdk";
import { badge, element, errorBox, muted, objectLink } from "./dom";
import {
  arr,
  get,
  helmChartOf,
  HELM_GROUP,
  IMAGE_GROUP,
  isKind,
  isSuspended,
  KUSTOMIZE_GROUP,
  localRef,
  NOTIFICATION_GROUP,
  readyMessage,
  readyReason,
  readyStatus,
  readyTone,
  revisionOf,
  sourceRefOf,
  str,
  text,
  type FluxRef,
} from "./flux";
import { t } from "./i18n";

type Value = Node | string | null | undefined;

/** `spec.ref` of a GitRepository / OCIRepository: "branch master", "tag v1.2.3", "semver 6.x", … */
export function sourceRevisionRef(obj: KubeObject): string | undefined {
  const ref = get(obj, "spec", "ref");
  const parts = ["branch", "tag", "semver", "semverFilter", "commit", "name", "digest"]
    .map((key) => (str(get(ref, key)) ? `${key} ${str(get(ref, key))}` : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** HelmRelease `spec.chart.spec` or HelmChart `spec`: "podinfo 6.x". */
export function chartText(obj: KubeObject): string | undefined {
  const spec = get(obj, "spec", "chart", "spec") ?? (typeof get(obj, "spec", "chart") === "string" ? get(obj, "spec") : undefined);
  const chart = str(get(spec, "chart"));
  if (!chart) return undefined;
  const version = str(get(spec, "version"));
  return version ? `${chart} ${version}` : chart;
}

const link = (sextant: Sextant, ref: FluxRef | undefined, label?: string): Value => (ref ? objectLink(sextant, ref, label) : null);

/** Links separated by commas. */
function links(sextant: Sextant, refs: FluxRef[]): Value {
  if (refs.length === 0) return null;
  const span = element("span", { className: "links" });
  refs.forEach((r, i) => {
    if (i > 0) span.append(", ");
    span.append(objectLink(sextant, r));
  });
  return span;
}

function chips(values: string[]): Value {
  if (values.length === 0) return null;
  return element("span", { className: "chips" }, ...values.map((v) => element("span", { className: "chip", textContent: v })));
}

/** The rows of the section, by the key of their label (`fields.<key>`), in order; a row without a value is left out. */
export function fieldRows(sextant: Sextant, obj: KubeObject): [string, Node | string][] {
  const ready = readyStatus(obj);
  const reason = readyReason(obj);
  const revision = revisionOf(obj);
  const attempted = str(get(obj, "status", "lastAttemptedRevision"));
  const kustomization = isKind(obj, KUSTOMIZE_GROUP, "Kustomization");
  const release = isKind(obj, HELM_GROUP, "HelmRelease");
  const alert = isKind(obj, NOTIFICATION_GROUP, "Alert");
  const provider = isKind(obj, NOTIFICATION_GROUP, "Provider");
  const receiver = isKind(obj, NOTIFICATION_GROUP, "Receiver");
  const source = sourceRefOf(obj);
  const dependsOn = (group: string, kind: string) =>
    links(
      sextant,
      arr(get(obj, "spec", "dependsOn"))
        .map((d) => localRef(obj, group, kind, d))
        .filter((r): r is FluxRef => r !== undefined),
    );
  const rows: [string, Value][] = [
    ["ready", ready ? element("span", {}, badge(ready, readyTone(ready)), reason ? ` ${reason}` : null) : null],
    ["message", readyMessage(obj)],
    ["revision", revision],
    ["lastAttemptedRevision", attempted && attempted !== revision ? attempted : null],
    ["suspended", isSuspended(obj) ? t("suspended.yes") : null],
    ["interval", str(get(obj, "spec", "interval"))],
    ["timeout", str(get(obj, "spec", "timeout"))],
    ["source", link(sextant, source, source && `${source.kind} ${source.name}`)],
    ["chart", chartText(obj)],
    ["helmChart", link(sextant, helmChartOf(obj))],
    ["url", str(get(obj, "spec", "url"))],
    ["ref", sourceRevisionRef(obj)],
    ["endpoint", str(get(obj, "spec", "endpoint"))],
    ["bucketName", str(get(obj, "spec", "bucketName"))],
    ["path", str(get(obj, "spec", "path"))],
    ["targetNamespace", str(get(obj, "spec", "targetNamespace"))],
    ["releaseName", release ? str(get(obj, "spec", "releaseName")) : null],
    ["prune", kustomization ? text(get(obj, "spec", "prune")) : null],
    ["dependsOn", kustomization ? dependsOn(KUSTOMIZE_GROUP, "Kustomization") : release ? dependsOn(HELM_GROUP, "HelmRelease") : null],
    ["image", isKind(obj, IMAGE_GROUP, "ImageRepository") ? str(get(obj, "spec", "image")) : null],
    [
      "imageRepository",
      isKind(obj, IMAGE_GROUP, "ImagePolicy") ? link(sextant, localRef(obj, IMAGE_GROUP, "ImageRepository", get(obj, "spec", "imageRepositoryRef"))) : null,
    ],
    ["provider", alert ? link(sextant, localRef(obj, NOTIFICATION_GROUP, "Provider", get(obj, "spec", "providerRef"))) : null],
    ["eventSeverity", alert ? str(get(obj, "spec", "eventSeverity")) : null],
    [
      "eventSources",
      alert ? chips(arr(get(obj, "spec", "eventSources")).map((s) => `${str(get(s, "kind")) ?? ""}/${str(get(s, "name")) ?? ""}`)) : null,
    ],
    ["type", provider || receiver ? str(get(obj, "spec", "type")) : null],
    ["channel", provider ? str(get(obj, "spec", "channel")) : null],
    ["webhookPath", receiver ? str(get(obj, "status", "webhookPath")) : null],
    ["lastHandledReconcileAt", str(get(obj, "status", "lastHandledReconcileAt"))],
  ];
  return rows.filter((row): row is [string, Node | string] => row[1] !== null && row[1] !== undefined && row[1] !== "");
}

export function fieldsView(sextant: Sextant, obj: KubeObject): HTMLElement {
  const rows = fieldRows(sextant, obj);
  return element(
    "dl",
    {},
    ...rows.flatMap(([key, value]) => [element("dt", { textContent: t(`fields.${key}`) }), element("dd", {}, value)]),
  );
}

/** Shows the fields of the object in the context, read again after every change of it. */
export function startFields(sextant: Sextant, root: HTMLElement): () => void {
  return followObject(sextant, root, (obj) => root.replaceChildren(fieldsView(sextant, obj)));
}

/**
 * Reads the object in the context, and again whenever its `resourceVersion` in the context changes; `show` draws it.
 * Returns the function that stops following it.
 */
export function followObject(sextant: Sextant, root: HTMLElement, show: (obj: KubeObject, ref: ObjectRef) => void): () => void {
  const ref: ObjectRef | undefined = sextant.context.selection[0];
  if (!ref) {
    root.replaceChildren(muted(t("common.nothingSelected")));
    return () => undefined;
  }
  root.replaceChildren(muted(t("common.loading")));
  let stopped = false;
  let shown: string | null | undefined;
  const follow = () => {
    if (sextant.context.resourceVersion === shown) return;
    shown = sextant.context.resourceVersion;
    void sextant.resources
      .get({ ref })
      .then((obj) => {
        if (!stopped) show(obj, ref);
      })
      .catch((err: unknown) => {
        if (!stopped) root.replaceChildren(errorBox(err));
      });
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    stopFollow();
  };
}
