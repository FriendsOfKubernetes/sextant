// Custom columns (#214): the field path grammar, key syntax, the Secret refusal and how values are read and shown.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import type { PathStep } from "./path";
import {
  pickItem,
  pickStep,
  cellValue,
  checkSpec,
  columnIdOf,
  formatFieldPath,
  isMetadataKey,
  MAX_CELL_CHARS,
  parseFieldPath,
  readColumn,
} from "./path";

const POD = { group: "", kind: "Pod" };
const SECRET = { group: "", kind: "Secret" };

describe("field paths", () => {
  it.each([
    [".spec.nodeName", ".spec.nodeName"],
    ["spec.nodeName", ".spec.nodeName"],
    ["  .status.phase ", ".status.phase"],
    [".spec.containers[0].image", ".spec.containers[0].image"],
    ['.metadata.labels["app.kubernetes.io/name"]', '.metadata.labels["app.kubernetes.io/name"]'],
    ['.metadata.labels["plain"]', ".metadata.labels.plain"],
    ['["a.b"].c', '["a.b"].c'],
    [".status.conditions[12].type", ".status.conditions[12].type"],
  ])("%s is read as %s", (text, canonical) => {
    const checked = checkSpec(POD, "field", text, "");
    expect(checked).toEqual({ spec: { source: "field", path: canonical, title: "" } });
  });

  it.each([
    ["", "pathEmpty"],
    [".", "pathInvalid"],
    ["..spec", "pathInvalid"],
    ["spec.", "pathInvalid"],
    ["spec..x", "pathInvalid"],
    [".spec.containers[*].image", "pathInvalid"],
    [".spec.containers[-1]", "pathInvalid"],
    [".spec.containers[]", "pathInvalid"],
    ["$.spec", "pathInvalid"],
    [".items[?(@.x)]", "pathInvalid"],
    ["{.spec.nodeName}", "pathInvalid"],
    ['spec["a\\"b"]', "pathInvalid"],
    ['spec[""]', "pathInvalid"],
    ['spec["a"', "pathInvalid"],
    ["spec name", "pathInvalid"],
    ["length(spec)", "pathInvalid"],
    [`.${"a".repeat(300)}`, "pathTooLong"],
  ])("%s is refused (%s)", (text, problem) => {
    expect(checkSpec(POD, "field", text, "")).toEqual({ problem });
  });

  it("formats steps back to the canonical text", () => {
    expect(formatFieldPath(parseFieldPath('a["b.c"][3].d')!)).toBe('.a["b.c"][3].d');
  });
});

describe("label and annotation keys", () => {
  it.each(["app", "app.kubernetes.io/name", "a_b-c.d", "x/Y9", "example.com/a"])("%s is a key", (key) => {
    expect(isMetadataKey(key)).toBe(true);
    expect(checkSpec(POD, "label", key, "")).toEqual({ spec: { source: "label", path: key, title: "" } });
  });

  it.each(["/app", "app/", "-app", "app-", "Example.com/app", "a/b/c", "a b", "x".repeat(64)])("%s is not", (key) => {
    expect(isMetadataKey(key)).toBe(false);
    expect(checkSpec(POD, "annotation", key, "")).toEqual({ problem: "keyInvalid" });
  });

  it("asks for a key and caps the header", () => {
    expect(checkSpec(POD, "label", " ", "")).toEqual({ problem: "keyEmpty" });
    expect(checkSpec(POD, "label", "app", "x".repeat(65))).toEqual({ problem: "titleTooLong" });
    expect(checkSpec(POD, "label", "app", "a\u0007b")).toEqual({ problem: "titleInvalid" });
    expect(checkSpec(POD, "label", "app", "  App  ")).toEqual({ spec: { source: "label", path: "app", title: "App" } });
  });
});

