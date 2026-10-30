// The memory measurement (scripts/memory.sh, issue #263): the app's memory (PSS + SwapPss of its process tree, see
// sample.ts) at fixed steps of a fixed scenario on the kind test cluster, written to target/memory/. The steps:
//
//   connected   connected, the Pods list of every namespace open, settled
//   loaded      after the load fixture (500 pending pods + 150 CRDs, scripts/fixtures/load/load.sh), settled
//   lists       after opening the busiest lists (Events, Deployments, Config Maps, CRD Definitions) and back to Pods
//   details     after opening the details of SEXTANT_MEMORY_DETAILS pods (100) one after another
//   idle        the same, after SEXTANT_MEMORY_IDLE_S (120) seconds without input
//   unloaded    after the load fixture is deleted, settled: what the app keeps of it
//
// Each step's number is the median of three samples five seconds apart. Compare runs made back to back on the same
// machine: the absolute numbers depend on the machine (and on the debug build e2e runs), the differences less so.
// Details are opened from the keyboard (Enter, Escape, ArrowDown), not by finding elements: WebKit's automation keeps
// every element a WebDriver command found until the session ends, which would be counted as the app's memory.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { $, browser } from "@wdio/globals";
import { connectTo, detailsPanel, openSection, row, searchTable } from "../app";
import { APP } from "../build";
import { CONTEXT, ROOT, testKubeconfig, toolPath } from "../cluster";
import { appPid, median, sampleTree, type MemorySample } from "./sample";

const SETTLE_S = Number(process.env.SEXTANT_MEMORY_SETTLE_S ?? 90);
const IDLE_S = Number(process.env.SEXTANT_MEMORY_IDLE_S ?? 120);
const DETAILS = Number(process.env.SEXTANT_MEMORY_DETAILS ?? 100);
const LOAD = path.join(ROOT, "scripts", "fixtures", "load", "load.sh");

const steps: { step: string; sample: MemorySample }[] = [];

async function measure(step: string, settleS = SETTLE_S): Promise<void> {
  await browser.pause(settleS * 1000);
  const pid = appPid(APP);
  if (pid === null) throw new Error(`no process runs ${APP}`);
  const samples: MemorySample[] = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) await browser.pause(5_000);
    samples.push(sampleTree(pid));
  }
  const sample = median(samples);
  steps.push({ step, sample });
  const parts = Object.entries(sample.byName)
    .map(([name, mb]) => `${name} ${mb.toFixed(0)}`)
    .join(", ");
  console.log(`[memory] ${step}: ${sample.totalMb.toFixed(0)} MB (${parts})`);
}

function load(action: "apply" | "delete"): void {
  const result = spawnSync(LOAD, [action], {
    stdio: "inherit",
    env: { ...process.env, PATH: toolPath(), SEXTANT_TEST_KUBECONFIG: testKubeconfig() },
  });
  if (result.status !== 0) throw new Error(`load.sh ${action} failed`);
}

function gitRevision(): string {
  const result = spawnSync("git", ["describe", "--always", "--dirty"], { cwd: ROOT, encoding: "utf8" });
  return result.stdout.trim() || "unknown";
}

function write(): void {
  const dir = path.join(ROOT, "target", "memory");
  mkdirSync(dir, { recursive: true });
  const label = process.env.SEXTANT_MEMORY_LABEL ?? gitRevision();
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w.-]+/g, "_")}.json`);
  const settings = { settleS: SETTLE_S, idleS: IDLE_S, details: DETAILS };
  writeFileSync(file, `${JSON.stringify({ label, revision: gitRevision(), settings, steps }, null, 2)}\n`);
  console.log(`[memory] written to ${path.relative(ROOT, file)}`);
  const first = steps[0]?.sample.totalMb ?? 0;
  for (const { step, sample } of steps) {
    console.log(`[memory] ${step.padEnd(10)} ${sample.totalMb.toFixed(0).padStart(5)} MB  ${(sample.totalMb - first >= 0 ? "+" : "") + (sample.totalMb - first).toFixed(0)}`);
  }
}

describe("memory", () => {
  before(async () => {
    await browser.setWindowSize(1280, 800);
    // A load fixture left by an interrupted run would make the first step a loaded one.
    load("delete");
  });

  after(() => {
    write();
    load("delete");
  });

  it("measures a connected cluster", async () => {
    await connectTo(CONTEXT);
    await openSection("Pods", "Workloads");
    await row("etcd-sextant-test").waitForDisplayed({ timeout: 60_000 });
    await measure("connected");
  });

  it("measures the load fixture", async () => {
    load("apply");
    await measure("loaded");
  });

  it("measures the busiest lists", async () => {
    await openSection("Events");
    await openSection("Deployments", "Workloads");
    await openSection("Config Maps", "Config");
    await openSection("Definitions", "Custom Resources");
    await browser.pause(15_000);
    await openSection("Pods", "Workloads");
    await measure("lists");
  });

  it("measures after many details", async () => {
    await searchTable("sextant-load");
    const first = $(`(//main//*[@role='row' and not(@aria-rowindex='1') and contains(., 'pending-')])[1]`);
    await first.waitForClickable({ timeout: 30_000 });
    await first.click();
    await detailsPanel().waitForDisplayed();
    // Escape closes the details and gives the focus back to the row; ArrowDown moves it to the next one.
    for (let i = 0; i < DETAILS; i++) {
      await browser.pause(700);
      await browser.keys("Escape");
      await browser.pause(200);
      await browser.keys("ArrowDown");
      await browser.keys("Enter");
    }
    await browser.pause(700);
    await browser.keys("Escape");
    // WebKitWebDriver refuses `setValue("")`.
    await $('main input[type="search"]').clearValue();
    await measure("details", 10);
    await measure("idle", IDLE_S);
  });

  it("measures after the load is gone", async () => {
    load("delete");
    await $("main").waitForDisplayed();
    await measure("unloaded");
  });
});
