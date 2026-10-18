// The policy map of one namespace (the "Policy map" tab of the Connectivity page): which pods are isolated for
// ingress and egress and by which policies, and what each policy that selects pods there allows, in plain words.
// Watches the namespace's pods and policies and the cluster-wide policies only while shown.
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { formatList } from "../../i18n";
import { ObjectLink } from "../../resources";
import { dnsCheck, isolationOf, type Isolation, type World } from "./engine";
import { NamespaceField } from "./fields";
import { useNetpolData } from "./hooks";
import { podInfo, SHOWN_DIRECTIONS, type Direction, type PodInfo, type Policy } from "./model";
import { useClusterConnectivity, useConnectivityStore } from "./state";
import { flavorText, phrase, policyName, unreadableText, type T } from "./text";
import { PolicyLink, RulesView } from "./views";

/** Pods listed at most. */
export const MAX_MAP_PODS = 200;

function isolationText(t: T, iso: Isolation, direction: Direction): string {
  switch (iso.state) {
    case "isolated":
      return t("netpol:map.isolatedBy", { policies: formatList(iso.by.map((p) => policyName(p.ref))) });
    case "maybe":
      return t("netpol:map.maybeBy", { policies: formatList(iso.maybe.map((p) => policyName(p.ref))) });
    case "notIsolated":
      return t(`netpol:map.notIsolated.${direction}`);
    default:
      return t(`netpol:map.${iso.state}`);
  }
}

const TONE = { isolated: "np-tag--isolated", notIsolated: "np-tag--open", maybe: "np-tag--unknown", unknown: "np-tag--unknown", hostNetwork: "np-tag--open" } as const;

function PodRow({ pod, world, dnsPods }: { pod: PodInfo; world: World; dnsPods: PodInfo[] }) {
  const { t } = useTranslation();
  const cells = (["ingress", "egress"] as const).map((d) => ({ d, iso: isolationOf(pod, d, world) }));
  const dns = dnsCheck(pod, dnsPods, world);
  return (
    <tr>
      <td>
        <ObjectLink target={{ apiVersion: "v1", kind: "Pod", name: pod.name ?? "" }} namespace={pod.namespace}>
          {pod.name}
        </ObjectLink>
      </td>
      {cells.map(({ d, iso }) => (
        <td key={d} data-direction={d} data-state={iso.state}>
          <span className={`np-tag ${TONE[iso.state]}`}>{isolationText(t, iso, d)}</span>
          {d === "egress" && dns && dns.udp !== "allowed" && <div className="np-warning-inline">{t(dns.udp === "denied" ? "netpol:map.noDns" : "netpol:map.dnsUnknown")}</div>}
        </td>
      ))}
    </tr>
  );
}

function PolicyBlock({ policy, selected }: { policy: Policy; selected: number }) {
  const { t } = useTranslation();
  return (
    <section className="np-policy" aria-label={policyName(policy.ref)}>
      <h4 className="np-policy__title">
        <PolicyLink policy={policy.ref} /> <span className="dt-muted">{flavorText(t, policy.ref)}</span>
      </h4>
      <p className="np-policy__selects">{t("netpol:map.selects", { what: phrase(t, policy.selectorText), count: selected })}</p>
      {policy.unmodelled.length > 0 && <p className="np-warning">{t("netpol:reason.unmodelled", { feature: formatList(policy.unmodelled) })}</p>}
      <div className="np-policy__rules">
        {SHOWN_DIRECTIONS.map((d) => (
          <div key={d}>
            <h5 className="np-policy__dir">{t(`netpol:direction.${d}`)}</h5>
            <RulesView policy={policy} direction={d} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function PolicyMap({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { mapNamespace } = useClusterConnectivity(clusterId);
  const patch = useConnectivityStore((s) => s.patch);
  const data = useNetpolData(clusterId, mapNamespace ? [mapNamespace] : [], { dns: Boolean(mapNamespace) });
  const objects = mapNamespace ? data.pods(mapNamespace) : undefined;
  const pods = (objects ?? []).map(podInfo).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const { world } = data;
  const policies = world.policies
    .map((p) => ({ policy: p, selected: pods.filter((pod) => !pod.hostNetwork && p.selects(pod, world).result !== "no").length }))
    .filter(({ policy, selected }) => policy.ref.namespace === mapNamespace || selected > 0);
  const count = (d: Direction) => pods.filter((p) => isolationOf(p, d, world).state === "isolated").length;
  return (
    <div className="np-map">
      <div className="np-form__line">
        <NamespaceField
          label={t("netpol:form.namespace")}
          value={mapNamespace}
          namespaces={data.namespaces}
          onChange={(ns) => patch(clusterId, { mapNamespace: ns })}
        />
      </div>
      {!mapNamespace ? (
        <p className="dt-muted">{t("netpol:map.choose")}</p>
      ) : data.loading ? (
        <p className="dt-muted" role="status">
          {t("netpol:loading")}
        </p>
      ) : (
        <>
          {world.unreadable.length > 0 && (
            <ul className="np-list np-list--unknown">
              {world.unreadable.map((u, i) => (
                <li key={i}>{unreadableText(t, u)}</li>
              ))}
            </ul>
          )}
          {objects === undefined ? (
            <p className="np-warning">{t("netpol:map.podsUnreadable", { namespace: mapNamespace })}</p>
          ) : (
            <>
              <p className="np-map__summary" role="status">
                {t("netpol:map.summary", { count: pods.length, ingress: count("ingress"), egress: count("egress") })}
              </p>
              {pods.length > 0 && (
                <div className="dt-table-wrap">
                  <table className="dt-table dt-table--words np-map__pods" aria-label={t("netpol:map.pods")}>
                    <thead>
                      <tr>
                        <th>{t("netpol:map.pod")}</th>
                        <th>{t("netpol:direction.ingress")}</th>
                        <th>{t("netpol:direction.egress")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pods.slice(0, MAX_MAP_PODS).map((pod) => (
                        <PodRow key={pod.name} pod={pod} world={world} dnsPods={data.dnsPods} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pods.length > MAX_MAP_PODS && <p className="dt-muted">{t("netpol:map.more", { count: pods.length - MAX_MAP_PODS })}</p>}
            </>
          )}
          <h3 className="np-subtitle">{t("netpol:map.policies")}</h3>
          {policies.length === 0 ? (
            <p className="dt-muted">{t("netpol:map.noPolicies")}</p>
          ) : (
            policies.map(({ policy, selected }) => <PolicyBlock key={`${policy.ref.flavor}/${policyName(policy.ref)}`} policy={policy} selected={selected} />)
          )}
        </>
      )}
    </div>
  );
}
