// The UI kit (#355): Sextant's details blocks as DOM, accessible and styled once.
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { block, blockOpen, button, chips, empty, errorState, fields, loading, namespaceSelect, objectLink, status, table, tabs } from "../src/ui";
import { setIconSource } from "../src/icons";
import { startTestHost } from "../src/testing";

afterEach(() => {
  document.body.innerHTML = "";
  document.getElementById("sextant-ui-styles")?.remove();
});

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    resultTypes: ["violations"],
  });
  return result.violations.map((v) => v.id);
}

describe("the UI kit", () => {
  it("draws fields, leaving out empty values, inside a collapsible block that keyboards and readers can use", async () => {
    const section = block("Status", [fields([["Ready", status("True", "success")], ["Message", null], ["Revision", "main@sha1:abc"]])], {
      collapsible: true,
    });
    document.body.append(section);
    expect(document.getElementById("sextant-ui-styles")).not.toBeNull();
    expect([...section.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Ready", "Revision"]);
    expect(section.querySelector(".sx-status--success")?.textContent).toBe("True");
    const toggle = section.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section.querySelector<HTMLElement>(".sx-block__body")!.hidden).toBe(true);
    expect(await violations()).toEqual([]);
  });

  it("tells each toggle of a block and puts its actions in the head (#406, #407)", async () => {
    const heard: boolean[] = [];
    const logs = button("Logs", () => undefined);
    const section = block("Pods", ["…"], { collapsible: true, collapsed: true, onToggle: (open) => heard.push(open), actions: [logs] });
    document.body.append(section);
    expect(section.querySelector(".sx-block__head .sx-block__actions")?.contains(logs)).toBe(true);
    const toggle = section.querySelector<HTMLButtonElement>(".sx-block__toggle")!;
    toggle.click();
    toggle.click();
    expect(heard).toEqual([true, false]);
    expect(await violations()).toEqual([]);
  });

  it("reads a block's choice from Sextant's memory, then Expand all, then its default (#416)", () => {
    expect(blockOpen({ pods: false }, "pods")).toBe(false);
    expect(blockOpen({ "*": false }, "pods")).toBe(false);
    expect(blockOpen({ "*": false, pods: true }, "pods")).toBe(true);
    expect(blockOpen(undefined, "pods", false)).toBe(false);
  });

  it("draws tables, chips, links, empty lines and errors", async () => {
    const openDetails = vi.fn(() => Promise.resolve());
    const ref = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "ns", name: "web-1" };
    document.body.append(
      table(["Name", "Phase"], [[objectLink({ ui: { openDetails } }, ref), status("Running", "success")]], { label: "Pods" }),
      chips(["a=b", "", null, "c=d"])!,
      empty("Nothing here."),
      errorState(new Error("forbidden"), "Could not list"),
    );
    expect(chips([])).toBeNull();
    expect(document.querySelectorAll(".sx-chip")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>(".sx-link")!.click();
    expect(openDetails).toHaveBeenCalledWith(ref);
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Could not list: forbidden");
    expect(await violations()).toEqual([]);
  });
});

describe("the shared controls", () => {
  it("offer the cluster's namespaces, else the window's, with every namespace as an option", async () => {
    const list = vi.fn(() => Promise.resolve({ items: [{ metadata: { name: "team-b" } }, { metadata: { name: "team-a" } }] }));
    const onChange = vi.fn();
    const node = namespaceSelect(
      { context: { clusterId: "c1", namespaces: ["team-a"] }, resources: { list } },
      { value: "team-a", onChange, labels: { label: "Namespace", all: "All namespaces" } },
    );
    document.body.append(node);
    const select = node.querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["", "team-a"]);
    await vi.waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(["", "team-a", "team-b"]));
    expect(list).toHaveBeenCalledWith({ clusterId: "c1", kind: { kind: "Namespace" } });
    expect(select.value).toBe("team-a");
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(await violations()).toEqual([]);
  });

  it("switch tabs with clicks and arrow keys, drawing only the chosen one", async () => {
    const changes: string[] = [];
    const node = tabs(
      [
        { id: "a", label: "Status", render: () => "status body" },
        { id: "b", label: "History", render: () => "history body" },
      ],
      { label: "Views", onChange: (id) => changes.push(id) },
    );
    document.body.append(node, button("Sync", () => changes.push("sync"), { variant: "primary" }), loading("Loading…"));
    const [first, second] = [...node.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    expect(node.querySelector("[role=tabpanel]")!.textContent).toBe("status body");
    first!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(second!.getAttribute("aria-selected")).toBe("true");
    expect(node.querySelector("[role=tabpanel]")!.textContent).toBe("history body");
    document.querySelector<HTMLButtonElement>("button.primary")!.click();
    expect(changes).toEqual(["a", "b", "sync"]);
    expect(await violations()).toEqual([]);
  });
});

describe("a button's icon (since Sextant 0.30)", () => {
  afterEach(() => setIconSource(null));

  it("draws the SVG Sextant gives for the name before the label, hidden from readers, asked once per name", async () => {
    const asked: string[] = [];
    setIconSource((name) => {
      asked.push(name);
      return Promise.resolve(name === "requestCheck" ? '<svg class="icon"><path d="M0 0"/></svg>' : null);
    });
    const check = button("Check a request…", () => undefined, { icon: "requestCheck" });
    const again = button("Check", () => undefined, { icon: "requestCheck", variant: "primary" });
    const unknown = button("Other", () => undefined, { icon: "nope" });
    document.body.append(check, again, unknown);
    await vi.waitFor(() => expect(check.querySelector(".sx-icon svg")).not.toBeNull());
    expect(check.textContent).toBe("Check a request…");
    expect(check.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(again.className).toBe("primary sx-button--icon");
    await vi.waitFor(() => expect(unknown.querySelector(".sx-icon")).toBeNull());
    expect(asked).toEqual(["requestCheck", "nope"]);
    expect(await violations()).toEqual([]);
  });

  it("asks the window through the connected client, and draws none without one", async () => {
    const plain = button("Plain", () => undefined, { icon: "requestCheck" });
    await vi.waitFor(() => expect(plain.querySelector(".sx-icon")).toBeNull());
    const host = await startTestHost({ handlers: { "ui.icon": ({ name }: { name: string }) => ({ svg: `<svg data-name="${name}"></svg>` }) } });
    try {
      expect(await host.sextant.ui.icon("logs")).toBe('<svg data-name="logs"></svg>');
      const node = button("Logs", () => undefined, { icon: "logs" });
      await vi.waitFor(() => expect(node.querySelector("svg")?.getAttribute("data-name")).toBe("logs"));
    } finally {
      host.sextant.disconnect();
    }
  });
});

