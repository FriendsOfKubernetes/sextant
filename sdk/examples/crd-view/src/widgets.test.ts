import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startScale } from "./scale";
import { startSettings } from "./settings";
import { startSummary } from "./summary";

const REF = { kind: { group: "demo.sextant.dev", version: "v1", kind: "Widget" }, namespace: "sextant-demo", name: "demo-widget" };
const widget = (replicas: number, generation = 1) => ({
  apiVersion: "demo.sextant.dev/v1",
  kind: "Widget",
  metadata: { name: "demo-widget", namespace: "sextant-demo", generation, resourceVersion: String(100 + generation) },
  spec: { size: "large", replicas },
});

let host: TestHost;
let root: HTMLElement;

async function start(view: "details" | "action" | "settings", options: TestHostOptions = {}) {
  host = await startTestHost({
    ...options,
    context: { view, selection: view === "settings" ? [] : [REF], ...options.context },
  });
  root = document.createElement("main");
  document.body.append(root);
}

const button = (text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text) ?? (null as unknown as HTMLButtonElement);
const input = (label: string) => root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const type = (field: HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event("input"));
};

afterEach(() => {
  root.remove();
  host.close();
});

describe("details section", () => {
  it("shows the widget and reads it again when it changes", async () => {
    let current = widget(3);
    await start("details", { handlers: { "resources.get": () => current } });
    startSummary(host.sextant, root);
    await expect.poll(() => root.querySelector("dl")?.textContent).toContain("large");
    expect(host.calls.find((c) => c.method === "resources.get")!.params).toEqual({ clusterId: "test-cluster", ref: REF });
    expect(root.querySelectorAll(".replicas span")).toHaveLength(3);
    current = widget(5, 2);
    host.setContext({ resourceVersion: "102" });
    await expect.poll(() => root.querySelectorAll(".replicas span").length).toBe(5);
    expect(root.querySelector("dl")!.textContent).toContain("Generation2");
  });
});

describe("Scale widget", () => {
  it("scales by a merge patch of spec.replicas, then says so and closes", async () => {
    await start("action", {
      handlers: { "resources.get": () => widget(3), "resources.patch": () => widget(5, 2) },
    });
    startScale(host.sextant, root);
    await expect.poll(() => input("Replicas")?.value).toBe("3");
    type(input("Replicas"), "5");
    button("Scale").click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.calls.find((c) => c.method === "resources.patch")!.params).toEqual({
      clusterId: "test-cluster",
      ref: REF,
      patch: { spec: { replicas: 5 } },
      patchType: "merge",
    });
    expect(host.notices).toEqual(["Scaled demo-widget to 5 replicas"]);
  });

  it("steps by the step from the settings and stays within their maximum", async () => {
    await start("action", { handlers: { "resources.get": () => widget(3) } });
    host.storage.set("scale", { step: 2, maxReplicas: 6 });
    startScale(host.sextant, root);
    await expect.poll(() => input("Replicas")?.value).toBe("3");
    await expect.poll(() => root.textContent).toContain("at most 6");
    button("+").click();
    expect(input("Replicas").value).toBe("5");
    button("+").click();
    expect(input("Replicas").value).toBe("6");
    button("−").click();
    expect(input("Replicas").value).toBe("4");
    type(input("Replicas"), "9");
    button("Scale").click();
    await expect.poll(() => root.querySelector(".error")?.textContent).toContain("from 0 to 6");
    expect(host.calls.some((c) => c.method === "resources.patch")).toBe(false);
  });

  it("shows Sextant's refusal and stays open", async () => {
    await start("action", {
      handlers: {
        "resources.get": () => widget(3),
        "resources.patch": () => {
          throw { code: "denied", message: "The user did not allow Extension Widgets to patch Widget demo-widget" };
        },
      },
    });
    startScale(host.sextant, root);
    await expect.poll(() => input("Replicas")?.value).toBe("3");
    button("Scale").click();
    await expect.poll(() => root.querySelector(".error")?.textContent).toContain("did not allow");
    expect(host.closedByFrame).toBe(false);
    expect(button("Scale").disabled).toBe(false);
  });

  it("Cancel closes without a change", async () => {
    await start("action", { handlers: { "resources.get": () => widget(3) } });
    startScale(host.sextant, root);
    button("Cancel").click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.calls.some((c) => c.method === "resources.patch")).toBe(false);
  });
});

describe("settings section", () => {
  it("keeps the step and the maximum in the extension's storage", async () => {
    await start("settings");
    startSettings(host.sextant, root);
    await expect.poll(() => input("Step")?.value).toBe("1");
    expect(input("Maximum replicas").value).toBe("10");
    type(input("Step"), "2");
    type(input("Maximum replicas"), "20");
    button("Save").click();
    await expect.poll(() => host.storage.get("scale")).toEqual({ step: 2, maxReplicas: 20 });
    await expect.poll(() => root.querySelector(".saved")?.textContent).toBe("Saved");
  });

  it("refuses what is not a positive whole number, and resets to the defaults", async () => {
    await start("settings");
    host.storage.set("scale", { step: 3, maxReplicas: 30 });
    startSettings(host.sextant, root);
    await expect.poll(() => input("Step")?.value).toBe("3");
    type(input("Step"), "0");
    button("Save").click();
    await expect.poll(() => root.querySelector(".error")?.textContent).toContain("whole numbers");
    expect(host.storage.get("scale")).toEqual({ step: 3, maxReplicas: 30 });
    button("Reset").click();
    await expect.poll(() => host.storage.has("scale")).toBe(false);
    expect(input("Step").value).toBe("1");
  });
});
