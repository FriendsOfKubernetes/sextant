// Pieces the "Related" tab and the map share: the health dot, opening a node's details, lists in the UI language.
import { useTranslation } from "react-i18next";
import type { KindRef, ObjectRef, ResourceKind } from "../../api";
import { useAppStore } from "../../app/store";
import { formatList } from "../../i18n/format";
import { findKind } from "../../resources";
import type { MapHealth } from "./health";
import { knownKind } from "./kinds";
import type { GraphNode } from "./relations";

export function HealthDot({ health }: { health: MapHealth }) {
  const { t } = useTranslation();
  return <span className={`rmap-dot rmap-dot--${health}`} role="img" aria-label={t(`resourcemap:health.${health}`)} />;
}

/** The ref to open a node's details with; `null` when its kind's version cannot be told (not served). */
export function objectRefOf(node: GraphNode, kinds: ResourceKind[] | null): ObjectRef | null {
  const { ref } = node;
  const kind: KindRef | undefined =
    node.kind ??
    findKind(kinds, ref)?.kindRef ??
    (ref.version ? { group: ref.group, version: ref.version, kind: ref.kind } : knownKind(ref));
  return kind ? { kind, namespace: ref.namespace, name: ref.name } : null;
}

export function useOpenDetails(): (ref: ObjectRef) => void {
  return useAppStore((s) => s.openDetails);
}

/** "Pod, ReplicaSet": names joined with the UI language's list separator. */
export function formatNames(items: readonly string[]): string {
  return formatList(items);
}
