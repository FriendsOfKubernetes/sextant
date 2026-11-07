// `sextant-extension.json` as an author writes it. Sextant reads it into `ExtensionManifest` (generated from Rust),
// filling what may be left out: contribution lists default to empty, `confirm` of a rule to `true`, `danger` and
// `multiple` of an action to `false`. `test/manifest.test.ts` keeps these types, the generated ones and the JSON
// schema (`crates/sextant-core/src/extensions/manifest.schema.json`) in step.
import type { ExtensionManifest } from "./generated/ExtensionManifest";
import type { KindPattern } from "./generated/KindPattern";
import type { DetailsPlacement } from "./generated/DetailsPlacement";
import type { ProblemCondition } from "./generated/ProblemCondition";
import type { ProblemScalar } from "./generated/ProblemScalar";
import type { MetricParamType } from "./generated/MetricParamType";
import type { CommandParamType } from "./generated/CommandParamType";

export type { ExtensionManifest, KindPattern, DetailsPlacement, MetricParamType, CommandParamType, ProblemCondition, ProblemScalar };

/** The file name of the manifest, at the top of the package. */
export const MANIFEST_FILE = "sextant-extension.json";

/**
 * The newest extension API major version this SDK speaks (`sextantApi`); 2 brought `contributes.problems`, 3
 * `contributes.sectionBadges` and `contributes.commands`, 4 sources and `not` in problem rules, computed columns,
 * action conditions, `contributes.kinds`, status patches, port-forwards, `contributes.menuItems`,
 * `contributes.services` and `contributes.agentTools`. Every older one stays readable (ADR-0142).
 */
export const SEXTANT_API = 4;

/** What an extension may be allowed to do with objects (a subset of the agent's actions). */
export type ExtensionAction = "read" | "modify" | "delete" | "logs" | "secretValues" | "portForward";

/** The actions, in the order Sextant lists them. */
export const EXTENSION_ACTIONS = [
  "read",
  "modify",
  "delete",
  "logs",
  "secretValues",
  "portForward",
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
  /**
   * Custom kinds whose status subresource the extension may patch (`resources.patch` with `subresource: "status"`)
   * where the rules allow Modify; sextantApi 4.
   */
  statusPatches?: KindPattern[];
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
  /** Offered only for objects for which this holds (a problem rule's condition without `missing`); sextantApi 4. */
  when?: ProblemCondition;
  /** Why it is not offered where `when` does not hold; sextantApi 4. */
  whyNot?: string;
  /**
   * `primary`: a button of the details bar on the kinds the extension lists in a section of its own
   * (`contributes.kinds`); elsewhere, and by default, the "Actions" menu; sextantApi 4.
   */
  placement?: "primary" | "more";
  /**
   * A merge patch Sextant sends itself to each object, without the extension's window (since Sextant 0.30,
   * sextantApi 4): its only placeholder is a whole string value `{{now}}` (the time, RFC 3339); at most 4 KiB.
   */
  patch?: Record<string, unknown>;
  /**
   * With `patch`: Sextant's question before sending it (the objects are listed under `text`). Sextant fills
   * `{{count}}`, and on an action of one object `{{kind}}`, `{{namespace}}` and `{{name}}` (since Sextant 0.30).
   */
  ask?: { title: string; text: string; confirm: string };
  /** With `patch`: what Sextant says once every object got it. */
  done?: string;
  /**
   * The action's frame runs out of sight, without a window: it ends with `ui.close`, tells the user with `ui.notify`,
   * and an error it reports is shown as a notice; ended after 2 minutes. Not with `patch` (since Sextant 0.30).
   */
  headless?: boolean;
}

/** How a computed column shows its value (sextantApi 4). */
export type ColumnFormat = "text" | "number" | "age" | "duration" | "ratio";
/** The tone of a value, drawn as Sextant's status text. */
export type ColumnTone = "ok" | "warning" | "error" | "neutral";

