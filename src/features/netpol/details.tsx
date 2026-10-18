// Details sections: a policy in plain words (NetworkPolicy, and the Cilium and Calico policy kinds) — which pods it
// selects (and which it selects now), its types, and what each rule allows — and a pod's isolation for ingress and
// egress with the policies that isolate it. Both watch only the object's namespace (pods and policies) while open.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Button } from "../../components";
import { formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ObjectLink } from "../../resources";
import { Block, Fields, type FieldRow } from "../details";
import { dnsCheck, isolationOf, type Isolation, type World } from "./engine";
import { policiesOf, useNetpolData } from "./hooks";
import { ignoredRules } from "./kubernetes";
import { podInfo, SHOWN_DIRECTIONS, type Direction, type PodInfo, type Policy } from "./model";
import { openConnectivity } from "./state";
import { flavorText, phrase, policyName, unevaluatedText, unreadableText, type T } from "./text";
import { DnsWarning, PolicyLink, RulesView } from "./views";

const FIELD_LABELS = "netpol:fields";
const DIRECTION_LABELS = "netpol:direction";

/** Selected pods named at most. */
export const MAX_SELECTED_SHOWN = 20;

function podLinks(pods: PodInfo[]): ReactNode {
  return (
    <span className="dt-links">
      {pods.slice(0, MAX_SELECTED_SHOWN).map((p) => (
        <ObjectLink key={p.name} target={{ apiVersion: "v1", kind: "Pod", name: p.name ?? "" }} namespace={p.namespace}>
          {p.name}
        </ObjectLink>
      ))}
    </span>
  );
}

function typesText(t: T, policy: Policy): string {
  const types = SHOWN_DIRECTIONS.filter((d) => policy.isolates[d]).map((d) => t(`netpol:direction.${d}`));
  if (types.length === 0) return t("netpol:fields.typesNone");
  return policy.defaultedTypes ? t("netpol:fields.typesDefaulted", { types: formatList(types) }) : formatList(types);
}

function PolicyView({ policy, pods, world, obj }: { policy: Policy; pods: PodInfo[] | undefined; world: World; obj: KubeObject }) {
  const { t } = useTranslation();
  const selected = pods?.filter((p) => !p.hostNetwork && policy.selects(p, world).result === "yes");
  // DNS under this policy alone: the egress it allows to kube-dns.
  const alone: World = { policies: [policy], unreadable: [], namespaceLabels: world.namespaceLabels };
  const first = selected?.[0];
  const dns = policy.isolates.egress && first ? dnsCheck(first, [], alone) : null;
  const ignored = policy.ref.flavor === "kubernetes" ? ignoredRules(obj) : [];
  const rows: FieldRow[] = [
    ["selects", phrase(t, policy.selectorText)],
    [
      "selectedNow",
      selected === undefined ? null : selected.length === 0 ? t("netpol:fields.noPods") : (
        <>
          {podLinks(selected)}
          {selected.length > MAX_SELECTED_SHOWN && <span className="dt-muted">{t("netpol:fields.morePods", { count: selected.length - MAX_SELECTED_SHOWN })}</span>}
        </>
      ),
    ],
    ["types", typesText(t, policy)],
    ["order", policy.semantics === "ordered" ? (policy.order === null ? t("netpol:fields.noOrder") : String(policy.order)) : null],
    ["notModelled", policy.unmodelled.length > 0 ? formatList(policy.unmodelled) : null],
  ];
  return (
    <div className="np-details-policy" data-policy={policyName(policy.ref)}>
      {policy.ref.part !== null && <h4 className="np-policy__title">{t("netpol:details.spec", { n: policy.ref.part + 1 })}</h4>}
      <Fields rows={rows} labelPrefix={FIELD_LABELS} />
      {ignored.map((d) => (
        <p key={d} className="np-warning">
          {t(`netpol:details.ignored.${d}`)}
        </p>
      ))}
      {SHOWN_DIRECTIONS.map((d) => (
        <div key={d}>
          <h4 className="np-policy__dir">{t(`netpol:direction.${d}`)}</h4>
          <RulesView policy={policy} direction={d} />
        </div>
      ))}
      {dns && dns.udp !== "allowed" && (
        <p className="np-warning" role="note">
          {t("netpol:details.noDns")}
        </p>
      )}
    </div>
  );
}

