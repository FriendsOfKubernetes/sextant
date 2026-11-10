// An extension's computed columns clean cluster text wherever it shows: a URI's credentials, query
// and fragment never reach a cell, a list or a hover, as they never reach a case's text.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnContribution, KubeObject } from "../api";
import { computedColumn } from "./columns";

const KIND = { group: "serving.kserve.io", kind: "InferenceService" };
const column = (rest: Partial<ColumnContribution>): ColumnContribution =>
  ({ kind: KIND, id: "c", title: "C", paths: [".status.url"], ...rest }) as ColumnContribution;
const obj = {
  metadata: { name: "a" },
  status: {
    url: "https://user:secret@model.example.com/v1?token=x",
    urls: ["https://u:p@a.example.com/", "plain"],
    message: "pulling s3://key:hidden@bucket/model failed",
  },
} as unknown as KubeObject;
const ctx = { now: Date.now(), t: (key: string) => key } as never;

describe("an extension's computed column", () => {
  it("cleans a text cell, a list cell and a hover", () => {
    const text = computedColumn("x", column({}));
    expect(text.searchText!(obj, ctx)).toBe("https://model.example.com/v1");
    const list = computedColumn("x", column({ paths: [".status.urls"], format: "list" }));
    expect(list.searchText!(obj, ctx)).not.toContain("u:p@");
    const hover = computedColumn("x", column({ tooltipPaths: [".status.message"] }));
    const { container } = render(<>{hover.render!(obj, ctx)}</>);
    const title = container.querySelector("span[title]")!.getAttribute("title")!;
    expect(title).not.toContain("hidden");
    expect(title).toContain("failed");
  });

  it("takes the width it asks for (#403)", () => {
    expect(computedColumn("x", column({ width: "minmax(140px, 1.5fr)" })).width).toBe("minmax(140px, 1.5fr)");
    expect(computedColumn("x", column({})).width).toBeUndefined();
  });

  it("count, add and list entries of what a [*] path reads (#404)", () => {
    const o = {
      metadata: { name: "a", labels: { tier: "web", app: "shop" } },
      spec: { listeners: [{ name: "plain" }, { name: "tls" }], jobs: [{ restarts: 1 }, { restarts: "2" }, {}] },
    } as unknown as KubeObject;
    expect(computedColumn("x", column({ paths: [".spec.listeners[*].name"], format: "list" })).searchText!(o, ctx)).toBe("plain, tls");
    expect(computedColumn("x", column({ paths: [".spec.listeners"], format: "count" })).searchText!(o, ctx)).toBe("2");
    expect(computedColumn("x", column({ paths: [".metadata.labels"], format: "count" })).searchText!(o, ctx)).toBe("2");
    expect(computedColumn("x", column({ paths: [".spec.jobs[*].restarts"], format: "sum" })).searchText!(o, ctx)).toBe("3");
    // A count or a sum filters as a number (#404).
    expect(computedColumn("x", column({ paths: [".spec.jobs[*].restarts"], format: "sum" })).filter).toMatchObject({ type: "number" });
    expect(computedColumn("x", column({ paths: [".spec.listeners"], format: "count" })).filter!.value!(o, ctx)).toBe(2);
    expect(computedColumn("x", column({ paths: [".metadata.labels"], format: "entries" })).searchText!(o, ctx)).toBe("app=shop, tier=web");
    expect(computedColumn("x", column({ paths: [".metadata.labels"], format: "entries", separator: " | " })).searchText!(o, ctx)).toBe("app=shop | tier=web");
    expect(computedColumn("x", column({ paths: [".spec.listeners[*].name"], format: "list", separator: "; " })).searchText!(o, ctx)).toBe("plain; tls");
  });

  it("leave a cell blank with an empty case text, filter by case values, show a map's keys (#404)", () => {
    const yes = { type: "exists", path: ".status.connectorStatus" } as const;
    const running = column({
      paths: [".status.tasks"],
      cases: [{ when: { type: "not", of: { type: "exists", path: ".status.tasks" } }, text: "", value: 0 }],
    });
    const none = { metadata: { name: "n" }, status: {} } as unknown as KubeObject;
    const def = computedColumn("x", running);
    expect(def.searchText!(none, ctx)).toBe("");
    expect(def.value!(none)).toBe(0);
    const state = computedColumn("s", column({ paths: [".status.phase"], filterBy: "value", cases: [{ when: yes, text: "Prêt", value: "ready" }] }));
    const ready = { metadata: { name: "r" }, status: { connectorStatus: {}, phase: "x" } } as unknown as KubeObject;
    expect(state.searchText!(ready, ctx)).toBe("Prêt");
    // `searchBy: "value"`: found by the case's value (a state's name), as some built-in columns were.
    const byName = computedColumn("s", column({ paths: [".status.phase"], filterBy: "value", searchBy: "value", cases: [{ when: yes, text: "Prêt", value: "ready" }] }));
    expect(byName.searchText!(ready, ctx)).toBe("ready");
    expect(state.filter!.value!(ready, ctx)).toBe("ready");
    const store = { metadata: { name: "s" }, spec: { provider: { vault: { server: "x" } } } } as unknown as KubeObject;
    const provider = computedColumn("p", column({ paths: [".spec.provider"], cases: [{ when: { type: "exists", path: ".spec.provider" }, text: "{{.spec.provider|keys}}" }] }));
    expect(provider.searchText!(store, ctx)).toBe("vault");
  });

  it("hover a list column's whole text, unless it says `listTooltip: false`", () => {
    const obj = { metadata: { name: "s" }, spec: { triggers: [{ type: "cpu" }, { type: "kafka" }] } } as unknown as KubeObject;
    const hoverOf = (rest: Partial<ColumnContribution>) =>
      render(<>{computedColumn("t", column({ paths: [".spec.triggers[*].type"], format: "list", ...rest })).render!(obj, ctx)}</>).container
        .querySelector("span[title]")
        ?.getAttribute("title");
    expect(hoverOf({})).toBe("cpu, kafka");
    expect(hoverOf({ listTooltip: false })).toBeUndefined();
  });

  it("write each list item by its first holding case, joined by the separator (#404)", () => {
    const route = {
      metadata: { name: "r" },
      status: {
        traffic: [
          { revisionName: "a-1", percent: 80 },
          { latestRevision: true, percent: 20 },
          { revisionName: "a-0", percent: 0 },
          { configurationName: "c", percent: 5 },
        ],
      },
    } as unknown as KubeObject;
    const traffic = computedColumn(
      "t",
      column({
        paths: [".status.traffic"],
        format: "list",
        items: {
          separator: " · ",
          cases: [
            { when: { type: "all", of: [{ type: "above", path: ".percent", value: 0 }, { type: "exists", path: ".revisionName" }] }, text: "{{.revisionName}} {{.percent}}%" },
            { when: { type: "all", of: [{ type: "above", path: ".percent", value: 0 }, { type: "equals", path: ".latestRevision", value: true }] }, text: "latest {{.percent}}%" },
            { when: { type: "above", path: ".percent", value: 0 }, text: "{{.configurationName}} {{.percent}}%" },
          ],
        },
      }),
    );
    expect(traffic.searchText!(route, ctx)).toBe("a-1 80% · latest 20% · c 5%");
    const twice = { metadata: { name: "r" }, status: { traffic: [{ revisionName: "a", percent: 50 }, { revisionName: "a", percent: 50 }] } } as unknown as KubeObject;
    expect(traffic.searchText!(twice, ctx)).toBe("a 50% · a 50%");
    const { container } = render(<>{traffic.render!(route, ctx)}</>);
    expect(container.querySelector("span")?.getAttribute("title")).toBe("a-1 80% · latest 20% · c 5%");
  });

  it("read a number column's case key from a path, and judge endsWith (#404)", () => {
    const backup = { metadata: { name: "b" }, status: { errors: 3, phase: "UploadingPartiallyFailed" } } as unknown as KubeObject;
    const errors = computedColumn(
      "e",
      column({ paths: [".status.errors"], format: "number", cases: [{ when: { type: "above", path: ".status.errors", value: 0 }, text: "{{.status.errors}}", tone: "error", value: "{{.status.errors}}" }] }),
    );
    expect(errors.filter!.value!(backup, ctx)).toBe(3);
    const phase = computedColumn("p", column({ paths: [".status.phase"], cases: [{ when: { type: "endsWith", path: ".status.phase", values: ["PartiallyFailed"], ignoreCase: false }, text: "Partly failed" }] }));
    expect(phase.searchText!(backup, ctx)).toBe("Partly failed");
  });

  it("write CPU and bytes as Sextant does and sort them by the amount; a time in the UI language (#404)", () => {
    const vpa = { metadata: { name: "v" }, status: { cpu: "250m", whole: "2", memory: "262144k", saved: "2026-11-01T10:00:00Z" } } as unknown as KubeObject;
    const cpu = computedColumn("c", column({ paths: [".status.cpu"], format: "cpu" }));
    expect(cpu.searchText!(vpa, ctx)).toBe("250m");
    expect(cpu.value!(vpa)).toBe(0.25);
    expect(cpu.filter).toMatchObject({ type: "number" });
    expect(computedColumn("w", column({ paths: [".status.whole"], format: "cpu" })).searchText!(vpa, ctx)).toBe("2");
    const memory = computedColumn("m", column({ paths: [".status.memory"], format: "bytes" }));
    expect(memory.searchText!(vpa, ctx)).toBe("250MiB");
    expect(memory.value!(vpa)).toBe(262144000);
    const saved = computedColumn("s", column({ paths: [".status.saved"], format: "dateTime" }));
    expect(saved.value!(vpa)).toBe(Date.parse("2026-11-01T10:00:00Z"));
  });

  it("sort a list in the UI language's order, and pick a case's text by its count's plural form (#404)", () => {
    const stream = { metadata: { name: "s" }, spec: { tags: ["v2", "latest", "v10"] }, status: { failing: [1, 2] } } as unknown as KubeObject;
    expect(computedColumn("t", column({ paths: [".spec.tags"], format: "list", sorted: true })).searchText!(stream, ctx)).toBe("latest, v10, v2");
    const imports = computedColumn(
      "i",
      column({
        paths: [".status.failing"],
        cases: [{ when: { type: "exists", path: ".status.failing" }, text: "{{.status.failing|count}} imports fail", pluralBy: ".status.failing|count", textForms: { one: "{{.status.failing|count}} import fails" } }],
      }),
    );
    expect(imports.searchText!(stream, ctx)).toBe("2 imports fail");
    const one = { metadata: { name: "o" }, status: { failing: [1] } } as unknown as KubeObject;
    expect(imports.searchText!(one, ctx)).toBe("1 import fails");
  });

  it("join every path's list with joinPaths, each item once (#404)", () => {
    const o = {
      metadata: { name: "k" },
      spec: { listeners: [{ name: "plain" }, { name: "tls" }] },
      status: { listeners: [{ name: "tls" }, { name: "old" }] },
    } as unknown as KubeObject;
    const paths = [".spec.listeners[*].name", ".status.listeners[*].name"];
    expect(computedColumn("x", column({ paths, format: "list" })).searchText!(o, ctx)).toBe("plain, tls");
    expect(computedColumn("x", column({ paths, format: "list", joinPaths: true })).searchText!(o, ctx)).toBe("plain, tls, old");
    const statusOnly = { metadata: { name: "k" }, status: { listeners: [{ name: "old" }] } } as unknown as KubeObject;
    expect(computedColumn("x", column({ paths, format: "list", joinPaths: true })).searchText!(statusOnly, ctx)).toBe("old");
    expect(computedColumn("x", column({ paths, format: "list", joinPaths: true })).searchText!({ metadata: { name: "e" } } as KubeObject, ctx)).toBeFalsy();
  });

  it("tones any other value with the \"*\" tone (#403)", () => {
    const toned = computedColumn("x", column({ paths: [".status.phase"], tones: { Running: "ok", "*": "warning" } }));
    const at = (phase: string) => render(<>{toned.render!({ metadata: { name: "a" }, status: { phase } } as unknown as KubeObject, ctx)}</>).container;
    expect(at("Running").innerHTML).not.toBe(at("Paused").innerHTML.replace("Paused", "Running"));
  });

  it("falls back to the next tooltip when one has an empty value (#403)", () => {
    const col = computedColumn(
      "x",
      column({
        paths: [".status.phase"],
        cases: [
          {
            when: { type: "exists", path: ".status.phase" },
            text: "{{.status.phase}}",
            tooltip: "{{.status.reason}}: {{.status.message}}",
            tooltipOr: ["{{.status.message}}"],
          },
        ],
      }),
    );
    const titleOf = (status: Record<string, unknown>) =>
      render(<>{col.render!({ metadata: { name: "a" }, status } as unknown as KubeObject, ctx)}</>).container.querySelector("span[title]")?.getAttribute("title");
    expect(titleOf({ phase: "Pending", reason: "Quota", message: "waiting" })).toBe("Quota: waiting");
    expect(titleOf({ phase: "Pending", reason: "", message: "waiting" })).toBe("waiting");
  });

  it("sorts a text column by a case's text value (#404)", () => {
    const col = computedColumn(
      "x",
      column({ paths: [".status.phase"], cases: [{ when: { type: "exists", path: ".status.reason" }, text: "{{.status.phase}}", value: "{{.status.reason}}" }] }),
    );
    expect(col.value!({ metadata: { name: "a" }, status: { phase: "Progressing", reason: "AllCatalogSourcesHealthy" } } as unknown as KubeObject)).toBe("AllCatalogSourcesHealthy");
  });

  it("show a list's first item and how many more, every item on a line of the hover, as the built-in hosts columns", () => {
    const vs = { metadata: { name: "a", namespace: "shop" }, spec: { hosts: ["a.example.com", "b.example.com", "c"] } } as unknown as KubeObject;
    const hosts = computedColumn("x", column({ paths: [".spec.hosts"], format: "firstPlus" }));
    expect(hosts.searchText!(vs, ctx)).toBe("a.example.com +2");
    expect(hosts.value(vs)).toBe("a.example.com +2");
    expect(hosts.filter).toMatchObject({ type: "string" });
    const { container } = render(<>{hosts.render!(vs, ctx)}</>);
    expect(container.textContent).toBe("a.example.com +2");
    expect(container.querySelector("span[title]")!.getAttribute("title")).toBe("a.example.com\nb.example.com\nc");
    const one = { metadata: { name: "b" }, spec: { hosts: ["only"] } } as unknown as KubeObject;
    expect(hosts.searchText!(one, ctx)).toBe("only");
    expect(hosts.searchText!({ metadata: { name: "c" } } as KubeObject, ctx)).toBeFalsy();
  });

  it("write text items as themselves and with the object's fields, in lower case and completed as a Service's name", () => {
    const vs = { metadata: { name: "a", namespace: "shop" }, spec: { gateways: ["mesh", "edge/public", "internal"] } } as unknown as KubeObject;
    const gateways = computedColumn(
      "x",
      column({
        paths: [".spec.gateways"],
        format: "list",
        items: {
          cases: [
            { when: { type: "equals", path: ".", value: "mesh" }, text: "mesh" },
            { when: { type: "contains", path: ".", values: ["/"], ignoreCase: false }, text: "{{.}}" },
            { when: { type: "exists", path: "." }, text: "{{$.metadata.namespace}}/{{.}}" },
          ],
          separator: ", ",
        },
      }),
    );
    expect(gateways.searchText!(vs, ctx)).toBe("mesh, edge/public, shop/internal");
    const se = { metadata: { name: "e", namespace: "pay" }, spec: { hosts: ["Ledger", "api.example.com", "*"] } } as unknown as KubeObject;
    const seHosts = computedColumn(
      "x",
      column({ paths: [".spec.hosts"], format: "firstPlus", items: { cases: [{ when: { type: "exists", path: "." }, text: "{{.|lower|fqdn:$.metadata.namespace}}" }] } }),
    );
    expect(seHosts.searchText!(se, ctx)).toBe("ledger.pay.svc.cluster.local +2");
    const { container } = render(<>{seHosts.render!(se, ctx)}</>);
    expect(container.querySelector("span[title]")!.getAttribute("title")).toBe("ledger.pay.svc.cluster.local\napi.example.com\n*");
  });

  it("name each host of a Gateway once after its namespace, and keep the repeats with joinPaths keep", () => {
    const gw = {
      metadata: { name: "g", namespace: "edge" },
      spec: { servers: [{ hosts: ["shop/Web.example.com", "api.example.com"] }, { hosts: ["*/web.example.com", "x.example.com"] }] },
    } as unknown as KubeObject;
    const hosts = computedColumn(
      "x",
      column({
        paths: [".spec.servers[*].hosts[*]"],
        format: "firstPlus",
        joinPaths: true,
        items: {
          cases: [
            { when: { type: "contains", path: ".", values: ["/"], ignoreCase: false }, text: "{{.|after:/|lower}}" },
            { when: { type: "exists", path: "." }, text: "{{.|lower}}" },
          ],
        },
      }),
    );
    expect(hosts.searchText!(gw, ctx)).toBe("web.example.com +2");
    const mtls = { metadata: { name: "m" }, spec: { identities: ["a", "b"], identityRefs: [{ name: "a" }] } } as unknown as KubeObject;
    const paths = [".spec.identities", ".spec.identityRefs[*].name"];
    expect(computedColumn("x", column({ paths, format: "list", joinPaths: "keep", separator: ", " })).searchText!(mtls, ctx)).toBe("a, b, a");
    expect(computedColumn("x", column({ paths, format: "list", joinPaths: true, separator: ", " })).searchText!(mtls, ctx)).toBe("a, b");
  });
});
