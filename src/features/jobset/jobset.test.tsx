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
import { categoryOf, detect, OPT_IN_CATEGORIES, resolve } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import objectsJson from "./fixtures/objects.json";
import "./index";
import { firstFailedJob, JOBSET, jobSetProblems, jobSetState, RECENT_FAILURE_MS, replicatedJobs, restartsOf } from "./model";

const objects = objectsJson as KubeObject[];
const find = (kind: string, name: string) => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const failed = () => find("JobSet", "failure-policy");
const running = () => find("JobSet", "success-policy");

describe("the model", () => {
  it("reads the state, the replicated jobs and the restarts against the limit", () => {
    expect(jobSetState(failed())).toBe("failed");
    expect(jobSetState(running())).toBe("running");
    expect(restartsOf(failed())).toEqual({ total: 3, counted: 3, max: 3 });
    expect(replicatedJobs(failed())[0]).toMatchObject({ name: "leader", replicas: 1, completions: 2, parallelism: 2, failed: 1 });
    expect(firstFailedJob("jobset failed due to one or more job failures (first failed job: js-workers-1)")).toBe("js-workers-1");
    // Without a failure policy any failed Job fails the JobSet: there is no limit.
    const plain = running();
    delete (plain.spec as Record<string, unknown>).failurePolicy;
    expect(restartsOf(plain).max).toBeUndefined();
    // RestartJob counts the Jobs' restarts toward the limit too.
    const perJob = running();
    (perJob.status as { replicatedJobsStatus: Record<string, unknown>[] }).replicatedJobsStatus[1]!.jobRestartsCountTowardsMax = [1, 0];
    expect(restartsOf(perJob).counted).toBe(2);
  });

  it("a failed JobSet is a problem for a day after it failed, with the controller's reason", () => {
    expect(categoryOf(JOBSET)).toBe("jobset");
    expect(OPT_IN_CATEGORIES).not.toContain("jobset");
    const [d] = detect(JOBSET, failed());
    expect(d).toMatchObject({ reason: "ReachedMaxRestarts", message: expect.stringContaining("first failed job: failure-policy-leader-0") });
    expect(d?.until).toBe(Date.parse("2026-10-20T08:20:00Z") + RECENT_FAILURE_MS);
    expect(jobSetProblems(failed(), Date.parse("2026-10-21T08:20:00Z"))).toEqual([]);
    const done = failed();
    (done.status as Record<string, unknown>).terminalState = "Completed";
    (done.status as Record<string, unknown>).conditions = [{ type: "Completed", status: "True", reason: "AllJobsCompleted" }];
    expect(detect(JOBSET, done)).toEqual([]);
  });

  it("restarts that leave at most one before the limit are a problem while it runs", () => {
    const [p] = resolve(JOBSET, running(), Date.parse("2026-10-20T09:00:00Z"));
    expect(p).toMatchObject({ reason: "RestartsNearLimit", messageKey: "messages.jobsetRestarts", messageParams: { used: 1, max: 2 } });
    const early = running();
    (early.status as Record<string, unknown>).restartsCountTowardsMax = 0;
    (early.status as Record<string, unknown>).restarts = 0;
    expect(detect(JOBSET, early)).toEqual([]);
  });

  it("the table shows the state, succeeded Jobs and restarts; the filter marks failures", () => {
    const def = getResourceDef(JOBSET);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "succeeded", "active", "failed", "restarts", "age"]);
    expect(def.columns.find((c) => c.id === "restarts")!.value(failed())).toBe("3/3");
    expect(def.problem?.(running())).toBe(true);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, JOBSET];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the JobSet section", () => {
  it("is there for a cluster that serves JobSets and counts the failed ones", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("JobSet"));
    const fresh = failed();
    (fresh.status as { conditions: { lastTransitionTime: string }[] }).conditions[0]!.lastTransitionTime = new Date().toISOString();
    emitSnapshot(wb, await watchOf(wb, "JobSet", (s) => s.namespaces === null), [fresh]);
    await waitFor(() => expect(screen.getByTitle("1 JobSet needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the CRD", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("JobSet");
  });
});

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref: ObjectRef = { kind: JOBSET, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, "JobSet", (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='jobset']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='jobset']")!);
const children = (name: string) => (s: { labelSelector: string | null }) => s.labelSelector === `jobset.sigs.k8s.io/jobset-name=${name}`;

describe("details", () => {
  it("of a failed JobSet: the reason, the first failed Job and its own reason, its Jobs and pods", async () => {
    const container = await openDetails(failed());
    const v = view();
    expect(v.getByText("ReachedMaxRestarts: jobset failed due to reaching max number of restarts (first failed job: failure-policy-leader-0)")).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "Job", children("failure-policy")), [find("Job", "failure-policy-leader-0")]);
    emitSnapshot(wb, await watchOf(wb, "Pod", children("failure-policy")), [find("Pod", "failure-policy-leader-0-0-x7k2p")]);
    // In the note under the failure and in the Jobs table.
    await waitFor(() => expect(v.getAllByText("BackoffLimitExceeded: Job has reached the specified backoff limit")[0]).toHaveClass("jobset-note--danger"));
    expect(v.getAllByRole("button", { name: "Open Job failure-policy-leader-0" }).length).toBe(2);
    expect(v.getByRole("button", { name: "Open Pod failure-policy-leader-0-0-x7k2p" })).toBeInTheDocument();
    expect(v.getByText("3 of 3 allowed (3 in all)")).toBeInTheDocument();
    expect(v.getAllByRole("row").map((r) => r.textContent)).toContain("fail-on-oomFailJobSetPodFailurePolicyleader");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a running JobSet near its restart limit: the warning and the success policy", async () => {
    const container = await openDetails(running());
    const v = view();
    expect(v.getByText("1 of 2 allowed restarts used: a failure past the limit fails the JobSet.")).toBeInTheDocument();
    expect(v.getByText("Every Job of workers completes")).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "Job", children("success-policy")), []);
    emitSnapshot(wb, await watchOf(wb, "Pod", children("success-policy")), []);
    await waitFor(() => expect(v.getByText("No Job exists.")).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
  });
});
