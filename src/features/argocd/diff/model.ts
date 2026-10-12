// What the diff shows for one resource of an Application, and which text explains a failed sign-in. No React here.
import type { ApiError, ArgoStatus, ManagedResource } from "../../../api";
import { toYaml } from "../../details";

/** The two sides of the diff; `null` when the object is missing on that side. */
export interface DiffSides {
  /** What Argo CD would make of the live object after a sync (or the object from Git when there is no prediction). */
  desired: unknown;
  /** The live object as Argo CD compares it (after its `ignoreDifferences` normalization). */
  live: unknown;
}

/**
 * Argo CD's own pairing: the predicted live state against the normalized live state, so fields the API server
 * fills in by itself do not show as differences. An object missing in Git or in the cluster stays missing.
 */
export function sidesOf(resource: ManagedResource): DiffSides {
  const desired = resource.targetState === null ? null : (resource.predictedLiveState ?? resource.targetState);
  const live = resource.liveState === null ? null : (resource.normalizedLiveState ?? resource.liveState);
  return { desired, live };
}

/** Keys sorted at every level, so the same object always gives the same text whatever order the JSON had. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** The YAML of one side; empty for a missing object. */
export function yamlOf(value: unknown): string {
  return value === null || value === undefined ? "" : toYaml(canonical(value));
}

export type DiffState = "changed" | "inSync" | "missingLive" | "missingTarget";

export function stateOf(resource: ManagedResource): DiffState {
  const { desired, live } = sidesOf(resource);
  if (desired === null) return "missingTarget";
  if (live === null) return "missingLive";
  return yamlOf(desired) === yamlOf(live) ? "inSync" : "changed";
}

export const isSecret = (resource: ManagedResource): boolean => resource.group === "" && resource.kind === "Secret";

/** `Kind namespace/name` (or `Kind name` for cluster-scoped objects). */
export function describe(resource: ManagedResource): string {
  return `${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ""}${resource.name}`;
}

export type LoginMode = "password" | "token";

/** The i18n key of the text for a failed sign-in (or a diff that needs one). */
export function loginErrorKey(error: ApiError, status: ArgoStatus | null, mode: LoginMode): string {
  switch (error.code) {
    case "unauthorized":
      if (mode === "password" && status && !status.localUsers) return "argocd:login.errors.ssoOnly";
      return mode === "token" ? "argocd:login.errors.invalidToken" : "argocd:login.errors.invalid";
    case "unreachable":
    case "timeout":
      return "argocd:login.errors.unreachable";
    case "invalid":
      return "argocd:login.errors.incomplete";
    default:
      return "argocd:login.errors.other";
  }
}
