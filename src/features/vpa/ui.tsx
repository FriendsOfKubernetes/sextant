// Pieces shared by a VPA's details and the VPA block of a workload's details: the per-container table of the
// recommendation against the template's requests and limits with what a pod created now would get, the update mode
// in words, and the HPA conflicts.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { StatusText, status } from "../../resources";
import { table, type ColumnWrap } from "../details";
import { formatAmount } from "../autoscaling/model";
import { baseUnits, templateChanges, templateContainers, type ContainerChange, type ResourceChange } from "./admission";
import { conflictsOf } from "./conflicts";
import { containerPoliciesOf, modeKey, recommendationsOf, updateModeOf } from "./model";

const { get, str } = status;

/** An amount as people read it, or the "not set" text. */
function useAmount(): (resource: string, amount: number | undefined) => string {
  const { t } = useTranslation();
  return (resource, amount) => (amount === undefined ? t("vpa:table.unset") : formatAmount(resource, baseUnits(resource, amount)));
}

const WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", undefined, "nowrap"];

/** The containers of the target's template with the VPA's recommendation and what a new pod would get. */
export function ChangesTable({ vpa, target, id }: { vpa: KubeObject; target: KubeObject; id: string }) {
  const { t } = useTranslation();
  const amount = useAmount();
  const mode = updateModeOf(vpa);
  const recommendations = recommendationsOf(vpa);
  const changes = templateChanges(target, containerPoliciesOf(vpa), recommendations);
  const inTemplate = new Set(changes.map((c) => c.container));
  const extra = recommendations.filter((r) => !inTemplate.has(r.container)).map((r) => r.container);
  const pair = (resource: string, a: number | undefined, b: number | undefined) =>
    t("vpa:table.pair", { request: amount(resource, a), limit: amount(resource, b) });
  const after = (c: ContainerChange, r: ResourceChange): ReactNode => {
    if (mode === "Off") return t("vpa:table.unchangedOff");
    if (c.state !== "scaled" || r.newRequest === undefined) return t("vpa:table.unchanged");
    return pair(r.resource, r.newRequest, r.newLimit ?? r.limit);
  };
  const targetCell = (r: ResourceChange): ReactNode => {
    if (r.target === undefined) return t("vpa:table.noTarget");
    const lines = [amount(r.resource, r.target)];
    if (r.uncappedTarget !== undefined && r.uncappedTarget !== r.target) lines.push(t("vpa:table.uncapped", { value: amount(r.resource, r.uncappedTarget) }));
    if (r.capped) lines.push(t(`vpa:table.capped.${r.capped}`));
    return lines.join(" · ");
  };
  const rows: ReactNode[][] = [];
  for (const c of changes) {
    if (c.state === "off") {
      rows.push([c.container, t("vpa:table.allResources"), "", "", t("vpa:table.containerOff"), ""]);
      continue;
    }
    for (const r of c.resources) {
      rows.push([
        c.container,
        r.resource,
        pair(r.resource, r.request, r.limit),
        r.lowerBound === undefined && r.upperBound === undefined ? "" : t("vpa:table.rangeValue", { lower: amount(r.resource, r.lowerBound), upper: amount(r.resource, r.upperBound) }),
        targetCell(r),
        after(c, r),
      ]);
    }
  }
  const view = table(
    id,
    [t("vpa:table.container"), t("vpa:table.resource"), t("vpa:table.now"), t("vpa:table.range"), t("vpa:table.target"), t("vpa:table.after")],
    rows,
    WRAP,
  );
  const requestsOnly = changes.some((c) => c.state === "scaled" && c.controlledValues === "RequestsOnly");
  return (
    <>
      {view ?? <p className="vpa-muted">{t("vpa:table.noContainers")}</p>}
      {extra.length > 0 && <p className="vpa-muted">{t("vpa:table.notInTemplate", { containers: formatList(extra) })}</p>}
      <p className="vpa-muted">{t(requestsOnly ? "vpa:table.howRequestsOnly" : "vpa:table.how")}</p>
      <p className="vpa-muted">{t("vpa:table.notModelled")}</p>
    </>
  );
}

/** The update mode and when changes reach the pods. */
export function ModeText({ vpa }: { vpa: KubeObject }) {
  const { t } = useTranslation();
  const mode = updateModeOf(vpa);
  const key = modeKey(mode);
  return <>{t(`vpa:modeExplain.${key}`, { mode })}</>;
}

/** The HPAs that fight the VPA, as a danger line; nothing without conflicts. */
export function ConflictLines({ vpa, hpas, target }: { vpa: KubeObject; hpas: readonly KubeObject[]; target?: KubeObject }) {
  const { t } = useTranslation();
  const containers = target ? templateContainers(target).map((c) => str(get(c, "name")) ?? "") : undefined;
  const conflicts = conflictsOf(vpa, hpas, containers);
  if (conflicts.length === 0) return null;
  return (
    <>
      {conflicts.map((c) => (
        <p key={c.hpa} className="vpa-danger">
          <StatusText
            value={t("vpa:conflict.line", { hpa: c.hpa, mode: updateModeOf(vpa), resources: formatList(c.resources) })}
            tone="danger"
          />
        </p>
      ))}
      <p className="vpa-muted">{t("vpa:conflict.why")}</p>
    </>
  );
}