describe("Secret values", () => {
  it.each([".data", "data.password", '.stringData["x"]', 'data["tls.crt"]', '["data"]'])("%s on a Secret is refused", (path) => {
    expect(checkSpec(SECRET, "field", path, "")).toEqual({ problem: "secretData" });
    // The same path elsewhere is just a path, and a custom kind named Secret is not the core Secret.
    expect("spec" in checkSpec({ group: "", kind: "ConfigMap" }, "field", path, "")).toBe(true);
    expect("spec" in checkSpec({ group: "example.com", kind: "Secret" }, "field", path, "")).toBe(true);
  });

  it("allows other Secret fields, labels and annotations", () => {
    expect("spec" in checkSpec(SECRET, "field", ".type", "")).toBe(true);
    expect("spec" in checkSpec(SECRET, "annotation", "kubernetes.io/service-account.name", "")).toBe(true);
  });
});

describe("metadata-only lists", () => {
  it("offer only .metadata paths besides labels and annotations", () => {
    const target = { ...POD, metadataOnly: true };
    expect(checkSpec(target, "field", ".spec.nodeName", "")).toEqual({ problem: "metadataOnly" });
    expect("spec" in checkSpec(target, "field", ".metadata.ownerReferences[0].name", "")).toBe(true);
    expect("spec" in checkSpec(target, "label", "app", "")).toBe(true);
  });
});

describe("values", () => {
  const obj: KubeObject = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "web", labels: { app: "web" }, annotations: { "example.com/owner": "team-a" } },
    spec: { nodeName: "node-1", containers: [{ name: "app", ports: [{ containerPort: 80 }, { containerPort: 443 }] }] },
    status: { ready: true, restarts: 3, tags: ["a", "b"], nested: { x: 1 }, empty: [] },
  };
  const read = (source: "label" | "annotation" | "field", path: string) =>
    cellValue(readColumn(obj, source, source === "field" ? parseFieldPath(path) : null, path), ", ");

  it("reads labels, annotations and field paths of the object", () => {
    expect(read("label", "app")).toBe("web");
    expect(read("label", "missing")).toBeUndefined();
    expect(read("annotation", "example.com/owner")).toBe("team-a");
    expect(read("field", ".spec.nodeName")).toBe("node-1");
    expect(read("field", ".spec.containers[0].ports[1].containerPort")).toBe(443);
    expect(read("field", ".spec.containers[5].name")).toBeUndefined();
    expect(read("field", ".spec.nodeName.deeper")).toBeUndefined();
    expect(read("field", ".spec.containers.name")).toBeUndefined();
    expect(read("field", ".metadata.name.length")).toBeUndefined();
  });

  it("shows numbers, booleans, lists and objects", () => {
    expect(read("field", ".status.restarts")).toBe(3);
    expect(read("field", ".status.ready")).toBe(true);
    expect(read("field", ".status.tags")).toBe("a, b");
    expect(read("field", ".status.nested")).toBe('{"x":1}');
    expect(read("field", ".status.empty")).toBeUndefined();
    expect(read("field", ".spec.containers[0].ports")).toBe('{"containerPort":80}, {"containerPort":443}');
  });

  it("clips long texts", () => {
    const long = cellValue("x".repeat(500), ", ");
    expect(typeof long === "string" && Array.from(long).length).toBe(MAX_CELL_CHARS);
    expect(String(long).endsWith("…")).toBe(true);
  });

  it("never reads inherited properties", () => {
    expect(read("field", ".constructor")).toBeUndefined();
    expect(read("label", "toString")).toBeUndefined();
  });
});

describe("column ids", () => {
  it("are stable, readable and short enough for the saved widths", () => {
    expect(columnIdOf("label", "app")).toBe("custom:label:app");
    expect(columnIdOf("field", ".spec.nodeName")).toBe("custom:field:.spec.nodeName");
    const long = `example.com/${"a".repeat(63)}x${"b".repeat(60)}`;
    const id = columnIdOf("annotation", long);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(columnIdOf("annotation", long)).toBe(id);
    expect(columnIdOf("annotation", `${long}c`)).not.toBe(id);
  });
});

