// The problem categories of extensions (ADR-0137): one per extension with problem rules, `ext:<extension id>`, titled
// with its name, after the built-in categories. Registered by the extension host from active extensions' manifests
// (`src/extensions/contributions.tsx`) and removed with them; where each kind's rules run in a cluster (the kinds the
// user agreed to, the namespaces the extension may read) is asked from Rust once per cluster and extension.
//
// These categories are not `PROBLEM_CATEGORIES`: agents never get them (`get_problems` takes only those), the fleet
// cards do not watch them and the timeline does not correlate them.
//
// An extension may also have categories of its own besides the main one (`problemCategories`, #410),
// `ext:<extension id>:<category id>`, each opt-in or not; agents never get these (Rust refuses any but `ext:<id>`).
//
// Rules whose kinds come from definitions (`kindsFrom`, ADR-0137/ADR-0144 amendment) run on the kinds Rust says the
// definitions define in the cluster (scopes with `definedBy`): one source per such kind the cluster serves, judged by
// those rules only (`SourceDef.defined`). The definition kind gets a source of its own whose rows keep the group and
// kinds each definition names; when they change, Rust is asked again (`refreshScopes`, `REFRESH_DELAY_MS` after),
// while the earlier answer stands.
import { useSyncExternalStore } from "react";
import {
  api,
  type ClusterId,
  type KindRef,
  type KindsFrom,
  type KubeObject,
  type ProblemContribution,
  type ProblemJudgeContribution,
  type ProblemScope,
  type ResourceKind,
  type RuleSource,
} from "../../api";
import { compileRules, kindKeyOf, type Lookup, type RuleContext } from "../../extensions/problemRules";
import { comparedPaths, factsOf, judgeAcross, judgedAcross, judgesOf, lookedUp, referrersOf, rowOf, selectedKinds, type AcrossTarget, type ReferrerRule } from "../../extensions/problemsAcross";
import { judgedFact, judgedFacts, judgeReads, NOT_SERVED_ROWS, observeJudge, type JudgeInput } from "../../extensions/problemJudges";
import { setExtensionDetector, setExtensionOptIn, type Detected, type ExtensionCategory, type ProblemCategory } from "./model";
import { MAX_SOURCE_OBJECTS, sourceKey, type JudgedRows, type SourceDef } from "./sources";

interface Entry {
  category: ExtensionCategory;
  extensionId: string;
  title: string;
  detectors: Map<string, (obj: KubeObject, ctx?: RuleContext) => Detected[]>;
  /** The rules by id. */
  rules: ReadonlyMap<string, ProblemContribution>;
  /** `group/kind` (lower case) of the kinds judged across objects (ADR-0144): their rules' or looked up. */
  across: ReadonlySet<string>;
  /** `group/kind` → the number its rules' `newestBy` ranks newest by (#404). */
  newestBy: ReadonlyMap<string, string>;
  /** `group/kind` → the labels `newestPer` of its rules names. */
  newestLabels: ReadonlyMap<string, readonly string[]>;
  /** `group/kind` → the `related` conditions' own `when`s its rows answer (#409). */
  facts: ReadonlyMap<string, readonly ProblemContribution["when"][]>;
  /** `group/kind` → the `source` its rules share (ADR-0152). */
  sources: ReadonlyMap<string, RuleSource>;
  /** `group/kind` of the kinds a `selectsNone` selects from: their rows keep every label (#404). */
  selected: ReadonlySet<string>;
  /** `group/kind` → the paths a `relatedBy` compares on it: its rows keep their texts (#404). */
  compared: ReadonlyMap<string, readonly string[]>;
  /** `group/kind` → how its rules' objects are named by others of the kind: its rows keep those names (#404). */
  referrers: ReadonlyMap<string, readonly ReferrerRule[]>;
  /** Off until the user turns it on (a category of the extension's own, #410). */
  optIn: boolean;
  /** The judges its rules' `judged` conditions name (ADR-0168): the backend decides their facts. */
  judges: readonly ProblemJudgeContribution[];
  /** `group/kind` → the paths the judges read of it: its rows keep their values. */
  judgedPaths: ReadonlyMap<string, readonly string[]>;
  /** Where its `kindsFrom` rules' kinds come from (one per extension); their detector is under `FROM_KEY`. */
  kindsFrom?: KindsFrom;
  /** `group/kind` of the looked-up kinds listed only where the lookups name (`contributes.narrowLookups`). */
  narrowed: ReadonlySet<string>;
  /** The extension's `sextantApi` (ADR-0169: what the window applies from 5). */
  api: number;
}

