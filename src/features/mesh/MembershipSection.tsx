import { useDetailsDisclosure } from "../../layout/details/disclosure";
import { useDisclosureProbe } from "../details/disclosureProbe";
// The "Service mesh" details section of Pods and workloads (#155): whether it is in the Istio or Linkerd mesh (and
// how: sidecar, native sidecar, ambient; revision; injection), its Istio mTLS mode by PeerAuthentication precedence,
// and "Who may call this workload?" from AuthorizationPolicies. Shown only when the cluster serves Istio or Linkerd
// kinds, or the pod carries a proxy. The namespace is read with one field-selected watch; the policies come from the
// shared Istio configuration (store.ts).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { Block, Fields, type FieldRow } from "../details";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { findKind, StatusText, useClusterKinds } from "../../resources";
import type { Tone } from "../../resources/status";
import { SimpleTable } from "../gateway-api/details";
import { whoMayCall, type AuthzDecision, type Caller } from "./authz";
import { AUTHORIZATION_POLICY, LINKERD_SERVER, PEER_AUTHENTICATION, SERVICE_PROFILE, VIRTUAL_SERVICE } from "./kinds";
import { istioMembership, linkerdMembership, namespaceShape, podShape, type IstioMembership, type LinkerdMembership, type NamespaceShape, type PodShape } from "./membership";
import { mtlsModeFor } from "./mtls";
import { useMeshConfig } from "./store";
import { meshLink, type T } from "./ui";
import { revealRequestHealth } from "../request-health/hooks";
import { requestHealthApplies } from "../request-health/model";

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

function LinkerdBlock({
  clusterId,
  m,
  template,
  requests,
  t,
}: {
  clusterId: ClusterId;
  m: LinkerdMembership;
  template: boolean;
  /** The details have a "Requests" section to point to. */
  requests: boolean;
  t: T;
}) {
  const on = m.inject === "enabled" || m.inject === "ingress";
  const sentence = template ? (on ? "mesh:membership.linkerd.injectedPods" : "mesh:membership.linkerd.noInjection") : `mesh:membership.linkerd.${m.mode}`;
  const meshed = m.mode !== "none" || (template && on);
  // Golden metrics (#212) come from linkerd-viz's Prometheus or the cluster's: the "Requests" section shows them; here
  // only linkerd-viz's presence is checked (one Namespace by name) to point there.
  const viz = useWatch(clusterId, meshed && requests ? oneNamespace("linkerd-viz") : null);
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
      {meshed && requests && viz.status === "ready" && viz.items.size > 0 && (
        <p className="dt-muted">
          {t("requesthealth:linkerdViz")}{" "}
          <button type="button" className="mx-link" onClick={(e) => revealRequestHealth(e.currentTarget)}>
            {t("requesthealth:showRequests")}
          </button>
        </p>
      )}
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
          tableId="mesh.membershipPorts"
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
          tableId="mesh.authzVerdicts"
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

/** The same applicability determines rendered headers and which of their open choices can own the namespace. */
function membershipView(pod: PodShape, ns: NamespaceShape | undefined, template: boolean, served: { istio: boolean; linkerd: boolean; authz: boolean }) {
  const istio = istioMembership(pod, ns, template);
  const linkerd = linkerdMembership(pod, ns, template);
  const showIstio = served.istio || istio.mode !== "none";
  const inIstio = istio.mode !== "none" || istio.injection;
  return {
    istio,
    linkerd,
    showIstio,
    showLinkerd: served.linkerd || linkerd.mode !== "none",
    showMtls: showIstio && served.istio && inIstio,
    showAuthz: showIstio && served.authz && inIstio,
  };
}

export function MeshMembershipSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { kinds } = useClusterKinds(clusterId);
  const served = (k: KindRef) => !!kinds && !!findKind(kinds, k);
  const istioServed = served(PEER_AUTHENTICATION) || served(VIRTUAL_SERVICE);
  const linkerdServed = served(LINKERD_SERVER) || served(SERVICE_PROFILE);
  const supported = { istio: istioServed, linkerd: linkerdServed, authz: served(AUTHORIZATION_POLICY) };
  const template = objectRef.kind.kind !== "Pod";
  const pod = useMemo(() => (obj ? podShape(obj, template) : undefined), [obj, template]);
  const hasProxy = !!pod && [...pod.containers, ...pod.initContainers].some((c) => c.name === "istio-proxy" || c.name === "linkerd-proxy");
  const shown = !!pod && (istioServed || linkerdServed || hasProxy);
  const istioOpen = useDetailsDisclosure("mesh:blocks.istioMembership")?.open ?? true;
  const linkerdOpen = useDetailsDisclosure("mesh:blocks.linkerdMembership")?.open ?? true;
  const mtlsOpen = useDetailsDisclosure("mesh:blocks.mtls")?.open ?? true;
  const authzOpen = useDetailsDisclosure("mesh:blocks.whoMayCall")?.open ?? true;
  const [lastNamespace, setLastNamespace] = useState(() => namespaceShape(undefined));
  const cached = pod ? membershipView(pod, lastNamespace, template, supported) : undefined;
  const active = [
    [cached?.showIstio, istioOpen],
    [cached?.showLinkerd, linkerdOpen],
    [cached?.showMtls, mtlsOpen],
    [cached?.showAuthz, authzOpen],
  ].some(([visible, open]) => visible && open);
  const { enabled, settle } = useDisclosureProbe("mesh:blocks.istioMembership", active);
  const nsWatch = useWatch(clusterId, shown && enabled ? oneNamespace(obj?.metadata?.namespace) : null);
  const nsObj: KubeObject | undefined = [...nsWatch.items.values()][0];
  const currentNamespace = useMemo(() => namespaceShape(nsObj), [nsObj]);
  useEffect(() => {
    if (!shown || !enabled || nsWatch.status === "loading") return;
    settle(nsWatch.status === "ready" ? "present" : "unknown");
    if (nsWatch.status === "ready") setLastNamespace(currentNamespace);
  }, [shown, enabled, nsWatch.status, currentNamespace, settle]);
  if (!shown || !pod) return null;
  const ns = enabled ? currentNamespace : lastNamespace;
  const view = membershipView(pod, ns, template, supported);
  const namespace = obj?.metadata?.namespace ?? "";
  return (
    <>
      {view.showIstio && (
        <Block id="mesh:blocks.istioMembership" title={t("mesh:blocks.istioMembership")}>
          <IstioBlock m={view.istio} template={template} t={t} />
        </Block>
      )}
      {view.showMtls && (
        <Block id="mesh:blocks.mtls" title={t("mesh:blocks.mtls")}>
          <MtlsBlock clusterId={clusterId} namespace={namespace} labels={pod.labels} t={t} />
        </Block>
      )}
      {view.showAuthz && (
        <Block id="mesh:blocks.whoMayCall" title={t("mesh:blocks.whoMayCall")}>
          <WhoMayCall clusterId={clusterId} namespace={namespace} labels={pod.labels} t={t} />
        </Block>
      )}
      {view.showLinkerd && (
        <Block id="mesh:blocks.linkerdMembership" title={t("mesh:blocks.linkerdMembership")}>
          <LinkerdBlock
            clusterId={clusterId}
            m={view.linkerd}
            template={template}
            requests={requestHealthApplies(objectRef.kind)}
            t={t}
          />
        </Block>
      )}
    </>
  );
}
