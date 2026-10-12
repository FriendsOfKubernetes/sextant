import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { toYaml } from "./yaml";

describe("toYaml", () => {
  it("writes maps, lists of maps and scalars the way kubectl does", () => {
    const value = {
      replicas: 2,
      paused: false,
      image: "nginx:1.27",
      ports: [{ name: "http", containerPort: 80 }],
      args: ["--port", "8080"],
      empty: {},
      none: [],
      nothing: null,
    };
    expect(toYaml(value)).toBe(
      [
        "replicas: 2",
        "paused: false",
        "image: nginx:1.27",
        "ports:",
        "- name: http",
        "  containerPort: 80",
        "args:",
        "- --port",
        '- "8080"',
        "empty: {}",
        "none: []",
        "nothing: null",
        "",
      ].join("\n"),
    );
  });

  it("quotes strings YAML would read as something else", () => {
    const value = { a: "true", b: "no", c: "1.5", d: "", e: "key: value", f: "x #y", g: "*star", "8080": "port", h: "~" };
    expect(toYaml(value)).toBe(
      [
        // Integer-like keys come first in a JS object.
        '"8080": port',
        'a: "true"',
        'b: "no"',
        'c: "1.5"',
        'd: ""',
        'e: "key: value"',
        'f: "x #y"',
        'g: "*star"',
        'h: "~"',
        "",
      ].join("\n"),
    );
  });

  it("writes multi-line text as a literal block", () => {
    expect(toYaml({ data: { "app.properties": "greeting=hello\ncolor=blue\n", script: "a\nb" } })).toBe(
      ["data:", "  app.properties: |", "    greeting=hello", "    color=blue", "  script: |-", "    a", "    b", ""].join("\n"),
    );
    // Leading spaces cannot start a block without an indentation indicator: quoted instead.
    expect(toYaml({ s: "  x\ny" })).toBe('s: "  x\\ny"\n');
  });
});

describe("toYaml round trip", () => {
  // Strings that a careless writer turns into other strings (or into YAML that does not parse at all).
  const EDGE = [
    "\n",
    "\n\n",
    "\n\n\n",
    "\n  x\ny",
    " leading space",
    " leading space\nnext",
    "  \nx",
    "\nx",
    "\n\nx",
    "a\n",
    "a\n\n",
    "a\n\n\nb",
    "x\n ",
    "x\n \n",
    "\n \n",
    "\t",
    "\t\n",
    "\ttabbed\nnext",
    "a\tb\nc\t",
    "a\n\t",
    "\t\nx",
    "line\n  indented\nback",
    "#comment\nx",
    "- item\nx",
    "key: v\nx",
    "---\nx",
    "...\nx",
    "a\r\nb",
    "a\u2028b",
    "a\u2029b\n",
    "a\u0085b\nc",
    "\ufeffa\nb",
    "😀\nzwj 👩‍👩‍👧",
    "",
    " ",
    "  ",
  ];

  it.each(EDGE.map((s) => [JSON.stringify(s), s]))("reads %s back unchanged at any depth", (_, s) => {
    const value = { top: s, nested: { deeper: { value: s } }, list: [s, { item: s }], [s || "empty"]: 1 };
    expect(parse(toYaml(value))).toEqual(value);
    expect(parse(toYaml(s))).toBe(s);
  });
});