/** `cluster|category` → the targets of its rules across objects as the latest look built them. */
const currentTargets = new Map<string, AcrossTarget[]>();

/** A narrowed lookup kind is listed in at most this many namespaces; past it, wherever the extension may read. */
export const MAX_NARROWED_NAMESPACES = 40;

/**
 * `cluster|extension|source` → per narrowed kind the namespaces the judged objects' lookups name there (`null`: every
 * one, a `selectsNone` of every namespace), as the source's latest problems had them.
 */
const lookupNamespaces = new Map<string, Map<string, Set<string> | null>>();
let lookupTimer: ReturnType<typeof setTimeout> | undefined;

/** The key a source's lookups are kept under: `cluster|extension|category|source`. */
const lookupKey = (clusterId: ClusterId, entry: Pick<Entry, "extensionId" | "category">, def: SourceDef): string =>
  `${clusterId}|${entry.extensionId}|${entry.category}|${sourceKey(clusterId, def)}`;

/** Where the lookups of a source's problems point, for the narrowed kinds; a change rebuilds the sources shortly after. */
function noteLookups(key: string, narrowed: ReadonlySet<string>, problems: readonly { lookups?: readonly Lookup[]; object: { namespace: string | null } }[]): void {
  const found = new Map<string, Set<string> | null>();
  for (const p of problems) {
    for (const lookup of p.lookups ?? []) {
      // A `missing` with `alsoKinds` (ADR-0169) names the same place in each of its kinds.
      for (const kind of [lookup, ...(lookup.also ?? [])].map(kindKeyOf)) {
        if (!narrowed.has(kind) || found.get(kind) === null) continue;
        const namespaces = lookup.selects ? lookup.selects.namespaces : [lookup.namespace ?? p.object.namespace ?? ""];
        if (namespaces === null) {
          found.set(kind, null);
          continue;
        }
        const set = found.get(kind) ?? new Set<string>();
        for (const ns of namespaces) if (ns !== "") set.add(ns);
        found.set(kind, set);
      }
    }
  }
  const text = (m: Map<string, Set<string> | null> | undefined) =>
    JSON.stringify([...(m ?? new Map()).entries()].map(([k, v]) => [k, v === null ? null : [...v].sort()]).sort());
  if (text(found) === text(lookupNamespaces.get(key))) return;
  lookupNamespaces.set(key, found);
  if (lookupTimer === undefined) {
    lookupTimer = setTimeout(() => {
      lookupTimer = undefined;
      changed();
    }, REFRESH_DELAY_MS);
  }
}

/** The namespaces a narrowed kind is listed in for the extension in the cluster: `undefined` while no source said. */
function narrowedNamespaces(clusterId: ClusterId, extensionId: string, kind: string): Set<string> | null | undefined {
  const prefix = `${clusterId}|${extensionId}|`;
  let out: Set<string> | null | undefined;
  for (const [key, kinds] of lookupNamespaces) {
    if (!key.startsWith(prefix) || !kinds.has(kind)) continue;
    const these = kinds.get(kind)!;
    if (these === null) return null;
    out = new Set([...(out ?? []), ...these]);
  }
  return out;
}

/** The kind `kindsFrom` rules are compiled under: no kind's key (a kind has no `#`). */
const FROM_KIND = { group: "", kind: "#defined" };
const FROM_KEY = kindKeyOf(FROM_KIND);
/** After the definitions' rows change, Rust is asked again this much later (changes in a burst ask once). */
export const REFRESH_DELAY_MS = 1000;

