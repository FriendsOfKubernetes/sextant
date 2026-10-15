import type { HostContext, JsonValue } from "@sextant/extension-sdk";
import { startTestHost, type TestHost } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { podSummary, startPodsPage } from "./pods";

const pod = (name: string, uid: string): JsonValue => ({
  metadata: { name, uid, namespace: "sextant-demo", creationTimestamp: "2026-10-14T10:00:00Z" },
  status: {
    phase: "Running",
    containerStatuses: [
      { name: "app", ready: true, restartCount: 1 },
      { name: "sidecar", ready: false, restartCount: 2, state: { waiting: { reason: "CrashLoopBackOff" } } },
    ],
  },
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void;

async function start(stored?: string, context: Partial<HostContext> = {}) {
  host = await startTestHost({
    context: { clusterId: "kind-sextant-test", namespaces: null, ...context },
    handlers: {
      "resources.list": () => ({
        items: [{ metadata: { name: "default" } }, { metadata: { name: "sextant-demo" } }],
        truncated: false,
      }),
    },
  });
  if (stored) host.storage.set("namespace", stored);
  root = document.createElement("main");
  document.body.append(root);
  stop = startPodsPage(host.sextant, root);
  await expect.poll(() => host.watches.length).toBe(1);
}

const rows = () => [...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

afterEach(() => {
  stop();
  root.remove();
  host.close();
});

describe("hello page", () => {
  it("watches the pods of the remembered namespace and lists them live", async () => {
    await start("sextant-demo");
    expect(host.watches[0]!.params).toEqual({
      clusterId: "kind-sextant-test",
      kind: { group: "", kind: "Pod" },
      namespaces: ["sextant-demo"],
    });
    host.watches[0]!.emit({ type: "snapshot", items: [pod("web-2", "2"), pod("web-1", "1")] });
    await expect.poll(() => rows().map((r) => r[0])).toEqual(["web-1", "web-2"]);
    expect(rows()[0]!.slice(1, 5)).toEqual(["sextant-demo", "1/2", "CrashLoopBackOff", "3"]);
    host.watches[0]!.emit({ type: "delta", upserted: [], deleted: ["1"] });
    await expect.poll(() => rows().map((r) => r[0])).toEqual(["web-2"]);
    expect(root.querySelector(".status")!.textContent).toBe("1 pod");
  });

  it("shows the namespaces of Sextant's filter by default, and every namespace when it has none", async () => {
    await start(undefined, { namespaces: ["team-a", "team-b"] });
    expect(host.watches[0]!.params).toEqual({
      clusterId: "kind-sextant-test",
      kind: { group: "", kind: "Pod" },
      namespaces: ["team-a", "team-b"],
    });
    const select = root.querySelector("select")!;
    await expect.poll(() => [...select.options].map((o) => o.textContent)).toEqual([
      "Sextant's filter (team-a, team-b)",
      "default",
      "sextant-demo",
    ]);
    expect(select.value).toBe("");
    stop();
    host.close();
    root.remove();

    await start();
    expect(host.watches[0]!.params).toEqual({ clusterId: "kind-sextant-test", kind: { group: "", kind: "Pod" } });
  });

  it("follows a change of Sextant's filter unless a namespace is picked on the page", async () => {
    await start(undefined, { namespaces: ["team-a"] });
    host.setContext({ namespaces: ["team-b"] });
    await expect.poll(() => host.watches.length).toBe(2);
    expect(host.watches[0]!.stopped).toBe(true);
    expect(host.watches[1]!.params).toMatchObject({ namespaces: ["team-b"] });

    const select = root.querySelector("select")!;
    await expect.poll(() => select.options.length).toBe(3);
    select.value = "sextant-demo";
    select.dispatchEvent(new Event("change"));
    await expect.poll(() => host.watches.length).toBe(3);
    expect(host.watches[2]!.params).toMatchObject({ namespaces: ["sextant-demo"] });
    await expect.poll(() => host.storage.get("namespace")).toBe("sextant-demo");

    // The picked namespace overrides the filter: a new filter only changes the picker's label.
    host.setContext({ namespaces: null });
    await expect.poll(() => select.options[0]!.textContent).toBe("Sextant's filter (all namespaces)");
    expect(host.watches).toHaveLength(3);

    // Back to Sextant's filter: the choice is forgotten.
    select.value = "";
    select.dispatchEvent(new Event("change"));
    await expect.poll(() => host.watches.length).toBe(4);
    expect(host.watches[2]!.stopped).toBe(true);
    expect(host.watches[3]!.params).toEqual({ clusterId: "kind-sextant-test", kind: { group: "", kind: "Pod" } });
    await expect.poll(() => host.storage.has("namespace")).toBe(false);
  });

  it("opens a pod's details in Sextant", async () => {
    await start("sextant-demo");
    host.watches[0]!.emit({ type: "snapshot", items: [pod("web-1", "1")] });
    await expect.poll(() => rows().length).toBe(1);
    root.querySelector<HTMLButtonElement>("tbody button")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespace: "sextant-demo",
      name: "web-1",
    });
  });

  it("follows the cluster of the context", async () => {
    await start("sextant-demo");
    host.setContext({ clusterId: "other" });
    await expect.poll(() => host.watches.length).toBe(2);
    expect(host.watches[0]!.stopped).toBe(true);
    expect(host.watches[1]!.params).toMatchObject({ clusterId: "other" });
  });

  it("says why when it may not watch", async () => {
    host = await startTestHost({
      handlers: {
        "resources.list": () => ({ items: [], truncated: false }),
        "resources.watch": () => {
          throw { code: "denied", message: "Extension Hello pods may not read Pods in default" };
        },
      },
    });
    root = document.createElement("main");
    stop = startPodsPage(host.sextant, root);
    await expect.poll(() => root.querySelector(".error")?.textContent).toContain("may not read Pods");
  });
});

describe("podSummary", () => {
  it("counts ready containers and restarts, and names the reason a container waits", () => {
    expect(podSummary(pod("a", "1") as never)).toMatchObject({ ready: "1/2", status: "CrashLoopBackOff", restarts: 3 });
    expect(podSummary({ metadata: { name: "b" }, status: { phase: "Pending" } })).toMatchObject({
      ready: "0/0",
      status: "Pending",
      restarts: 0,
    });
    expect(podSummary({ metadata: { name: "c", deletionTimestamp: "x" }, status: { phase: "Running" } }).status).toBe(
      "Terminating",
    );
  });
});
