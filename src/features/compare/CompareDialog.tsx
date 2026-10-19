// "Compare with…" (#156): an object against a counterpart — the same or another object of the kind in a connected
// cluster and namespace, its last-applied configuration, or its Helm release's manifest (and the whole release).
// Read-only: nothing is sent to a cluster but reads.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { Button, Dialog, Radio } from "../../components";
import { formatParts } from "../../i18n/format";
import { refOf } from "../../resources/refs";
import { useClusterChoices, useIgnorePaths } from "./hooks";
import { helmReleaseOf, mayHaveLastApplied } from "./objects";
import type { NormalizeOptions } from "./normalize";
import { CompareOptions } from "./Options";
import { HelmResult, LastAppliedResult, ObjectResult } from "./results";
import { TargetPicker, type Target } from "./TargetPicker";

export type CompareMode = "object" | "lastApplied" | "helm";

export interface CompareDialogProps {
  clusterId: ClusterId;
  kind: KindRef;
  object: KubeObject;
  onClose: () => void;
}

export function CompareDialog({ clusterId, kind, object, onClose }: CompareDialogProps) {
  const { t } = useTranslation();
  const ref = refOf(object, kind);
  const namespaced = Boolean(ref.namespace);
  const release = helmReleaseOf(object);
  const lastApplied = mayHaveLastApplied(object, kind);
  const [mode, setMode] = useState<CompareMode>("object");
  const [draft, setDraft] = useState<Target>({ clusterId, namespace: ref.namespace ?? "", name: ref.name });
  const [target, setTarget] = useState<Target | null>(null);
  const [hideDefaults, setHideDefaults] = useState(false);
  const ignore = useIgnorePaths(kind);
  const options = useMemo<NormalizeOptions>(() => ({ hideDefaults, ignorePaths: ignore.paths }), [hideDefaults, ignore.paths]);
  const choices = useClusterChoices();
  const clusterLabel = (id: ClusterId) => choices.find((c) => c.id === id)?.label ?? id;
  const describe = (id: ClusterId, ns: string | null, name: string) => formatParts([clusterLabel(id), ns ? `${ns}/${name}` : name]);
  const ready = draft.name !== "" && (!namespaced || draft.namespace !== "") && choices.some((c) => c.id === draft.clusterId && c.connected);
  const modes: Array<[CompareMode, boolean]> = [
    ["object", true],
    ["lastApplied", lastApplied],
    ["helm", release !== null],
  ];

  return (
    <Dialog
      open
      title={t("compare:dialog.title", { kind: kind.kind, name: ref.name })}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("common:actions.close")}</Button>}
    >
      <div className="compare-dialog">
        <fieldset className="compare-modes">
          <legend>{t("compare:dialog.with")}</legend>
          {modes.map(([id, available]) => (
            <label key={id} className="compare-check" title={available ? undefined : t(`compare:dialog.unavailable.${id}`)}>
              <Radio name="compare-mode" checked={mode === id} disabled={!available} onChange={() => setMode(id)} />
              {t(`compare:dialog.modes.${id}`)}
            </label>
          ))}
        </fieldset>
        {mode === "object" && (
          <form
            className="compare-pick"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) setTarget(draft);
            }}
          >
            <TargetPicker kind={kind} namespaced={namespaced} value={draft} onChange={setDraft} />
            <Button type="submit" variant="primary" disabled={!ready}>
              {t("compare:dialog.compare")}
            </Button>
          </form>
        )}
        <CompareOptions kind={kind} hideDefaults={hideDefaults} onHideDefaults={setHideDefaults} />
        {mode === "object" && target && (
          <ObjectResult
            clusterId={clusterId}
            kind={kind}
            object={object}
            target={target}
            options={options}
            leftTitle={describe(clusterId, ref.namespace, ref.name)}
            rightTitle={describe(target.clusterId, namespaced ? target.namespace : null, target.name)}
          />
        )}
        {mode === "lastApplied" && <LastAppliedResult clusterId={clusterId} kind={kind} object={object} options={options} />}
        {mode === "helm" && release && (
          <HelmResult clusterId={clusterId} kind={kind} object={object} release={release} options={options} hideDefaults={hideDefaults} />
        )}
      </div>
    </Dialog>
  );
}

/** Opens the dialog through an action's `openDialog`. */
export function compareDialog(clusterId: ClusterId, kind: KindRef, object: KubeObject) {
  return (close: () => void) => <CompareDialog clusterId={clusterId} kind={kind} object={object} onClose={close} />;
}
