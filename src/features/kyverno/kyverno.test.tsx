import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { OPT_IN_CATEGORIES, resolve } from "../problems/model";
import { CATEGORY_SOURCES, MAX_SOURCE_OBJECTS } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import clusterPolicyJson from "./fixtures/clusterpolicy.json";
import podJson from "./fixtures/pod.json";
import reportJson from "./fixtures/policyreport.json";
import "./index";
import {
  CLUSTER_POLICY,
  CLUSTER_POLICY_REPORT,
  EPHEMERAL_REPORT,
  POLICY,
  POLICY_REPORT,
  policyMode,
  policyReady,
  policyReportLabel,
  policyRules,
  reportResults,
  reportScope,
  reportSummary,
  resultPolicyName,
} from "./model";
import { policyProblems } from "./problemRules";

const policy = clusterPolicyJson as KubeObject;
const report = reportJson as KubeObject;
const pod = podJson as KubeObject;

describe("the model", () => {
  it("a policy's readiness, mode per rule and the label of its reports", () => {
    expect(policyReady(policy)).toBe("True");
    expect(policyRules(policy).map((r) => [r.name, r.type, r.mode, r.kinds])).toEqual([
      ["check-team", "validate", "Enforce", ["Pod"]],
      ["add-default-owner", "mutate", undefined, ["Deployment", "StatefulSet"]],
    ]);
    expect(policyMode(policy)).toBe("Enforce");
    expect(policyReportLabel(policy, CLUSTER_POLICY)).toBe("cpol.kyverno.io/require-labels");

    // The policy-wide action of older policies, lowercase too; rules that differ are Mixed.
    const older = copy(policy);
    const spec = older.spec as { validationFailureAction?: string; rules: { validate?: { failureAction?: string } }[] };
    spec.validationFailureAction = "audit";
    delete spec.rules[0]!.validate!.failureAction;
    expect(policyMode(older)).toBe("Audit");
    spec.rules.push({ validate: { failureAction: "Enforce" } });
    expect(policyMode(older)).toBe("Mixed");

    const namespaced = copy(policy);
    namespaced.metadata!.namespace = "team-a";
    expect(resultPolicyName(namespaced, POLICY)).toBe("team-a/require-labels");
    expect(policyReportLabel(namespaced, POLICY)).toBe("pol.kyverno.io/require-labels");
  });

  it("a report's object, results and summary", () => {
    expect(reportScope(POLICY_REPORT, report)).toEqual({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "nginx" });
    expect(reportResults(POLICY_REPORT, report).map((r) => [r.policy, r.result])).toEqual([
      ["require-labels", "fail"],
      ["disallow-latest-tag", "pass"],
    ]);
    expect(reportSummary(POLICY_REPORT, report)).toEqual({ pass: 1, fail: 1, warn: 0, error: 0, skip: 0 });
    expect(getResourceDef(POLICY_REPORT).problem?.(report)).toBe(true);
  });
});

