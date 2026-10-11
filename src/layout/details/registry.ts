// Sections of the details panel. Features add blocks (metadata, events, metrics, port forwarding, …)
// by registering them; the panel shows every section whose `appliesTo(kind)` is true, by `order`.
import { useEffect, useState, type ComponentType } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type KubeObject, type ObjectRef } from "../../api";

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
}

const sections = new Map<string, DetailsSectionDef>();

export function registerDetailsSection(def: DetailsSectionDef): void {
  sections.set(def.id, def);
}

export function unregisterDetailsSection(id: string): void {
  sections.delete(id);
}

export function getDetailsSections(kind: KindRef): DetailsSectionDef[] {
  return [...sections.values()]
    .filter((s) => s.appliesTo(kind))
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