describe("secret material outside a Secret (#294)", () => {
  const BUILD = { group: "build.openshift.io", kind: "BuildConfig" };
  const NODE = { group: "", kind: "Node" };
  it.each([".spec.triggers[0].github.secret", ".spec.triggers", ".spec", ".spec.triggers[1].generic"])(
    "%s on a BuildConfig reads a webhook secret, so it is refused",
    (path) => expect(checkSpec(BUILD, "field", path, "")).toEqual({ problem: "inlineSecret" }),
  );
  it("allows the BuildConfig's other fields and the same paths on other kinds", () => {
    expect("spec" in checkSpec(BUILD, "field", ".spec.source.git.uri", "")).toBe(true);
    expect("spec" in checkSpec(BUILD, "field", ".spec.triggers[0].type", "")).toBe(true);
    expect("spec" in checkSpec({ group: "", kind: "ConfigMap" }, "field", ".spec.triggers[0].github.secret", "")).toBe(true);
  });
  it("refuses a node's argument annotations of k3s and RKE2, not its other annotations", () => {
    expect(checkSpec(NODE, "annotation", "k3s.io/node-args", "")).toEqual({ problem: "inlineSecret" });
    expect(checkSpec(NODE, "annotation", "rke2.io/node-args", "")).toEqual({ problem: "inlineSecret" });
    expect(checkSpec(NODE, "field", '.metadata.annotations["k3s.io/node-args"]', "")).toEqual({ problem: "inlineSecret" });
    expect("spec" in checkSpec(NODE, "annotation", "k3s.io/hostname", "")).toBe(true);
  });
});

describe("a step picking by fields (#392)", () => {
  it("takes several pairs and picks a list item or a map's value in key order", () => {
    const steps = parseFieldPath('.status.nodes[type="Suspend",phase="Running"].name');
    expect(steps).toEqual([{ key: "status" }, { key: "nodes" }, { match: [["type", "Suspend"], ["phase", "Running"]] }, { key: "name" }]);
    expect(formatFieldPath(steps!)).toBe('.status.nodes[type="Suspend",phase="Running"].name');
    const nodes = {
      "wf-b": { type: "Suspend", phase: "Running", name: "second" },
      "wf-a": { type: "Suspend", phase: "Running", name: "first" },
      "wf-c": { type: "Pod", phase: "Running", name: "pod" },
    };
    expect(pickItem(nodes, [["type", "Suspend"], ["phase", "Running"]])).toEqual(nodes["wf-a"]);
    expect(pickItem([{ type: "Suspend", phase: "Succeeded" }, nodes["wf-b"]], [["type", "Suspend"], ["phase", "Running"]])).toEqual(nodes["wf-b"]);
    expect(pickItem("x", [["type", "Pod"]])).toBeUndefined();
    // Up to 12 pairs (#404): "the first False condition but these types" needs many.
    const pairs = (n: number) => Array.from({ length: n }, (_, i) => `k${i}!="${i}"`).join(",");
    expect(parseFieldPath(`a[${pairs(12)}]`)).not.toBeNull();
    expect(parseFieldPath(`a[${pairs(13)}]`)).toBeNull();
    expect(parseFieldPath('a[b="1",]')).toBeNull();
    expect(parseFieldPath('a[b="1" c="2"]')).toBeNull();
  });
});

