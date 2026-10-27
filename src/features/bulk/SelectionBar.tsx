// The selection bar of a resource table (ADR-0126): while rows are selected, a labelled toolbar under the table's
// header with "N selected", the actions for the whole selection (`selection.ts`) and "Clear selection". It is in the
// tab order right after the header's controls, before the table. A live region, kept while the bar comes and goes,
// says the selection's size when it changes. An action that applies to only part of the selection says so on its
// button and, on a click, first lists what it leaves out and why (`PartialDialog`).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { Button } from "../../components";
import type { ActionId } from "../../resources/registry";
import { actionLabel, openActionDialog, runAction, useActionsVersion } from "../actions/registry";
import { PartialDialog } from "./PartialDialog";
import { selectionActions, type BarAction } from "./selection";
import "./bulk.css";

export interface SelectionBarProps {
  clusterId: ClusterId;
  kind: KindRef;
  /** The selected objects, in the table's order. */
  objects: KubeObject[];
  /** The kind's action ids (`ResourceDef.actions`, or the table's own). */
  actionIds: readonly ActionId[];
  onClear: () => void;
}

/** Runs `entry`'s action on the selection, after the explanation when it applies to part of it only. */
export function startBarAction(entry: BarAction, clusterId: ClusterId, kind: KindRef): void {
  if (entry.left.length === 0) {
    void runAction(entry.action, clusterId, kind, entry.applying);
    return;
  }
  openActionDialog((close) => (
    <PartialDialog
      entry={entry}
      kind={kind}
      close={close}
      onContinue={() => {
        close();
        void runAction(entry.action, clusterId, kind, entry.applying);
      }}
    />
  ));
}

export function SelectionBar({ clusterId, kind, objects, actionIds, onClear }: SelectionBarProps) {
  const { t } = useTranslation();
  useActionsVersion();
  const count = objects.length;
  const announced = useSelectionAnnouncement(count);
  const entries = count > 0 ? selectionActions(objects, kind, actionIds) : [];
  return (
    <>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="selection-announce">
        {announced}
      </span>
      {count > 0 && (
        <div className="sel-bar" role="toolbar" aria-label={t("bulk:bar.label")} data-testid="selection-bar">
          <span className="sel-bar__count">{t("bulk:bar.selected", { count })}</span>
          <div className="sel-bar__actions">
            {entries.map((entry) => {
              const label = actionLabel(entry.action, t);
              const partial = entry.left.length > 0;
              const name = partial ? t("bulk:bar.partialLabel", { action: label, part: entry.applying.length, total: count }) : undefined;
              return (
                <Button
                  key={entry.action.id}
                  size="compact"
                  variant={entry.action.danger ? "danger" : "default"}
                  icon={entry.action.icon}
                  aria-label={name}
                  title={name}
                  data-action={entry.action.id}
                  onClick={() => startBarAction(entry, clusterId, kind)}
                >
                  {label}
                  {partial && (
                    <span className="sel-bar__part" aria-hidden>
                      {t("bulk:bar.part", { part: entry.applying.length, total: count })}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
          <Button size="compact" icon="close" onClick={onClear}>
            {t("bulk:bar.clear")}
          </Button>
        </div>
      )}
    </>
  );
}

/** "3 selected" after the selection changed, "Selection cleared" when it emptied; nothing before the first change. */
function useSelectionAnnouncement(count: number): string {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const last = useRef(count);
  useEffect(() => {
    if (last.current === count) return;
    last.current = count;
    setText(count > 0 ? t("bulk:bar.selected", { count }) : t("bulk:bar.cleared"));
  }, [count, t]);
  return text;
}
