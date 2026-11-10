// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, ResourceKind, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import clusterPolicyJson from "../fixtures/clusterpolicy.json";
import podJson from "../fixtures/pod.json";
import reportJson from "../fixtures/policyreport.json";
import { MAX_LISTED, MAX_SUMMARY_REPORTS, startDetails } from "./details";
import { CATALOGS, setLanguage } from "./i18n";

const policy = clusterPolicyJson as unknown as KubeObject;
const report = reportJson as unknown as KubeObject;
const pod = podJson as unknown as KubeObject;
const copy = <T>(value: T): T => structuredClone(value);

const KINDS: Record<string, { group: string; version: string; kind: string }> = {
  ClusterPolicy: { group: "kyverno.io", version: "v1", kind: "ClusterPolicy" },
  Policy: { group: "kyverno.io", version: "v1", kind: "Policy" },
  PolicyReport: { group: "wgpolicyk8s.io", version: "v1alpha2", kind: "PolicyReport" },
  ClusterPolicyReport: { group: "wgpolicyk8s.io", version: "v1alpha2", kind: "ClusterPolicyReport" },
  Pod: { group: "", version: "v1", kind: "Pod" },
  Namespace: { group: "", version: "v1", kind: "Namespace" },
  Event: { group: "", version: "v1", kind: "Event" },
};
const ref = (o: KubeObject) => ({ kind: KINDS[o.kind!]!, namespace: o.metadata.namespace ?? null, name: o.metadata.name });
const served = (...names: string[]): ResourceKind[] =>
  names.map((n) => ({ kindRef: KINDS[n]!, plural: `${n.toLowerCase()}s`, namespaced: !n.startsWith("Cluster"), verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(
  obj: KubeObject,
  contribution: string,
  options: { language?: string; kinds?: ResourceKind[] | "fail" | { code: string; message: string }; get?: () => unknown; uid?: string | null; blocks?: Record<string, boolean> } = {},
): Promise<void> {
  const language = options.language ?? "en";
  const kinds = options.kinds ?? served("ClusterPolicy", "Policy", "PolicyReport", "ClusterPolicyReport", "Pod");
  let blocks = options.blocks ?? {};
  const uid = options.uid === undefined ? obj.metadata.uid : options.uid;
  host = await startTestHost({
    context: { view: "details", contribution, selection: [ref(obj)], resourceVersion: "1", language, blocks, ...(uid ? { uid } : {}) },
    handlers: {
      "resources.get": options.get ?? (() => copy(obj)),
      kinds: () => {
        if (kinds === "fail") throw Object.assign(new Error("discovery failed"), { code: "other" });
        if (!Array.isArray(kinds)) throw kinds;
        return kinds;
      },
      "ui.setHidden": () => null,
      // Sextant's memory: `ui.setBlockOpen` writes it, the context tells it back, as the window does.
      "ui.setBlockOpen": (params) => {
        const { id, open } = params as { id: string; open: boolean };
        blocks = { ...blocks, [id]: open };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string; maxObjects?: number };
const params = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string) => host.watches.find((w) => params(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const hiddenCalls = () => host.calls.filter((c) => c.method === "ui.setHidden").map((c) => (c.params as { hidden: boolean }).hidden);
const lastHidden = () => hiddenCalls().at(-1);
const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("Policy results on every other object", () => {
  it("hide first, watch the object's own report by name in its namespace, and show it failures first", async () => {
    await open(pod, "policy-results");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    expect(hiddenCalls()[0]).toBe(true);
    expect(params(watchOf("PolicyReport")!)).toMatchObject({
      kind: { kind: "PolicyReport", version: "v1alpha2" },
      namespaces: ["default"],
      fieldSelector: `metadata.name=${pod.metadata.uid}`,
    });
    const withPass = copy(report);
    (withPass.results as unknown[]).reverse();
    watchOf("PolicyReport")!.emit(snapshot([withPass]));
    await expect.poll(text).toContain("Failing policy rules: 1 of 2 checked.");
    expect(lastHidden()).toBe(false);
    expect(root.querySelector(".ky-explain--danger")).not.toBeNull();
    expect(rows().map((r) => [r[0], r[1], r[2]])).toEqual([
      ["require-labels", "check-team", "Fail"],
      ["disallow-latest-tag", "validate-image-tag", "Pass"],
    ]);
    expect(byLabel("Open ClusterPolicy require-labels")).toHaveLength(1);
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Fail");
  });

  it("say so when nothing fails", async () => {
    await open(pod, "policy-results");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    const passing = copy(report);
    (passing.results as { result: string }[])[0]!.result = "pass";
    watchOf("PolicyReport")!.emit(snapshot([passing]));
    await expect.poll(text).toContain("No policy rule fails (2 checked).");
    expect(root.querySelector(".ky-explain--danger")).toBeNull();
  });

  it("stay hidden without a report, and for a report about another object", async () => {
    await open(pod, "policy-results");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    watchOf("PolicyReport")!.emit(snapshot([]));
    await settle();
    expect(hiddenCalls()).toEqual([true]);
    const other = copy(report);
    (other.scope as { name: string }).name = "other";
    watchOf("PolicyReport")!.emit(snapshot([other]));
    await settle();
    expect(hiddenCalls()).toEqual([true]);
    expect(text()).toBe("");
  });

  it("read a cluster-scoped object's ClusterPolicyReport, in no namespace", async () => {
    const ns: KubeObject = { apiVersion: "v1", kind: "Namespace", metadata: { name: "team-a", uid: "ns-uid" } };
    await open(ns, "policy-results");
    await expect.poll(() => watchOf("ClusterPolicyReport")).toBeDefined();
    expect(params(watchOf("ClusterPolicyReport")!)).toMatchObject({ fieldSelector: "metadata.name=ns-uid" });
    expect(params(watchOf("ClusterPolicyReport")!).namespaces).toBeUndefined();
  });

  it("never show on Kyverno's own kinds, reports and Events, and never read them", async () => {
    for (const obj of [policy, report, { apiVersion: "v1", kind: "Event", metadata: { name: "e", namespace: "default", uid: "e" } } as KubeObject]) {
      await open(obj, "policy-results");
      await settle();
      expect(hiddenCalls(), obj.kind).toEqual([true]);
      expect(host.calls.some((c) => c.method === "resources.get" || c.method === "kinds"), obj.kind).toBe(false);
      expect(host.watches, obj.kind).toEqual([]);
      stop();
      root.remove();
      host.close();
    }
  });

  it("stay hidden where the cluster serves no reports", async () => {
    await open(pod, "policy-results", { kinds: served("Pod") });
    await settle();
    expect(host.watches).toEqual([]);
    expect(hiddenCalls()).toEqual([true]);
  });

  it("show an error where discovery or the watch failed", async () => {
    await open(pod, "policy-results", { kinds: "fail" });
    await expect.poll(() => root.querySelector(".sx-error")?.textContent).toBe("Something went wrong.");
    // Discovery's own message, as the built-in error state gave it.
    expect(root.querySelector(".ky-error")?.textContent).toBe("Something went wrong.Details: discovery failed");
    expect(lastHidden()).toBe(false);
    stop();
    root.remove();
    host.close();

    // Named by its code, as the built-in error state did, in the UI language.
    await open(pod, "policy-results", { kinds: { code: "unreachable", message: "dial tcp 10.0.0.1:6443: i/o timeout" } });
    await expect.poll(() => root.querySelector(".ky-error")?.textContent).toBe("The cluster cannot be reached.Details: dial tcp 10.0.0.1:6443: i/o timeout");
    expect(root.querySelector(".ky-error")?.getAttribute("role")).toBe("alert");
    stop();
    root.remove();
    host.close();
    await open(pod, "policy-results", { kinds: { code: "forbidden", message: "no discovery" }, language: "de" });
    await expect.poll(() => root.querySelector(".ky-error .sx-error")?.textContent).toBe(CATALOGS.de["error.code.forbidden"]);
    expect(text()).toContain("Details: no discovery");
    stop();
    root.remove();
    host.close();

    await open(pod, "policy-results");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    watchOf("PolicyReport")!.emit({ type: "forbidden", message: "no" } as unknown as WatchUpdate);
    await expect.poll(() => root.querySelector(".sx-error")).not.toBeNull();
    expect(lastHidden()).toBe(false);
  });

  it("look the report up by the uid Sextant gives, never reading the object; wait for it", async () => {
    await open(pod, "policy-results", { uid: null });
    await settle();
    expect(hiddenCalls()).toEqual([true]);
    expect(host.watches).toEqual([]);
    host.setContext({ uid: pod.metadata.uid });
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    expect(params(watchOf("PolicyReport")!).fieldSelector).toBe(`metadata.name=${pod.metadata.uid}`);
    expect(host.calls.some((c) => c.method === "resources.get")).toBe(false);
  });

  it("list at most 50 results, and say how many are not shown", async () => {
    await open(pod, "policy-results");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    const many = copy(report);
    many.results = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ policy: `p${i}`, result: "pass", rule: "r" }));
    watchOf("PolicyReport")!.emit(snapshot([many]));
    await expect.poll(rows).toHaveLength(MAX_LISTED);
    expect(text()).toContain("Not shown: 3");
  });

  it("speak the UI language", async () => {
    await open(pod, "policy-results", { language: "ru" });
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    watchOf("PolicyReport")!.emit(snapshot([report]));
    await expect.poll(text).toContain("Нарушено правил политик: 1 из 2 проверенных.");
  });
});

describe("a policy's details", () => {
  it("mode, rules and the objects that fail it, from the reports with its label", async () => {
    await open(policy, "cluster-policy");
    await expect.poll(text).toContain("Ready: Kyverno applies this policy.");
    expect(text()).toContain("Enforce: a request that breaks a rule is refused.");
    expect(text()).toContain("check-team");
    expect(text()).toContain("Background scans");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    expect(params(watchOf("PolicyReport")!)).toMatchObject({ labelSelector: "cpol.kyverno.io/require-labels" });
    expect(params(watchOf("PolicyReport")!).namespaces).toBeUndefined();
    expect(params(watchOf("ClusterPolicyReport")!)).toMatchObject({ labelSelector: "cpol.kyverno.io/require-labels" });
    expect(text()).toContain("Reading the reports…");
    watchOf("PolicyReport")!.emit(snapshot([report]));
    watchOf("ClusterPolicyReport")!.emit(snapshot([]));
    await expect.poll(() => byLabel("Open Pod nginx")).toHaveLength(1);
    expect(text()).toContain("Failed: 1");
    expect(byLabel("Open Pod nginx")[0]!.textContent).toBe("Pod/nginx");
    // A policy has no policy results of its own: no report is watched by its uid.
    expect(host.watches.some((w) => params(w).fieldSelector !== undefined)).toBe(false);
  });

  it("of a Policy: only the PolicyReports of its namespace", async () => {
    const namespaced = copy(policy);
    namespaced.kind = "Policy";
    namespaced.metadata.namespace = "team-a";
    await open(namespaced, "policy");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    expect(params(watchOf("PolicyReport")!)).toMatchObject({ namespaces: ["team-a"], labelSelector: "pol.kyverno.io/require-labels" });
    expect(watchOf("ClusterPolicyReport")).toBeUndefined();
    watchOf("PolicyReport")!.emit(snapshot([]));
    await expect.poll(text).toContain("No report holds results of this policy yet.");
  });

  it("not ready: the explanation in red and Kyverno's message", async () => {
    const broken = copy(policy);
    broken.status = { conditions: [{ type: "Ready", status: "False", message: "the rule is invalid" }] };
    await open(broken, "cluster-policy");
    await expect.poll(text).toContain("Not ready: Kyverno does not apply this policy until the problem below is fixed.");
    expect(root.querySelector(".ky-explain--danger")).not.toBeNull();
    expect(root.querySelector(".ky-message")?.textContent).toBe("the rule is invalid");
  });

  it("say when the name cannot be a label, and when only part of the reports was read", async () => {
    const long = copy(policy);
    long.metadata.name = "x".repeat(64);
    await open(long, "cluster-policy");
    await expect.poll(text).toContain("The policy's name is too long");
    expect(host.watches).toEqual([]);
    stop();
    root.remove();
    host.close();

    await open(policy, "cluster-policy");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    // The core keeps 1000 and counts the rest (#406), as the built-in watch asked.
    expect(params(watchOf("PolicyReport")!)).toMatchObject({ maxObjects: MAX_SUMMARY_REPORTS });
    expect(params(watchOf("ClusterPolicyReport")!)).toMatchObject({ maxObjects: MAX_SUMMARY_REPORTS });
    const reports = Array.from({ length: MAX_SUMMARY_REPORTS }, (_, i) => {
      const r = copy(report);
      r.metadata.name = `r${String(i).padStart(4, "0")}`;
      r.metadata.uid = `u${i}`;
      return r;
    });
    watchOf("PolicyReport")!.emit(snapshot(reports));
    watchOf("ClusterPolicyReport")!.emit(snapshot([]));
    await expect.poll(text).toContain(`Not shown: ${MAX_SUMMARY_REPORTS - MAX_LISTED}`);
    expect(text()).not.toContain("Only part of the reports was read");
    watchOf("PolicyReport")!.emit({ type: "capped", total: MAX_SUMMARY_REPORTS + 1 } as unknown as WatchUpdate);
    // The SDK writes the count in the UI language's digits.
    await expect.poll(text).toContain(`Only part of the reports was read: the counts are incomplete (${MAX_SUMMARY_REPORTS.toLocaleString("en")} results counted).`);
    expect(text()).toContain(`Not shown: ${MAX_SUMMARY_REPORTS - MAX_LISTED}`);
  });

  it("leave the block out where the cluster serves no reports", async () => {
    await open(policy, "cluster-policy", { kinds: served("ClusterPolicy") });
    await expect.poll(text).toContain("check-team");
    await settle();
    expect(text()).not.toContain("Results in reports");
    expect(host.watches).toEqual([]);
  });

  it("name discovery's error by its code and message in \"Results in reports\"", async () => {
    await open(policy, "cluster-policy", { kinds: { code: "timeout", message: "discovery took too long" } });
    await expect.poll(() => root.querySelector(".ky-error")?.textContent).toBe("The operation took too long.Details: discovery took too long");
    expect(text()).toContain("Results in reports");
    expect(host.watches).toEqual([]);
  });
});

describe("a report's details", () => {
  it("the object it is about, its counts and its results", async () => {
    await open(report, "policy-report");
    await expect.poll(() => byLabel("Open Pod nginx")).toHaveLength(1);
    expect(text()).toContain("Failed: 1 and Passed: 1");
    expect(rows().map((r) => r[2])).toEqual(["Fail", "Pass"]);
    expect(host.watches).toEqual([]);
  });
});

describe("the blocks, in Sextant's memory of details sections", () => {
  const toggle = (title: string) => [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")].find((b) => b.textContent === title);
  const setBlockOpen = () => host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params);
  const live = () => host.watches.filter((w) => !w.stopped);

  it("a section titled by its kind, closed as Sextant remembers it: nothing drawn, nothing watched", async () => {
    await open(policy, "cluster-policy", { blocks: { kind: false } });
    await expect.poll(() => toggle("ClusterPolicy")).toBeDefined();
    await settle();
    expect(toggle("ClusterPolicy")!.getAttribute("aria-expanded")).toBe("false");
    expect(text()).toBe("ClusterPolicy");
    expect(live()).toEqual([]);
    toggle("ClusterPolicy")!.focus();
    toggle("ClusterPolicy")!.click();
    await expect.poll(setBlockOpen).toEqual([{ id: "kind", open: true }]);
    await expect.poll(text).toContain("check-team");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    // Drawn again, the focus stays on the toggle.
    expect(document.activeElement).toBe(toggle("ClusterPolicy"));
  });

  it("\"Results in reports\" watches its reports only while open", async () => {
    await open(policy, "cluster-policy");
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    toggle("Results in reports")!.click();
    await expect.poll(setBlockOpen).toEqual([{ id: "policySummary", open: false }]);
    await expect.poll(live).toEqual([]);
    expect(text()).not.toContain("Reading the reports…");
    toggle("Results in reports")!.click();
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
  });

  it("follow the panel's Collapse all and Expand all", async () => {
    await open(report, "policy-report");
    await expect.poll(() => byLabel("Open Pod nginx")).toHaveLength(1);
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => byLabel("Open Pod nginx")).toHaveLength(0);
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => byLabel("Open Pod nginx")).toHaveLength(1);
  });

  it("closed \"Policy results\" look once: the title where there are results, hidden where none, then stop watching", async () => {
    await open(pod, "policy-results", { blocks: { objectResults: false } });
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    watchOf("PolicyReport")!.emit(snapshot([report]));
    await expect.poll(() => toggle("Policy results")).toBeDefined();
    expect(lastHidden()).toBe(false);
    expect(toggle("Policy results")!.getAttribute("aria-expanded")).toBe("false");
    expect(text()).toBe("Policy results");
    await expect.poll(live).toEqual([]);
    // Opened: watched again, "Loading…" until it answers, then the results.
    toggle("Policy results")!.click();
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    expect(text()).toContain("Loading…");
    watchOf("PolicyReport")!.emit(snapshot([report]));
    await expect.poll(text).toContain("Failing policy rules: 1 of 2 checked.");
    stop();
    root.remove();
    host.close();

    await open(pod, "policy-results", { blocks: { objectResults: false } });
    await expect.poll(() => watchOf("PolicyReport")).toBeDefined();
    watchOf("PolicyReport")!.emit(snapshot([]));
    await expect.poll(live).toEqual([]);
    expect(hiddenCalls()).toEqual([true]);
  });
});

describe("a policy without rules", () => {
  it("draw no empty rules table, as the built-in details' tables", async () => {
    const bare = copy(policy);
    delete (bare.spec as Record<string, unknown>).rules;
    await open(bare, "cluster-policy");
    await expect.poll(text).toContain("Background scans");
    expect(root.querySelector("table[aria-label='Rule']")).toBeNull();
  });
});
