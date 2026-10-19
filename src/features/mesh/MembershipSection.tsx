// The "Service mesh" details section of Pods and workloads (#155): whether it is in the Istio or Linkerd mesh (and
// how: sidecar, native sidecar, ambient; revision; injection), its Istio mTLS mode by PeerAuthentication precedence,
// and "Who may call this workload?" from AuthorizationPolicies. Shown only when the cluster serves Istio or Linkerd
// kinds, or the pod carries a proxy. The namespace is read with one field-selected watch; the policies come from the
// shared Istio configuration (store.ts).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { Block, Fields, type FieldRow } from "../details";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { findKind, StatusText, useClusterKinds } from "../../resources";
import type { Tone } from "../../resources/status";
import { SimpleTable } from "../gateway-api/details";
import { whoMayCall, type AuthzDecision, type Caller } from "./authz";
import { AUTHORIZATION_POLICY, LINKERD_SERVER, PEER_AUTHENTICATION, SERVICE_PROFILE, VIRTUAL_SERVICE } from "./kinds";
import { istioMembership, linkerdMembership, namespaceShape, podShape, type IstioMembership, type LinkerdMembership } from "./membership";
import { mtlsModeFor } from "./mtls";
import { useMeshConfig } from "./store";
import { meshLink, type T } from "./ui";

const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };
const FIELDS = "mesh:fields";

/** The kinds that get the section: pods and what owns a pod template. */
export function hasMeshSection(kind: KindRef): boolean {
  return (kind.group === "" && kind.kind === "Pod") || (kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(kind.kind));
}

const oneNamespace = (name: string | undefined): WatchSpec | null =>
  name ? { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: `metadata.name=${name}` } : null;

const DECISION_TONE: Record<AuthzDecision, Tone> = { allowed: "success", denied: "danger", unknown: "warning", external: "warning" };

function IstioBlock({ m, template, t }: { m: IstioMembership; template: boolean; t: T }) {
  const sentence = template
    ? m.injection
      ? "mesh:membership.istio.injectedPods"
      : m.mode === "ambient"
        ? "mesh:membership.istio.ambient"
        : "mesh:membership.istio.noInjection"
    : `mesh:membership.istio.${m.mode}`;
  const rows: FieldRow[] = [
    ["revision", m.revision],
    ["injection", m.injection && m.via ? t(`mesh:membership.via.${m.via}`) : null],
    ["proxyImage", m.proxyImage],
  ];
  return (
    <>
      <p className="mesh-line">{t(sentence)}</p>
      {m.optedOut && <p className="mesh-line">{t("mesh:membership.istio.optedOut")}</p>}
      {m.restartNeeded && <p className="mesh-line mesh-line--warning">{t("mesh:membership.istio.restart")}</p>}
      <Fields rows={rows} labelPrefix={FIELDS} />
    </>
  );
}

function LinkerdBlock({ clusterId, m, template, t }: { clusterId: ClusterId; m: LinkerdMembership; template: boolean; t: T }) {
  const on = m.inject === "enabled" || m.inject === "ingress";
  const sentence = template ? (on ? "mesh:membership.linkerd.injectedPods" : "mesh:membership.linkerd.noInjection") : `mesh:membership.linkerd.${m.mode}`;
  const meshed = m.mode !== "none" || (template && on);
  // Golden metrics need linkerd-viz: only its presence is checked (one Namespace by name).
  const viz = useWatch(clusterId, meshed ? oneNamespace("linkerd-viz") : null);
  const rows: FieldRow[] = [
    ["linkerdInject", m.inject ? t(`mesh:membership.injectOn.${m.via ?? "pod"}`, { value: m.inject }) : null],
    ["controlPlane", m.controlPlane],
    ["proxyVersion", m.proxyVersion],
  ];
  return (
    <>
      <p className="mesh-line">{t(sentence)}</p>
      {m.restartNeeded && <p className="mesh-line mesh-line--warning">{t("mesh:membership.linkerd.restart")}</p>}
      <Fields rows={rows} labelPrefix={FIELDS} />
      {meshed && viz.status === "ready" && viz.items.size > 0 && <p className="dt-muted">{t("mesh:membership.linkerd.goldenMetrics")}</p>}
    </>
  );
}

function MtlsBlock({ clusterId, namespace, labels, t }: { clusterId: ClusterId; namespace: string; labels: Record<string, string>; t: T }) {
  const config = useMeshConfig(clusterId);
  if (config.loading) return <p className="dt-muted">{t("mesh:loading")}</p>;
  const r = mtlsModeFor(namespace, labels, config.peerAuthentications);
  const rows: FieldRow[] = [["mtlsMode", r.mode]];
  return (
    <>
      <Fields rows={rows} labelPrefix={FIELDS} />
      <p className="mesh-line">{t(`mesh:mtls.meaning.${r.mode}`)}</p>
      <p className="mesh-line">
        {r.policy ? t(`mesh:mtls.source.${r.source}`, { name: r.policy.name }) : t("mesh:mtls.source.default")}{" "}
        {r.policy && meshLink(r.policy)}
      </p>
      {r.ports.length > 0 && (
        <SimpleTable
          headers={[t("mesh:columns.port"), t("mesh:columns.mtlsMode")]}
          rows={r.ports.map((p) => ({ key: `${p.port}`, cells: [p.port, p.mode] }))}
        />
      )}
    </>
  );
}

