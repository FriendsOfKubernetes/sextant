// Printer columns of a custom resource, read from its one CRD (`<plural>.<group>`) when its table opens: discovery
// carries no columns, and the list of all CRDs (with their schemas, megabytes on a big cluster) is never needed.
import { useEffect, useSyncExternalStore } from "react";
import { api, type ClusterId, type PrinterColumn, type ResourceKind } from "../api";
import { CRD_KIND } from "./kinds/custom";

/** Columns by `cluster|group|plural|version`; `null` while being read. */
const cache = new Map<string, PrinterColumn[] | null>();
const listeners = new Set<() => void>();

function keyOf(clusterId: ClusterId, kind: ResourceKind): string {
  return [clusterId, kind.kindRef.group, kind.plural, kind.kindRef.version].join("|");
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** The `additionalPrinterColumns` of `version` in a CRD object. */
export function crdPrinterColumns(crd: unknown, version: string): PrinterColumn[] {
  const versions = (crd as { spec?: { versions?: unknown } } | null)?.spec?.versions;
  if (!Array.isArray(versions)) return [];
  const entry = versions.find((v) => (v as { name?: unknown }).name === version) as
    | { additionalPrinterColumns?: unknown }
    | undefined;
  const columns = entry?.additionalPrinterColumns;
  if (!Array.isArray(columns)) return [];
  return columns.flatMap((c) => {
    const { name, jsonPath, type, priority } = c as Record<string, unknown>;
    if (typeof name !== "string" || typeof jsonPath !== "string") return [];
    return [
      {
        name,
        jsonPath,
        type: typeof type === "string" ? type : "string",
        priority: typeof priority === "number" ? priority : 0,
      },
    ];
  });
}

function load(clusterId: ClusterId, kind: ResourceKind): void {
  const key = keyOf(clusterId, kind);
  if (cache.has(key)) return;
  cache.set(key, null);
  const ref = { kind: CRD_KIND, namespace: null, name: `${kind.plural}.${kind.kindRef.group}` };
  const done = (columns: PrinterColumn[]) => {
    // Forgotten meanwhile (the cluster reconnected): the answer belongs to the old connection.
    if (!cache.has(key)) return;
    cache.set(key, columns);
    notify();
  };
  // Without the right to read the CRD (or for a kind no CRD defines) the table has the standard columns only.
  api.resources.get(clusterId, ref).then(
    (crd) => done(crdPrinterColumns(crd, kind.kindRef.version)),
    () => done([]),
  );
}

/**
 * The printer columns of the custom kind `kind` (`null` for none or while they are read). Read once per cluster
 * connection.
 */
export function useCrdPrinterColumns(clusterId: ClusterId, kind: ResourceKind | null): PrinterColumn[] | null {
  const key = kind ? keyOf(clusterId, kind) : null;
  const columns = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (key ? (cache.get(key) ?? null) : null),
    () => null,
  );
  useEffect(() => {
    if (kind) load(clusterId, kind);
  }, [clusterId, kind]);
  return columns;
}

/** Forgets the columns read for a cluster (a new connection may serve changed CRDs); all clusters without one. */
export function forgetCrdPrinterColumns(clusterId?: ClusterId): void {
  for (const key of [...cache.keys()]) {
    if (clusterId === undefined || key.startsWith(`${clusterId}|`)) cache.delete(key);
  }
  notify();
}