export interface ManifestColumn {
  kind: KindPattern;
  id: string;
  title: string;
  /** JSONPath as in CRD printer columns, e.g. `.spec.size`; a column has it or `paths`. */
  jsonPath?: string;
  /** Title of the column this one goes after. */
  after?: string;
  /** Field paths, the first with a value giving the cell; sextantApi 4. */
  paths?: string[];
  /** Default `text`. */
  format?: ColumnFormat;
  /** `duration`: the end time; now without one. */
  endPaths?: string[];
  /** `ratio`: the whole; with it there, a missing value counts as 0 (Kubernetes leaves zero counts out). */
  totalPaths?: string[];
  /** A tone per shown value. */
  tones?: Record<string, ColumnTone>;
  /** The cell's tooltip. */
  tooltipPaths?: string[];
  /**
   * Texts shown instead of the value where a condition holds, the first that holds, each with its tone; a text may hold
   * `{{<field path>}}` placeholders (since Sextant 0.30), and a case whose placeholder has no value does not hold.
   */
  cases?: {
    when: ProblemCondition;
    text: string;
    tone?: ColumnTone;
    /** Shown on hover while the case holds, instead of `tooltipPaths`; the text's placeholders (since Sextant 0.30). */
    tooltip?: string;
    /** With `format: "number"`: the number it sorts and filters by while it holds; the text is still shown (since Sextant 0.30). */
    value?: number;
  }[];
  /** The id of the column this one goes after (`name`, `namespace`, `age`, or one of the extension's own ids). */
  afterColumn?: string;
  /**
   * The value picked from a list by an index field, before `paths` (since Sextant 0.30): `field` of the item of `list`
   * that `index` names (0 when the object leaves the index out); with `nearestBefore`, else of the nearest earlier item
   * that has it; else `orElse`.
   */
  lookup?: { list: string; index: string; field: string; nearestBefore?: boolean; orElse?: string | number | boolean };
  /** How a `text` or `number` value is written, with the one placeholder `{{value}}`: `{{value}}%` (since Sextant 0.30). */
  valueText?: string;
}

/**
 * A kind listed in a sidebar section of the extension's own with Sextant's table, details and actions
 * (sextantApi 4, ADR-0152). Kinds of the core API group are Sextant's.
 */
export interface ManifestKind {
  group: string;
  kind: string;
  /** A section of the extension's own: it, or a page or kind of it with this section, has a `sectionTitle`. */
  section: string;
  sectionTitle?: string;
  /** The plural label and the table's title; the kind's name by default. */
  title?: string;
  icon?: string;
  order?: number;
  /** Short names the command palette takes as a kind prefix (`hr web`), lowercase. */
  aliases?: string[];
  /** The command palette searches the kind without being asked to. Default `false`. */
  searchByDefault?: boolean;
  /** `false`: the CRD's printer columns are left out of the table (the extension's columns take their place). Default `true`. */
  printerColumns?: boolean;
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
  /** Not told while the object's controller has a problem of this extension (sextantApi 3). Default `false`. */
  toldThroughOwner?: boolean;
  /** A label key: of one namespace's objects with the same value of it, only the newest has the problem (sextantApi 3). */
  newestPer?: string;
  /**
   * Which objects of the kind the rule sees (sextantApi 4): those a Kubernetes label selector picks, and only their
   * metadata (then every path is under `.metadata`). Every rule of a kind has the same source.
   */
  source?: { labelSelector?: string; metadataOnly?: boolean };
  /** Rules with the same group notify once per object for all of them (sextantApi 4). */
  group?: string;
  /**
   * The reason shown, from the object: text with `{{<field path>}}` placeholders as `message`; the title when it comes
   * out empty. Not translated (since Sextant 0.30, sextantApi 4).
   */
  reason?: string;
  /**
   * A field path whose value, when the object has one, is what a notification is about instead of the object, so the
   * runs of one owner notify as one: `.metadata.labels["workflows.argoproj.io/cron-workflow"]` (since Sextant 0.30).
   */
  notifyAs?: string;
}

/**
 * A metric query (`sextantApi` 2, ADR-0138): PromQL fixed in the manifest that the extension runs by id with
 * `sextant.metrics.query`, giving a value for each parameter. A `namespace`, `name` or `labelValue` placeholder goes
 * inside a `"…"` string (escaped there; matched literally after `=~`), a `duration` outside strings.
 */
