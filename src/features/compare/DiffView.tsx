// Two normalized objects side by side (the rollouts' `TemplateDiff`, no diff library of its own) and lists of field
// changes.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { toYaml } from "../details";
import { TemplateDiff } from "../rollouts/TemplateDiff";
import { fieldChanges, valueText, type FieldChange } from "./model";
import { normalize, type NormalizeOptions } from "./normalize";

export interface ObjectDiffProps {
  kind: Pick<KindRef, "group" | "kind">;
  /** `undefined`: nothing on that side (the diff shows an empty column). */
  left: unknown;
  right: unknown;
  leftTitle: string;
  rightTitle: string;
  options: NormalizeOptions;
}

/** The two objects normalized, how many fields differ, and the side-by-side YAML. */
export function ObjectDiff({ kind, left, right, leftTitle, rightTitle, options }: ObjectDiffProps) {
  const { t } = useTranslation();
  const normalized = useMemo(() => {
    const a = left === undefined ? undefined : normalize(left, kind, options);
    const b = right === undefined ? undefined : normalize(right, kind, options);
    return { a, b, changes: a && b ? fieldChanges(a, b).length : null };
  }, [left, right, kind, options]);
  const leftText = useMemo(() => (normalized.a ? toYaml(normalized.a) : ""), [normalized]);
  const rightText = useMemo(() => (normalized.b ? toYaml(normalized.b) : ""), [normalized]);
  return (
    <div className="compare-diff">
      {normalized.changes !== null && (
        <p className="compare-summary" role="status">
          {normalized.changes === 0 ? t("compare:diff.same") : t("compare:diff.changes", { count: normalized.changes })}
        </p>
      )}
      <TemplateDiff left={leftText} right={rightText} leftTitle={leftTitle} rightTitle={rightTitle} />
    </div>
  );
}

export interface ChangeListProps {
  changes: readonly FieldChange[];
  leftTitle: string;
  rightTitle: string;
  /** Text above the table, already translated. */
  label: string;
}

/** Field changes as a table: path, the value on each side (empty: not set). */
export function ChangeList({ changes, leftTitle, rightTitle, label }: ChangeListProps) {
  const { t } = useTranslation();
  if (changes.length === 0) return null;
  return (
    <table className="compare-table compare-changes" aria-label={label}>
      <thead>
        <tr>
          <th>{t("compare:diff.field")}</th>
          <th>{leftTitle}</th>
          <th>{rightTitle}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.path}>
            <td className="compare-mono">{c.path}</td>
            <td className="compare-mono">{c.left === undefined ? <NotSet /> : valueText(c.left)}</td>
            <td className="compare-mono">{c.right === undefined ? <NotSet /> : valueText(c.right)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NotSet() {
  const { t } = useTranslation();
  return <span className="compare-muted">{t("compare:diff.notSet")}</span>;
}
