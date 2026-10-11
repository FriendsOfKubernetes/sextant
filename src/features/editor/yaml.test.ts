import { describe, expect, it } from "vitest";
import { toYaml } from "./yaml";

describe("toYaml", () => {
  it("writes an object as block YAML with lists of objects under their key", () => {
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", labels: { app: "web" }, annotations: {} },
      spec: {
        replicas: 2,
        paused: false,
        template: {
          spec: {
            containers: [{ name: "web", image: "nginx:stable-alpine", ports: [{ containerPort: 80 }], args: [] }],
          },
        },
      },
      status: null,
    };
    expect(toYaml(deployment)).toBe(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: web",
        "  labels:",
        "    app: web",
        "  annotations: {}",
        "spec:",
        "  replicas: 2",
        "  paused: false",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: web",
        "          image: nginx:stable-alpine",
        "          ports:",
        "            - containerPort: 80",
        "          args: []",
        "status: null",
        "",
      ].join("\n"),
    );
  });

  it("quotes strings that plain YAML would read as another type", () => {
    const labels = {
      enabled: "true",
      off: "off",
      version: "1.10",
      port: "8080",
      octal: "0755",
      hex: "0x1F",
      empty: "",
      tilde: "~",
      date: "2026-10-11",
      time: "12:30",
      colon: "a: b",
      comment: "a #b",
      star: "*all",
      dash: "- x",
      spaced: " lead",
      "8080": "numeric key",
      plain: "nginx:stable-alpine",
      path: "/var/run",
      negative: "-foo",
    };
    const text = toYaml(labels);
    expect(text).toContain('enabled: "true"');
    expect(text).toContain('"off": "off"');
    expect(text).toContain('version: "1.10"');
    expect(text).toContain('port: "8080"');
    expect(text).toContain('octal: "0755"');
    expect(text).toContain('hex: "0x1F"');
    expect(text).toContain('empty: ""');
    expect(text).toContain('tilde: "~"');
    expect(text).toContain('date: "2026-10-11"');
    expect(text).toContain('time: "12:30"');
    expect(text).toContain('colon: "a: b"');
    expect(text).toContain('comment: "a #b"');
    expect(text).toContain('star: "*all"');
    expect(text).toContain('dash: "- x"');
    expect(text).toContain('spaced: " lead"');
    expect(text).toContain('"8080": numeric key');
    expect(text).toContain("plain: nginx:stable-alpine");
    expect(text).toContain("path: /var/run");
    expect(text).toContain("negative: -foo");
  });

  it("keeps multi-line strings exactly as literal blocks", () => {
    expect(toYaml({ data: { script: "echo a\necho b\n" } })).toBe("data:\n  script: |\n    echo a\n    echo b\n");
    expect(toYaml({ s: "a\nb" })).toBe("s: |-\n  a\n  b\n");
    expect(toYaml({ s: "a\n\n" })).toBe("s: |+\n  a\n\n");
    // A first line that starts with a space would need an indentation indicator: quoted instead.
    expect(toYaml({ s: "  indented\nnext" })).toBe('s: "  indented\\nnext"\n');
    // Carriage returns cannot live in a block: quoted instead.
    expect(toYaml({ s: "a\r\nb" })).toBe('s: "a\\r\\nb"\n');
  });

  it("writes nested and empty lists", () => {
    expect(toYaml({ matrix: [[1, 2], [], ["x"]] })).toBe("matrix:\n  -\n    - 1\n    - 2\n  - []\n  -\n    - x\n");
  });
});
