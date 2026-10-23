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
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES, resolve } from "../problems/model";
import { CATEGORY_SOURCES, MAX_SOURCE_OBJECTS } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import objectsJson from "./fixtures/objects.json";
import "./index";
import { HIDDEN, looksSecret, maskedEntrypoint, maskedServeConfig } from "./mask";
import {
  clusterState,
  FAILED_JOB_MS,
  failedAppOf,
  jobMessageOf,
  jobState,
  RAY_CLUSTER,
  RAY_GRACE_MS,
  RAY_JOB,
  RAY_SERVICE,
  rayProblems,
  serveServiceOf,
  SERVICE_GRACE_MS,
  serviceState,
  submitterJobOf,
  workersOf,
} from "./model";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const status = (o: KubeObject) => o.status as Record<string, unknown>;

describe("the model", () => {
  it("reads a RayCluster's state from its conditions, else from the deprecated state", () => {
    const ok = byName("RayCluster", "raycluster-kuberay");
    expect(clusterState(ok)).toBe("ready");
    expect(workersOf(ok)).toMatchObject({ ready: 1, desired: 1, min: 1, max: 5 });
    expect(clusterState(byName("RayCluster", "raycluster-gpu"))).toBe("failed");
    expect(clusterState(byName("RayCluster", "raycluster-legacy"))).toBe("failed");
    const headDown = copy(ok);
    (status(headDown).conditions as { type: string; status: string }[])[0]!.status = "False";
    expect(clusterState(headDown)).toBe("headNotReady");
    const coming = copy(ok);
    status(coming).conditions = [{ type: "RayClusterProvisioned", status: "False", reason: "RayClusterPodsProvisioning" }];
    expect(clusterState(coming)).toBe("provisioning");
    const old = copy(ok);
    delete status(old).conditions;
    expect(clusterState(old)).toBe("ready");
    status(old).state = "suspended";
    expect(clusterState(old)).toBe("suspended");
    const suspending = copy(ok);
    status(suspending).conditions = [{ type: "RayClusterSuspending", status: "True" }];
    expect(clusterState(suspending)).toBe("suspending");
    expect(rayProblems(RAY_CLUSTER, suspending)).toEqual([]);
  });

  it("reads a RayJob's state; Retrying comes before a failure and a failed job counts for a day after it ended", () => {
    const failed = byName("RayJob", "rayjob-sample");
    expect(jobState(failed)).toBe("failed");
    expect(submitterJobOf(failed)).toBe("rayjob-sample");
    expect(submitterJobOf(byName("RayJob", "rayjob-done"))).toBeUndefined();
    expect(jobState(byName("RayJob", "rayjob-done"))).toBe("succeeded");
    const retrying = copy(failed);
    status(retrying).jobDeploymentStatus = "Retrying";
    expect(jobState(retrying)).toBe("retrying");
    expect(rayProblems(RAY_JOB, retrying)).toEqual([]);
    const old = copy(failed);
    status(old).jobDeploymentStatus = "Complete";
    expect(jobState(old)).toBe("failed");
    const [d] = detect(RAY_JOB, failed);
    expect(d).toMatchObject({ reason: "AppFailed", since: "2026-10-21T08:02:40Z" });
    expect(d?.until).toBe(Date.parse("2026-10-21T08:02:40Z") + FAILED_JOB_MS);
    expect(rayProblems(RAY_JOB, failed, Date.parse("2026-10-23T00:00:00Z"))).toEqual([]);
    expect(detect(RAY_JOB, byName("RayJob", "rayjob-done"))).toEqual([]);
  });

  it("a RayCluster that cannot create pods or whose head is not ready counts after a grace; a legacy failure at once", () => {
    const [gpu] = detect(RAY_CLUSTER, byName("RayCluster", "raycluster-gpu"));
    expect(gpu).toMatchObject({ reason: "FailedCreateWorkerPod", graceMs: RAY_GRACE_MS });
    expect(gpu?.message).toContain("exceeded quota: gpu-quota");
    const [legacy] = detect(RAY_CLUSTER, byName("RayCluster", "raycluster-legacy"));
    expect(legacy).toMatchObject({ reason: "RayClusterFailed", graceMs: undefined });
    expect(legacy?.message).toContain("image registry is not allowed");
    const headDown = byName("RayCluster", "raycluster-kuberay");
    (status(headDown).conditions as Record<string, unknown>[])[0] = {
      type: "HeadPodReady",
      status: "False",
      reason: "HeadPodNotFound",
      message: "Head Pod not found",
      lastTransitionTime: "2026-10-20T12:00:00Z",
    };
    const problems = resolve(RAY_CLUSTER, headDown, Date.parse("2026-10-20T12:01:00Z"));
    expect(problems.map((p) => p.reason)).toEqual(["HeadPodNotFound"]);
    expect(problems[0]?.activeAt).toBe(Date.parse("2026-10-20T12:00:00Z") + RAY_GRACE_MS);
    expect(detect(RAY_CLUSTER, byName("RayCluster", "raycluster-kuberay"))).toEqual([]);
  });

  it("a RayService not ready counts after a grace, with a failed application's message", () => {
    const starting = byName("RayService", "rayservice-sample");
    expect(serviceState(starting)).toBe("failed");
    expect(failedAppOf(starting)?.name).toBe("fruit_app");
    const [d] = detect(RAY_SERVICE, starting);
    expect(d).toMatchObject({ reason: "Initializing", graceMs: SERVICE_GRACE_MS });
    expect(d?.message).toContain("No module named 'fruit'");
    const ready = byName("RayService", "rayservice-ready");
    expect(serviceState(ready)).toBe("ready");
    expect(serveServiceOf(ready)).toBe("rayservice-ready-serve-svc");
    expect(detect(RAY_SERVICE, ready)).toEqual([]);
    // During an upgrade the active cluster still serves: a failing pending application is no failure.
    const upgrading = copy(ready);
    status(upgrading).pendingServiceStatus = { rayClusterName: "next", applicationStatuses: { fruit_app: { status: "DEPLOY_FAILED" } } };
    status(upgrading).conditions = [
      { type: "Ready", status: "True" },
      { type: "UpgradeInProgress", status: "True", reason: "BothActivePendingClustersExist" },
    ];
    expect(serviceState(upgrading)).toBe("upgrading");
    expect(detect(RAY_SERVICE, upgrading)).toEqual([]);
    // Before KubeRay 1.3: no conditions, `serviceStatus` only.
    const old = copy(ready);
    delete status(old).conditions;
    expect(serviceState(old)).toBe("ready");
    status(old).serviceStatus = "";
    expect(serviceState(old)).toBe("notReady");
  });

  it("a Serve application failing while Ready is True counts from when it was first seen, not from Ready's time", () => {
    const ready = byName("RayService", "rayservice-ready");
    (status(ready).activeServiceStatus as { applicationStatuses: Record<string, { status: string; message?: string }> }).applicationStatuses.math_app = {
      status: "UNHEALTHY",
      message: "replica health check failed",
    };
    expect(serviceState(ready)).toBe("failed");
    const [d] = detect(RAY_SERVICE, ready);
    expect(d).toMatchObject({ reason: "ServeApplicationFailed", since: undefined, graceMs: RAY_GRACE_MS, message: "replica health check failed" });
    const now = Date.parse("2026-10-23T10:00:00Z");
    const [p] = resolve(RAY_SERVICE, ready, now);
    expect(p?.activeAt).toBe(now + RAY_GRACE_MS);
  });

  it("a rollback of an upgrade reads as upgrading and is no problem", () => {
    const rolling = byName("RayService", "rayservice-ready");
    status(rolling).conditions = [
      { type: "Ready", status: "True", reason: "NonZeroServeEndpoints" },
      { type: "UpgradeInProgress", status: "False" },
      { type: "RollbackInProgress", status: "True", reason: "GoalClusterChanged" },
    ];
    status(rolling).pendingServiceStatus = { rayClusterName: "next", applicationStatuses: { fruit_app: { status: "DEPLOYING" } } };
    expect(serviceState(rolling)).toBe("upgrading");
    expect(detect(RAY_SERVICE, rolling)).toEqual([]);
  });

  it("messages lose the credentials and queries of the URIs in them", () => {
    const job = byName("RayJob", "rayjob-sample");
    status(job).message = "failed to fetch working_dir https://ci:ghp_s3cr3t@github.com/org/repo.zip?token=abc";
    expect(jobMessageOf(job)).toBe("failed to fetch working_dir https://github.com/org/repo.zip");
    expect(detect(RAY_JOB, job)[0]?.message).not.toMatch(/ghp_s3cr3t|token=abc/);
    const svc = byName("RayService", "rayservice-sample");
    const apps = (status(svc).pendingServiceStatus as { applicationStatuses: Record<string, { message?: string }> }).applicationStatuses;
    apps.fruit_app!.message = "pip install git+https://oauth2:glpat-xyz@gitlab.com/org/pkg.git failed";
    expect(detect(RAY_SERVICE, svc)[0]?.message).toBe("pip install git+https://gitlab.com/org/pkg.git failed");
  });

  it("masks every environment value and secret-looking value of a serve config, and cleans its URIs", () => {
    const config = [
      "applications:",
      "  - name: llm",
      "    import_path: serve_llm:app",
      "    runtime_env:",
      '      working_dir: "https://user:ghp_secret@github.com/org/repo/archive/main.zip?token=abc"',
      '      py_modules: ["s3://AKIAX:wJalrSecret@bucket/mod.zip"]',
      "      pip:",
      '        - "git+https://oauth2:glpat-xyz@gitlab.com/org/pkg.git"',
      "        - vllm==0.6.0",
      "      env_vars:",
      "        HF_TOKEN: hf_abcdefSECRET",
      "        AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE",
      "        AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMIK7MDENG",
      "        LOG_LEVEL: verbose-logging",
      "      config:",
      "        api_key: sk-live-123",
      "    args:",
      "      model: meta-llama/Llama-3.1-8B",
      "      max_tokens: 512",
      "      tokenizer: hf-internal",
      "      hf_token: hf_argsSECRET",
      "      authToken: tok-camel",
    ].join("\n");
    const shown = maskedServeConfig(config)!;
    for (const secret of ["ghp_secret", "token=abc", "wJalrSecret", "AKIAX", "glpat-xyz", "hf_abcdefSECRET", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMIK7MDENG", "verbose-logging", "sk-live-123", "hf_argsSECRET", "tok-camel"])
      expect(shown).not.toContain(secret);
    for (const kept of ["import_path: serve_llm:app", "max_tokens: 512", "tokenizer: hf-internal", `HF_TOKEN: ${HIDDEN}`, "github.com/org/repo/archive/main.zip", "s3://bucket/mod.zip", "vllm==0.6.0"])
      expect(shown).toContain(kept);
    // What does not parse as one mapping is not shown at all.
    expect(maskedServeConfig("applications: [\n  - name: x\n    env_vars: {HF_TOKEN: hf_x")).toBeUndefined();
    expect(maskedServeConfig("HF_TOKEN=hf_plain")).toBeUndefined();
    expect(["token", "HF_TOKEN", "authToken", "AWS_ACCESS_KEY_ID", "db-password", "githubtoken", "client_secret"].every(looksSecret)).toBe(true);
    expect(["tokenizer", "max_tokens", "author", "monkey", "num-tokens", "model"].some(looksSecret)).toBe(false);
  });

  it("masks secret-looking flags and variables of an entrypoint, and cleans its URIs", () => {
    const entrypoint =
      'HF_TOKEN=hf_abc AWS_SECRET_ACCESS_KEY=wJalr python train.py --hf-token=hf_def --api-key sk-123 --password "p w" --model meta-llama/x --data s3://AKIA:sec@bucket/d?sig=1 --verbose --num-tokens 5';
    expect(maskedEntrypoint(entrypoint)).toBe(
      `HF_TOKEN=${HIDDEN} AWS_SECRET_ACCESS_KEY=${HIDDEN} python train.py --hf-token=${HIDDEN} --api-key ${HIDDEN} --password ${HIDDEN} --model meta-llama/x --data s3://bucket/d --verbose --num-tokens 5`,
    );
    expect(maskedEntrypoint("python /home/ray/samples/sample_code.py")).toBe("python /home/ray/samples/sample_code.py");
  });

  it("the category: on by default, its sources capped for RayJobs, and the tables' columns and filter", () => {
    expect(PROBLEM_CATEGORIES).toContain("kuberay");
    expect(OPT_IN_CATEGORIES).not.toContain("kuberay");
    expect(categoryOf(RAY_JOB)).toBe("kuberay");
    expect(categoryOf({ group: "ray.io", kind: "RayCronJob" })).toBeUndefined();
    expect(CATEGORY_SOURCES.kuberay.map((s) => [s.kind.kind, s.maxObjects])).toEqual([
      ["RayCluster", undefined],
      ["RayJob", MAX_SOURCE_OBJECTS],
      ["RayService", undefined],
    ]);
    const def = getResourceDef(RAY_CLUSTER);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "workers", "headIP", "rayVersion", "age"]);
    expect(def.columns.find((c) => c.id === "workers")!.value(byName("RayCluster", "raycluster-kuberay"))).toBe("1/1");
    expect(def.problem?.(byName("RayCluster", "raycluster-gpu"))).toBe(true);
    expect(def.problem?.(byName("RayCluster", "raycluster-kuberay"))).toBe(false);
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
  discovery = [POD, RAY_CLUSTER, RAY_JOB, RAY_SERVICE];
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

describe("the KubeRay section", () => {
  it("is there for a cluster that serves the kinds and counts the failed objects", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("KubeRay"));
    emitSnapshot(wb, await watchOf(wb, "RayCluster"), [byName("RayCluster", "raycluster-kuberay"), byName("RayCluster", "raycluster-legacy")]);
    const failed = byName("RayJob", "rayjob-sample");
    status(failed).endTime = new Date().toISOString();
    emitSnapshot(wb, await watchOf(wb, "RayJob"), [failed, byName("RayJob", "rayjob-done")]);
    emitSnapshot(wb, await watchOf(wb, "RayService"), [byName("RayService", "rayservice-ready")]);
    await waitFor(() => expect(screen.getByTitle("2 objects need attention")).toHaveTextContent("2"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("KubeRay");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "ray.io", version: "v1", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='kuberay']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='kuberay']")!);

describe("details", () => {
  it("of a RayCluster: the head pod with its logs, the worker groups and the pods by label", async () => {
    const container = await openDetails(byName("RayCluster", "raycluster-kuberay"));
    const podsWatch = await watchOf(wb, "Pod", (s) => s.labelSelector === "ray.io/cluster=raycluster-kuberay");
    emitSnapshot(wb, podsWatch, objects.filter((o) => o.kind === "Pod"));
    const v = view();
    await waitFor(() => expect(v.getByRole("button", { name: "Head logs" })).toBeInTheDocument());
    expect(v.getByText("1 of 1 ready")).toBeInTheDocument();
    expect(v.getAllByRole("button", { name: "Open Pod raycluster-kuberay-head" }).length).toBeGreaterThan(0);
    expect(v.getByRole("button", { name: "Open Service raycluster-kuberay-head-svc" })).toBeInTheDocument();
    expect(v.getByText("dashboard: 8265")).toBeInTheDocument();
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("workergroup11 to 51No");
    v.getByRole("button", { name: "Head logs" }).click();
    expect(useAppStore.getState().dock.tabs.some((tab) => tab.type === "logs" && tab.title === "raycluster-kuberay-head")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a RayCluster whose worker groups have no upper limit: no limit, not 2147483647", async () => {
    const unbounded = byName("RayCluster", "raycluster-kuberay");
    const groups = (unbounded.spec as { workerGroupSpecs: Record<string, unknown>[] }).workerGroupSpecs;
    groups[0]!.maxReplicas = 2147483647;
    status(unbounded).maxWorkerReplicas = 2147483647;
    const container = await openDetails(unbounded);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "ray.io/cluster=raycluster-kuberay"), []);
    const v = view();
    await waitFor(() => expect(v.getAllByText("At least 1, no upper limit").length).toBe(2));
    expect(container.textContent).not.toContain("2147483647");
  });

  it("of a failed RayCluster: the operator's message", async () => {
    const container = await openDetails(byName("RayCluster", "raycluster-gpu"));
    expect(view().getByText(/exceeded quota: gpu-quota/)).toBeInTheDocument();
    expect(view().getAllByText("Failed")[0]).toHaveClass("rt-status--danger");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a RayJob: why it failed, the entrypoint, its RayCluster and submitter Job", async () => {
    const container = await openDetails(byName("RayJob", "rayjob-sample"));
    const v = view();
    expect(v.getByText(/No module named 'requests'/)).toBeInTheDocument();
    expect(v.getByText("python /home/ray/samples/sample_code.py")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open RayCluster rayjob-sample-raycluster-v6bgw" })).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open Job rayjob-sample" })).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Submitter logs" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a RayJob and a RayService: the entrypoint and serve config masked, an unreadable config not shown", async () => {
    const job = byName("RayJob", "rayjob-sample");
    (job.spec as Record<string, unknown>).entrypoint = "python train.py --hf-token=hf_SECRET --data https://u:pw@h/d?sig=1";
    status(job).dashboardURL = "https://admin:dash_pw@ray.example.com/?auth=1";
    const jobView = await openDetails(job);
    expect(view().getByText(`python train.py --hf-token=${HIDDEN} --data https://h/d`)).toBeInTheDocument();
    expect(jobView.textContent).not.toMatch(/hf_SECRET|dash_pw|auth=1/);
    document.body.innerHTML = "";
    const svc = byName("RayService", "rayservice-ready");
    (svc.spec as Record<string, unknown>).serveConfigV2 = "applications:\n  - name: a\n    runtime_env: {env_vars: {HF_TOKEN: hf_SECRET\n";
    const svcView = await openDetails(svc);
    expect(view().getByText("Not shown: the serve configuration could not be read safely. See the YAML section.")).toBeInTheDocument();
    expect(svcView.querySelector("[data-section='kuberay']")!.textContent).not.toContain("hf_SECRET");
  });

  it("of a RayService: the failed application of the pending cluster and the serve config", async () => {
    const container = await openDetails(byName("RayService", "rayservice-sample"));
    const v = view();
    expect(v.getAllByText(/No module named 'fruit'/).length).toBeGreaterThan(0);
    expect(v.getByRole("button", { name: "Open RayCluster rayservice-sample-raycluster-bk8jd" })).toBeInTheDocument();
    expect(v.getByText("DEPLOY_FAILED")).toHaveClass("rt-status--danger");
    expect(v.getByText("3 of 3 healthy")).toBeInTheDocument();
    expect(v.getByText(/import_path: fruit.deployment_graph/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
