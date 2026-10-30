// `sextant-extension.json` as an author writes it. Sextant reads it into `ExtensionManifest` (generated from Rust),
// filling what may be left out: contribution lists default to empty, `confirm` of a rule to `true`, `danger` and
// `multiple` of an action to `false`. `test/manifest.test.ts` keeps these types, the generated ones and the JSON
// schema (`crates/sextant-core/src/extensions/manifest.schema.json`) in step.
import type { ExtensionManifest } from "./generated/ExtensionManifest";
import type { KindPattern } from "./generated/KindPattern";
import type { DetailsPlacement } from "./generated/DetailsPlacement";
import type { ProblemCondition } from "./generated/ProblemCondition";
import type { ProblemScalar } from "./generated/ProblemScalar";

export type { ExtensionManifest, KindPattern, DetailsPlacement, ProblemCondition, ProblemScalar };

/** The file name of the manifest, at the top of the package. */
export const MANIFEST_FILE = "sextant-extension.json";

/** The newest extension API major version this SDK speaks (`sextantApi`); 2 brought `contributes.problems`. */
export const SEXTANT_API = 2;

/** What an extension may be allowed to do with objects (a subset of the agent's actions). */
export type ExtensionAction = "read" | "modify" | "delete" | "logs" | "secretValues";

/** The actions, in the order Sextant lists them. */
export const EXTENSION_ACTIONS = [
  "read",
  "modify",
  "delete",
  "logs",
  "secretValues",
] as const satisfies readonly ExtensionAction[];

/** Clusters by kubeconfig context name. */
export type ManifestClusterScope = { type: "all" } | { type: "only"; names: string[] };

export type ManifestNamespaceScope = { type: "all" } | { type: "only"; namespaces: string[] };

export type ManifestKindScope = { type: "all" } | { type: "only"; kinds: KindPattern[] };

export interface ManifestRule {
  namespaces: ManifestNamespaceScope;
  kinds: ManifestKindScope;
  actions: ExtensionAction[];
  /** Ask the user before every Modify or Delete this rule allows. Default `true`. */
  confirm?: boolean;
}

export interface ManifestPermissions {
  clusters: ManifestClusterScope;
  rules: ManifestRule[];
}

export interface ManifestPage {
  id: string;
  title: string;
  /** A sidebar section of Sextant (`workloads`, `config`, `customResources`, …) or the extension's own. */
  section: string;
  sectionTitle?: string;
  icon?: string;
  order?: number;
}

export interface ManifestDetailsSection {
  id: string;
  title: string;
  kinds: KindPattern[];
  order?: number;
  placement: DetailsPlacement;
}

export interface ManifestAction {
  id: string;
  title: string;
  icon?: string;
  kinds: KindPattern[];
  /** Default `false`. */
  danger?: boolean;
  /** Runs on several selected objects at once. Default `false`. */
  multiple?: boolean;
}

export interface ManifestColumn {
  kind: KindPattern;
  id: string;
  title: string;
  /** JSONPath as in CRD printer columns, e.g. `.spec.size`. */
  jsonPath: string;
  /** Title of the column this one goes after. */
  after?: string;
}

export interface ManifestDockAction {
  id: string;
  title: string;
  icon?: string;
}

export interface ManifestSettings {
  title: string;
}

/**
 * A problem rule (`sextantApi` 2, ADR-0137): Sextant judges objects of `kind` by `when` on its own watches and lists
 * a problem titled `title` on the Problems page; no extension code runs for it. Paths are field paths
 * (`.status.phase`, `.items[0]`, `.metadata.labels["app"]`) that read no Secret values or inline secret fields.
 */
export interface ManifestProblem {
  id: string;
  /** Shown as the problem's reason; unique among the rules. */
  title: string;
  kind: KindPattern;
  when: ProblemCondition;
  /** A field holding an RFC 3339 time: when the state began. */
  since?: string;
  /** The problem counts only this long after it began. Default `0`. */
  graceMinutes?: number;
  /** It may send a notification. Default `true`. */
  notify?: boolean;
  /** Text with at most 5 `{{<field path>}}` placeholders. */
  message: string;
}

export interface ManifestContributions {
  pages?: ManifestPage[];
  detailsSections?: ManifestDetailsSection[];
  actions?: ManifestAction[];
  columns?: ManifestColumn[];
  dockActions?: ManifestDockAction[];
  settings?: ManifestSettings;
  /** Problem rules; needs `sextantApi` 2. */
  problems?: ManifestProblem[];
}

/** `sextant-extension.json` as written. */
export interface ManifestFile {
  /** Lets an editor find the schema; Sextant ignores it. */
  $schema?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** 1, or 2 for `contributes.problems`. */
  sextantApi: 1 | typeof SEXTANT_API;
  /** The HTML file every view opens, relative to the package root. */
  entry: string;
  icon?: string;
  permissions: ManifestPermissions;
  contributes: ManifestContributions;
  /** Code that runs outside the window: a WebAssembly component, the hosts it may call, its credentials (ADR-0131). */
  backend?: ManifestBackend;
}

/** `backend` as written: `network` and `credentials` may be left out. */
export interface ManifestBackend {
  /** The component's path in the package, e.g. `backend.wasm`. */
  module: string;
  network?: { hosts: string[] };
  credentials?: Array<{ id: string; label: string }>;
}

/** Fills what Sextant fills when it reads a manifest: the result has the shape of `ExtensionManifest`. */
export function normalizeManifest(file: ManifestFile): ExtensionManifest {
  const c = file.contributes;
  const manifest: ExtensionManifest = {
    id: file.id,
    name: file.name,
    version: file.version,
    description: file.description,
    author: file.author,
    sextantApi: file.sextantApi,
    entry: file.entry,
    permissions: {
      clusters: file.permissions.clusters,
      rules: file.permissions.rules.map((rule) => ({ ...rule, confirm: rule.confirm ?? true })),
    },
    contributes: {
      pages: c.pages ?? [],
      detailsSections: c.detailsSections ?? [],
      actions: (c.actions ?? []).map((a) => ({ ...a, danger: a.danger ?? false, multiple: a.multiple ?? false })),
      columns: c.columns ?? [],
      dockActions: c.dockActions ?? [],
      problems: (c.problems ?? []).map((p) => ({ ...p, graceMinutes: p.graceMinutes ?? 0, notify: p.notify ?? true })),
    },
  };
  if (file.icon !== undefined) manifest.icon = file.icon;
  if (c.settings !== undefined) manifest.contributes.settings = c.settings;
  if (file.backend !== undefined) {
    manifest.backend = {
      module: file.backend.module,
      network: { hosts: file.backend.network?.hosts ?? [] },
      credentials: file.backend.credentials ?? [],
    };
  }
  return manifest;
}
