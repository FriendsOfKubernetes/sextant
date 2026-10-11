import { describe, expect, it } from "vitest";
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
