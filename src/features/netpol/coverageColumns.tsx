// The namespace table's coverage columns (#239): "Ingress isolated" and "Egress isolated" — all, some, none of the
// namespace's pods, or "Cannot tell". Bounded like the Coverage tab: only namespaces among the first
// `MAX_COVERAGE_NAMESPACES` of the namespace filter are computed (their pods and policies watched while the row is
// shown, shared with the other connectivity views); any other row says it is not in the filter.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { StatusText, type ColumnDef } from "../../resources";
import { useSelectedNamespaces } from "../namespaces";
import { namespaceCoverage, type NamespaceCoverage } from "./coverage";
import { LEVEL_TONE, levelText } from "./coverageText";
import { MAX_COVERAGE_NAMESPACES } from "./CoverageView";
import { useNetpolData } from "./hooks";
import { podInfo, type Direction } from "./model";

/** The coverage of one namespace, from the shared watches of its pods and policies. */
export function useNamespaceCoverage(clusterId: ClusterId, namespace: string): NamespaceCoverage | null {
  const data = useNetpolData(clusterId, [namespace]);
  return useMemo(
    () => (data.loading ? null : namespaceCoverage(namespace, data.pods(namespace)?.map(podInfo), data.world)),
    [data, namespace],
  );
}

function ComputedCell({ clusterId, namespace, direction }: { clusterId: ClusterId; namespace: string; direction: Direction }) {
  const { t } = useTranslation();
  const coverage = useNamespaceCoverage(clusterId, namespace);
  if (!coverage) return <span className="dt-muted">{t("netpol:coverage.column.loading")}</span>;
  const s = coverage[direction];
  return (
    <span data-level={s.level}>
      <StatusText value={levelText(t, s)} tone={LEVEL_TONE[s.level]} />
    </span>
  );
}

export function NamespaceCoverageCell({ clusterId, namespace, direction }: { clusterId: ClusterId; namespace: string; direction: Direction }) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  const inFilter = (selected ?? []).slice(0, MAX_COVERAGE_NAMESPACES).includes(namespace);
  if (!inFilter) {
    return (
      <span className="dt-muted" title={t("netpol:coverage.column.notInFilterHint")}>
        {t("netpol:coverage.column.notInFilter")}
      </span>
    );
  }
  return <ComputedCell clusterId={clusterId} namespace={namespace} direction={direction} />;
}

const column = (direction: Direction, after: string): ColumnDef => ({
  id: direction === "ingress" ? "netpolIngressCoverage" : "netpolEgressCoverage",
  titleKey: `netpol:coverage.column.${direction}`,
  width: "130px",
  sortable: false,
  after,
  value: () => undefined,
  render: (o, ctx) => <NamespaceCoverageCell clusterId={ctx.clusterId} namespace={o.metadata?.name ?? ""} direction={direction} />,
});

export const COVERAGE_COLUMNS: ColumnDef[] = [column("ingress", "status"), column("egress", "netpolIngressCoverage")];
