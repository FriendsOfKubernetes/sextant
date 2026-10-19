// Drift of a Helm release (#156): each object of the release's stored manifest against the live object. Only what the
// manifest sets counts (`driftChanges`), so fields the API server added are not drift; a Secret is compared by key
// names and value hashes in the backend.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, DriftObject, HelmDrift } from "../../api";
import { Badge, Button, ErrorState, type BadgeTone } from "../../components";
import { formatParts } from "../../i18n/format";
import { kindKey } from "../../resources/refs";
import { ChangeList, ObjectDiff } from "./DiffView";
import { objectDrift, type FieldChange } from "./model";
import type { NormalizeOptions } from "./normalize";
import { SecretKeys } from "./SecretKeys";
import { ResizableTable } from "../../components/Table";

export type DriftState = "inSync" | "drifted" | "missing" | "error";

const TONES: Record<DriftState, BadgeTone> = { inSync: "success", drifted: "warning", missing: "danger", error: "neutral" };

export interface DriftSummary {
  state: DriftState;
  changes: FieldChange[];
  /** Secret keys whose presence or value differs. */
  secretKeys: number;
}

/** Whether a manifest object matches the live one, and what differs. */
export function driftOf(entry: DriftObject, options: NormalizeOptions): DriftSummary {
  if (entry.error) return { state: "error", changes: [], secretKeys: 0 };
  if (!entry.live) return { state: "missing", changes: [], secretKeys: 0 };
  const changes = objectDrift(entry.rendered, entry.live, entry.object.kind, options);
  const secretKeys = (entry.secretKeys ?? []).filter((k) => !(k.onLeft && k.onRight && k.equal)).length;
  return { state: changes.length > 0 || secretKeys > 0 ? "drifted" : "inSync", changes, secretKeys };
}

function objectLabel(entry: DriftObject): string {
  const { kind, namespace, name } = entry.object;
  return formatParts([kind.kind, namespace ? `${namespace}/${name}` : name]);
}

/** One object: its drift, the manifest and live YAML side by side, and a Secret's keys. */
export function DriftDetails({ clusterId, entry, options }: { clusterId: ClusterId; entry: DriftObject; options: NormalizeOptions }) {
  const { t } = useTranslation();
  const summary = driftOf(entry, options);
  const leftTitle = t("compare:side.manifest");
  const rightTitle = t("compare:side.live");
  if (entry.error) return <ErrorState error={entry.error} />;
  if (!entry.live) return <p className="compare-muted">{t("compare:drift.missingObject")}</p>;
  return (
    <div className="compare-drift-details">
      {summary.changes.length > 0 && (
        <ChangeList changes={summary.changes} leftTitle={leftTitle} rightTitle={rightTitle} label={t("compare:drift.changesLabel")} />
      )}
      {entry.secretKeys && (
        <SecretKeys
          keys={entry.secretKeys}
          leftTitle={leftTitle}
          rightTitle={rightTitle}
          revealLeft={null}
          revealRight={{ clusterId, namespace: entry.object.namespace ?? "", name: entry.object.name }}
        />
      )}
      <ObjectDiff kind={entry.object.kind} left={entry.rendered} right={entry.live} leftTitle={leftTitle} rightTitle={rightTitle} options={options} />
    </div>
  );
}

export interface ReleaseDriftProps {
  clusterId: ClusterId;
  drift: HelmDrift;
  hideDefaults: boolean;
  ignorePaths: Readonly<Record<string, readonly string[]>>;
}

/** Every object of the release with its drift state; a click shows the object's details. */
export function ReleaseDrift({ clusterId, drift, hideDefaults, ignorePaths }: ReleaseDriftProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const optionsOf = (entry: DriftObject): NormalizeOptions => ({ hideDefaults, ignorePaths: ignorePaths[kindKey(entry.object.kind)] ?? [] });
  return (
    <div className="compare-release">
      <p className="compare-muted">
        {t("compare:drift.release", { name: drift.release, namespace: drift.namespace, revision: drift.revision })}
      </p>
      {drift.unreadable > 0 && <p className="compare-muted">{t("compare:drift.unreadable", { count: drift.unreadable })}</p>}
      {drift.truncated > 0 && <p className="compare-muted">{t("compare:drift.truncated", { count: drift.truncated })}</p>}
      <ResizableTable tableId="compare.helmDrift" className="compare-table" aria-label={t("compare:drift.objectsLabel")}>
        <thead>
          <tr>
            <th>{t("compare:drift.object")}</th>
            <th>{t("compare:drift.state")}</th>
            <th aria-label={t("compare:drift.details")} />
          </tr>
        </thead>
        <tbody>
          {drift.objects.map((entry, i) => {
            const summary = driftOf(entry, optionsOf(entry));
            const label = objectLabel(entry);
            return (
              <DriftRow
                key={`${kindKey(entry.object.kind)}|${entry.object.namespace ?? ""}|${entry.object.name}`}
                label={label}
                summary={summary}
                open={open === i}
                onToggle={() => setOpen(open === i ? null : i)}
              >
                <DriftDetails clusterId={clusterId} entry={entry} options={optionsOf(entry)} />
              </DriftRow>
            );
          })}
        </tbody>
      </ResizableTable>
    </div>
  );
}

function DriftRow({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: DriftSummary;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const count = summary.changes.length + summary.secretKeys;
  return (
    <>
      <tr>
        <td className="compare-mono">{label}</td>
        <td>
          <Badge tone={TONES[summary.state]}>
            {summary.state === "drifted" ? t("compare:drift.drifted", { count }) : t(`compare:drift.states.${summary.state}`)}
          </Badge>
        </td>
        <td>
          <Button size="compact" icon={open ? "chevronUp" : "chevronDown"} aria-expanded={open} onClick={onToggle}>
            {open ? t("compare:drift.hideDetails") : t("compare:drift.showDetails")}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>{children}</td>
        </tr>
      )}
    </>
  );
}
