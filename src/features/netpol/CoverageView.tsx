// The "Coverage" tab of the Connectivity page (#239): for each namespace of the filter, how many pods a policy isolates
// for ingress and for egress, the namespace's default deny, the policies that isolate pods there, and the pods no
// policy isolates (or for which it cannot be told, with why). Bounded like the other views: only the first
// `MAX_COVERAGE_NAMESPACES` namespaces of the filter, watched only while the tab is shown (`useNetpolData`).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { EmptyState, LoadingIndicator } from "../../components";
import { ResizableTable } from "../../components/Table";
import { ObjectLink, StatusText } from "../../resources";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { namespaceCoverage, type NamespaceCoverage, type PodCoverage } from "./coverage";
import { causeTexts, defaultDenyText, LEVEL_TONE, levelText, stateText } from "./coverageText";
import { useNetpolData } from "./hooks";
import { podInfo } from "./model";
import { flavorText, policyName } from "./text";
import { PolicyLink } from "./views";

/** At most this many namespaces of the filter are looked at. */
export const MAX_COVERAGE_NAMESPACES = 10;
/** Pods not isolated (or undecided) listed at most per namespace. */
export const MAX_COVERAGE_PODS = 50;

export function CoverageView({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  return (
    <div className="np-coverage">
      <p className="np-coverage__intro">{t("netpol:coverage.intro")}</p>
      <div className="np-form__line">
        <NamespaceFilter clusterId={clusterId} />
      </div>
      {selected === undefined ? (
        <LoadingIndicator text={t("netpol:loading")} />
      ) : selected === null || selected.length === 0 ? (
        <EmptyState title={t("netpol:coverage.chooseNamespace")} text={t("netpol:coverage.chooseNamespaceText")} />
      ) : (
        <CoverageTable clusterId={clusterId} selected={selected} />
      )}
    </div>
  );
}

function CoverageTable({ clusterId, selected }: { clusterId: ClusterId; selected: string[] }) {
  const { t } = useTranslation();
  const nsKey = selected.slice(0, MAX_COVERAGE_NAMESPACES).join("\u0000");
  // `nsKey` stands for the first namespaces by value.
  const namespaces = useMemo(() => nsKey.split("\u0000"), [nsKey]);
  const data = useNetpolData(clusterId, namespaces);
  const rows = useMemo(
    () => (data.loading ? [] : namespaces.map((ns) => namespaceCoverage(ns, data.pods(ns)?.map(podInfo), data.world))),
    [data, namespaces],
  );
  return (
    <>
      {selected.length > MAX_COVERAGE_NAMESPACES && (
        <p className="np-warning" role="status">
          {t("netpol:coverage.firstNamespaces", { count: MAX_COVERAGE_NAMESPACES })}
        </p>
      )}
      {data.loading ? (
        <p className="dt-muted" role="status">
          {t("netpol:loading")}
        </p>
      ) : (
        <>
          <div className="dt-table-wrap">
            <ResizableTable tableId="netpol.coverage" className="dt-table dt-table--words np-coverage__table" aria-label={t("netpol:coverage.table")}>
              <thead>
                <tr>
                  <th>{t("netpol:coverage.namespace")}</th>
                  <th>{t("netpol:coverage.pods")}</th>
                  <th>{t("netpol:coverage.ingress")}</th>
                  <th>{t("netpol:coverage.egress")}</th>
                  <th>{t("netpol:coverage.defaultDeny")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.namespace} data-namespace={r.namespace}>
                    <td>{r.namespace}</td>
                    <td className="dt-col--nowrap">{r.pods === null ? t("netpol:coverage.level.unknown") : String(r.pods.length)}</td>
                    <td data-level={r.ingress.level}>
                      <StatusText value={levelText(t, r.ingress)} tone={LEVEL_TONE[r.ingress.level]} />
                    </td>
                    <td data-level={r.egress.level}>
                      <StatusText value={levelText(t, r.egress)} tone={LEVEL_TONE[r.egress.level]} />
                    </td>
                    <td>{defaultDenyText(t, r.ingress.defaultDeny.state, r.egress.defaultDeny.state)}</td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
          {rows.map((r) => (
            <NamespaceBlock key={r.namespace} coverage={r} />
          ))}
        </>
      )}
    </>
  );
}

const isOpen = (p: PodCoverage) => p.ingress.state !== "isolated" || p.egress.state !== "isolated";

function NamespaceBlock({ coverage }: { coverage: NamespaceCoverage }) {
  const { t } = useTranslation();
  const { namespace, pods, policies } = coverage;
  const open = (pods ?? []).filter(isOpen);
  const causes = causeTexts(t, [...coverage.unknown, ...open.flatMap((p) => [...p.ingress.unknown, ...p.egress.unknown])]);
  return (
    <section className="np-coverage__ns" aria-label={namespace} data-namespace={namespace}>
      <h3 className="np-subtitle">{namespace}</h3>
      {causes.length > 0 && (
        <ul className="np-list np-list--unknown">
          {causes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {policies.length === 0 ? (
        <p className="dt-muted">{t("netpol:coverage.noPolicies")}</p>
      ) : (
        <div className="dt-table-wrap">
          <ResizableTable tableId="netpol.coveragePolicies" className="dt-table dt-table--words" aria-label={t("netpol:coverage.policies", { namespace })}>
            <thead>
              <tr>
                <th>{t("netpol:coverage.policy")}</th>
                <th>{t("netpol:coverage.flavor")}</th>
                <th>{t("netpol:coverage.ingressPods")}</th>
                <th>{t("netpol:coverage.egressPods")}</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={`${p.ref.flavor}/${policyName(p.ref)}`}>
                  <td>
                    <PolicyLink policy={p.ref} />
                  </td>
                  <td>{flavorText(t, p.ref)}</td>
                  <td className="dt-col--nowrap">{String(p.ingress)}</td>
                  <td className="dt-col--nowrap">{String(p.egress)}</td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>
      )}
      {pods === null ? (
        <p className="np-warning">{t("netpol:map.podsUnreadable", { namespace })}</p>
      ) : pods.length === 0 ? null : open.length === 0 ? (
        <p className="dt-muted">{t("netpol:coverage.allIsolated")}</p>
      ) : (
        <>
          <div className="dt-table-wrap">
            <ResizableTable tableId="netpol.coveragePods" className="dt-table dt-table--words" aria-label={t("netpol:coverage.openPods", { namespace })}>
              <thead>
                <tr>
                  <th>{t("netpol:map.pod")}</th>
                  <th>{t("netpol:direction.ingress")}</th>
                  <th>{t("netpol:direction.egress")}</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, MAX_COVERAGE_PODS).map((p) => (
                  <tr key={p.pod.name}>
                    <td>
                      <ObjectLink target={{ apiVersion: "v1", kind: "Pod", name: p.pod.name ?? "" }} namespace={namespace}>
                        {p.pod.name}
                      </ObjectLink>
                    </td>
                    <td data-state={p.ingress.state}>{stateText(t, p.ingress)}</td>
                    <td data-state={p.egress.state}>{stateText(t, p.egress)}</td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
          {open.length > MAX_COVERAGE_PODS && <p className="dt-muted">{t("netpol:map.more", { count: open.length - MAX_COVERAGE_PODS })}</p>}
        </>
      )}
    </section>
  );
}