describe("problems", () => {
  it("are opt-in, from the wgpolicyk8s.io reports, about the object the report names", () => {
    expect(OPT_IN_CATEGORIES).toContain("policies");
    expect(CATEGORY_SOURCES.policies.map((d) => d.kind.kind)).toEqual(["PolicyReport", "ClusterPolicyReport"]);
    const [p] = resolve(POLICY_REPORT, report, Date.now());
    expect(p).toMatchObject({
      category: "policies",
      reason: "PolicyViolation",
      messageKey: "messages.policyFailures",
      messageParams: { count: 1 },
      messageLists: { policies: ["require-labels"] },
      object: { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "nginx" },
    });
    // Kyverno's own intermediate reports and passing reports are none.
    expect(policyProblems(EPHEMERAL_REPORT, report)).toEqual([]);
    const passing = copy(report);
    (passing.results as { result: string }[])[0]!.result = "pass";
    expect(policyProblems(POLICY_REPORT, passing)).toEqual([]);
  });

  it("a rule that could not be evaluated (result error) is a problem of its own, listed but not notified", () => {
    const errored = copy(report);
    (errored.results as { result: string }[])[0]!.result = "error";
    expect(getResourceDef(POLICY_REPORT).problem?.(errored)).toBe(true);
    expect(policyProblems(POLICY_REPORT, errored)).toMatchObject([
      { reason: "PolicyError", messageKey: "messages.policyErrors", messageParams: { count: 1 }, notify: false, messageLists: { policies: ["require-labels"] } },
    ]);
    // Both on one report: two problems.
    (errored.results as { result: string; policy: string }[]).push({ ...(report.results as { result: string; policy: string }[])[0]!, result: "fail" });
    expect(policyProblems(POLICY_REPORT, errored).map((p) => p.reason)).toEqual(["PolicyViolation", "PolicyError"]);
  });

  it("the report sources are capped and say so", () => {
    expect(CATEGORY_SOURCES.policies.map((d) => d.maxObjects)).toEqual([MAX_SOURCE_OBJECTS, MAX_SOURCE_OBJECTS]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: !kind.kind.startsWith("Cluster"),
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, CLUSTER_POLICY, POLICY, POLICY_REPORT, CLUSTER_POLICY_REPORT];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

function refTo(obj: KubeObject): ObjectRef {
  const apiVersion = obj.apiVersion ?? "";
  const slash = apiVersion.indexOf("/");
  const kind = slash < 0 ? { group: "", version: apiVersion, kind: obj.kind ?? "" } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind: obj.kind ?? "" };
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const section = (id: string) => within(document.querySelector<HTMLElement>(`[data-section='${id}']`)!);

describe("the Kyverno section", () => {
  it("is there with the kinds the cluster serves, and counts nothing while the opt-in category is off", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Kyverno"));
    // No report is watched for problems while `policies` is off.
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "settings_get")).toBe(true));
    expect([...wb.specs.values()].some((s) => s.kind.kind === "PolicyReport")).toBe(false);
  });

  it("counts the failing objects once the category is on", async () => {
    stored = { ...defaultAppSettings(), notifications: { ...defaultAppSettings().notifications, enabledCategories: ["policies"] } };
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Kyverno"));
    emitSnapshot(wb, await watchOf(wb, "PolicyReport"), [report]);
    emitSnapshot(wb, await watchOf(wb, "ClusterPolicyReport"), []);
    await waitFor(() => expect(screen.getByTitle("1 object fails policy rules")).toHaveTextContent("1"));
  });
});

describe("details", () => {
  it("of an object: its own report, watched by name in its namespace, failures first", async () => {
    await openDetails(pod);
    const id = await watchOf(wb, "PolicyReport");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["default"], fieldSelector: `metadata.name=${pod.metadata!.uid}` });
    emitSnapshot(wb, id, [report]);
    const results = section("kyvernoResults");
    await waitFor(() => expect(results.getByText("Failing policy rules: 1 of 2 checked.")).toBeInTheDocument());
    const rows = results.getAllByRole("row");
    expect(within(rows[1]!).getByRole("button", { name: "Open ClusterPolicy require-labels" })).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Fail")).toHaveClass("rt-status--danger");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of a policy: mode, rules and the objects that fail it, from the reports with its label", async () => {
    await openDetails(policy);
    const kv = section("kyverno");
    await waitFor(() => expect(kv.getByText("Ready: Kyverno applies this policy.")).toBeInTheDocument());
    expect(kv.getByText(/Enforce: a request that breaks a rule is refused/)).toBeInTheDocument();
    expect(kv.getByText("check-team")).toBeInTheDocument();
    const reports = await watchOf(wb, "PolicyReport");
    expect(wb.specs.get(reports)).toMatchObject({ namespaces: null, labelSelector: "cpol.kyverno.io/require-labels" });
    emitSnapshot(wb, reports, [report]);
    emitSnapshot(wb, await watchOf(wb, "ClusterPolicyReport", (spec) => spec.labelSelector !== null), []);
    // A policy has no policy results of its own: no report is watched by its uid.
    expect([...wb.specs.values()].some((spec) => spec.fieldSelector === `metadata.name=${policy.metadata!.uid}`)).toBe(false);
    await waitFor(() => expect(kv.getByRole("button", { name: "Open Pod nginx" })).toBeInTheDocument());
    expect(kv.getByText("Failed: 1")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
