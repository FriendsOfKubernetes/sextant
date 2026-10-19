// Accessibility of the main screens on the real WebKit page, in the light and the dark theme (#186): axe-core with
// the rule set of the vitest helper plus colour contrast (e2e/a11y.ts). Each screen is a test that fails with the list
// of its violations; all of them are also written to target/e2e/a11y.json.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { type AxeFinding, axeFindings, formatFindings } from "../a11y";
import {
  activeDockPanel,
  byName,
  click,
  closeDetails,
  connectTo,
  detailsPanel,
  eventually,
  openSection,
  row,
  rowAction,
  searchTable,
  textOf,
} from "../app";
import { CONTEXT, ROOT, webPod } from "../cluster";

const report: Record<string, AxeFinding[]> = {};

/** Runs axe on the window as it is now and fails with the violations, keeping them for the report. */
async function check(screen: string): Promise<void> {
  // Transitions (dialogs, panels) end before the colours are read.
  await browser.pause(400);
  const findings = await axeFindings();
  report[screen] = findings;
  if (findings.length > 0) {
    throw new Error(`${findings.length} accessibility violation(s) on ${screen}:\n${formatFindings(findings)}`);
  }
}

async function setTheme(theme: "Light" | "Dark"): Promise<void> {
  await click("Settings", $('nav[aria-label="Clusters"]'));
  await click("General", $('[role="tablist"][aria-label="Settings sections"]'));
  const group = $('[role="radiogroup"][aria-label="Theme"]');
  await expect(group).toBeDisplayed();
  await group.$(`label=${theme}`).click();
  const value = theme.toLowerCase();
  await eventually(async () => (await browser.execute(() => document.documentElement.dataset.theme)) === value, `the ${value} theme`);
}

describe("Accessibility of the main screens", () => {
  let pod = "";

  before(async () => {
    pod = webPod();
    await browser.setWindowSize(1280, 800);
    await browser.setTimeout({ script: 120_000 });
    await connectTo(CONTEXT);
  });

  after(() => {
    const dir = path.join(ROOT, "target", "e2e");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a11y.json"), `${JSON.stringify(report, null, 2)}\n`);
  });

  for (const theme of ["Light", "Dark"] as const) {
    describe(`${theme} theme`, () => {
      const at = (screen: string) => `${screen} (${theme.toLowerCase()})`;

      before(async () => {
        await setTheme(theme);
      });

      it("Settings, every tab", async () => {
        const tabs = $('[role="tablist"][aria-label="Settings sections"]');
        const names = await tabs.$$('[role="tab"]').map((tab) => tab.getText());
        const failures: string[] = [];
        for (const name of names) {
          await click(name, tabs);
          await expect(byName(name, tabs)).toHaveAttribute("aria-selected", "true");
          await check(at(`Settings › ${name}`)).catch((err: Error) => failures.push(err.message));
        }
        if (failures.length > 0) throw new Error(failures.join("\n\n"));
      });

      it("the rail, the sidebar and the pods table", async () => {
        await openSection("Pods", "Workloads");
        await searchTable("e2e-web");
        await expect(row(pod)).toBeDisplayed({ wait: 30_000 });
        await check(at("Pods table"));
      });

      it("the details panel, every tab", async () => {
        await row(pod).click();
        const panel = detailsPanel();
        await expect(panel).toBeDisplayed();
        await eventually(async () => (await textOf(panel)).includes("nginx:stable-alpine"), "the container image");
        const tabs = panel.$('[role="tablist"]');
        const names = (await tabs.isExisting()) ? await tabs.$$('[role="tab"]').map((tab) => tab.getText()) : [];
        const failures: string[] = [];
        await check(at("Details › Overview")).catch((err: Error) => failures.push(err.message));
        for (const name of names.slice(1)) {
          await click(name, tabs);
          await check(at(`Details › ${name}`)).catch((err: Error) => failures.push(err.message));
        }
        if (names.length > 1) await click(names[0], tabs);
        if (failures.length > 0) throw new Error(failures.join("\n\n"));
      });

      it("the dock with logs", async () => {
        await click("Logs", $('aside[aria-label="Details"] [role="toolbar"]'));
        const log = activeDockPanel().$('[role="log"]');
        await expect(log).toBeDisplayed();
        await eventually(async () => (await textOf(log)).includes("kube-probe"), "nginx access log lines", 60_000);
        await check(at("Dock › Logs"));
      });

      it("the dock with a terminal", async () => {
        await click("Shell", $('aside[aria-label="Details"] [role="toolbar"]'));
        await expect(activeDockPanel().$(".terminal__screen")).toBeDisplayed();
        await eventually(async () => (await textOf(activeDockPanel().$(".xterm-rows"))).trim().length > 0, "the shell prompt");
        await check(at("Dock › Terminal"));
      });

      it("the Scale dialog", async () => {
        await closeDetails();
        await openSection("Deployments", "Workloads");
        await searchTable("e2e-web");
        await expect(row("e2e-web")).toBeDisplayed({ wait: 30_000 });
        await rowAction("e2e-web", "Scale");
        const dialog = $('[role="dialog"]');
        await expect(dialog).toBeDisplayed();
        try {
          await check(at("Scale dialog"));
        } finally {
          await dialog.$("button=Cancel").click();
          await expect(dialog).not.toBeExisting();
          await closeDetails();
        }
      });

      it("the Problems page", async () => {
        await openSection("Problems", "Cluster");
        await eventually(async () => (await textOf($("main"))).length > 0, "the problems page");
        await check(at("Problems page"));
      });

      after(async () => {
        // Close the dock tabs this theme opened, so the next one starts from the same window.
        for (const close of await $$('section[aria-label="Dock"] button[aria-label^="Close "]')) {
          if ((await close.isDisplayed()) && (await close.getAttribute("aria-label")) !== "Close dock") await close.click();
        }
      });
    });
  }
});
