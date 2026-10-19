import { describe, expect, it } from "vitest";
import { contextAt, documentsOf, fieldAt } from "./context";
import { cursor } from "./fixtures";


function ctx(marked: string) {
  const { text, offset } = cursor(marked);
  return contextAt(text, offset);
}

describe("contextAt: block style", () => {
  it.each([
    ["a key at the root", "apiVersion: v1\nki¦", [], "key", "ki"],
    ["a key in a nested map", "spec:\n  template:\n    spec:\n      host¦", ["spec", "template", "spec"], "key", "host"],
    ["an empty line in a map", "spec:\n  replicas: 1\n  ¦", ["spec"], "key", ""],
    [
      "a key in a list item (kubectl style, dash under the key)",
      "spec:\n  containers:\n  - name: web\n    ima¦",
      ["spec", "containers", -1],
      "key",
      "ima",
    ],
    ["a key in a list item (indented dash)", "spec:\n  containers:\n    - name: web\n      po¦", ["spec", "containers", -1], "key", "po"],
    ["the first key of a list item", "spec:\n  containers:\n  - na¦", ["spec", "containers", -1], "key", "na"],
    ["a list in a list item", "containers:\n- env:\n  - name: A\n    val¦", ["containers", -1, "env", -1], "key", "val"],
    ["a key after a block scalar", "data:\n  script: |\n    run: this\n    other: that\n  ne¦", ["data"], "key", "ne"],
    ["a scalar list item", "spec:\n  args:\n  - --verb¦", ["spec", "args", -1], "key", "--verb"],
  ] as const)("%s", (_name, marked, path, mode, prefix) => {
    const found = ctx(marked);
    expect(found?.path).toEqual(path);
    expect(found?.mode).toBe(mode);
    expect(found?.prefix).toBe(prefix);
  });

  it("names the key whose value is typed", () => {
    expect(ctx("spec:\n  strategy:\n    type: Rec¦")).toMatchObject({ path: ["spec", "strategy"], mode: "value", key: "type", prefix: "Rec" });
    expect(ctx('metadata:\n  "quoted key": ¦')).toMatchObject({ path: ["metadata"], mode: "value", key: "quoted key", prefix: "" });
  });

  it("lists the keys the map already has, above and below, but not those of other items", () => {
    const found = ctx("spec:\n  containers:\n  - name: a\n    image: x\n    ¦\n    tty: true\n  - name: b\n    args: []\n");
    expect(found?.siblings.sort()).toEqual(["image", "name", "tty"]);
    expect(found?.column).toBe(4);
  });

  it("says nothing inside a comment or a block scalar", () => {
    expect(ctx("spec: # a comm¦")).toBeNull();
    expect(ctx("data:\n  script: |\n    echo ¦")).toBeNull();
  });
});

describe("contextAt: flow style on the cursor's line", () => {
  it.each([
    ["a key in a flow map", "metadata:\n  labels: {app: web, tie¦", ["metadata", "labels"], "key", undefined, "tie"],
    ["a value in a flow map", "spec:\n  strategy: {type: Rol¦", ["spec", "strategy"], "value", "type", "Rol"],
    ["a map in a flow list", "containers:\n- ports: [{containerPort: 80, prot¦", ["containers", -1, "ports", -1], "key", undefined, "prot"],
    ["an item of a flow list", "args: [--a, --b¦", ["args"], "value", -1, "--b"],
    ["a flow map as a list item", "env:\n- {name: A, val¦", ["env", -1], "key", undefined, "val"],
  ] as const)("%s", (_name, marked, path, mode, key, prefix) => {
    const found = ctx(marked);
    expect(found?.path).toEqual(path);
    expect(found?.mode).toBe(mode);
    expect(found?.key).toBe(key);
    expect(found?.prefix).toBe(prefix);
  });

  it("is outside the collection once it is closed", () => {
    expect(ctx("labels: {app: web} ¦")).toBeNull();
  });
});

describe("documents", () => {
  it("splits at --- and reads each document's own apiVersion and kind", () => {
    const text = "apiVersion: v1\nkind: Service\n---\napiVersion: apps/v1\nkind: 'Deployment' # web\nspec: {}\n---\n";
    const docs = documentsOf(text);
    expect(docs.map((d) => [d.apiVersion, d.kind])).toEqual([
      ["v1", "Service"],
      ["apps/v1", "Deployment"],
      // After the last separator: an empty document, where the next object is typed.
      [undefined, undefined],
    ]);
    expect(text.slice(docs[1]?.from, docs[1]?.to)).toBe("apiVersion: apps/v1\nkind: 'Deployment' # web\nspec: {}");
  });

  it("finds the path of a key in the second document from its own lines only", () => {
    const { text, offset } = cursor("kind: A\nspec:\n  x: 1\n---\nkind: B\nspec:\n  y¦");
    expect(contextAt(text, offset)?.path).toEqual(["spec"]);
  });
});

describe("fieldAt", () => {
  it("is the key under the pointer, or the field whose value is under it", () => {
    const text = "spec:\n  replicas: 3\n  strategy:\n    type: Recreate\n";
    expect(fieldAt(text, text.indexOf("plicas"))).toMatchObject({ path: ["spec", "replicas"], from: 8, to: 16 });
    expect(fieldAt(text, text.indexOf("create"))?.path).toEqual(["spec", "strategy", "type"]);
    expect(fieldAt(text, text.indexOf("spec"))?.path).toEqual(["spec"]);
  });
});