function PolicyDetails({ clusterId, objectRef, obj }: { clusterId: ClusterId; objectRef: DetailsSectionProps["objectRef"]; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const data = useNetpolData(clusterId, ns ? [ns] : []);
  const policies = policiesOf(objectRef.kind, obj);
  const pods = ns ? data.pods(ns)?.map(podInfo) : undefined;
  const actions = ns ? (
    <Button size="compact" icon="connectivity" onClick={() => openConnectivity(clusterId, { tab: "map", namespace: ns })}>
      {t("netpol:details.openMap")}
    </Button>
  ) : undefined;
  return (
    <Block title={t("netpol:details.plainWords")} actions={actions}>
      {flavorNote(t, policies)}
      {policies.length === 0 ? <p className="dt-muted">{t("netpol:details.selectsNoPods")}</p> : policies.map((p, i) => <PolicyView key={i} policy={p} pods={pods} world={data.world} obj={obj} />)}
    </Block>
  );
}

function flavorNote(t: T, policies: Policy[]): ReactNode {
  const ref = policies[0]?.ref;
  if (!ref || ref.flavor === "kubernetes") return null;
  return <p className="dt-muted">{t(`netpol:details.flavorNote.${ref.flavor}`)}</p>;
}

export function PolicySection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  return obj ? <PolicyDetails clusterId={clusterId} objectRef={objectRef} obj={obj} /> : null;
}

// ---------- A pod's isolation ----------

function IsolationValue({ iso, direction }: { iso: Isolation; direction: Direction }) {
  const { t } = useTranslation();
  if (iso.state === "isolated" || iso.state === "maybe") {
    const list = iso.state === "isolated" ? iso.by : iso.maybe;
    return (
      <span data-state={iso.state}>
        {t(iso.state === "isolated" ? "netpol:pod.isolatedBy" : "netpol:pod.maybeBy")}{" "}
        <span className="dt-links">
          {list.map((p) => (
            <PolicyLink key={`${p.ref.flavor}/${policyName(p.ref)}`} policy={p.ref} label={p.ref.flavor === "kubernetes" ? p.ref.name : `${p.ref.name} (${flavorText(t, p.ref)})`} />
          ))}
        </span>
      </span>
    );
  }
  return <span data-state={iso.state}>{t(iso.state === "notIsolated" ? `netpol:pod.notIsolated.${direction}` : `netpol:pod.${iso.state}`)}</span>;
}

function PodIsolation({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const pod = podInfo(obj);
  const data = useNetpolData(clusterId, [pod.namespace], { dns: true, pods: false });
  const actions = (
    <Button
      size="compact"
      icon="connectivity"
      onClick={() => openConnectivity(clusterId, { tab: "check", form: { sourceType: "pod", sourceNamespace: pod.namespace, sourcePod: pod.name ?? "" } })}
    >
      {t("netpol:pod.check")}
    </Button>
  );
  if (data.loading) {
    return (
      <Block title={t("netpol:pod.title")} actions={actions}>
        <p className="dt-muted" role="status">
          {t("netpol:loading")}
        </p>
      </Block>
    );
  }
  const rows: FieldRow[] = SHOWN_DIRECTIONS.map((d) => [d, <IsolationValue key={d} iso={isolationOf(pod, d, data.world)} direction={d} />]);
  const unknown = data.world.unreadable.filter((u) => u.namespace === null || u.namespace === pod.namespace);
  return (
    <Block title={t("netpol:pod.title")} actions={actions}>
      <Fields rows={rows} labelPrefix={DIRECTION_LABELS} />
      {unknown.map((u, i) => (
        <p key={i} className="dt-muted">
          {unreadableText(t, u)}
        </p>
      ))}
      {(data.world.unevaluated ?? [])
        .filter((u) => !u.namespace || u.namespace === pod.namespace)
        .map((u, i) => (
          <p key={`u${i}`} className="dt-muted">
            {unevaluatedText(t, u)}
          </p>
        ))}
      <DnsWarning dns={dnsCheck(pod, data.dnsPods, data.world)} />
    </Block>
  );
}

export function PodIsolationSection({ clusterId, obj }: DetailsSectionProps) {
  return obj ? <PodIsolation clusterId={clusterId} obj={obj} /> : null;
}
