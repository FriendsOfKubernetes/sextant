// The objects the two actions create (ADR-0086), built from the window's fields and nothing else, so what the
// confirmation lists is exactly what `resources.create` posts; ported unchanged from Sextant's former built-in view
// (`src/features/storage/forms.ts`):
//   veleroBackupOf   — "Back up namespace…": a Velero Backup of that one namespace, in Velero's namespace;
//   veleroRestoreOf  — "Restore from this backup…": a Velero Restore, optionally into other namespaces.
// With `existingResourcePolicy` unset (none) Velero skips most objects that already exist; some kinds (ServiceAccounts)
// are merged.
import type { KubeObject } from "@sextant/extension-sdk";

/** A DNS-1123 subdomain (most object names). */
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** A DNS-1123 label (namespace names). */
const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** A Go duration as Velero reads a TTL: "720h", "72h0m0s", "30m". */
const DURATION = /^(\d+h)?(\d+m)?(\d+s)?$/;

/** Velero's own default TTL of a backup: 30 days. */
export const DEFAULT_TTL = "720h0m0s";

/** Names Velero also writes as label values: at most 63 characters. */
const MAX_LABEL_NAME = 63;

/** A name Velero also writes into labels. */
export const validVeleroName = (name: string): boolean => name.length <= MAX_LABEL_NAME && SUBDOMAIN.test(name);
export const validNamespace = (name: string): boolean => name.length <= 63 && LABEL.test(name);
export const validTtl = (ttl: string): boolean => ttl !== "" && DURATION.test(ttl);

/** `20261019-1432` for a name suffix. */
export function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** `<base>-<suffix>` within `max` characters: the base is cut (and a trailing dash or dot dropped). */
export function suffixed(base: string, suffix: string, max = MAX_LABEL_NAME): string {
  const room = max - suffix.length - 1;
  const cut = base.slice(0, Math.max(1, room)).replace(/[-.]+$/, "");
  return `${cut}-${suffix}`;
}

export interface BackupForm {
  /** Velero's namespace. */
  veleroNamespace: string;
  name: string;
  /** The namespace backed up. */
  namespace: string;
  ttl: string;
  /** `""`: Velero's default location. */
  storageLocation: string;
}

export function veleroBackupOf(f: BackupForm): KubeObject {
  return {
    apiVersion: "velero.io/v1",
    kind: "Backup",
    metadata: { name: f.name, namespace: f.veleroNamespace },
    spec: {
      includedNamespaces: [f.namespace],
      ttl: f.ttl,
      ...(f.storageLocation ? { storageLocation: f.storageLocation } : {}),
    },
  };
}

export interface RestoreForm {
  veleroNamespace: string;
  name: string;
  backup: string;
  /** Source namespace → target namespace; only the entries that differ are written. */
  mapping: Record<string, string>;
}

export function veleroRestoreOf(f: RestoreForm): KubeObject {
  const mapping = Object.fromEntries(Object.entries(f.mapping).filter(([from, to]) => to !== "" && to !== from));
  return {
    apiVersion: "velero.io/v1",
    kind: "Restore",
    metadata: { name: f.name, namespace: f.veleroNamespace },
    spec: {
      backupName: f.backup,
      ...(Object.keys(mapping).length > 0 ? { namespaceMapping: mapping } : {}),
    },
  };
}

/** "Backup velero/shop-20261019-1432". */
export function describeObject(obj: KubeObject): string {
  const ns = obj.metadata?.namespace;
  return `${obj.kind ?? ""} ${ns ? `${ns}/` : ""}${obj.metadata?.name ?? ""}`;
}
