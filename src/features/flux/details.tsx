// Details of Flux objects. The kind's own fields (`FluxFields`: Ready, revision, interval, the source as a link, …)
// go into the panel's "fields" section; `FluxRelatedSection` (a section of its own, it needs the cluster) lists
// what a Kustomization or HelmRelease created and which Kustomizations and HelmReleases use a source. Conditions are
// the panel's own section.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ApiError, type ClusterId, type KindRef, type KubeObject, type ObjectRef, type WatchSpec } from "../../api";
import { formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ErrorState } from "../../components";
import { findKind, kindFromApiVersion, ObjectLink, status, StatusText, useClusterKinds } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { Block, chips, Fields, type FieldRow } from "../details";
import {
  ALERT,
  fluxKind,
  helmChartOf,
  helmReleaseSelector,
  HELM_RELEASE,
  IMAGE_POLICY,
  IMAGE_REPOSITORY,
  inventoryOf,
  isKind,
  isSuspended,
  KUSTOMIZATION,
  PROVIDER,
  readyMessage,
  readyReason,
  readyStatus,
  readyTone,
  RECEIVER,
  revisionOf,
  sourceRefOf,
  usesSource,
  type FluxRef,
} from "./model";
import { ResizableTable } from "../../components/Table";

const { arr, get, str } = status;

const text = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;

function refLink(ref: FluxRef | undefined, label?: string): ReactNode {
  if (!ref) return null;
  return (
    <ObjectLink target={{ apiVersion: ref.apiVersion, kind: ref.kind, name: ref.name }} namespace={ref.namespace}>
      {label ?? ref.name}
    </ObjectLink>
  );
}

/** A reference by name to an object of `kind` in the namespace of `obj` (`providerRef`, `imageRepositoryRef`). */
function localRef(obj: KubeObject, kind: KindRef, field: unknown): FluxRef | undefined {
  const name = str(get(field, "name"));
  if (!name) return undefined;
  return {
    apiVersion: apiVersionOf(kind),
    kind: kind.kind,
    name,
    namespace: str(get(field, "namespace")) ?? obj.metadata?.namespace ?? null,
  };
}

