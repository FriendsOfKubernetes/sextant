import { describe, expect, it } from "vitest";
import { buildLinks, edgeValues, objectValues, targetOf, WINDOW_MS } from "./model";
import { MIXIN_UIDS, PRESETS, explorePath } from "./presets";
import { checkBaseUrl, checkTemplate, fillTemplate, type Target } from "./template";

const BASE = "https://grafana.example.com";

describe("base URLs", () => {
  it.each([
    ["https://grafana.example.com/", { url: BASE }],
    ["  https://example.com/grafana/  ", { url: "https://example.com/grafana" }],
    ["http://localhost:3000", { url: "http://localhost:3000" }],
    ["http://127.0.0.1:3000", { url: "http://127.0.0.1:3000" }],
    ["http://[::1]:3000", { url: "http://[::1]:3000" }],
    ["", { error: "empty" }],
    ["http://grafana.example.com", { error: "scheme" }],
    ["javascript:alert(1)", { error: "invalid" }],
    ["data:text/html,hi", { error: "invalid" }],
    ["ftp://grafana.example.com", { error: "scheme" }],
    ["https://admin:secret@grafana.example.com", { error: "credentials" }],
    ["https://user@grafana.example.com", { error: "credentials" }],
    ["https://grafana.example.com/?orgId=1", { error: "query" }],
    ["https://grafana.example.com/#x", { error: "query" }],
    ["https://grafana example.com", { error: "invalid" }],
    ["https://grafana.example.com\\x", { error: "invalid" }],
    ["grafana.example.com", { error: "invalid" }],
    [`https://g.example/${"a".repeat(2048)}`, { error: "tooLong" }],
  ])("%s", (text, expected) => {
    expect(checkBaseUrl(text)).toEqual(expected);
  });
});

describe("templates", () => {
  it.each<[string, Target, string | null]>([
    ["/d/abc?var-pod={pod}&from={from}&to={to}", "pod", null],
    [`${BASE}/d/abc?var-pod={pod}`, "pod", null],
    ["https://grafana.example.com:443/d/abc", "pod", null],
    ["https://evil.example.com/d/abc?var-pod={pod}", "pod", "origin"],
    ["http://grafana.example.com/d/abc", "pod", "origin"],
    ["javascript:alert(1)", "pod", "origin"],
    ["data:text/html,{pod}", "pod", "origin"],
    ["//evil.example.com/x", "pod", null],
    ["https://user:pw@grafana.example.com/d/abc", "pod", "origin"],
    ["/d/abc?var-x={secret}", "pod", "variable"],
    ["/d/abc?var-node={node}", "namespace", "variable"],
    ["/d/abc?q={pod", "pod", "brace"],
    ['/explore?q={namespace="a"}', "namespace", "brace"],
    ["/d/abc?q=%7Bjob%7D&p={pod}", "pod", null],
    ["/d/a b", "pod", "invalid"],
    ["/d/a\\b", "pod", "invalid"],
    ["", "pod", "empty"],
  ])("%s for %s", (template, target, expected) => {
    expect(checkTemplate(BASE, template, target)).toBe(expected);
  });

  it("needs a base URL", () => {
    expect(checkTemplate(null, "/d/abc", "pod")).toBe("noBase");
  });

  it("puts in URL-encoded values and keeps the base path", () => {
    const url = fillTemplate("https://example.com/grafana", "/d/abc?var-pod={pod}&x={namespace}", "pod", {
      pod: "web-1",
      namespace: "team:a",
    });
    expect(url).toBe("https://example.com/grafana/d/abc?var-pod=web-1&x=team%3Aa");
  });

  it("gives no link for a missing or unsafe value", () => {
    expect(fillTemplate(BASE, "/d/abc?var-pod={pod}", "pod", {})).toBeNull();
    for (const pod of ["a b", "a&b=c", "a/../b", "-x", "a\"b", "é"]) {
      expect(fillTemplate(BASE, "/d/abc?var-pod={pod}", "pod", { pod })).toBeNull();
    }
  });

  it("gives no link for a template that fails its check", () => {
    expect(fillTemplate(BASE, "https://evil.example.com/{pod}", "pod", { pod: "a" })).toBeNull();
    expect(fillTemplate(BASE, "/d/{secret}", "pod", { pod: "a" })).toBeNull();
  });
});

