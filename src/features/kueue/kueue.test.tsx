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
import { resetKueueTaps } from "./hooks";
import "./index";
import {
  ADMISSION_CHECK,
  CLUSTER_QUEUE,
  COHORT,
  EVICTIONS_THRESHOLD,
  LOCAL_QUEUE,
  ownerOf,
  PENDING_GRACE_MS,
  prebuiltWorkloadOf,
  QUEUE_GRACE_MS,
  queueState,
  quotaRows,
  RESOURCE_FLAVOR,
  WORKLOAD,
  WORKLOAD_PRIORITY_CLASS,
  workloadInfo,
  workloadProblems,
} from "./model";

const objects = objectsJson as KubeObject[];
const find = (kind: string, name: string) => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const cq = () => find("ClusterQueue", "cluster-queue");
const gpuQueue = () => find("ClusterQueue", "gpu-queue");
const pending = () => find("Workload", "job-sample-job-7f3a1");
const evicted = () => find("Workload", "jobset-trainer-1b2c3");

describe("the model", () => {
  it("reads a queue's state from its Active condition", () => {
    expect(queueState(cq())).toBe("active");
    expect(queueState(gpuQueue())).toBe("inactive");
    const stopped = cq();
    (stopped.status as { conditions: unknown[] }).conditions = [{ type: "Active", status: "False", reason: "Stopped", message: "Can't admit new workloads: is stopped." }];
    expect(queueState(stopped)).toBe("stopped");
    expect(queueState(find("LocalQueue", "team-queue"))).toBe("inactive");
  });

  it("puts the quota beside what is reserved, borrowed and in use, per flavor and resource", () => {
    expect(quotaRows(cq())).toEqual([
      { flavor: "default-flavor", resource: "cpu", nominal: "9", borrowingLimit: "2", lendingLimit: undefined, reserved: "10", borrowed: "1", used: "10", percent: 111 },
      { flavor: "default-flavor", resource: "memory", nominal: "36Gi", borrowingLimit: undefined, lendingLimit: undefined, reserved: "6Gi", borrowed: undefined, used: "6Gi", percent: 17 },
    ]);
    // v1beta1 names the cohort `cohort`.
    const old = cq();
    const spec = old.spec as Record<string, unknown>;
    delete spec.cohortName;
    spec.cohort = "legacy";
    expect(getResourceDef(CLUSTER_QUEUE).columns.find((c) => c.id === "cohort")!.value(old)).toBe("legacy");
  });

  it("tells a Workload's state, its queues and the job that owns it", () => {
    expect(workloadInfo(pending())).toMatchObject({ state: "pending", queue: "user-queue", evictions: 0, why: { type: "QuotaReserved", reason: "Pending" } });
    expect(workloadInfo(evicted())).toMatchObject({ state: "admitted", clusterQueue: "cluster-queue", priorityClass: "high-priority", evictions: 3 });
    expect(ownerOf(pending())).toEqual({ apiVersion: "batch/v1", kind: "Job", name: "sample-job" });
    const composed = pending();
    composed.metadata!.ownerReferences = [];
    composed.metadata!.annotations = { "kueue.x-k8s.io/job-owner-gvk": "apps/v1, Kind=StatefulSet", "kueue.x-k8s.io/job-owner-name": "db" };
    expect(ownerOf(composed)).toEqual({ apiVersion: "apps/v1", kind: "StatefulSet", name: "db" });
    const missingQueue = pending();
    (missingQueue.status as { conditions: unknown[] }).conditions = [
      { type: "QuotaReserved", status: "False", reason: "Inadmissible", message: "LocalQueue user-queue doesn't exist", lastTransitionTime: "2026-10-20T09:00:01Z" },
    ];
    expect(workloadInfo(missingQueue).state).toBe("inadmissible");
    // A stopped queue is the queue's state, not the Workload's fault.
    (missingQueue.status as { conditions: { message: string }[] }).conditions[0]!.message = "ClusterQueue cluster-queue is inactive";
    expect(workloadInfo(missingQueue).state).toBe("pending");
    expect(workloadProblems(missingQueue)).toEqual([]);
  });

  it("an inactive ClusterQueue and a LocalQueue of a missing ClusterQueue are problems after a short grace", () => {
    expect(categoryOf(CLUSTER_QUEUE)).toBe("kueue");
    expect(detect(CLUSTER_QUEUE, gpuQueue())).toMatchObject([{ reason: "FlavorNotFound", graceMs: QUEUE_GRACE_MS, message: expect.stringContaining("gpu-flavor") }]);
    expect(detect(CLUSTER_QUEUE, cq())).toEqual([]);
    expect(detect(LOCAL_QUEUE, find("LocalQueue", "team-queue")).map((d) => d.reason)).toEqual(["ClusterQueueDoesNotExist"]);
    const ofInactive = find("LocalQueue", "team-queue");
    (ofInactive.status as { conditions: { reason: string }[] }).conditions[0]!.reason = "ClusterQueueIsInactive";
    expect(detect(LOCAL_QUEUE, ofInactive)).toEqual([]);
  });

  it("a Workload waiting for quota counts after 30 minutes, with the scheduler's message; evicted repeatedly at once", () => {
    expect(categoryOf(WORKLOAD)).toBe("kueueWorkloads");
    expect(OPT_IN_CATEGORIES).toContain("kueueWorkloads");
    expect(OPT_IN_CATEGORIES).not.toContain("kueue");
    const [problem] = resolve(WORKLOAD, pending(), Date.parse("2026-10-20T09:10:00Z"));
    expect(problem).toMatchObject({ reason: "PendingQuota", message: expect.stringContaining("insufficient unused quota for cpu") });
    expect(problem!.activeAt).toBe(Date.parse("2026-10-20T09:00:01Z") + PENDING_GRACE_MS);
    expect(EVICTIONS_THRESHOLD).toBe(3);
    const [again] = workloadProblems(evicted(), Date.parse("2026-10-20T10:00:00Z"));
    expect(again).toMatchObject({ reason: "EvictedRepeatedly", messageKey: "messages.kueueEvictions", messageParams: { count: 3 } });
    // Admitted again: it stops counting an hour after the last eviction.
    expect(workloadProblems(evicted(), Date.parse("2026-10-20T10:41:00Z"))).toEqual([]);
    const finished = pending();
    (finished.status as { conditions: unknown[] }).conditions = [{ type: "Finished", status: "True", reason: "Succeeded" }];
    expect(workloadProblems(finished)).toEqual([]);
  });

  it("a Workload Kueue deactivated after too many requeues is a problem; one the user deactivated is not", () => {
    const off = pending();
    (off.spec as Record<string, unknown>).active = false;
    expect(workloadInfo(off).state).toBe("deactivated");
    expect(workloadProblems(off)).toEqual([]);
    (off.status as { conditions: unknown[] }).conditions = [
      { type: "Evicted", status: "True", reason: "DeactivatedDueToRequeuingLimitExceeded", message: "The workload is deactivated due to exceeding the maximum number of re-queuing retries" },
    ];
    expect(workloadProblems(off).map((p) => p.reason)).toEqual(["Deactivated"]);
  });

  it("an older Kueue's deactivation tells its cause only in the eviction counts: still a failure", () => {
    const off = pending();
    (off.spec as Record<string, unknown>).active = false;
    const st = off.status as Record<string, unknown>;
    st.conditions = [{ type: "Evicted", status: "True", reason: "InactiveWorkload", message: "The workload is deactivated due to exceeding the PodsReady timeout 5 times in a row" }];
    st.schedulingStats = { evictions: [{ reason: "Deactivated", underlyingCause: "RequeuingLimitExceeded", count: 1 }] };
    expect(workloadProblems(off).map((p) => p.reason)).toEqual(["Deactivated"]);
    // A cause that is no failure, or an Evicted reason that names its own cause, is not.
    st.schedulingStats = { evictions: [{ reason: "Deactivated", underlyingCause: "", count: 1 }] };
    expect(workloadProblems(off)).toEqual([]);
    st.conditions = [{ type: "Evicted", status: "True", reason: "DeactivatedDueToUser" }];
    st.schedulingStats = { evictions: [{ reason: "Deactivated", underlyingCause: "RequeuingLimitExceeded", count: 1 }] };
    expect(workloadProblems(off)).toEqual([]);
  });

  it("waiting for pods ready waits; unresolved DRA resources cannot be queued as they are", () => {
    const waiting = pending();
    const reserved = (waiting.status as { conditions: { type: string; reason: string }[] }).conditions.find((c) => c.type === "QuotaReserved")!;
    reserved.reason = "WaitingForPodsReady";
    expect(workloadProblems(waiting).map((p) => p.reason)).toEqual(["PendingQuota"]);
    reserved.reason = "DRAResourcesUnresolved";
    expect(workloadInfo(waiting).state).toBe("inadmissible");
    expect(workloadProblems(waiting).map((p) => p.reason)).toEqual(["Inadmissible"]);
  });

  it("a job's prebuilt Workload: the annotation first, then the label", () => {
    const job = { metadata: { name: "j", labels: { "kueue.x-k8s.io/prebuilt-workload-name": "from-label" } } } as KubeObject;
    expect(prebuiltWorkloadOf(job)).toBe("from-label");
    job.metadata!.annotations = { "kueue.x-k8s.io/prebuilt-workload-name": "from-annotation" };
    expect(prebuiltWorkloadOf(job)).toBe("from-annotation");
    expect(prebuiltWorkloadOf({ metadata: { name: "x" } } as KubeObject)).toBeUndefined();
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };
const KUEUE = [CLUSTER_QUEUE, LOCAL_QUEUE, WORKLOAD, RESOURCE_FLAVOR, COHORT, ADMISSION_CHECK, WORKLOAD_PRIORITY_CLASS];
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
  discovery = [POD, JOB, ...KUEUE];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  resetKueueTaps();
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

const everywhere = (spec: { namespaces: string[] | null; fieldSelector: string | null; labelSelector: string | null }) =>
  spec.namespaces === null && spec.fieldSelector === null && spec.labelSelector === null;

describe("the Kueue section", () => {
  it("is there for a cluster that serves the kinds and counts the inactive queues", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Kueue"));
    emitSnapshot(wb, await watchOf(wb, "ClusterQueue", everywhere), [cq(), gpuQueue()]);
    emitSnapshot(wb, await watchOf(wb, "LocalQueue", everywhere), [find("LocalQueue", "user-queue")]);
    // The Workloads are opt-in: nothing of them is watched for the counter while the category is off.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Workload")).toBe(false);
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Kueue");
  });
});

function refTo(obj: KubeObject, kind: KindRef): ObjectRef {
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject, kind: KindRef, section = "kueue"): Promise<HTMLElement> {
  const ref = refTo(obj, kind);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector(`[data-section='${section}']`)).not.toBeNull());
  return container;
}