/** Whether a field path reads only under `.metadata` (`.metadata.labels`, `metadata.name`). */
const underMetadata = (path: string): boolean => /^\.?metadata(\.|\[|$)/.test(path.trim());

/** The tap id of a source judged across objects (`SourceDef.judge`): the same on every source of a category. */
const ACROSS_TAP = "ext-across";

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
export const categoryOfExtension = (extensionId: string, sub?: string): ExtensionCategory =>
  sub === undefined ? `ext:${extensionId}` : `ext:${extensionId}:${sub}`;

/** The registered categories of an extension: its main one and those of its own (#410). */
export function categoriesOfExtension(extensionId: string): ExtensionCategory[] {
  return [...entries.values()].filter((e) => e.extensionId === extensionId).map((e) => e.category);
}

/** Whether a registered extension category is opt-in. */
export const isOptInExtensionCategory = (category: ProblemCategory): boolean =>
  isExtensionCategory(category) && (entries.get(category)?.optIn ?? false);

setExtensionOptIn(isOptInExtensionCategory);

/**
 * Registers the rules of an active extension (replacing earlier ones); returns what removes them. `own`: a category of
 * the extension's own (#410) these rules belong to instead of its main one.
 */
export function registerExtensionProblems(
  extensionId: string,
  title: string,
  rules: readonly ProblemContribution[],
  own?: { id: string; optIn: boolean },
  manifestJudges: readonly ProblemJudgeContribution[] = [],
  narrowLookups: readonly { group: string; kind: string }[] = [],
  api = 4,
): () => void {
  const category = categoryOfExtension(extensionId, own?.id);
  // Rules of kinds from definitions are one detector, applied to the sources of the kinds Rust says are defined.
  const kindsFrom = rules.find((rule) => rule.kindsFrom !== undefined)?.kindsFrom;
  const detectors = compileRules(rules.filter((rule) => rule.kindsFrom === undefined));
  const fromDetector = compileRules(rules.filter((rule) => rule.kindsFrom !== undefined).map((rule) => ({ ...rule, kind: FROM_KIND }))).get(FROM_KEY);
  if (fromDetector) detectors.set(FROM_KEY, fromDetector);
  // The judges of these rules (ADR-0168): every kind they read gets a source, its rows the declared paths.
  const named = new Set(rules.flatMap((rule) => judgesOf(rule.when)));
  const judges = manifestJudges.filter((judge) => named.has(judge.id));
  const judgedPaths = new Map<string, string[]>();
  for (const read of judges.flatMap((judge) => judge.reads)) {
    const key = kindKeyOf(read.kind);
    judgedPaths.set(key, [...new Set([...(judgedPaths.get(key) ?? []), ...read.paths])]);
  }
  const across = new Set<string>();
  const newestLabels = new Map<string, string[]>();
  for (const rule of rules) {
    if (!judgedAcross(rule)) continue;
    const key = kindKeyOf(rule.kind);
    across.add(key);
    for (const target of lookedUp(rule.when)) across.add(kindKeyOf(target));
    if (judgesOf(rule.when).length > 0) for (const key of judgedPaths.keys()) across.add(key);
    if (rule.newestPer !== undefined) newestLabels.set(key, [...new Set([...(newestLabels.get(key) ?? []), rule.newestPer])]);
  }
  // The definitions get a source, their rows the names they define.
  if (kindsFrom) across.add(kindKeyOf(kindsFrom.kind));
  const sources = new Map<string, RuleSource>();
  for (const rule of rules) if (rule.source) sources.set(rule.kindsFrom ? FROM_KEY : kindKeyOf(rule.kind), rule.source);
  const entry: Entry = {
    category,
    extensionId,
    title,
    detectors,
    rules: new Map(rules.map((r) => [r.id, r])),
    across,
    newestLabels,
    facts: factsOf(rules, kindKeyOf),
    selected: selectedKinds(rules, kindKeyOf),
    compared: comparedPaths(rules, kindKeyOf),
    newestBy: new Map(rules.flatMap((r) => (r.newestBy !== undefined ? [[kindKeyOf(r.kind), r.newestBy] as const] : []))),
    referrers: referrersOf(rules, kindKeyOf),
    sources,
    optIn: own?.optIn ?? false,
    judges,
    judgedPaths,
    ...(kindsFrom ? { kindsFrom } : {}),
    narrowed: new Set(narrowLookups.map(kindKeyOf)),
    api,
  };
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
  // Another category of the extension still registered keeps the answer: it is per extension.
  if ([...entries.values()].some((e) => e.extensionId === extensionId)) return;
  for (const key of [...scopes.keys()]) if (key.endsWith(`|${extensionId}`)) forgetScope(key);
}

/** Forgets one `cluster|extension` answer and what follows the definitions there. */
function forgetScope(key: string): void {
  scopes.delete(key);
  definitionsSeen.delete(key);
  const timer = refreshTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  refreshTimers.delete(key);
}

/** `cluster|extension` → the names its definitions defined when last looked at. */
const definitionsSeen = new Map<string, string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The rows of an extension's definitions in a cluster were looked at: when the names they define changed, Rust is
 * asked again where the rules run (`REFRESH_DELAY_MS` later); the answer it gave stands meanwhile.
 */
function noteDefinitions(clusterId: ClusterId, extensionId: string, rows: JudgedRows | undefined): void {
  if (!rows || (rows.status !== "ready" && rows.status !== "reconnecting")) return;
  const key = `${clusterId}|${extensionId}`;
  const names = [...new Set([...rows.rows.values()].flatMap((row) => (row as { defines?: string[] }).defines ?? []))].sort().join("\n");
  if (definitionsSeen.get(key) === names) return;
  definitionsSeen.set(key, names);
  if (refreshTimers.has(key)) return;
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      refreshScopes(clusterId, extensionId);
    }, REFRESH_DELAY_MS),
  );
}