describe("presets", () => {
  it("each passes its own check and fills", () => {
    const values = {
      namespace: "shop",
      name: "web",
      kind: "deployment",
      pod: "web-1",
      node: "n1",
      service: "web",
      destination: "api",
      source: "web",
      from: "1000",
      to: "2000",
    };
    for (const preset of PRESETS) {
      expect(checkTemplate(BASE, preset.template, preset.target), preset.id).toBeNull();
      const url = fillTemplate(BASE, preset.template, preset.target, values);
      expect(url, preset.id).not.toBeNull();
      expect(new URL(url!).origin).toBe(BASE);
    }
  });

  it("use the Kubernetes mixin's dashboard uids", () => {
    expect(MIXIN_UIDS.pod).toBe("6581e46e4e5c7ba40a07646395ef7b23");
    const pod = PRESETS.find((p) => p.id === "mixinPod")!;
    expect(fillTemplate(BASE, pod.template, "pod", { namespace: "shop", pod: "web-1", from: "1", to: "2" })).toBe(
      `${BASE}/d/6581e46e4e5c7ba40a07646395ef7b23?var-namespace=shop&var-pod=web-1&from=1&to=2`,
    );
  });

  it("build an Explore pane whose JSON carries the values", () => {
    const template = explorePath({ type: "tempo", uid: "tempo" }, { query: '{resource.service.name="{service}"}' });
    const url = new URL(fillTemplate(BASE, template, "traces", { service: "web", from: "1", to: "2" })!);
    const panes = JSON.parse(url.searchParams.get("panes")!);
    expect(panes.a.queries[0].query).toBe('{resource.service.name="web"}');
    expect(panes.a.range).toEqual({ from: "1", to: "2" });
  });

  it("Jaeger's search takes microseconds", () => {
    const jaeger = PRESETS.find((p) => p.id === "jaeger")!;
    const url = fillTemplate("https://jaeger.example.com", jaeger.template, "traces", { service: "web", from: "5", to: "9" });
    expect(url).toBe("https://jaeger.example.com/search?service=web&start=5000&end=9000&lookback=custom&limit=20");
  });
});

describe("object values", () => {
  const now = 10 * WINDOW_MS;
  it("knows the targets", () => {
    expect(targetOf({ group: "apps", version: "v1", kind: "Deployment" })).toBe("workload");
    expect(targetOf({ group: "", version: "v1", kind: "Pod" })).toBe("pod");
    expect(targetOf({ group: "", version: "v1", kind: "Secret" })).toBeNull();
    expect(targetOf({ group: "example.com", version: "v1", kind: "Pod" })).toBeNull();
  });

  it("fills a workload and a pod", () => {
    const deploy = objectValues(
      { group: "apps", version: "v1", kind: "Deployment" },
      { metadata: { name: "web", namespace: "shop" }, spec: { template: { metadata: { labels: { app: "web-svc" } } } } },
      "workload",
      now,
    );
    expect(deploy).toMatchObject({ name: "web", namespace: "shop", kind: "deployment", service: "web-svc" });
    expect(deploy.from).toBe(String(now - WINDOW_MS));
    const pod = objectValues(
      { group: "", version: "v1", kind: "Pod" },
      { metadata: { name: "web-1", namespace: "shop" }, spec: { nodeName: "n1", containers: [{ name: "app" }] } },
      "pod",
      now,
    );
    expect(pod).toMatchObject({ pod: "web-1", node: "n1", container: "app", service: "web-1" });
  });

  it("builds links only where configured", () => {
    const links = { grafanaUrl: BASE, dashboards: { node: "/d/n?var-node={node}" }, tracesUrl: null, traces: "/t?s={service}" };
    const values = objectValues({ group: "", version: "v1", kind: "Node" }, { metadata: { name: "n1" } }, "node", now);
    expect(buildLinks(links, "node", values)).toEqual({ dashboard: `${BASE}/d/n?var-node=n1`, traces: null });
    expect(buildLinks(links, "pod", { service: "web" })).toEqual({ dashboard: null, traces: `${BASE}/t?s=web` });
    expect(buildLinks({ ...links, grafanaUrl: "http://grafana.example.com" }, "node", values).dashboard).toBeNull();
    expect(buildLinks(null, "node", values)).toEqual({ dashboard: null, traces: null });
  });

  it("fills an edge from its ends", () => {
    const values = edgeValues(
      { kind: "workload", namespace: "a", name: "web" },
      { kind: "service", namespace: "b", name: "api" },
      now,
    );
    expect(values).toMatchObject({ source: "web", destination: "api", service: "api", namespace: "b" });
  });
});