/** `spec.ref` of a GitRepository / OCIRepository: "branch master", "tag v1.2.3", "semver 6.x", … */
function sourceRevisionRef(obj: KubeObject): string | undefined {
  const ref = get(obj, "spec", "ref");
  const parts = ["branch", "tag", "semver", "semverFilter", "commit", "name", "digest"]
    .map((key) => (str(get(ref, key)) ? `${key} ${str(get(ref, key))}` : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** HelmRelease `spec.chart.spec` or HelmChart `spec`: "podinfo 6.x". */
function chartText(obj: KubeObject): string | undefined {
  const spec =
    get(obj, "spec", "chart", "spec") ?? (typeof get(obj, "spec", "chart") === "string" ? get(obj, "spec") : undefined);
  const chart = str(get(spec, "chart"));
  if (!chart) return undefined;
  const version = str(get(spec, "version"));
  return version ? `${chart} ${version}` : chart;
}

/** `spec.dependsOn` of a Kustomization or HelmRelease, as links to objects of the same kind. */
function dependsOn(obj: KubeObject, kind: KindRef): ReactNode {
  const links = arr(get(obj, "spec", "dependsOn"))
    .map((d) => localRef(obj, kind, d))
    .filter((r): r is FluxRef => Boolean(r))
    .map((r) => <span key={`${r.namespace ?? ""}/${r.name}`}>{refLink(r)}</span>);
  return links.length > 0 ? <span className="dt-links">{links}</span> : null;
}

/** Labels of the fields: `flux:fields.*`. */
const FIELD_LABELS = "flux:fields";

/** The kind's own fields of any Flux object (the panel's "fields" section). */
export function FluxFields({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const kind = kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
  const ready = readyStatus(obj);
  const reason = readyReason(obj);
  const revision = revisionOf(obj);
  const attempted = str(get(obj, "status", "lastAttemptedRevision"));
  const kustomization = isKind(kind, KUSTOMIZATION);
  const release = isKind(kind, HELM_RELEASE);
  const rows: FieldRow[] = [
    [
      "ready",
      ready ? (
        <>
          <StatusText value={ready} tone={readyTone(ready)} /> {reason}
        </>
      ) : null,
    ],
    ["message", readyMessage(obj)],
    ["revision", revision],
    ["lastAttemptedRevision", attempted && attempted !== revision ? attempted : null],
    ["suspended", isSuspended(obj) ? t("flux:suspended.yes") : null],
    ["interval", str(get(obj, "spec", "interval"))],
    ["timeout", str(get(obj, "spec", "timeout"))],
    ["source", refLink(sourceRefOf(obj), sourceRefOf(obj) && `${sourceRefOf(obj)?.kind} ${sourceRefOf(obj)?.name}`)],
    ["chart", chartText(obj)],
    ["helmChart", refLink(helmChartOf(obj))],
    ["url", str(get(obj, "spec", "url"))],
    ["ref", sourceRevisionRef(obj)],
    ["endpoint", str(get(obj, "spec", "endpoint"))],
    ["bucketName", str(get(obj, "spec", "bucketName"))],
    ["path", str(get(obj, "spec", "path"))],
    ["targetNamespace", str(get(obj, "spec", "targetNamespace"))],
    ["releaseName", release ? str(get(obj, "spec", "releaseName")) : null],
    ["prune", kustomization ? text(get(obj, "spec", "prune")) : null],
    ["dependsOn", kustomization || release ? dependsOn(obj, kustomization ? KUSTOMIZATION : HELM_RELEASE) : null],
    ["image", isKind(kind, IMAGE_REPOSITORY) ? str(get(obj, "spec", "image")) : null],
    [
      "imageRepository",
      isKind(kind, IMAGE_POLICY)
        ? refLink(localRef(obj, IMAGE_REPOSITORY, get(obj, "spec", "imageRepositoryRef")))
        : null,
    ],
    ["provider", isKind(kind, ALERT) ? refLink(localRef(obj, PROVIDER, get(obj, "spec", "providerRef"))) : null],
    ["eventSeverity", isKind(kind, ALERT) ? str(get(obj, "spec", "eventSeverity")) : null],
    [
      "eventSources",
      isKind(kind, ALERT)
        ? chips(
            arr(get(obj, "spec", "eventSources")).map(
              (s) => `${str(get(s, "kind")) ?? ""}/${str(get(s, "name")) ?? ""}`,
            ),
          )
        : null,
    ],
    ["type", isKind(kind, PROVIDER, RECEIVER) ? str(get(obj, "spec", "type")) : null],
    ["channel", isKind(kind, PROVIDER) ? str(get(obj, "spec", "channel")) : null],
    ["webhookPath", isKind(kind, RECEIVER) ? str(get(obj, "status", "webhookPath")) : null],
    ["lastHandledReconcileAt", str(get(obj, "status", "lastHandledReconcileAt"))],
  ];
  return <Fields rows={rows} labelPrefix={FIELD_LABELS} />;
}

// ---------- Related objects ----------

/** Whether the related section has something to show for `kind`. */
export function hasRelated(kind: Pick<KindRef, "group" | "kind">): boolean {
  return isKind(kind, KUSTOMIZATION, HELM_RELEASE) || Boolean(fluxKind(kind)?.source);
}

/**
 * The version to watch `kind` in: the one the cluster prefers; the registered one when discovery failed; `null`
 * when the cluster does not serve the kind (no such controller installed); `undefined` while discovery is coming.
 */
function useServedKind(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const { kinds, error } = useClusterKinds(clusterId);
  if (kinds) return findKind(kinds, kind)?.kindRef ?? null;
  return error ? kind : undefined;
}

/** The line a block shows while one of its lists is loading. */
function LoadingLine() {
  const { t } = useTranslation();
  return (
    <p className="dt-muted" role="status">
      {t("flux:related.loading")}
    </p>
  );
}

function everywhere(kind: KindRef | null): WatchSpec | null {
  return kind ? { kind, namespaces: null, labelSelector: null, fieldSelector: null } : null;
}

const refKey = (r: ObjectRef) => `${r.kind.group}/${r.kind.kind}/${r.namespace ?? ""}/${r.name}`;

/** The object as a reference; `fallback` stands in for an `apiVersion`/`kind` it came without. */
function objectRefOf(obj: KubeObject, fallback: KindRef): ObjectRef {
  const kind = obj.apiVersion && obj.kind ? kindFromApiVersion(obj.apiVersion, obj.kind) : fallback;
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

function RefRow({ objectRef }: { objectRef: ObjectRef }) {
  return (
    <tr>
      <td>{objectRef.kind.kind}</td>
      <td>
        <ObjectLink
          target={{ apiVersion: apiVersionOf(objectRef.kind), kind: objectRef.kind.kind, name: objectRef.name }}
          namespace={objectRef.namespace}
        >
          {objectRef.name}
        </ObjectLink>
      </td>
      <td>{objectRef.namespace}</td>
    </tr>
  );
}

function RefTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ResizableTable tableId="flux.details" className="dt-table">
      <thead>
        <tr>
          <th>{t("flux:related.kind")}</th>
          <th>{t("flux:related.name")}</th>
          <th>{t("flux:related.namespace")}</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </ResizableTable>
  );
}

/** Kinds a Helm chart usually creates; helm-controller labels them with the HelmRelease's name and namespace. */
const LABELLED_KINDS: KindRef[] = [
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "batch", version: "v1", kind: "CronJob" },
  { group: "", version: "v1", kind: "Service" },
  { group: "", version: "v1", kind: "ConfigMap" },
  { group: "", version: "v1", kind: "Secret" },
  { group: "", version: "v1", kind: "ServiceAccount" },
  { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
];

/**
 * Where a HelmRelease's objects are: its target namespace (`spec.targetNamespace`, else its own), and its storage
 * namespace when that differs. `null` (every namespace) only for an object without a namespace.
 */
export function helmReleaseNamespaces(obj: KubeObject): string[] | null {
  const own = obj.metadata?.namespace;
  if (!own) return null;
  const target = str(get(obj, "spec", "targetNamespace")) ?? own;
  const storage = str(get(obj, "spec", "storageNamespace")) ?? str(get(obj, "status", "storageNamespace")) ?? own;
  return target === storage ? [target] : [target, storage];
}

/** How the list of one labelled kind ended: its error, and the namespaces it may not list. */
interface KindLoaded {
  error: ApiError | null;
  forbiddenIn: readonly string[];
}

const sameLoaded = (a: KindLoaded | undefined, b: KindLoaded) =>
  a !== undefined && a.error === b.error && a.forbiddenIn.join(",") === b.forbiddenIn.join(",");

/**
 * Rows of the objects of `kind` with the HelmRelease's labels in `namespaces`, except those in `known` (from the
 * inventory); `onLoaded(kind)` once its list has come (or failed).
 */
function LabelledRows({
  clusterId,
  kind,
  selector,
  namespaces,
  known,
  onLoaded,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  selector: string;
  namespaces: string[] | null;
  known: Set<string>;
  onLoaded: (kind: string, loaded: KindLoaded) => void;
}) {
  // Only names are needed: metadata, nothing of a Secret.
  const spec: WatchSpec = { kind, namespaces, labelSelector: selector, fieldSelector: null, metadataOnly: true };
  const { items, status: watchStatus, error, forbidden } = useWatch(clusterId, spec);
  const loaded = watchStatus !== "loading";
  const failure = watchStatus === "error" ? (error ?? null) : null;
  const forbiddenKey = (forbidden ?? []).join(",");
  useEffect(() => {
    if (loaded) onLoaded(kind.kind, { error: failure, forbiddenIn: forbiddenKey ? forbiddenKey.split(",") : [] });
  }, [loaded, failure, forbiddenKey, kind.kind, onLoaded]);
  const refs = [...items.values()]
    .map((o) => objectRefOf(o, kind))
    .filter((r) => !known.has(refKey(r)))
    .sort((a, b) => refKey(a).localeCompare(refKey(b)));
  return (
    <>
      {refs.map((r) => (
        <RefRow key={refKey(r)} objectRef={r} />
      ))}
    </>
  );
}

/** Each retry ("Retry" after an error) starts the lists again. */
function HelmReleaseResources({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <HelmReleaseResourcesView
      key={attempt}
      clusterId={clusterId}
      obj={obj}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

function HelmReleaseResourcesView({
  clusterId,
  obj,
  onRetry,
}: {
  clusterId: ClusterId;
  obj: KubeObject;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const inventory = inventoryOf(obj);
  const known = new Set(inventory.map(refKey));
  const selector = helmReleaseSelector(obj);
  const namespaces = helmReleaseNamespaces(obj);
  // The kinds whose list has come, with how it ended.
  const [loaded, setLoaded] = useState<ReadonlyMap<string, KindLoaded>>(() => new Map());
  const onLoaded = useCallback(
    (kind: string, result: KindLoaded) =>
      setLoaded((prev) => (sameLoaded(prev.get(kind), result) ? prev : new Map(prev).set(kind, result))),
    [],
  );
  // A kind the user may not list is only that kind missing: the other kinds stay. Any other failure (the cluster
  // cannot be reached, …) is shown with Retry.
  const results = LABELLED_KINDS.flatMap((kind) => {
    const result = loaded.get(kind.kind);
    return result ? [{ kind: kind.kind, ...result }] : [];
  });
  const notAllowed = results.filter((r) => r.error?.code === "forbidden").map((r) => r.kind);
  const partly = results
    .filter((r) => r.error === null && r.forbiddenIn.length > 0)
    .map((r) => `${r.kind}: ${t("resources:table.forbiddenIn", { namespaces: r.forbiddenIn.join(", ") })}`);
  const unavailable = [
    ...(notAllowed.length > 0 ? [t("resources:table.forbidden", { kind: formatList(notAllowed) })] : []),
    ...partly,
  ];
  const failure = results.find((r) => r.error !== null && r.error.code !== "forbidden")?.error;
  return (
    <Block title={t("flux:related.resources")}>
      <RefTable>
        {inventory.map((r) => (
          <RefRow key={refKey(r)} objectRef={r} />
        ))}
        {LABELLED_KINDS.map((kind) => (
          <LabelledRows
            key={kind.kind}
            clusterId={clusterId}
            kind={kind}
            selector={selector}
            namespaces={namespaces}
            known={known}
            onLoaded={onLoaded}
          />
        ))}
      </RefTable>
      {unavailable.map((line) => (
        <p key={line} className="dt-muted">
          {line}
        </p>
      ))}
      {failure ? (
        <ErrorState error={failure} onRetry={onRetry} />
      ) : (
        loaded.size < LABELLED_KINDS.length && <LoadingLine />
      )}
    </Block>
  );
}

/** Kustomizations and HelmReleases (in any namespace) that take their artifact from `source`; Retry lists again. */
function UsedBy({ clusterId, source }: { clusterId: ClusterId; source: KubeObject }) {
  const [attempt, setAttempt] = useState(0);
  return <UsedByView key={attempt} clusterId={clusterId} source={source} onRetry={() => setAttempt((n) => n + 1)} />;
}

function UsedByView({ clusterId, source, onRetry }: { clusterId: ClusterId; source: KubeObject; onRetry: () => void }) {
  const { t } = useTranslation();
  const kustomization = useServedKind(clusterId, KUSTOMIZATION);
  const release = useServedKind(clusterId, HELM_RELEASE);
  const kustomizations = useWatch(clusterId, everywhere(kustomization ?? null));
  const releases = useWatch(clusterId, everywhere(release ?? null));
  const loading = (
    [
      [kustomization, kustomizations.status],
      [release, releases.status],
    ] as const
  ).some(([kind, watchStatus]) => kind === undefined || (kind !== null && watchStatus === "loading"));
  const failed = [kustomizations, releases].find((list) => list.status === "error");
  const using = [
    ...[...kustomizations.items.values()]
      .filter((o) => usesSource(o, source))
      .map((o) => objectRefOf(o, KUSTOMIZATION)),
    ...[...releases.items.values()].filter((o) => usesSource(o, source)).map((o) => objectRefOf(o, HELM_RELEASE)),
  ].sort((a, b) => refKey(a).localeCompare(refKey(b)));
  return (
    <Block title={t("flux:related.usedBy")}>
      {using.length > 0 && (
        <RefTable>
          {using.map((r) => (
            <RefRow key={refKey(r)} objectRef={r} />
          ))}
        </RefTable>
      )}
      {failed ? (
        <ErrorState error={failed.error} onRetry={onRetry} />
      ) : loading ? (
        <LoadingLine />
      ) : (
        using.length === 0 && <p className="dt-muted">{t("flux:related.notUsed")}</p>
      )}
    </Block>
  );
}

export function FluxRelatedSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  if (isKind(objectRef.kind, KUSTOMIZATION)) {
    const inventory = inventoryOf(obj);
    if (inventory.length === 0) return null;
    return (
      <Block title={t("flux:related.inventory")}>
        <RefTable>
          {inventory.map((r) => (
            <RefRow key={refKey(r)} objectRef={r} />
          ))}
        </RefTable>
      </Block>
    );
  }
  if (isKind(objectRef.kind, HELM_RELEASE)) {
    // Another release starts over (its lists load again).
    return <HelmReleaseResources key={helmReleaseSelector(obj)} clusterId={clusterId} obj={obj} />;
  }
  return <UsedBy clusterId={clusterId} source={obj} />;
}