/** Asks Rust again where an extension's rules run in a cluster, keeping its answer until the new one comes. */
function refreshScopes(clusterId: ClusterId, extensionId: string): void {
  const key = `${clusterId}|${extensionId}`;
  const before = scopes.get(key);
  // Not asked yet, or being asked (that answer lists the definitions then): asked again a little later.
  if (before === "loading") {
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        refreshScopes(clusterId, extensionId);
      }, REFRESH_DELAY_MS),
    );
    return;
  }
  if (before === undefined) return;
  api.extensions.problemScopes(extensionId, clusterId).then(
    (found) => {
      // Forgotten or answered anew meanwhile: this answer belongs to grants or a connection that are gone.
      if (scopes.get(key) !== before) return;
      if (JSON.stringify(found) === JSON.stringify(before)) return;
      scopes.set(key, found);
      changed();
    },
    () => undefined,
  );
}

/** The registered categories, by title. */
export function extensionCategories(): ExtensionCategory[] {
  return [...entries.values()].sort((a, b) => a.title.localeCompare(b.title) || a.category.localeCompare(b.category)).map((e) => e.category);
}

/** The kinds the problem judges of a registered category read (ADR-0168), as `{group, kind}`. */
export function extensionJudgedKinds(category: ProblemCategory): { group: string; kind: string }[] {
  const entry = isExtensionCategory(category) ? entries.get(category) : undefined;
  return entry ? entry.judges.flatMap((judge) => judge.reads.map((read) => read.kind)) : [];
}

/** The extension's name for its category; `undefined` once it is gone. */
export function extensionCategoryTitle(category: ProblemCategory): string | undefined {
  return isExtensionCategory(category) ? entries.get(category)?.title : undefined;
}

