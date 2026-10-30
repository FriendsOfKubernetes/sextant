// The problem categories of extensions (ADR-0137): one per extension with problem rules, `ext:<extension id>`, titled
// with its name, after the built-in categories. Registered by the extension host from active extensions' manifests
// (`src/extensions/contributions.tsx`) and removed with them; where each kind's rules run in a cluster (the kinds the
// user agreed to, the namespaces the extension may read) is asked from Rust once per cluster and extension.
//
// These categories are not `PROBLEM_CATEGORIES`: agents never get them (`get_problems` takes only those), the fleet
// cards do not watch them and the timeline does not correlate them.
import { useSyncExternalStore } from "react";
import { api, type ClusterId, type KindRef, type KubeObject, type ProblemContribution, type ProblemScope, type ResourceKind } from "../../api";
import { compileRules, kindKeyOf } from "../../extensions/problemRules";
import { setExtensionDetector, type Detected, type ExtensionCategory, type ProblemCategory } from "./model";
import { MAX_SOURCE_OBJECTS, type SourceDef } from "./sources";

interface Entry {
  category: ExtensionCategory;
  extensionId: string;
  title: string;
  detectors: Map<string, (obj: KubeObject) => Detected[]>;
}

const entries = new Map<ExtensionCategory, Entry>();
/** `cluster|extension` → where its rules run there; "loading" while asked. */
const scopes = new Map<string, readonly ProblemScope[] | "loading">();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export const isExtensionCategory = (category: string): category is ExtensionCategory => category.startsWith("ext:");
export const categoryOfExtension = (extensionId: string): ExtensionCategory => `ext:${extensionId}`;

/** Registers the rules of an active extension (replacing earlier ones); returns what removes them. */
export function registerExtensionProblems(extensionId: string, title: string, rules: readonly ProblemContribution[]): () => void {
  const category = categoryOfExtension(extensionId);
  const entry: Entry = { category, extensionId, title, detectors: compileRules(rules) };
  entries.set(category, entry);
  forgetScopes(extensionId);
  changed();
  return () => {
    if (entries.get(category) !== entry) return;
    entries.delete(category);
    forgetScopes(extensionId);
    changed();
  };
}

function forgetScopes(extensionId: string): void {
  for (const key of [...scopes.keys()]) if (key.endsWith(`|${extensionId}`)) scopes.delete(key);
}

/** The registered categories, by title. */
export function extensionCategories(): ExtensionCategory[] {
  return [...entries.values()].sort((a, b) => a.title.localeCompare(b.title) || a.category.localeCompare(b.category)).map((e) => e.category);
}

/** The extension's name for its category; `undefined` once it is gone. */
export function extensionCategoryTitle(category: ProblemCategory): string | undefined {
  return isExtensionCategory(category) ? entries.get(category)?.title : undefined;
}

/** The problems the category's rules find in `obj` of `kind` (none for a kind it does not judge). */
export function detectExtension(category: ExtensionCategory, kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  return entries.get(category)?.detectors.get(kindKeyOf(kind))?.(obj) ?? [];
}

setExtensionDetector(detectExtension);

export function subscribeExtensionProblems(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function extensionProblemsVersion(): number {
  return version;
}

/** Re-renders on every change of the registered categories or their scopes. */
export function useExtensionProblemsVersion(): number {
  return useSyncExternalStore(subscribeExtensionProblems, extensionProblemsVersion, extensionProblemsVersion);
}

/** The registered categories, the same list until they change. */
export function useExtensionCategories(): readonly ExtensionCategory[] {
  useExtensionProblemsVersion();
  return cachedCategories();
}

let lastCategories: { version: number; list: ExtensionCategory[] } = { version: -1, list: [] };
function cachedCategories(): ExtensionCategory[] {
  if (lastCategories.version !== version) {
    const list = extensionCategories();
    const same = list.length === lastCategories.list.length && list.every((c, i) => c === lastCategories.list[i]);
    lastCategories = { version, list: same ? lastCategories.list : list };
  }
  return lastCategories.list;
}

/** Asks Rust where the rules of the extension categories among `categories` run in the cluster, once each. */
export function requestScopes(clusterId: ClusterId, categories: readonly ProblemCategory[]): void {
  for (const category of categories) {
    const entry = isExtensionCategory(category) ? entries.get(category) : undefined;
    if (!entry) continue;
    const key = `${clusterId}|${entry.extensionId}`;
    if (scopes.has(key)) continue;
    scopes.set(key, "loading");
    api.extensions.problemScopes(entry.extensionId, clusterId).then(
      (found) => {
        // Re-registered or removed meanwhile: that answer belongs to grants that are gone.
        if (scopes.get(key) !== "loading" || entries.get(entry.category) !== entry) return;
        scopes.set(key, found);
        changed();
      },
      () => {
        // Asked again on the next look (an extension list that changed, a reconnect).
        if (scopes.get(key) === "loading") scopes.delete(key);
      },
    );
  }
}

/** Forgets the scopes of a cluster (a connection that ended or began: its context may differ). */
export function forgetClusterScopes(clusterId: ClusterId): void {
  let any = false;
  for (const key of [...scopes.keys()]) {
    if (key.startsWith(`${clusterId}|`)) {
      scopes.delete(key);
      any = true;
    }
  }
  if (any) changed();
}

/**
 * The sources of the extension categories among `categories` in the cluster: one per kind its rules may run on, at
 * the version the cluster serves, narrowed to the namespaces the extension may read. A cluster-scoped kind runs only
 * where it may be read everywhere. Nothing until Rust answered (`requestScopes`).
 */
export function extensionSourcesFor(
  categories: readonly ProblemCategory[],
  clusterId: ClusterId,
  kinds: ResourceKind[] | null | undefined,
): SourceDef[] {
  const out: SourceDef[] = [];
  for (const category of categories) {
    const entry = isExtensionCategory(category) ? entries.get(category) : undefined;
    const scope = entry ? scopes.get(`${clusterId}|${entry.extensionId}`) : undefined;
    if (!entry || !scope || scope === "loading" || !kinds) continue;
    for (const { kind, namespaces } of scope) {
      if (!entry.detectors.has(kindKeyOf(kind))) continue;
      const served = kinds.find((k) => kindKeyOf(k.kindRef) === kindKeyOf(kind));
      if (!served) continue;
      const everywhere = namespaces.type === "all";
      if (!served.namespaced && !everywhere) continue;
      out.push({
        category,
        kind: served.kindRef,
        fieldSelector: null,
        discovered: true,
        maxObjects: MAX_SOURCE_OBJECTS,
        ...(everywhere || !served.namespaced ? {} : { namespaces: namespaces.namespaces }),
      });
    }
  }
  return out;
}
