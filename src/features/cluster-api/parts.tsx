// Pieces the Cluster API details share: links to referenced objects at the version the cluster serves, what those
// objects say of themselves, the workload cluster's buttons and the plain-language notes.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, ObjectRef } from "../../api";
import { Button } from "../../components";
import { formatDateTime } from "../../i18n";
import { findKind, StatusText, useClusterKinds } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { selectCluster, useClustersStore } from "../clusters/clustersStore";
import { link } from "../details";
import { openInCluster } from "../fleet/store";
import { refKey, type Fetched } from "./hooks";
import { providerFailureOf, providerReady, serverMatches, type CapiRef, type Endpoint } from "./model";

export const LABELS = "clusterapi:fields";

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** A link to the object a reference names, at the version the cluster serves. */
export function useRefLink(clusterId: ClusterId): (ref: CapiRef | undefined, label?: string) => ReactNode {
  const kinds = useClusterKinds(clusterId);
  return (ref, label) => {
    if (!ref) return null;
    const served = kinds.kinds ? findKind(kinds.kinds, ref)?.kindRef : undefined;
    const apiVersion = served ? apiVersionOf(served) : `${ref.group}/${ref.version ?? "v1beta2"}`;
    return link({ apiVersion, kind: ref.kind }, ref.name, ref.namespace, label ?? `${ref.kind}/${ref.name}`);
  };
}

/** What a referenced object says of itself: ready, not ready, missing, unreadable, not served. */
export function RefStatus({ fetched }: { fetched: Fetched | undefined }) {
  const { t } = useTranslation();
  if (!fetched) return null;
  if ("notServed" in fetched) return <span className="cm-chain__extra">{t("clusterapi:ref.notServed")}</span>;
  if ("error" in fetched)
    return fetched.error.code === "notFound" ? (
      <StatusText value={t("clusterapi:ref.missing")} tone="danger" />
    ) : (
      <span className="cm-chain__extra">{t("clusterapi:ref.unreadable")}</span>
    );
  const ready = providerReady(fetched.obj);
  if (ready === undefined) return <StatusText value={t("clusterapi:ref.unknown")} tone="muted" />;
  return ready ? <StatusText value={t("clusterapi:ref.ready")} tone="success" /> : <StatusText value={t("clusterapi:ref.notReady")} tone="warning" />;
}

/** A reference as a field value: the link, what the object says, and its terminal error when it has one. */
export function RefValue({ ref, fetched, linkTo }: { ref: CapiRef | undefined; fetched: Fetched | undefined; linkTo: (ref: CapiRef) => ReactNode }) {
  if (!ref) return null;
  const failure = fetched && "obj" in fetched ? providerFailureOf(fetched.obj) : undefined;
  return (
    <span className="cm-chain__row">
      {linkTo(ref)}
      <RefStatus fetched={fetched} />
      {failure && <span className="cm-chain__extra">{failure}</span>}
    </span>
  );
}

export const fetchedOf = (byKey: Map<string, Fetched>, ref: CapiRef | undefined) => (ref ? byKey.get(refKey(ref)) : undefined);

/**
 * The configured clusters whose API server is `endpoint`, each with a button: "Open cluster …", or, with `node`,
 * "Open Node … in …". A click connects that cluster when it is not connected (never before); nothing matching is said
 * in words.
 */
export function WorkloadClusters({ endpoint, node }: { endpoint: Endpoint | undefined; node?: string }) {
  const { t } = useTranslation();
  const clusters = useClustersStore((s) => s.clusters);
  if (!endpoint) return null;
  const address = `${endpoint.host}:${endpoint.port}`;
  const matching = clusters.filter((c) => serverMatches(c.server, endpoint));
  if (matching.length === 0) return <span className="cm-chain__extra">{t("clusterapi:workload.none", { address })}</span>;
  const nodeRef: ObjectRef | null = node ? { kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: node } : null;
  return (
    <span className="capi-actions">
      {matching.map((c) => (
        <Button key={c.id} size="compact" onClick={() => (nodeRef ? openInCluster(c.id, nodeRef) : selectCluster(c.id))}>
          {nodeRef ? t("clusterapi:workload.openNode", { node, context: c.context }) : t("clusterapi:workload.open", { context: c.context })}
        </Button>
      ))}
    </span>
  );
}

/** A plain-language note on the object's state; `danger` for failures. */
export function Explain({ text, danger }: { text: string | undefined; danger?: boolean }) {
  if (!text) return null;
  return <p className={danger ? "cm-explain cm-explain--danger" : "cm-explain"}>{text}</p>;
}

/** The message from the cluster that explains a failure, shown under the note. */
export function Message({ text }: { text: string | undefined }) {
  return text ? <p className="cm-message capi-message">{text}</p> : null;
}
