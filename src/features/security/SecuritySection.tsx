// "Security" section of the details panel (#143) for Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs
// and CronJobs: the posture against the Pod Security Standards, the namespace's Pod Security labels compared with
// this object and its findings with a fix to copy. Watched only while the panel shows it: the namespace by name, the
// object's live Pods (a Deployment's through its ReplicaSets). A workload's Trivy reports ("Image scans (Trivy)") are
// the `scans` section of Sextant's own extension `extensions/trivy`.
import { Block } from "../details/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { Badge } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { FindingList, LevelCounts, ModeComparisons, POSTURE_TONE } from "./components";
import { findingsOf, inNamespaces, NAMESPACE, POD, REPLICASET } from "./hooks";
import { psaLabels } from "./namespaces";
import { admittedFindings, POD_SPEC_KINDS, postureOf } from "./pss";
import "./security.css";

export function securityApplies(kind: KindRef): boolean {
  return (kind.group === "" || kind.group === "apps" || kind.group === "batch") && POD_SPEC_KINDS.has(kind.kind) && kind.kind !== "ReplicationController";
}

/** `k=v,…` of a workload's `spec.selector.matchLabels`; `null` without any. */
function selectorOf(obj: KubeObject): string | null {
  const labels = status.get(obj, "spec", "selector", "matchLabels");
  if (typeof labels !== "object" || labels === null) return null;
  const pairs = Object.entries(labels as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  return pairs.length > 0 ? pairs.map(([k, v]) => `${k}=${v}`).join(",") : null;
}

/** Kinds whose live Pods are compared with their template here (a CronJob's Pods belong to Jobs that come and go). */
const POD_OWNERS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

/** The Pods of `obj` among `pods` (by their controller; a Deployment's through its ReplicaSets). */
export function podsOf(kind: string, obj: KubeObject, replicaSets: readonly KubeObject[], pods: Iterable<KubeObject>): KubeObject[] {
  const name = obj.metadata?.name;
  if (!name) return [];
  const isOwn = (o: KubeObject, ownerKind: string, owners: ReadonlySet<string>) => {
    const c = status.controllerOf(o);
    return !!c && c.kind === ownerKind && owners.has(c.name);
  };
  const [podOwner, owners] =
    kind === "Deployment"
      ? ["ReplicaSet", new Set(replicaSets.filter((rs) => isOwn(rs, "Deployment", new Set([name]))).map((rs) => rs.metadata?.name ?? ""))]
      : [kind, new Set([name])];
  return [...pods].filter((p) => !p.metadata?.deletionTimestamp && isOwn(p, podOwner, owners));
}

function SecuritySectionBody({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const kind = objectRef.kind.kind;
  const namespace = objectRef.namespace ?? "";
  const nsSpec: WatchSpec | null = namespace
    ? { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: `metadata.name=${namespace}` }
    : null;
  const nsWatch = useWatch(clusterId, nsSpec);
  const nsObject = useMemo(() => [...nsWatch.items.values()][0], [nsWatch.items]);
  // Its live Pods (by its selector, in its namespace; a Deployment's through its ReplicaSets): what admission added.
  const withPods = obj && namespace && POD_OWNERS.has(kind) ? selectorOf(obj) : null;
  const rsWatch = useWatch(clusterId, withPods && kind === "Deployment" ? inNamespaces(REPLICASET, [namespace], withPods) : null);
  const podWatch = useWatch(clusterId, withPods ? inNamespaces(POD, [namespace], withPods) : null);
  const replicaSets = useMemo(() => [...rsWatch.items.values()], [rsWatch.items]);
  const findings = useMemo(() => {
    if (!obj) return [];
    const own = findingsOf(kind, obj);
    const pods = podsOf(kind, obj, replicaSets, podWatch.items.values());
    return [...own, ...admittedFindings(own, pods.map((p) => ({ name: p.metadata?.name ?? "", findings: findingsOf("Pod", p) })))];
  }, [kind, obj, replicaSets, podWatch.items]);

  if (!obj) return null;
  const posture = postureOf(findings);
  const violations = findings.filter((f) => f.level !== "hint");
  const hints = findings.filter((f) => f.level === "hint");
  const owner = status.controllerOf(obj);
  return (
    <section className="sec-section" aria-label={t("security:details.title")}>
      <p className="sec-section__posture">
        <Badge tone={POSTURE_TONE[posture]}>{t(`security:posture.${posture}`)}</Badge>
        <span>{t(`security:postureText.${posture}`)}</span>
        <LevelCounts findings={findings} />
      </p>
      {kind === "Pod" && owner && (
        <p className="sec-note">{t("security:details.ownedPod", { kind: owner.kind, name: owner.name })}</p>
      )}
      {namespace && (
        <ModeComparisons
          labels={nsWatch.status === "ready" && nsObject ? psaLabels(nsObject) : undefined}
          judged={[{ kind, obj, findings }]}
        />
      )}
      {violations.length > 0 && <FindingList findings={violations} />}
      {hints.length > 0 && (
        <details className="sec-hints">
          <summary>{t("security:details.hints", { count: hints.length })}</summary>
          <p className="sec-note">{t("security:details.hintsNote")}</p>
          <FindingList findings={hints} />
        </details>
      )}
      {findings.length === 0 && <p className="sec-note">{t("security:details.noFindings")}</p>}
    </section>
  );
}

export function SecuritySection(props: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!props.obj) return null;
  return <Block id="security:details.title" title={t("security:details.title")}><SecuritySectionBody {...props} /></Block>;
}
