// Saved preferences live only in the shared settings cache. This store retains unsaved edits, including a failed
// write for the current session; the existing settings queue serializes writes with every other settings editor.
import { create } from "zustand";
import { updateSettings, type AppSettings } from "../../api";
import { clusterSettingsOf } from "../../features/clusters/clusterSettings";

type Choices = Record<string, boolean>;
/** Kind-wide default, including subsections that have not mounted yet. */
export const ALL_DETAILS_SECTIONS = "*";
interface Edit { choices: Choices; error: boolean; replace: boolean }
const useEdits = create<{ banks: Record<string, Edit> }>(() => ({ banks: {} }));

const detailsBankKey = (clusterId: string | null, kind: string) => JSON.stringify([clusterId, kind]);

export function useDetailsEdits(clusterId: string | null, kind: string): Edit | undefined {
  return useEdits((s) => s.banks[detailsBankKey(clusterId, kind)]);
}

export function savedDetailsChoices(settings: AppSettings | null, clusterId: string | null, kind: string): Choices | undefined {
  return clusterId === null ? settings?.appearance.detailsSections?.[kind] : settings?.clusters[clusterId]?.detailsSections?.[kind];
}

export function saveDetailsChoice(clusterId: string | null, kind: string, path: string, open: boolean): void {
  const previous = useEdits.getState().banks[detailsBankKey(clusterId, kind)];
  saveDetailsEdit(clusterId, kind, { choices: { ...previous?.choices, [path]: open }, error: false, replace: previous?.replace ?? false });
}

export function saveAllDetailsChoices(clusterId: string | null, kind: string, open: boolean): void {
  saveDetailsEdit(clusterId, kind, { choices: { [ALL_DETAILS_SECTIONS]: open }, error: false, replace: true });
}

function checkDetailsChoiceLimits(kinds: Record<string, Choices> | undefined, kind: string, choices: Choices): void {
  // Match the native reader's bounds. An over-cap edit stays session-only with a visible save error.
  const kindCount = new Set([...Object.keys(kinds ?? {}), kind]).size;
  const paths = Object.keys(choices);
  if (kindCount > 256 || paths.length > 256 || kind.length > 240 || paths.some((path) => path.length > 240)) {
    throw new Error("Details section settings exceed their storage limit");
  }
}

function saveDetailsEdit(clusterId: string | null, kind: string, edit: Edit): void {
  const key = detailsBankKey(clusterId, kind);
  useEdits.setState((s) => ({ banks: { ...s.banks, [key]: edit } }));
  void updateSettings((settings) => {
    const choices = edit.replace ? edit.choices : { ...savedDetailsChoices(settings, clusterId, kind), ...edit.choices };
    const kinds = clusterId === null ? settings.appearance.detailsSections : settings.clusters[clusterId]?.detailsSections;
    checkDetailsChoiceLimits(kinds, kind, choices);
    if (clusterId === null) return {
      ...settings,
      appearance: { ...settings.appearance, detailsSections: { ...settings.appearance.detailsSections, [kind]: choices } },
    };
    const cluster = clusterSettingsOf(settings, clusterId);
    return { ...settings, clusters: { ...settings.clusters, [clusterId]: {
      ...cluster, detailsSections: { ...cluster.detailsSections, [kind]: choices },
    } } };
  }).then(
    () => {
      if (useEdits.getState().banks[key] !== edit) return;
      useEdits.setState((s) => { const banks = { ...s.banks }; delete banks[key]; return { banks }; });
    },
    () => {
      if (useEdits.getState().banks[key] !== edit) return;
      useEdits.setState((s) => ({ banks: { ...s.banks, [key]: { ...edit, error: true } } }));
    },
  );
}

/** Test/session reset: saved settings are never modified. */
export function resetDetailsDisclosureState(): void { useEdits.setState({ banks: {} }); }