/** The problems the category's rules find in `obj` of `kind` (none for a kind it does not judge). */
export function detectExtension(
  category: ExtensionCategory,
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
  ctx?: RuleContext & { defined?: boolean },
): Detected[] {
  const entry = entries.get(category);
  if (!entry) return [];
  const own = entry.detectors.get(kindKeyOf(kind))?.(obj, ctx) ?? [];
  // A kind its definitions define (`kindsFrom`): those rules too.
  const defined = ctx?.defined === true ? (entry.detectors.get(FROM_KEY)?.(obj, ctx) ?? []) : [];
  return defined.length > 0 ? [...own, ...defined] : own;
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

/** Whether Rust has answered where the rules of each extension category among `categories` run in the cluster. */
export function scopesKnown(clusterId: ClusterId, categories: readonly ProblemCategory[]): boolean {
  return categories.every((category) => {
    const entry = isExtensionCategory(category) ? entries.get(category) : undefined;
    if (!entry) return true;
    const scope = scopes.get(`${clusterId}|${entry.extensionId}`);
    return scope !== undefined && scope !== "loading";
  });
}

/** Forgets the scopes of a cluster (a connection that ended or began: its context may differ). */
export function forgetClusterScopes(clusterId: ClusterId): void {
  for (const k of [...lookupNamespaces.keys()]) if (k.startsWith(`${clusterId}|`)) lookupNamespaces.delete(k);
  for (const k of [...currentTargets.keys()]) if (k.startsWith(`${clusterId}|`)) currentTargets.delete(k);
  let any = false;
  for (const key of [...scopes.keys()]) {
    if (key.startsWith(`${clusterId}|`)) {
      forgetScope(key);
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
    const judged: { def: SourceDef; key: string }[] = [];
    const targets: AcrossTarget[] = [];
    const targetsKey = `${clusterId}|${category}`;
    for (const { kind, namespaces, definedBy, moreDefinitions } of scope) {
      const key = kindKeyOf(kind);
      // A kind its definitions define (`kindsFrom`): its rules only, where Rust found it defined.
      const defined = definedBy !== undefined;
      if (defined && !entry.kindsFrom) continue;
      // A kind only looked up (`missing`) gets a source too: its rows hold the names.
      if (!defined && !entry.detectors.has(key) && !entry.across.has(key)) continue;
      const served = kinds.find((k) => kindKeyOf(k.kindRef) === key);
      if (!served) continue;
      const everywhere = namespaces.type === "all";
      if (!served.namespaced && !everywhere) continue;
      const source = entry.sources.get(defined ? FROM_KEY : key);
      if (defined) {
        out.push({
          category,
          kind: served.kindRef,
          fieldSelector: null,
          discovered: true,
          maxObjects: source?.maxObjects ?? MAX_SOURCE_OBJECTS,
          ...(everywhere || !served.namespaced ? {} : { namespaces: namespaces.namespaces }),
          ...(source?.labelSelector ? { labelSelector: source.labelSelector } : {}),
          ...(source?.metadataOnly ? { metadataOnly: true } : {}),
          defined: true,
        });
        continue;
      }
      // A kind only looked up and listed in part (`narrowLookups`): just the namespaces the judged objects' lookups name
      // (within those it may read), nothing before any source said, everywhere past `MAX_NARROWED_NAMESPACES`.
      let listedIn: readonly string[] | undefined = everywhere ? undefined : namespaces.namespaces;
      if (entry.narrowed.has(key) && served.namespaced) {
        const needed = narrowedNamespaces(clusterId, entry.extensionId, key);
        if (needed !== null) {
          if (needed === undefined || needed.size === 0) continue;
          if (needed.size <= MAX_NARROWED_NAMESPACES) {
            const within = [...needed].filter((ns) => everywhere || namespaces.namespaces.includes(ns)).sort();
            if (within.length === 0) continue;
            listedIn = within;
          }
        }
      }
      const def: SourceDef = {
        category,
        kind: served.kindRef,
        // A rule's `source.fieldSelector` (#409), checked against the fields the API server selects the kind by.
        fieldSelector: source?.fieldSelector ?? null,
        discovered: true,
        // The rules' own cap (#404), else Sextant's.
        maxObjects: source?.maxObjects ?? MAX_SOURCE_OBJECTS,
        ...(listedIn === undefined || !served.namespaced ? {} : { namespaces: listedIn }),
        ...(source?.labelSelector ? { labelSelector: source.labelSelector } : {}),
        // A kind only looked up by name or labels (`missing`, `selectsNone`, #404) is listed metadata-only: a Secret never
        // with a value, Services and Pods without their specs. `related`/`relatedBy` read fields, so theirs stay whole,
        // and so do a judge's when it reads a path outside `.metadata` (ADR-0168) and the definitions of a `kindsFrom`.
        ...(source?.metadataOnly ||
        (!entry.detectors.has(key) &&
          !entry.facts.has(key) &&
          !entry.compared.has(key) &&
          !(entry.judgedPaths.get(key) ?? []).some((p) => !underMetadata(p)) &&
          !(entry.kindsFrom && kindKeyOf(entry.kindsFrom.kind) === key && ![entry.kindsFrom.groupPath, ...entry.kindsFrom.kindPaths].every(underMetadata)))
          ? { metadataOnly: true }
          : {}),
        // The cluster holds more definitions than the `kindsFrom` reads (Rust counted them): a part is judged.
        ...(moreDefinitions === true ? { moreDefinitions: true } : {}),
      };
      out.push(def);
      if (entry.across.has(key)) {
        judged.push({ def, key });
        targets.push({ group: served.kindRef.group, kind: served.kindRef.kind, namespaced: served.namespaced, def });
      }
    }
    // The judges' inputs (ADR-0168): each kind they read, with its source; a kind with no source here (not served,
    // not readable) leaves the judge unable to tell — but an `optional` read the cluster does not serve is no objects
    // (ADR-0168 amendment): a served kind without a source (not readable) still cannot tell.
    const judgeInputs = entry.judges.map((judge) => ({
      judge,
      inputs: judge.reads.map((read) => {
        const target = targets.find((t) => kindKeyOf(t) === kindKeyOf(read.kind));
        const notServed = !target && read.optional === true && !kinds.some((k) => kindKeyOf(k.kindRef) === kindKeyOf(read.kind));
        return { read, target, notServed };
      }),
    }));
    // A kind the cluster serves (ADR-0169: one it does not has no objects for a `missing` with `alsoKinds`).
    const servedKinds = new Set(kinds.map((k) => kindKeyOf(k.kindRef)));
    const served = (kind: { group: string; kind: string }) => servedKinds.has(kindKeyOf(kind));
    const judges = {
      fact: (judge: string, fact: string, uid: string) => judgedFact(clusterId, entry.extensionId, judge, fact, uid),
      entries: (judge: string, fact: string, uid: string) => judgedFacts(clusterId, entry.extensionId, judge, fact, uid),
      reads: (judge: string) => judgeReads(clusterId, entry.extensionId, judge),
    };
    currentTargets.set(targetsKey, targets);
    // What sources of this category no longer stand said is forgotten (another namespace filter, a reconnect).
    if (entry.narrowed.size > 0) {
      const current = new Set(judged.map(({ def }) => lookupKey(clusterId, entry, def)));
      const prefix = `${clusterId}|${entry.extensionId}|${entry.category}|`;
      for (const k of [...lookupNamespaces.keys()]) if (k.startsWith(prefix) && !current.has(k)) lookupNamespaces.delete(k);
    }
    for (const { def, key } of judged) {
      def.judge = {
        tap: {
          id: ACROSS_TAP,
          toRow: rowOf(
            entry.newestLabels.get(key) ?? [],
            entry.facts.get(key) ?? [],
            entry.selected.has(key),
            entry.compared.get(key) ?? [],
            entry.referrers.get(key) ?? [],
            entry.newestBy.get(key),
            entry.judgedPaths.get(key) ?? [],
            entry.kindsFrom && kindKeyOf(entry.kindsFrom.kind) === key ? entry.kindsFrom : undefined,
          ),
          max: def.maxObjects ?? MAX_SOURCE_OBJECTS,
        },
        judge: (problems, context, untold) => {
          // Where these problems' lookups point, for the kinds listed only there (`narrowLookups`).
          if (entry.narrowed.size > 0) noteLookups(lookupKey(clusterId, entry, def), entry.narrowed, problems);
          // The definitions' rows: what they define may have changed (`kindsFrom`).
          if (entry.kindsFrom && kindKeyOf(entry.kindsFrom.kind) === key) noteDefinitions(clusterId, entry.extensionId, context.rows);
          for (const { judge, inputs } of judgeInputs) {
            observeJudge(
              clusterId,
              entry.extensionId,
              judge,
              inputs.map(({ read, target, notServed }): JudgeInput =>
                notServed
                  ? { read, kind: read.kind.kind, rows: NOT_SERVED_ROWS, notServed: true }
                  : { read, kind: target?.kind ?? read.kind.kind, rows: target && context.target(target.def), namespaced: target?.namespaced ?? true },
              ),
            );
          }
          // The targets as the latest look built them: the store keeps a source's first definition, and a narrowed kind's
          // source may have come (or gone) since.
          return judgeAcross(
            problems,
            context,
            { rules: entry.rules, targets: currentTargets.get(targetsKey) ?? targets, judges, served, api: entry.api },
            untold,
          );
        },
      };
    }
  }
  return out;
}