export interface ManifestMetricQuery {
  id: string;
  /** What it reads; shown when the user agrees to the extension. */
  title: string;
  /** PromQL with `{{name}}` placeholders of `params`; no comments. */
  query: string;
  params?: Array<{ name: string; type: MetricParamType }>;
  /** It may also run over a range of up to `maxHours` back. */
  range?: { maxHours: number };
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
  /** Metric queries; needs `sextantApi` 2. */
  metricQueries?: ManifestMetricQuery[];
  /** Problem counters on the extension's own sidebar sections; needs `sextantApi` 3. */
  sectionBadges?: ManifestSectionBadge[];
  /** Programs run by id in a container named by labels (`sextant.exec.run`); needs `sextantApi` 3. */
  commands?: ManifestCommand[];
  /** Kinds in a sidebar section of the extension's own; needs `sextantApi` 4. */
  kinds?: ManifestKind[];
  /** Items of Sextant's menus opening the extension's window; needs `sextantApi` 4. */
  menuItems?: ManifestMenuItem[];
  /** Services inside a cluster the extension sends requests to (`sextant.service.request`); needs `sextantApi` 4. */
  services?: ManifestService[];
  /** Tools for AI agents in Sextant's MCP server, answered by the backend; needs `sextantApi` 4 and a `backend`. */
  agentTools?: ManifestAgentTool[];
  /** The extension's own sidebar sections: title, header icon, place; needs `sextantApi` 4. */
  sections?: ManifestSection[];
  /** A tab in a cluster's settings (`view=settings` with the contribution `clusterSettings`, that cluster in the context); needs `sextantApi` 4. */
  clusterSettings?: ManifestSettings;
}

/** One of the extension's own sidebar sections (sextantApi 4, ADR-0160). */
export interface ManifestSection {
  section: string;
  /** Its header; makes it the extension's own. */
  title?: string;
  /** An icon of Sextant's set on the header. */
  icon?: string;
  /** One of Sextant's sections (`workloads`, `customResources`, …): this one comes right after it. */
  after?: string;
}

/**
 * A tool for AI agents (sextantApi 4, ADR-0159): listed by Sextant's MCP server as `ext_<extension id, dots as _>__<id>`
 * only when the user lets agents have the extension's tools, and answered by the backend's `handle("agentTool:<id>",
 * arguments)`. Everything the backend does then is decided for the extension and the agent both.
 */
export interface ManifestAgentTool {
  id: string;
  /** Shown to the user. */
  title: string;
  /** What the agent reads to choose the tool. */
  description: string;
  /**
   * The JSON Schema of the arguments: an object, with `type`, `description`, `properties`, `required`,
   * `additionalProperties`, `items`, `enum` and the bounds only, at most 4 deep and 8 KiB.
   */
  inputSchema: Record<string, unknown>;
  /** It only reads. Default `false`. */
  readOnly?: boolean;
}

/**
 * A Service inside a cluster (sextantApi 4, ADR-0158), agreed to at install: `sextant.service.request` reaches it in
 * the namespace each call names, through Sextant's own port forward, with Read and Port forward on Services there.
 */
export interface ManifestService {
  id: string;
  /** What it is, at consent: "Argo CD API". */
  title: string;
  /** The Service's name; or `labelSelector`. */
  name?: string;
  /** A label selector picking exactly one Service in the namespace (a Helm release's prefixed name), instead of `name`. */
  labelSelector?: string;
  /** Keys of Secrets of the namespace it may receive in `{{secret:<name>/<key>}}`, agreed to with it: no namespace-wide "Secret values" needed. */
  secrets?: ({ name: string; key: string } | { labelSelector: string; key: string })[];
  /** Its port: a number or a port name. */
  port: number | string;
  /** `https`: TLS without checking the certificate (the loopback end of Sextant's forward); `http`: plain. */
  scheme: "https" | "http";
  /**
   * What the user types to sign in, in Sextant's own dialog (`sextant.ui.signIn`): a request body value
   * `{{signIn:<field id>}}` gets it, and the extension never sees it; remembered per cluster in the keyring on request.
   */
  signIn?: { fields: { id: string; label: string; secret?: boolean }[] };
}

/**
 * An item of one of Sextant's menus (sextantApi 4, ADR-0157): a click opens the extension's window (`view=action`, the
 * item's id as the contribution) with the menu's subject in the context — for `cluster`, the cluster's context menu,
 * that cluster as `clusterId`.
 */
export interface ManifestMenuItem {
  id: string;
  title: string;
  icon?: string;
  menu: "cluster";
}

/**
 * A command (`sextantApi` 3, ADR-0147): a program fixed in the manifest that the extension runs by id with
 * `sextant.exec.run`, never through a shell. An argument may be exactly `{{name}}` of a parameter, put in whole after
 * its value is checked. Agreed to word for word at install; one that `changes` something asks the user every time.
 */