const view = (section = "kueue") => within(document.querySelector<HTMLElement>(`[data-section='${section}']`)!);

describe("details", () => {
  it("of a ClusterQueue: quota against usage, its LocalQueues and the Workloads waiting with why", async () => {
    const container = await openDetails(cq(), CLUSTER_QUEUE);
    const v = view();
    const rows = () => v.getAllByRole("row").map((r) => r.textContent);
    expect(rows()).toContain("default-flavorcpu910 (111%), 1 borrowed102");
    emitSnapshot(wb, await watchOf(wb, "LocalQueue", everywhere), [find("LocalQueue", "user-queue"), find("LocalQueue", "team-queue")]);
    emitSnapshot(wb, await watchOf(wb, "Workload", everywhere), [pending(), evicted()]);
    await waitFor(() => expect(v.getByRole("button", { name: "Open Workload job-sample-job-7f3a1" })).toBeInTheDocument());
    // In the LocalQueues and in the waiting list.
    expect(v.getAllByRole("button", { name: "Open LocalQueue user-queue" })).toHaveLength(2);
    expect(v.queryByRole("button", { name: "Open LocalQueue team-queue" })).toBeNull();
    expect(v.getByText(/insufficient unused quota for cpu in flavor default-flavor/)).toBeInTheDocument();
    expect(v.queryByRole("button", { name: "Open Workload jobset-trainer-1b2c3" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of an inactive ClusterQueue: why it admits nothing", async () => {
    const container = await openDetails(gpuQueue(), CLUSTER_QUEUE);
    expect(view().getByText("FlavorNotFound: Can't admit new workloads: references missing ResourceFlavor(s): gpu-flavor.")).toBeInTheDocument();
    expect(view().getByText("Inactive")).toHaveClass("rt-status--danger");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a Workload: why it waits, its job and queues, pod sets and evictions", async () => {
    const container = await openDetails(pending(), WORKLOAD);
    const v = view();
    expect(v.getByText("Waiting in its queue: Kueue has not reserved quota for it yet.")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open Job sample-job" })).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open LocalQueue user-queue" })).toBeInTheDocument();
    expect(v.getByText("cpu: 3")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of an evicted and admitted Workload: the evictions and the admission check", async () => {
    const container = await openDetails(evicted(), WORKLOAD);
    const v = view();
    expect(v.getByRole("button", { name: "Open JobSet trainer" })).toBeInTheDocument();
    expect(v.getAllByRole("row").map((r) => r.textContent)).toContain("PodsReadyTimeout3");
    expect(v.getByText("4 (at least 2)")).toBeInTheDocument();
    expect(v.getByText("Ready")).toHaveClass("rt-status--success");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a ResourceFlavor: the ClusterQueues that use it", async () => {
    const container = await openDetails(find("ResourceFlavor", "default-flavor"), RESOURCE_FLAVOR);
    emitSnapshot(wb, await watchOf(wb, "ClusterQueue", everywhere), [cq(), gpuQueue()]);
    await waitFor(() => expect(view().getByRole("button", { name: "Open ClusterQueue cluster-queue" })).toBeInTheDocument());
    expect(view().queryByRole("button", { name: "Open ClusterQueue gpu-queue" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a Job Kueue queues: the Queue section with its Workload, found by the job's uid", async () => {
    const job: KubeObject = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "sample-job", namespace: "default", uid: "job-uid-1", labels: { "kueue.x-k8s.io/queue-name": "user-queue" } },
      spec: { suspend: true },
    };
    const ref = refTo(job, JOB);
    useAppStore.getState().openDetails(ref);
    const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    emitSnapshot(wb, await watchOf(wb, "Job", (s) => s.fieldSelector === "metadata.name=sample-job"), [job]);
    const id = await watchOf(wb, "Workload", (s) => s.labelSelector === "kueue.x-k8s.io/job-uid=job-uid-1" && s.namespaces?.[0] === "default");
    emitSnapshot(wb, id, [pending()]);
    await waitFor(() => expect(document.querySelector("[data-section='kueueQueue']")).not.toBeNull());
    const v = view("kueueQueue");
    await waitFor(() => expect(v.getByRole("button", { name: "Open Workload job-sample-job-7f3a1" })).toBeInTheDocument());
    expect(v.getByText("Pending")).toHaveClass("rt-status--warning");
    expect(await axeViolations(container)).toEqual([]);
  });
});
