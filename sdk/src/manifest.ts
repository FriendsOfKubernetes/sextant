// `sextant-extension.json` as an author writes it. Sextant reads it into `ExtensionManifest` (generated from Rust),
// filling what may be left out: contribution lists default to empty, `confirm` of a rule to `true`, `danger` and
// `multiple` of an action to `false`. `test/manifest.test.ts` keeps these types, the generated ones and the JSON
// schema (`crates/sextant-core/src/extensions/manifest.schema.json`) in step.
import type { ExtensionManifest } from "./generated/ExtensionManifest";
import type { KindPattern } from "./generated/KindPattern";
import type { DetailsPlacement } from "./generated/DetailsPlacement";

export type { ExtensionManifest, KindPattern, DetailsPlacement };

/** The file name of the manifest, at the top of the package. */
export const MANIFEST_FILE = "sextant-extension.json";

/** The extension API major version this SDK speaks (`sextantApi`). */
export const SEXTANT_API = 1;

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

export interface ManifestContributions {
  pages?: ManifestPage[];
  detailsSections?: ManifestDetailsSection[];
  actions?: ManifestAction[];
  columns?: ManifestColumn[];
  dockActions?: ManifestDockAction[];
  settings?: ManifestSettings;
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
  sextantApi: typeof SEXTANT_API;
  /** The HTML file every view opens, relative to the package root. */
  entry: string;
  icon?: string;
  permissions: ManifestPermissions;
  contributes: ManifestContributions;
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
    },
  };
  if (file.icon !== undefined) manifest.icon = file.icon;
  if (c.settings !== undefined) manifest.contributes.settings = c.settings;
  return manifest;
}
