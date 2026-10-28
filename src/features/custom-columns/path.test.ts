// Custom columns (#214): the field path grammar, key syntax, the Secret refusal and how values are read and shown.
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import {
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
