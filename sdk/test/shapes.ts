// The fields of each manifest type, and whether they are required — written against the types, so the compiler
// refuses a missing, extra or wrongly optional field; test/manifest.test.ts compares them with the JSON schema.
import type {
  DetailsPlacement,
  KindPattern,
  ManifestAction,
  ManifestBackend,
  ManifestColumn,
  ManifestContributions,
  ManifestDetailsSection,
  ManifestDockAction,
  ManifestFile,
  ManifestMetricQuery,
  ManifestPage,
  ManifestPermissions,
  ManifestProblem,
  ManifestRule,
  ManifestSettings,
} from "../src/manifest";

/** For each field of `T`: `"optional"` when it may be left out, else `"required"`. */
type Shape<T> = { [K in keyof T]-?: object extends Pick<T, K> ? "optional" : "required" };

interface Described<T> {
  /** Where the type's object is in the schema (a JSON pointer). */
  schema: string;
  fields: Shape<T>;
}

const described = <T>(schema: string, fields: Shape<T>): Described<T> => ({ schema, fields });

const CONTRIBUTION = "/$defs/contributes/properties";

export const MANIFEST_SHAPES = {
  ManifestFile: described<ManifestFile>("", {
    $schema: "optional",
    id: "required",
    name: "required",
    version: "required",
    description: "required",
    author: "required",
    sextantApi: "required",
    entry: "required",
    icon: "optional",
    permissions: "required",
    contributes: "required",
    backend: "optional",
  }),
  ManifestBackend: described<ManifestBackend>("/properties/backend", {
    module: "required",
    network: "optional",
    credentials: "optional",
  }),
  ManifestPermissions: described<ManifestPermissions>("/$defs/permissions", {
    clusters: "required",
    rules: "required",
  }),
  ManifestRule: described<ManifestRule>("/$defs/rule", {
    namespaces: "required",
    kinds: "required",
    actions: "required",
    confirm: "optional",
  }),
  KindPattern: described<KindPattern>("/$defs/kind", { group: "required", kind: "required" }),
  ManifestContributions: described<ManifestContributions>("/$defs/contributes", {
    pages: "optional",
    detailsSections: "optional",
    actions: "optional",
    columns: "optional",
    dockActions: "optional",
    settings: "optional",
    problems: "optional",
    metricQueries: "optional",
  }),
  ManifestMetricQuery: described<ManifestMetricQuery>(`${CONTRIBUTION}/metricQueries/items`, {
    id: "required",
    title: "required",
    query: "required",
    params: "optional",
    range: "optional",
  }),
  ManifestProblem: described<ManifestProblem>(`${CONTRIBUTION}/problems/items`, {
    id: "required",
    title: "required",
    kind: "required",
    when: "required",
    since: "optional",
    graceMinutes: "optional",
    notify: "optional",
    message: "required",
  }),
  ManifestPage: described<ManifestPage>(`${CONTRIBUTION}/pages/items`, {
    id: "required",
    title: "required",
    section: "required",
    sectionTitle: "optional",
    icon: "optional",
    order: "optional",
  }),
  ManifestDetailsSection: described<ManifestDetailsSection>(`${CONTRIBUTION}/detailsSections/items`, {
    id: "required",
    title: "required",
    kinds: "required",
    order: "optional",
    placement: "required",
  }),
  ManifestAction: described<ManifestAction>(`${CONTRIBUTION}/actions/items`, {
    id: "required",
    title: "required",
    icon: "optional",
    kinds: "required",
    danger: "optional",
    multiple: "optional",
  }),
  ManifestColumn: described<ManifestColumn>(`${CONTRIBUTION}/columns/items`, {
    kind: "required",
    id: "required",
    title: "required",
    jsonPath: "required",
    after: "optional",
  }),
  ManifestDockAction: described<ManifestDockAction>(`${CONTRIBUTION}/dockActions/items`, {
    id: "required",
    title: "required",
    icon: "optional",
  }),
  ManifestSettings: described<ManifestSettings>(`${CONTRIBUTION}/settings`, { title: "required" }),
};

export const PLACEMENTS = ["section", "tab"] as const satisfies readonly DetailsPlacement[];