function CallerField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="gw-check__field">
      <span className="gw-check__label">{label}</span>
      <input type="text" value={value} spellCheck={false} autoComplete="off" placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function WhoMayCall({ clusterId, namespace, labels, t }: { clusterId: ClusterId; namespace: string; labels: Record<string, string>; t: T }) {
  const config = useMeshConfig(clusterId);
  const [form, setForm] = useState({ namespace: "", serviceAccount: "", method: "", path: "", port: "", ip: "", remoteIp: "" });
  const caller: Caller = useMemo(
    () => ({
      namespace: form.namespace.trim() || undefined,
      serviceAccount: form.serviceAccount.trim() || undefined,
      method: form.method.trim() || undefined,
      path: form.path.trim() || undefined,
      port: /^\d+$/.test(form.port.trim()) ? Number(form.port.trim()) : undefined,
      ip: form.ip.trim() || undefined,
      remoteIp: form.remoteIp.trim() || undefined,
    }),
    [form],
  );
  const result = useMemo(
    () => whoMayCall(namespace, labels, config.authorizationPolicies, caller),
    [namespace, labels, config.authorizationPolicies, caller],
  );
  if (config.loading) return <p className="dt-muted">{t("mesh:loading")}</p>;
  const set = (key: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [key]: v }));
  return (
    <>
      <p className="dt-muted">{t("mesh:authz.callerHint")}</p>
      <div className="mesh-caller">
        <CallerField label={t("mesh:authz.caller.namespace")} value={form.namespace} onChange={set("namespace")} />
        <CallerField label={t("mesh:authz.caller.serviceAccount")} value={form.serviceAccount} onChange={set("serviceAccount")} />
        <CallerField label={t("mesh:authz.caller.method")} value={form.method} onChange={set("method")} />
        <CallerField label={t("mesh:authz.caller.path")} value={form.path} onChange={set("path")} />
        <CallerField label={t("mesh:authz.caller.port")} value={form.port} onChange={set("port")} />
        <CallerField label={t("mesh:authz.caller.ip")} value={form.ip} onChange={set("ip")} />
        <CallerField label={t("mesh:authz.caller.remoteIp")} value={form.remoteIp} onChange={set("remoteIp")} />
      </div>
      <div className="mesh-decision" role="status">
        <StatusText value={t(`mesh:authz.decision.${result.decision}`)} tone={DECISION_TONE[result.decision]} />
        <span className="mesh-line">
          {t(`mesh:authz.reason.${result.reason}`, { name: result.by?.ref.name ?? "", rule: (result.by?.rule ?? 0) + 1 })}
        </span>
      </div>
      {result.verdicts.length > 0 && (
        <SimpleTable
          headers={[t("mesh:columns.policy"), t("mesh:columns.action"), t("mesh:columns.matches"), t("mesh:columns.notEvaluated")]}
          rows={result.verdicts.map((v) => ({
            key: `${v.ref.namespace}/${v.ref.name}`,
            cells: [
              meshLink(v.ref, undefined, namespace),
              v.dryRun ? t("mesh:authz.dryRunAction", { action: v.action }) : v.action,
              t(`mesh:authz.match.${v.match}`),
              v.unknown.join(", "),
            ],
          }))}
        />
      )}
      {result.notEvaluated.length > 0 && (
        <p className="dt-muted">
          {t("mesh:authz.targetRefSkipped")} <span className="dt-links">{result.notEvaluated.map((r) => meshLink(r, undefined, namespace))}</span>
        </p>
      )}
    </>
  );
}

export function MeshMembershipSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { kinds } = useClusterKinds(clusterId);
  const served = (k: KindRef) => !!kinds && !!findKind(kinds, k);
  const istioServed = served(PEER_AUTHENTICATION) || served(VIRTUAL_SERVICE);
  const linkerdServed = served(LINKERD_SERVER) || served(SERVICE_PROFILE);
  const template = objectRef.kind.kind !== "Pod";
  const pod = useMemo(() => (obj ? podShape(obj, template) : undefined), [obj, template]);
  const hasProxy = !!pod && [...pod.containers, ...pod.initContainers].some((c) => c.name === "istio-proxy" || c.name === "linkerd-proxy");
  const shown = !!pod && (istioServed || linkerdServed || hasProxy);
  const nsWatch = useWatch(clusterId, shown ? oneNamespace(obj?.metadata?.namespace) : null);
  const nsObj: KubeObject | undefined = [...nsWatch.items.values()][0];
  if (!shown || !pod) return null;
  const ns = namespaceShape(nsObj);
  const istio = istioMembership(pod, ns, template);
  const linkerd = linkerdMembership(pod, ns, template);
  const namespace = obj?.metadata?.namespace ?? "";
  const showIstio = istioServed || istio.mode !== "none";
  const showLinkerd = linkerdServed || linkerd.mode !== "none";
  const inIstio = istio.mode !== "none" || istio.injection;
  return (
    <>
      {showIstio && (
        <Block title={t("mesh:blocks.istioMembership")}>
          <IstioBlock m={istio} template={template} t={t} />
        </Block>
      )}
      {showIstio && istioServed && inIstio && (
        <Block title={t("mesh:blocks.mtls")}>
          <MtlsBlock clusterId={clusterId} namespace={namespace} labels={pod.labels} t={t} />
        </Block>
      )}
      {showIstio && served(AUTHORIZATION_POLICY) && inIstio && (
        <Block title={t("mesh:blocks.whoMayCall")}>
          <WhoMayCall clusterId={clusterId} namespace={namespace} labels={pod.labels} t={t} />
        </Block>
      )}
      {showLinkerd && (
        <Block title={t("mesh:blocks.linkerdMembership")}>
          <LinkerdBlock clusterId={clusterId} m={linkerd} template={template} t={t} />
        </Block>
      )}
    </>
  );
}
