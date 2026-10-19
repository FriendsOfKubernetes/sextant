// The counterpart of an object: a connected cluster, a namespace and a name. Only connected clusters are offered; a
// cluster that is not connected is connected only by the user's click on "Connect". Names are suggested from the
// palette's object index (metadata-only watches of the kind, started at the first typed character, shared with the
// palette and stopped when nobody uses them).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef } from "../../api";
import { Button } from "../../components";
import { useClusterKinds } from "../../resources/useKinds";
import { connectCluster } from "../clusters/clustersStore";
import { useObjectIndex, type SearchKind } from "../palette/objectIndex";
import { useClusterChoices, type ClusterChoice } from "./hooks";

/** Suggested names shown at most. */
const MAX_SUGGESTIONS = 20;

export interface Target {
  clusterId: ClusterId;
  namespace: string;
  name: string;
}

export interface TargetPickerProps {
  kind: KindRef;
  namespaced: boolean;
  value: Target;
  onChange: (value: Target) => void;
}

export function TargetPicker({ kind, namespaced, value, onChange }: TargetPickerProps) {
  const { t } = useTranslation();
  const choices = useClusterChoices();
  const connected = choices.filter((c) => c.connected);
  const [searching, setSearching] = useState(false);
  return (
    <div className="compare-target">
      <label className="compare-field">
        <span>{t("compare:target.cluster")}</span>
        <select
          className="compare-input"
          value={connected.some((c) => c.id === value.clusterId) ? value.clusterId : ""}
          onChange={(e) => onChange({ ...value, clusterId: e.target.value })}
        >
          {connected.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <ConnectOther choices={choices.filter((c) => !c.connected)} />
      {namespaced && (
        <label className="compare-field">
          <span>{t("compare:target.namespace")}</span>
          <input className="compare-input" value={value.namespace} onChange={(e) => onChange({ ...value, namespace: e.target.value.trim() })} />
        </label>
      )}
      <label className="compare-field">
        <span>{t("compare:target.name")}</span>
        <input
          className="compare-input"
          value={value.name}
          onChange={(e) => {
            setSearching(true);
            onChange({ ...value, name: e.target.value.trim() });
          }}
        />
      </label>
      {searching && (
        <Suggestions kind={kind} target={value} namespaced={namespaced} onPick={(name, namespace) => onChange({ ...value, name, namespace })} />
      )}
    </div>
  );
}

/** Clusters that are not connected, and a "Connect" button: nothing is connected without this click. */
export function ConnectOther({ choices }: { choices: ClusterChoice[] }) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  if (choices.length === 0) return null;
  const id = choices.some((c) => c.id === picked) ? picked : (choices[0]?.id ?? "");
  return (
    <div className="compare-field compare-connect">
      <span>{t("compare:target.notConnected")}</span>
      <select className="compare-input" value={id} aria-label={t("compare:target.notConnected")} onChange={(e) => setPicked(e.target.value)}>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void connectCluster(id).finally(() => setBusy(false));
        }}
      >
        {busy ? t("compare:target.connecting") : t("compare:target.connect")}
      </Button>
    </div>
  );
}

function Suggestions({
  kind,
  target,
  namespaced,
  onPick,
}: {
  kind: KindRef;
  target: Target;
  namespaced: boolean;
  onPick: (name: string, namespace: string) => void;
}) {
  const { t } = useTranslation();
  const { kinds } = useClusterKinds(target.clusterId);
  const search = useMemo<SearchKind[] | null>(() => {
    const resourceKind = kinds?.find((k) => k.kindRef.group === kind.group && k.kindRef.kind === kind.kind);
    return resourceKind ? [{ kind: resourceKind.kindRef, resourceKind }] : null;
  }, [kinds, kind.group, kind.kind]);
  const index = useObjectIndex(target.clusterId, search);
  const items = index.kinds[0]?.state.items;
  const names = useMemo(() => {
    if (!items) return [];
    const query = target.name.toLowerCase();
    const found: Array<{ name: string; namespace: string }> = [];
    for (const obj of items.values()) {
      const name = obj.metadata?.name ?? "";
      const namespace = obj.metadata?.namespace ?? "";
      if (namespaced && target.namespace && namespace !== target.namespace) continue;
      if (query && !name.toLowerCase().includes(query)) continue;
      found.push({ name, namespace });
      if (found.length >= MAX_SUGGESTIONS) break;
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }, [items, target.name, target.namespace, namespaced]);
  if (names.length === 0) return null;
  return (
    <ul className="compare-suggestions" aria-label={t("compare:target.suggestions")}>
      {names.map((n) => (
        <li key={`${n.namespace}/${n.name}`}>
          <button type="button" className="compare-link" onClick={() => onPick(n.name, n.namespace)}>
            {namespaced ? `${n.namespace}/${n.name}` : n.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
