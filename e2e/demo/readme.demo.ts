// The README demo (docs/demo.gif): one pass through the main features against `sextant-test`. Recorded by
// scripts/demo-gif.sh, not part of `npm run e2e`.
import { $, browser } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { activeDockPanel, byName, detailsPanel, eventually, row, textOf } from "../app";
import { CONTEXT, webPod } from "../cluster";
import { HEIGHT, WIDTH, demoClick, openSection, startRecording, stopRecording, typeSlowly } from "./helpers";

describe("README demo", () => {
  let pod = "";

  before(async () => {
    pod = webPod();
    await browser.setWindowSize(WIDTH, HEIGHT);
    const rail = $('nav[aria-label="Clusters"]');
    await byName(CONTEXT, rail).waitForDisplayed();
    await browser.pause(1_000);
    startRecording();
    await browser.pause(300);
  });

  after(async () => {
    await stopRecording();
  });

  it("connects and shows the cluster overview", async () => {
    const rail = $('nav[aria-label="Clusters"]');
    await demoClick(byName(CONTEXT, rail));
    await $('nav[aria-label="Sections"]').waitForDisplayed({ timeout: 60_000 });
    await openSection("Overview", "Cluster");
    const main = $("main");
    await eventually(async () => (await main.$$(".uplot").length) > 0, "the charts", 60_000);
    await browser.pause(2_200);
  });

  it("lists the pods of every namespace and filters them", async () => {
    await openSection("Pods", "Workloads");
    await eventually(async () => (await textOf(row("etcd-sextant-test"))).includes("Running"), "the pods");
    await browser.pause(1_600);
    const box = $('main input[type="search"]');
    await demoClick(box);
    await typeSlowly("e2e-web");
    await row(pod).waitForDisplayed({ timeout: 30_000 });
    await browser.pause(900);
  });

  it("opens the pod, its logs and a shell", async () => {
    // The name cell, not the row's centre: that ends up under the details panel's Delete button.
    await demoClick($(`//main//*[(self::tr or @role='row')]//*[normalize-space(text())='${pod}']`));
    const panel = detailsPanel();
    await eventually(async () => (await textOf(panel)).includes("nginx:stable-alpine"), "the container image");
    await browser.pause(1_800);

    await demoClick(byName("Logs", $('aside[aria-label="Details"] [role="toolbar"]')));
    const log = activeDockPanel().$('[role="log"]');
    await eventually(async () => (await textOf(log)).includes("kube-probe"), "nginx access log lines", 60_000);
    await browser.pause(2_400);

    await demoClick(byName("Shell", $('aside[aria-label="Details"] [role="toolbar"]')));
    const screen = activeDockPanel().$(".terminal__screen");
    await eventually(async () => (await textOf(activeDockPanel().$(".xterm-rows"))).trim().length > 0, "the shell prompt");
    await demoClick(screen);
    await typeSlowly("nginx -v");
    await browser.keys("Enter");
    await eventually(async () => (await textOf(activeDockPanel().$(".xterm-rows"))).includes("nginx version"), "nginx -v");
    await browser.pause(2_500);
  });
});
