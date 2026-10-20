import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindSchema, type MockBackend, type ResourceKind } from "../../../api";
import { knownClusterKinds, loadClusterKinds, refreshClusterKinds, resetClusterKinds } from "../../../resources/useKinds";
import { explain, suggest } from "./complete";
import { cursor, deploymentSchema, widgetSchema } from "./fixtures";
import { nodeAt, typeLabel } from "./model";
import { resetSchemaSources, RETRY_AFTER_MS, SchemaSource, schemaSourceFor } from "./source";
import { validate, type Problem } from "./validate";

const lookup = (apiVersion: string, kind: string): KindSchema | null => {
  if (apiVersion === "apps/v1" && kind === "Deployment") return deploymentSchema;
  if (apiVersion === "example.com/v1" && kind === "Widget") return widgetSchema;
  return null;
};

const HEAD = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n";
const VALID_SPEC = [
  "spec:",
  "  replicas: 2",
  "  selector:",
  "    matchLabels: {app: web}",
  "  strategy:",
  "    type: RollingUpdate",
  "    rollingUpdate:",
  "      maxSurge: 25%",
  "  template:",
  "    spec:",
  "      containers:",
  "      - name: web",
  "        image: nginx",
  "        ports:",
  "        - containerPort: 80",
  "        resources:",
  "          limits: {cpu: 500m, memory: 1}",
  "",
].join("\n");

/** The problems of `text` as `[code, the underlined text]`. */
function problems(text: string): Array<[Problem["code"], string]> {
  return validate(text, lookup).map((p) => [p.code, text.slice(p.from, p.to)]);
}