describe("the earliest match and every match (#399)", () => {
  it("parses `<field` and `*`, the latter only last, and reads them", () => {
    const earliest = parseFieldPath('.status.nodes[phase="Failed",<finishedAt].n');
    expect(earliest).toEqual([{ key: "status" }, { key: "nodes" }, { match: [["phase", "Failed"]], earliest: "finishedAt" }, { key: "n" }]);
    expect(formatFieldPath(earliest!)).toBe('.status.nodes[phase="Failed",<finishedAt].n');
    expect(parseFieldPath('.status.nodes[type="Pod",*]')).toEqual([{ key: "status" }, { key: "nodes" }, { match: [["type", "Pod"]], all: true }]);
    // The steps after `*` read each item (#404); one list per path.
    expect(parseFieldPath('.status.nodes[type="Pod",*].name')).not.toBeNull();
    expect(parseFieldPath(".spec.listeners[*].name")).toEqual([{ key: "spec" }, { key: "listeners" }, { match: [], all: true }, { key: "name" }]);
    expect(formatFieldPath(parseFieldPath(".spec.listeners[*].name")!)).toBe(".spec.listeners[*].name");
    expect(parseFieldPath(".spec.c[<name]")).toEqual([{ key: "spec" }, { key: "c" }, { match: [], earliest: "name" }]);
    expect(formatFieldPath(parseFieldPath(".spec.c[<name]")!)).toBe(".spec.c[<name]");
    // Lists three deep, flattened into one (#404, ADR-0169); four are too many.
    expect(parseFieldPath(".a[*].b[*]")).not.toBeNull();
    expect(parseFieldPath(".a[*].b[*].c[*]")).not.toBeNull();
    expect(parseFieldPath(".a[*].b[*].c[*].d[*]")).toBeNull();
    expect(parseFieldPath('.a[b="1",<]')).toBeNull();
    const nodes = {
      a: { phase: "Failed", finishedAt: "2026-11-07T10:05:00Z", n: "late" },
      b: { phase: "Failed", finishedAt: "2026-11-07T10:01:00Z", n: "early" },
      c: { phase: "Failed", n: "unfinished" },
      d: { phase: "Succeeded", finishedAt: "2026-11-07T09:00:00Z", n: "ok" },
    };
    expect(pickStep(nodes, { match: [["phase", "Failed"]], earliest: "finishedAt" })).toEqual(nodes.b);
    expect(pickStep(nodes, { match: [["phase", "Failed"]], all: true })).toHaveLength(3);
  });
});

describe("match fields compared trimmed (ADR-0169)", () => {
  it("read blank text and a field that leads nowhere as empty, as Rust's `trimmed_fits`", () => {
    const routes = [{ match: "  " }, { match: "Host(`a`)" }, {}, { match: null }, { match: ["x"] }];
    const blank = parseFieldPath('.spec.routes[match~="",*]')!;
    expect(blank[2]).toEqual({ match: [["match~", ""]], all: true });
    expect(pickStep(routes, blank[2] as Extract<PathStep, { match: unknown }>)).toEqual([routes[0], routes[2], routes[3]]);
    const set = parseFieldPath('.spec.routes[match~!="",*]')!;
    expect(pickStep(routes, set[2] as Extract<PathStep, { match: unknown }>)).toEqual([routes[1], routes[4]]);
    // The wanted text is trimmed too; `~` comes before `!` only.
    const padded = parseFieldPath('.a[b~=" x "]')!;
    expect(pickStep([{ b: "x  " }], padded[1] as Extract<PathStep, { match: unknown }>)).toEqual({ b: "x  " });
    expect(parseFieldPath('.a[b!~=""]')).toBeNull();
    expect(parseFieldPath('.a[~=""]')).toBeNull();
  });
});

describe("match steps with nested fields, negation and scalars (#404)", () => {
  it("pick by a nested field, not a value, or a boolean written as text", () => {
    const connectors = [
      { name: "a", connector: { state: "RUNNING" } },
      { name: "b", connector: { state: "FAILED" } },
    ];
    const failed = parseFieldPath('[connector.state="FAILED"]')!;
    expect(pickStep(connectors, failed[0] as Extract<PathStep, { match: unknown }>)).toEqual(connectors[1]);
    const owners = [{ name: "x", controller: false }, { name: "y", controller: true }];
    expect(pickStep(owners, { match: [["controller", "true"]] })).toEqual(owners[1]);
    expect(pickStep([{ type: "Ready" }, { type: "Synced" }, { reason: "x" }], { match: [["type!", "Ready"]], all: true })).toHaveLength(2);
    expect(parseFieldPath('.a[b.c!="x"]')).not.toBeNull();
    for (const bad of ['.a[.b="x"]', '.a[b..c="x"]', '.a[b.="x"]', '.a[b!!="x"]']) expect(parseFieldPath(bad), bad).toBeNull();
  });
});
