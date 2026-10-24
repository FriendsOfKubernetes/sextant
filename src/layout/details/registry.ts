// Sections of the details panel. Features add blocks (metadata, events, metrics, port forwarding, …)
// by registering them; the panel shows every section whose `appliesTo(kind)` is true, by `order`. A section placed as
// a tab (`placement: "tab"`, extensions) gets a tab of its own next to "Overview", which holds all the other sections.
import { useEffect, useState, type ComponentType } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { createRegistryVersion } from "../registryVersion";

export interface DetailsSectionProps {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  /** The object, `null` while loading or after an error. */
  obj: KubeObject | null;
}

export interface DetailsSectionDef {
  id: string;
  order: number;
  appliesTo: (kind: KindRef) => boolean;
  Component: ComponentType<DetailsSectionProps>;
  /** `section` (default): stacked with the others; `tab`: a tab of its own, filling the panel. */
  placement?: "section" | "tab";
  /** Title as shown (the tab's label); a `section` draws its own heading. */
  label?: string;
  /** i18n key of the tab's label, translated when shown (in place of `label`). */
  labelKey?: string;
}

const sections = new Map<string, DetailsSectionDef>();
const version = createRegistryVersion();

export function registerDetailsSection(def: DetailsSectionDef): void {
  sections.set(def.id, def);
  version.bump();
}

export function unregisterDetailsSection(id: string): void {
  if (sections.delete(id)) version.bump();
}

/** Re-renders the caller when sections are registered or removed. */
export function useDetailsSectionsVersion(): number {
  return version.use();
}

export function getDetailsSections(kind: KindRef): DetailsSectionDef[] {
  return [...sections.values()]
    .filter((s) => s.appliesTo(kind))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// ---------- Icon buttons of the panel's header (#274) ----------

/** Where a header tool sits: right after the object's name, or right after its namespace line. */
export type DetailsHeaderPlace = "name" | "namespace";

export interface DetailsHeaderToolDef {
  id: string;
  place: DetailsHeaderPlace;
  /** Order within its place, lower first. */
  order: number;
  /** An icon-only button (or nothing). `obj` is `null` while the object loads. */
  Component: ComponentType<DetailsSectionProps>;
}

const headerTools = new Map<string, DetailsHeaderToolDef>();

/** Adds a small tool (copy, pin) next to the name or the namespace in the panel's header, for every kind. */
export function registerDetailsHeaderTool(def: DetailsHeaderToolDef): () => void {
  headerTools.set(def.id, def);
  version.bump();
  return () => {
    if (headerTools.get(def.id) === def && headerTools.delete(def.id)) version.bump();
  };
}

export function getDetailsHeaderTools(place: DetailsHeaderPlace): DetailsHeaderToolDef[] {
  return [...headerTools.values()]
    .filter((tool) => tool.place === place)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export interface DetailsObject {
  obj: KubeObject | null;
  loading: boolean;
  error: ApiError | null;
}

/** Hook that provides the object shown in the details panel. */
export type DetailsObjectSource = (clusterId: ClusterId, ref: ObjectRef) => DetailsObject;

/** Default source: one `resource_get` per opened object. */
export const useFetchOnce: DetailsObjectSource = (clusterId, ref) => {
  const [state, setState] = useState<DetailsObject>({ obj: null, loading: true, error: null });
  const key = JSON.stringify([clusterId, ref]);
  useEffect(() => {
    let cancelled = false;
    setState({ obj: null, loading: true, error: null });
    api.resources.get(clusterId, ref).then(
      (obj) => !cancelled && setState({ obj, loading: false, error: null }),
      (err: unknown) => !cancelled && setState({ obj: null, loading: false, error: toApiError(err) }),
    );
    return () => {
      cancelled = true;
    };
    // `key` captures clusterId and ref by value, so an equal ref does not refetch.
  }, [key]);
  return state;
};

let objectSource: DetailsObjectSource = useFetchOnce;

/**
 * Replaces how the panel obtains the object (e.g. a live watch). Call once at module load —
 * the source is a hook, so it must not change between renders.
 */
export function setDetailsObjectSource(source: DetailsObjectSource): void {
  objectSource = source;
}

export function useDetailsObject(clusterId: ClusterId, ref: ObjectRef): DetailsObject {
  return objectSource(clusterId, ref);
}