describe("validate", () => {
  it("finds nothing wrong in a valid Deployment", () => {
    expect(problems(HEAD + VALID_SPEC)).toEqual([]);
  });

  it.each([
    ["an unknown field", "  replica: 2\n", "unknownField", "replica"],
    ["a string where an integer goes", '  replicas: "2"\n', "wrongType", '"2"'],
    ["a list where a map goes", "  strategy: []\n", "wrongType", "strategy"],
    ["a value outside an enum", "  strategy:\n    type: Sometimes\n", "notInEnum", "Sometimes"],
    ["a boolean where an int-or-string goes", "  strategy:\n    rollingUpdate:\n      maxSurge: true\n", "wrongType", "true"],
    ["a boolean that is a string", '  paused: "true"\n', "wrongType", '"true"'],
  ] as const)("underlines %s", (_name, line, code, underlined) => {
    const text = `${HEAD}spec:\n  selector: {}\n  template: {spec: {containers: [{name: a}]}}\n${line}`;
    expect(problems(text)).toEqual([[code, underlined]]);
  });

  it("names missing required fields at the parent's key or the item's first key", () => {
    const text = `${HEAD}spec:\n  selector: {}\n  template:\n    spec:\n      containers:\n      - image: x\n        ports:\n        - protocol: TCP\n`;
    const found = validate(text, lookup).map((p) => [p.code, p.params.field, text.slice(p.from, p.to)]);
    expect(found).toEqual([
      ["missingRequired", "name", "image"],
      ["missingRequired", "containerPort", "protocol"],
    ]);
    const bare = `${HEAD}spec:\n  replicas: 1\n`;
    expect(validate(bare, lookup).map((p) => [p.params.field, bare.slice(p.from, p.to)])).toEqual([
      ["selector", "spec"],
      ["template", "spec"],
    ]);
  });

  it("checks the values of a map against its value type", () => {
    const text = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels: {tier: 1, app: web}\nspec: {selector: {}, template: {}}\n";
    expect(problems(text)).toEqual([["wrongType", "1"]]);
  });

  it("accepts int-or-string either way, and keeps unknown fields where the schema keeps them", () => {
    const text = [
      "apiVersion: example.com/v1",
      "kind: Widget",
      "spec:",
      "  size: 3",
      "  config: {anything: [1, 2], goes: {here: true}}",
      "  deep: {a: {b: {c: 1}}}",
      "---",
      "apiVersion: example.com/v1",
      "kind: Widget",
      "spec:",
      "  size: large",
      "  colour: red",
    ].join("\n");
    expect(problems(text)).toEqual([["unknownField", "colour"]]);
  });

  it("leaves the status alone, and checks nothing below a CRD without a schema", () => {
    const status = `${HEAD}spec:\n  selector: {}\n  template: {}\nstatus:\n  anything: [1]\n  replicas: "x"\n`;
    expect(problems(status)).toEqual([]);
    const schemaless: KindSchema = { group: "example.com", version: "v1", kind: "Loose", root: { types: ["object"], preserveUnknown: true }, definitions: {} };
    const loose = "apiVersion: example.com/v1\nkind: Loose\nspec: {whatever: 1}\nmore: [true]\n";
    expect(validate(loose, () => schemaless)).toEqual([]);
    const untyped: KindSchema = { ...schemaless, root: {} };
    expect(validate(loose, () => untyped)).toEqual([]);
  });

  it("checks each document against its own kind and skips kinds without a schema", () => {
    const text = `apiVersion: v1\nkind: Service\nspec:\n  whatever: 1\n---\n${HEAD}spec:\n  selector: {}\n  replica: 1\n`;
    expect(problems(text)).toEqual([
      ["missingRequired", "spec"],
      ["unknownField", "replica"],
    ]);
  });

  it("reports a syntax error instead of checking a document that does not parse", () => {
    const found = validate(`${HEAD}spec:\n  replicas: [1\n`, lookup);
    expect(found.map((p) => p.code)).toEqual(["syntax"]);
  });

  it("checks a 2000-line text in time that grows linearly, not with the square of its length", () => {
    // Compared with a pass over a tenth of the text in the same run, not a fixed time: a loaded runner is slow for
    // both (#220). Linear work takes ~10x as long for 10x the text; a quadratic check would take ~100x.
    const one = HEAD + VALID_SPEC.replace("  replicas: 2", "  replicas: 2\n  replica: 3");
    const lines = one.split("\n").length;
    const docs = Math.ceil(2000 / lines);
    const text = Array.from({ length: docs }, () => one).join("---\n");
    const tenth = Array.from({ length: Math.ceil(docs / 10) }, () => one).join("---\n");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(2000);
    const fastest = (input: string, times: number) => {
      validate(input, lookup);
      let best = Infinity;
      for (let i = 0; i < times; i++) {
        const started = performance.now();
        validate(input, lookup);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = fastest(tenth, 5);
    const big = fastest(text, 3);
    expect(validate(text, lookup).length).toBe(docs);
    expect(big).toBeLessThan(Math.max(30 * small * (docs / Math.ceil(docs / 10)) / 10, 20));
  });
});

describe("suggest", () => {
  const at = (marked: string) => {
    const { text, offset } = cursor(HEAD + marked);
    return suggest(text, offset, deploymentSchema);
  };

  it("offers the fields of the map at the cursor, required first, without the ones written", () => {
    const found = at("spec:\n  replicas: 1\n  ¦");
    expect(found?.items.map((i) => [i.label, i.required])).toEqual([
      ["selector", true],
      ["template", true],
      ["paused", false],
      ["strategy", false],
    ]);
    expect(found?.items.find((i) => i.label === "paused")?.apply).toBe("paused: ");
    // A map or a list opens a block below the key.
    expect(found?.items.find((i) => i.label === "strategy")?.apply).toBe("strategy:\n    ");
  });

  it("offers the fields of a list item, with types and descriptions", () => {
    const found = at("spec:\n  template:\n    spec:\n      containers:\n      - name: web\n        po¦");
    const ports = found?.items.find((i) => i.label === "ports");
    expect(ports).toMatchObject({ type: "[]ContainerPort", description: "List of ports to expose from the container." });
    expect(ports?.apply).toBe("ports:\n          - ");
    expect(found?.items.some((i) => i.label === "name")).toBe(false);
  });

  it("offers enum values and booleans for a value", () => {
    expect(at("spec:\n  strategy:\n    type: ¦")?.items.map((i) => i.label)).toEqual(["Recreate", "RollingUpdate"]);
    expect(at("spec:\n  paused: ¦")?.items.map((i) => i.label)).toEqual(["true", "false"]);
    expect(at("spec:\n  strategy: {type: R¦")?.items.map((i) => i.label)).toEqual(["Recreate", "RollingUpdate"]);
    expect(at("spec:\n  replicas: ¦")).toBeNull();
  });

  it("offers nothing where the schema keeps any field", () => {
    const { text, offset } = cursor("apiVersion: example.com/v1\nkind: Widget\nspec:\n  config:\n    ¦");
    expect(suggest(text, offset, widgetSchema)).toBeNull();
  });
});

describe("explain", () => {
  it("says what a field is, like kubectl explain", () => {
    const found = explain(deploymentSchema, ["spec", "template", "spec", "containers"]);
    expect(found).toMatchObject({
      pathLabel: "spec.template.spec.containers",
      type: "[]Container",
      required: true,
      description: "List of containers belonging to the pod.",
    });
    expect(found?.fields.slice(0, 2).map((f) => [f.name, f.type, f.required])).toEqual([
      ["name", "string", true],
      ["args", "[]string", false],
    ]);
    expect(explain(deploymentSchema, ["spec", "template", "spec", "restartPolicy"])).toMatchObject({
      default: "Always",
      enum: ["Always", "OnFailure", "Never"],
    });
    expect(explain(deploymentSchema, [])?.pathLabel).toBe("Deployment");
    expect(explain(deploymentSchema, ["spec", "nothing"])).toBeNull();
  });

  it("writes types the way kubectl does", () => {
    const type = (path: Array<string | number>) => typeLabel(deploymentSchema, nodeAt(deploymentSchema, path));
    expect(type(["metadata", "labels"])).toBe("map[string]string");
    expect(type(["spec", "strategy", "rollingUpdate", "maxSurge"])).toBe("integer | string");
    expect(type(["spec", "replicas"])).toBe("integer (int32)");
  });
});

const served = (...kinds: Array<[string, string, string]>): ResourceKind[] =>
  kinds.map(([group, version, kind]) => ({
    kindRef: { group, version, kind },
    plural: `${kind.toLowerCase()}s`,
    namespaced: true,
    verbs: [],
    printerColumns: [],
  }));

describe("SchemaSource", () => {
  afterEach(() => {
    backend?.restore();
    backend = undefined;
    resetClusterKinds();
    resetSchemaSources();
  });
  let backend: MockBackend | undefined;

  it("fetches a served kind once, keeps it when the cluster goes away, and retries a failure later", async () => {
    let now = 1000;
    let online = true;
    const fetch = vi.fn((_c: string, group: string, version: string, kind: string) =>
      online ? Promise.resolve(group === "apps" && version === "v1" && kind === "Deployment" ? deploymentSchema : null) : Promise.reject(new Error("not connected")),
    );
    const kinds = served(["apps", "v1", "Deployment"], ["", "v1", "Pod"]);
    const source = new SchemaSource("c1", fetch, () => kinds, () => now);
    const [a, b] = await Promise.all([source.load("apps/v1", "Deployment"), source.load("apps/v1", "Deployment")]);
    expect(a).toBe(deploymentSchema);
    expect(b).toBe(deploymentSchema);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("c1", "apps", "v1", "Deployment");
    online = false;
    expect(await source.load("apps/v1", "Deployment")).toBe(deploymentSchema);
    expect(source.peek("apps/v1", "Deployment")).toBe(deploymentSchema);
    expect(await source.load("v1", "Pod")).toBeNull();
    expect(await source.load("v1", "Pod")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    online = true;
    now += RETRY_AFTER_MS;
    expect(await source.load("v1", "Pod")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    // Malformed names never reach the backend.
    expect(await source.load("a/b/c", "Pod")).toBeNull();
    expect(await source.load("v1", "Pod/x")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never asks for, nor remembers, a kind discovery does not serve (one being typed)", async () => {
    const fetch = vi.fn(() => Promise.resolve(deploymentSchema));
    const source = new SchemaSource("c1", fetch, () => served(["apps", "v1", "Deployment"]));
    for (const [apiVersion, kind] of [["apps/v1", "Deplo"], ["apps/v", "Deployment"], ["app", "Deployment"]] as const) {
      expect(await source.load(apiVersion, kind)).toBeNull();
      expect(source.peek(apiVersion, kind)).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
    // Another Kubernetes-style version of a served kind is asked for.
    await source.load("apps/v2beta1", "Deployment");
    expect(fetch).toHaveBeenCalledWith("c1", "apps", "v2beta1", "Deployment");
  });

  it("asks again for a missing schema once discovery changed (a CRD was created)", async () => {
    let kinds = served(["example.com", "v1", "Widget"]);
    backend = mockBackend({ cluster_kinds: () => kinds });
    loadClusterKinds("c1");
    await vi.waitFor(() => expect(knownClusterKinds("c1")).not.toBeNull());
    let schema: KindSchema | null = null;
    const fetch = vi.fn(() => Promise.resolve(schema));
    const source = new SchemaSource("c1", fetch);
    expect(await source.load("example.com/v1", "Widget")).toBeNull();
    expect(await source.load("example.com/v1", "Widget")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    schema = widgetSchema;
    kinds = served(["example.com", "v1", "Widget"]);
    refreshClusterKinds("c1");
    await vi.waitFor(() => expect(knownClusterKinds("c1")).toBe(kinds));
    expect(await source.load("example.com/v1", "Widget")).toBe(widgetSchema);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is shared by every editor of a cluster", () => {
    expect(schemaSourceFor("c1")).toBe(schemaSourceFor("c1"));
    expect(schemaSourceFor("c2")).not.toBe(schemaSourceFor("c1"));
  });
});
