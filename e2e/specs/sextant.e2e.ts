// End-to-end scenarios, one per feature, against the kind cluster `sextant-test`. They run in order in one window:
// connect first, then each feature on the resources of namespace `sextant-e2e` (see e2e/fixtures/e2e.yaml).
import http from "node:http";
import path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import {
  activeDockPanel,
  byName,
  click,
  closeDetails,
  detailsPanel,
  eventually,
  openSection,
  row,
  rowAction,
  searchTable,
  textOf,
  typeText,
} from "../app";
import { CONTEXT, NAMESPACE, RELEASE, ROOT, kubectl, webPod } from "../cluster";

const SCREENSHOT = path.join(ROOT, "docs", "screenshot.png");

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 10_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

describe("Sextant against sextant-test", () => {
  let pod = "";

  before(async () => {
    pod = webPod();
    await browser.setWindowSize(1280, 800);
  });

  it("starts with the test cluster in the rail", async () => {
    await expect(browser).toHaveTitle("Sextant");
    await expect(byName(CONTEXT, $('nav[aria-label="Clusters"]'))).toBeDisplayed();
  });

  it("connects to the cluster", async () => {
    await click(CONTEXT, $('nav[aria-label="Clusters"]'));
    await expect($('nav[aria-label="Sections"]')).toBeDisplayed({ wait: 60_000 });
    await expect(byName(CONTEXT, $('nav[aria-label="Clusters"]'))).toHaveAttribute("data-state", "connected");
  });

  it("shows the overview of the cluster", async () => {
    // The section "Cluster" holds the overview ("Overview") and the problems page.
    await openSection("Overview", "Cluster");
    const main = $("main");
    await eventually(async () => (await textOf(main)).includes("Cluster overview"), "the overview page");
    await eventually(async () => /Nodes[\s\S]*1/.test(await textOf(main)), "the node count");
    // Prometheus runs in `monitoring`: the last-hour charts are drawn.
    await eventually(async () => (await main.$$(".uplot").length) > 0, "the charts", 60_000);
  });

  it("lists pods in a live table", async () => {
    await openSection("Pods", "Workloads");
    // Pods of every namespace, the window as a user first sees it: the README screenshot.
    await expect(row(pod)).toBeDisplayed({ wait: 30_000 });
    // A pod of kube-system, high in the list by name: rows below the fold are not drawn (`monitoring/prometheus…` is
    // there once a GitOps cluster adds the pods of flux-system and argocd).
    await eventually(async () => (await textOf(row("etcd-sextant-test"))).includes("Running"), "the pods of every namespace");
    await browser.pause(1_000);
    await browser.saveScreenshot(SCREENSHOT);
    await searchTable("e2e-web");
    await expect(row(pod)).toBeDisplayed({ wait: 30_000 });
    await expect(row(pod)).toHaveText(expect.stringContaining("Running"));
  });

  it("opens the details of a pod", async () => {
    await row(pod).click();
    const panel = detailsPanel();
    await expect(panel).toBeDisplayed();
    await expect(panel.$("h2")).toHaveText(pod);
    await eventually(async () => (await textOf(panel)).includes("nginx:stable-alpine"), "the container image");
  });

  it("streams the logs of the pod", async () => {
    await click("Logs", $('aside[aria-label="Details"] [role="toolbar"]'));
    const log = activeDockPanel().$('[role="log"]');
    await expect(log).toBeDisplayed();
    // The readiness probe hits nginx every 2 s, so access-log lines keep coming.
    await eventually(async () => (await textOf(log)).includes("kube-probe"), "nginx access log lines", 60_000);
  });

  it("opens a shell in the container", async () => {
    await click("Shell", $('aside[aria-label="Details"] [role="toolbar"]'));
    const screen = activeDockPanel().$(".terminal__screen");
    await expect(screen).toBeDisplayed();
    await eventually(async () => (await textOf(activeDockPanel().$(".xterm-rows"))).trim().length > 0, "the shell prompt");
    await screen.click();
    await typeText("echo sextant-$((40 + 2))");
    await browser.keys("Enter");
    await eventually(async () => {
      const text = await textOf(activeDockPanel().$(".xterm-rows"));
      return text.includes("sextant-42");
    }, "the command output");
  });

  it("forwards a port of the pod and serves it on localhost", async () => {
    await click("Forward port 80", detailsPanel());
    const dialog = $('[role="dialog"]');
    await expect(dialog).toBeDisplayed();
    await click("Start forwarding", dialog);
    const text = await eventually(async () => {
      const match = /localhost:(\d+)/.exec(await textOf(dialog));
      return match ? match[1] : null;
    }, "the forwarded port");
    const body = await httpGet(Number(text));
    expect(body).toContain("Welcome to nginx");
    await dialog.$("footer").$("button=Close").click();
    await click("Close details");
  });

  it("edits the YAML of a ConfigMap and saves it to the cluster", async () => {
    await openSection("Config Maps", "Config");
    await searchTable("e2e-config");
    await expect(row("e2e-config")).toBeDisplayed({ wait: 30_000 });
    await rowAction("e2e-config", "Edit");
    const panel = activeDockPanel();
    const line = panel.$("//div[contains(@class,'cm-line') and normalize-space(.)='greeting: hello']");
    await expect(line).toBeDisplayed({ wait: 30_000 });
    await line.click();
    await browser.keys("End");
    for (let i = 0; i < "hello".length; i++) await browser.keys("Backspace");
    await typeText("world");
    await click("Save", panel);
    await eventually(
      () => kubectl("-n", NAMESPACE, "get", "configmap", "e2e-config", "-o", "jsonpath={.data.greeting}").trim() === "world",
      "the new value in the cluster",
    );
  });

  it("scales a deployment", async () => {
    await openSection("Deployments", "Workloads");
    await searchTable("e2e-web");
    await expect(row("e2e-web")).toBeDisplayed({ wait: 30_000 });
    await rowAction("e2e-web", "Scale");
    const dialog = $('[role="dialog"]');
    const input = dialog.$("input");
    await input.waitForDisplayed();
    await input.setValue("2");
    await dialog.$("button=Scale").click();
    await eventually(
      () => kubectl("-n", NAMESPACE, "get", "deployment", "e2e-web", "-o", "jsonpath={.spec.replicas}").trim() === "2",
      "two replicas in the cluster",
    );
    await closeDetails();
    await eventually(async () => /2\s*\/\s*2/.test(await textOf(row("e2e-web"))), "2/2 ready in the table", 120_000);
  });

  it("lists the Helm release read from the cluster", async () => {
    await closeDetails();
    await openSection("Releases", "Helm");
    const text = await eventually(async () => textOf(row(RELEASE)), "the release in the table");
    expect(text).toContain("e2e-chart");
    expect(text).toContain(NAMESPACE);
  });

  it("changes the theme in Settings", async () => {
    await click("Settings", $('nav[aria-label="Clusters"]'));
    const theme = $('[role="radiogroup"][aria-label="Theme"]');
    await expect(theme).toBeDisplayed();
    await theme.$("label=Dark").click();
    await eventually(
      async () => (await browser.execute(() => document.documentElement.dataset.theme)) === "dark",
      "the dark theme",
    );
    await theme.$("label=Light").click();
    await eventually(
      async () => (await browser.execute(() => document.documentElement.dataset.theme)) === "light",
      "the light theme",
    );
    await theme.$("label=System").click();
  });

  it("at 400 px wide keeps every section, the details and the dock reachable through the menu", async () => {
    await browser.setWindowSize(400, 800);
    const menu = byName("Open menu");
    await expect(menu).toBeDisplayed({ wait: 10_000 });
    await menu.click();
    await openSection("Pods", "Workloads");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await searchTable("e2e-web");
    await row(pod).click();
    const panel = detailsPanel();
    await expect(panel).toBeDisplayed();
    const [panelWidth, windowWidth] = await browser.execute(() => [
      document.querySelector("aside.details")?.getBoundingClientRect().width ?? 0,
      document.documentElement.clientWidth,
    ]);
    expect(panelWidth).toBe(windowWidth);
    // Nothing is cut off: the page itself never scrolls sideways.
    const overflow = await browser.execute(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await click("Close details");
    expect(await $$('section[aria-label="Dock"] [role="tab"]').length).toBeGreaterThan(0);
    await expect(byName("Close dock")).toBeDisplayed();
    await browser.setWindowSize(1280, 800);
  });
});
