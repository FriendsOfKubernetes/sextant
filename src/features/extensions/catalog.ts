// The extension catalog in the window (ADR-0130): reading it through the backend (which alone fetches the index, at
// most once an hour unless the user refreshes), and the small rules of what an entry offers. Nothing here is trusted
// for an install: the backend downloads, checks and verifies the package, and the consent screen shows its manifest.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  toApiError,
  type ApiError,
  type CatalogCategory,
  type CatalogEntry,
  type CatalogStatus,
  type CatalogView,
  type ExtensionInfo,
} from "../../api";

export const CATEGORIES: CatalogCategory[] = [
  "observability",
  "cost",
  "security",
  "gitops",
  "networking",
  "storage",
  "workloads",
  "developer",
  "other",
];

/** The extension API versions this Sextant reads: `MIN_API` to `SUPPORTED_API`, as the core's `supports_api` (a Rust test
 * keeps them equal). */
export const MIN_API = 1;
export const SUPPORTED_API = 2;

/** Whether this Sextant installs an extension written for API version `api`. */
export function supportsApi(api: number): boolean {
  return api >= MIN_API && api <= SUPPORTED_API;
}

/** What an entry offers next to what is installed. */
export type EntryOffer =
  | { kind: "install" }
  | { kind: "installed" }
  | { kind: "update"; version: string }
  | { kind: "needsNewer"; version: string }
  | { kind: "otherSource" }
  | { kind: "pinnedElsewhere" }
  | { kind: "withdrawn"; reason: string };

/** The entry's offer, from the installed extension of its id and the backend's status of it. */
export function offerOf(entry: CatalogEntry, installed: ExtensionInfo | undefined, status: CatalogStatus | undefined): EntryOffer {
  if (entry.withdrawn !== null) return { kind: "withdrawn", reason: entry.withdrawn };
  if (installed === undefined) {
    if (entry.latest !== null && !supportsApi(entry.latest.sextantApi)) return { kind: "needsNewer", version: entry.latest.version };
    return { kind: "install" };
  }
  if (installed.source.type !== "catalog") return { kind: "otherSource" };
  switch (status?.type) {
    case "updateAvailable":
      return { kind: "update", version: status.version };
    case "needsNewerSextant":
      return { kind: "needsNewer", version: status.version };
    case "keyChanged":
    case "repositoryChanged":
      return { kind: "pinnedElsewhere" };
    default:
      return { kind: "installed" };
  }
}

/**
 * The entries shown: those with a release, and withdrawn ones only while installed (to say why). Sorted by name in
 * the UI language's order is left to the caller; the index's order (by id) is kept here.
 */
export function shownEntries(view: CatalogView | null, installedIds: ReadonlySet<string>): CatalogEntry[] {
  const entries = view?.index?.entries ?? [];
  return entries.filter((entry) => (entry.withdrawn === null ? entry.latest !== null : installedIds.has(entry.id)));
}

/** Whether the entry matches the typed words (every word, in its name, id, author or description) and category. */
export function matches(entry: CatalogEntry, query: string, category: CatalogCategory | null): boolean {
  if (category !== null && !entry.categories.includes(category)) return false;
  const text = `${entry.name} ${entry.id} ${entry.author} ${entry.description}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export interface CatalogState {
  view: CatalogView | null;
  loading: boolean;
  /** The command itself failed (a refresh that failed is `view.error`, with the older copy kept). */
  error: ApiError | null;
  load: (refresh: boolean) => Promise<void>;
}

/** The catalog, read once when `active` turns on and on `load`; never while it is off. */
export function useCatalog(active: boolean): CatalogState {
  const [view, setView] = useState<CatalogView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.extensions.catalog(refresh);
      if (live.current) setView(next);
    } catch (err) {
      if (live.current) setError(toApiError(err));
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active) void load(false);
  }, [active, load]);
  return { view, loading, error, load };
}

/** The backend's status of each installed catalog extension. */
export function statusesOf(view: CatalogView | null): Map<string, CatalogStatus> {
  return new Map((view?.installed ?? []).map((s) => [s.id, s.status]));
}

/** `https://github.com/<repository>`, opened in the browser from a click. */
export function repositoryUrl(repository: string): string {
  return `https://github.com/${repository}`;
}