export interface ManifestCommand {
  id: string;
  /** What it does; shown at install and when it asks. */
  title: string;
  /** The newest ready pod with these labels, in the namespace the call names, and its container. */
  target: { labelSelector: string; container: string };
  argv: string[];
  params?: ManifestCommandParam[];
  /** It changes something: the user confirms it every time. Default `false`. */
  changes?: boolean;
  /** 1–60; default 30. */
  timeoutSeconds?: number;
}

export interface ManifestCommandParam {
  name: string;
  type: CommandParamType;
  /** `enum`: the values it may be. */
  values?: string[];
  /** `int`: the smallest and largest value. */
  min?: number;
  max?: number;
}

/**
 * A counter on a sidebar section of the extension's own (one of its pages gives the section a `sectionTitle`):
 * Sextant counts the objects with active problems of `rules` (left out: every rule) and shows the number.
 */
export interface ManifestSectionBadge {
  section: string;
  rules?: string[];
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
  /** 1; 2 for `contributes.problems`, `contributes.metricQueries` and `translations`; 3 for `contributes.sectionBadges`. */
  sextantApi: 1 | 2 | typeof SEXTANT_API;
  /** The HTML file every view opens, relative to the package root. */
  entry: string;
  icon?: string;
  permissions: ManifestPermissions;
  contributes: ManifestContributions;
  /** Code that runs outside the window: a WebAssembly component, the hosts it may call, its credentials (ADR-0131). */
  backend?: ManifestBackend;
  /**
   * Translations of the texts above (sextantApi 2): language tag (`de`, `pt-BR`) → text key (`name`, `description`,
   * `pages.<id>.title`, `problems.<id>.message`, …) → text. Untranslated texts are shown in English.
   */
  translations?: ManifestTranslations;
}

/** Language tag → text key → text. */
export type ManifestTranslations = Record<string, Record<string, string>>;

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
      ...(file.permissions.statusPatches !== undefined && file.permissions.statusPatches.length > 0
        ? { statusPatches: file.permissions.statusPatches }
        : {}),
    },
    contributes: {
      pages: c.pages ?? [],
      detailsSections: c.detailsSections ?? [],
      actions: (c.actions ?? []).map((a) => ({
        ...a,
        danger: a.danger ?? false,
        multiple: a.multiple ?? false,
        headless: a.headless ?? false,
      })),
      columns: (c.columns ?? []).map((col) => {
        const { lookup, ...rest } = col;
        return lookup === undefined ? rest : { ...rest, lookup: { ...lookup, nearestBefore: lookup.nearestBefore ?? false } };
      }),
      dockActions: c.dockActions ?? [],
      problems: (c.problems ?? []).map((p) => {
        const { source, ...rule } = p;
        return {
          ...rule,
          graceMinutes: p.graceMinutes ?? 0,
          notify: p.notify ?? true,
          toldThroughOwner: p.toldThroughOwner ?? false,
          ...(source !== undefined ? { source: { ...source, metadataOnly: source.metadataOnly ?? false } } : {}),
        };
      }),
      metricQueries: (c.metricQueries ?? []).map((q) => ({ ...q, params: q.params ?? [] })),
      sectionBadges: (c.sectionBadges ?? []).map((b) => ({ section: b.section, rules: b.rules ?? [] })),
      commands: (c.commands ?? []).map((command) => ({ ...command, params: command.params ?? [], changes: command.changes ?? false })),
      kinds: (c.kinds ?? []).map((k) => ({ ...k, searchByDefault: k.searchByDefault ?? false, printerColumns: k.printerColumns ?? true })),
      sections: c.sections ?? [],
      menuItems: c.menuItems ?? [],
      services: (c.services ?? []).map(({ signIn, ...service }) =>
        signIn ? { ...service, signIn: { fields: signIn.fields.map((f) => ({ ...f, secret: f.secret ?? false })) } } : service,
      ),
      agentTools: (c.agentTools ?? []).map((tool) => ({ ...tool, readOnly: tool.readOnly ?? false })),
    },
  };
  if (file.icon !== undefined) manifest.icon = file.icon;
  if (c.settings !== undefined) manifest.contributes.settings = c.settings;
  if (c.clusterSettings !== undefined) manifest.contributes.clusterSettings = c.clusterSettings;
  if (file.backend !== undefined) {
    manifest.backend = {
      module: file.backend.module,
      network: { hosts: file.backend.network?.hosts ?? [] },
      credentials: file.backend.credentials ?? [],
    };
  }
  if (file.translations !== undefined && Object.keys(file.translations).length > 0) manifest.translations = file.translations;
  return manifest;
}
