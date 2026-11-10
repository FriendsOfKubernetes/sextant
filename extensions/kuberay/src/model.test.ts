// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view (ADR-0115), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import { HIDDEN, looksSecret, maskedEntrypoint, maskedServeConfig } from "./mask";
import {
  activeOf,
  CLUSTER_TONE,
  clusterReason,
  clusterState,
  deploymentStatusOf,
  FAILED_JOB_MS,
  failedAppOf,
  headOf,
  isKind,
  isProblem,
  JOB_TONE,
  jobMessageOf,
  jobState,
  jobStatusOf,
  RAY_CLUSTER,
  RAY_GRACE_MS,
  RAY_JOB,
  RAY_SERVICE,
  rayProblems,
  serveServiceOf,
  SERVICE_GRACE_MS,
  SERVICE_TONE,
  serviceReason,
  serviceState,
  str,
  get,
  submitterJobOf,
  workersOf,
  type KindOf,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const at = (iso: string) => Date.parse(iso);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map(copy);
type Cond = Record<string, unknown>;
const conds = (o: KubeObject) => st(o).conditions as Cond[];
/** Sets a condition as KubeRay writes it: a metav1.Condition always carries `message` (no omitempty), "" when empty. */
const setCond = (o: KubeObject, c: Cond) => {
  const list = (st(o).conditions as Cond[] | undefined) ?? [];
  st(o).conditions = [...list.filter((x) => x.type !== c.type), { message: "", ...c }];
};

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
  /** `notifyAgainOn`'s values: a new one notifies again. */
  notifyTag?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  filter?: { value(obj: KubeObject, ctx: { now: number }): unknown };
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** The problems the manifest's rules find in `obj`, as the window finds them. */
const windowProblems = (kind: KindOf, obj: KubeObject): Detected[] =>
  manifest.contributes.problems.filter((r) => sameKind(r.kind, kind)).flatMap((rule) => engine.detectRule(rule, obj));

/** The built-in notification groups (a problem without one was grouped by its reason), as the rules' groups. */
const BUILT_IN_GROUPS: Record<string, string> = { failed: "failed", headNotReady: "head-not-ready", notReady: "not-ready" };

function expectSameProblems(kind: KindOf, obj: KubeObject): void {
  const expected = rayProblems(kind, obj).map((d) => ({
    reason: d.reason,
    message: d.message ?? "",
    since: d.since,
    graceMs: d.graceMs,
    until: d.until,
    group: d.group ? BUILT_IN_GROUPS[d.group] : "job-failed",
  }));
  const found = windowProblems(kind, obj).map((d) => ({ reason: d.reason, message: d.message, since: d.since, graceMs: d.graceMs, until: d.until, group: d.group }));
  expect(found, `${kind.kind} ${obj.metadata.name}`).toEqual(expected);
}

// ---------- Variants of the fixtures ----------

function clusters(): KubeObject[] {
  const ok = find("RayCluster", "raycluster-kuberay");
  const headDown = copy(ok);
  setCond(headDown, { type: "HeadPodReady", status: "False", reason: "HeadPodNotFound", message: "Head Pod not found", lastTransitionTime: "2026-10-20T12:00:00Z" });
  const headDownUnnamed = copy(headDown);
  delete conds(headDownUnnamed).find((c) => c.type === "HeadPodReady")!.reason;
  const coming = copy(ok);
  st(coming).conditions = [{ type: "RayClusterProvisioned", status: "False", reason: "RayClusterPodsProvisioning", message: "provisioning" }];
  const comingHeadDown = copy(coming);
  setCond(comingHeadDown, { type: "HeadPodReady", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [ray-head]", lastTransitionTime: "2026-10-20T12:00:00Z" });
  const old = copy(ok);
  delete st(old).conditions;
  const oldSuspended = copy(old);
  st(oldSuspended).state = "suspended";
  const oldProvisioning = copy(old);
  delete st(oldProvisioning).state;
  const suspending = copy(headDown);
  setCond(suspending, { type: "RayClusterSuspending", status: "True" });
  const suspended = copy(headDown);
  setCond(suspended, { type: "RayClusterSuspended", status: "True" });
  const gpu = find("RayCluster", "raycluster-gpu");
  const gpuUnnamed = copy(gpu);
  conds(gpuUnnamed).find((c) => c.type === "ReplicaFailure")!.reason = "";
  const gpuDeleting = copy(gpu);
  gpuDeleting.metadata.deletionTimestamp = "2026-10-20T12:00:00Z";
  const gpuHeadDown = copy(gpu);
  setCond(gpuHeadDown, { type: "HeadPodReady", status: "False", reason: "HeadPodNotFound", message: "gone" });
  const bare = copy(ok);
  delete (bare as { status?: unknown }).status;
  // Conditions without words of their own: the reason, else the next condition's, else `status.reason`.
  const replicaFailure = (o: KubeObject) => conds(o).find((c) => c.type === "ReplicaFailure")!;
  const gpuNoMessage = copy(gpu);
  replicaFailure(gpuNoMessage).message = "";
  const gpuNoWords = copy(gpuNoMessage);
  replicaFailure(gpuNoWords).reason = "";
  const gpuNoWordsHeadDown = copy(gpuNoWords);
  setCond(gpuNoWordsHeadDown, { type: "HeadPodReady", status: "False", reason: "HeadPodNotFound" });
  const gpuNoWordsHeadMessage = copy(gpuNoWordsHeadDown);
  setCond(gpuNoWordsHeadMessage, { type: "HeadPodReady", status: "False", reason: "HeadPodNotFound", message: "Head Pod not found" });
  const gpuNoWordsAtAll = copy(gpuNoWords);
  st(gpuNoWordsAtAll).reason = "quota exceeded";
  const headDownNoMessage = copy(headDown);
  conds(headDownNoMessage).find((c) => c.type === "HeadPodReady")!.message = "";
  const suspendingQuiet = copy(ok);
  setCond(suspendingQuiet, { type: "RayClusterSuspending", status: "True" });
  st(suspendingQuiet).reason = "suspending now";
  const legacy = find("RayCluster", "raycluster-legacy");
  const legacyHeadDown = copy(legacy);
  setCond(legacyHeadDown, { type: "HeadPodReady", status: "False", reason: "HeadPodNotFound" });
  // Workers of operators before `desiredWorkerReplicas`: the replicas of the groups not suspended.
  const groups = (o: KubeObject) => (o.spec as { workerGroupSpecs: Record<string, unknown>[] }).workerGroupSpecs;
  const noDesired = copy(old);
  delete st(noDesired).desiredWorkerReplicas;
  groups(noDesired).push({ groupName: "big", replicas: 3, minReplicas: 0, maxReplicas: 4 }, { groupName: "off", replicas: 7, suspend: true, numOfHosts: 1 });
  const noDesiredNoReady = copy(noDesired);
  delete st(noDesiredNoReady).readyWorkerReplicas;
  const noDesiredAllSuspended = copy(noDesired);
  for (const g of groups(noDesiredAllSuspended)) g.suspend = true;
  return [
    ...ofKind("RayCluster"),
    headDown,
    headDownUnnamed,
    coming,
    comingHeadDown,
    old,
    oldSuspended,
    oldProvisioning,
    suspending,
    suspended,
    gpuUnnamed,
    gpuDeleting,
    gpuHeadDown,
    bare,
    gpuNoMessage,
    gpuNoWords,
    gpuNoWordsHeadDown,
    gpuNoWordsHeadMessage,
    gpuNoWordsAtAll,
    headDownNoMessage,
    suspendingQuiet,
    legacyHeadDown,
    noDesired,
    noDesiredNoReady,
    noDesiredAllSuspended,
  ];
}

function jobs(): KubeObject[] {
  const failed = find("RayJob", "rayjob-sample");
  const retrying = copy(failed);
  st(retrying).jobDeploymentStatus = "Retrying";
  const oldFailed = copy(failed);
  st(oldFailed).jobDeploymentStatus = "Complete";
  const invalid = copy(failed);
  st(invalid).jobDeploymentStatus = "ValidationFailed";
  delete st(invalid).reason;
  delete st(invalid).jobStatus;
  delete st(invalid).endTime;
  delete st(invalid).startTime;
  const unnamed = copy(failed);
  st(unnamed).reason = "";
  const startedOnly = copy(failed);
  delete st(startedOnly).endTime;
  const suspended = copy(failed);
  st(suspended).jobDeploymentStatus = "Suspended";
  st(suspended).jobStatus = "";
  const running = copy(failed);
  st(running).jobDeploymentStatus = "Running";
  st(running).jobStatus = "RUNNING";
  delete st(running).reason;
  const stopped = copy(running);
  st(stopped).jobStatus = "STOPPED";
  const pending = copy(running);
  delete st(pending).jobStatus;
  st(pending).jobDeploymentStatus = "Initializing";
  const deleting = copy(failed);
  deleting.metadata.deletionTimestamp = "2026-10-21T09:00:00Z";
  const recent = copy(failed);
  st(recent).endTime = "2026-10-23T09:00:00Z";
  return [...ofKind("RayJob"), retrying, oldFailed, invalid, unnamed, startedOnly, suspended, running, stopped, pending, deleting, recent];
}

type Apps = Record<string, { status: string; message?: string }>;
/** A RayService whose Serve applications all run and whose `Ready` is False. */
function notReady0(ready: KubeObject): KubeObject {
  const o = copy(ready);
  setCond(o, { type: "Ready", status: "False", reason: "ZeroServeEndpoints", message: "no endpoints", lastTransitionTime: "2026-10-22T10:00:00Z" });
  return o;
}
function services(): KubeObject[] {
  const sample = find("RayService", "rayservice-sample");
  const ready = find("RayService", "rayservice-ready");
  const apps = (o: KubeObject, which: "activeServiceStatus" | "pendingServiceStatus") => {
    const s = (st(o)[which] ??= {}) as { applicationStatuses?: Apps };
    return (s.applicationStatuses ??= {});
  };
  const upgrading = copy(ready);
  st(upgrading).pendingServiceStatus = { rayClusterName: "next", applicationStatuses: { fruit_app: { status: "DEPLOY_FAILED" } } };
  st(upgrading).conditions = [
    { type: "Ready", status: "True" },
    { type: "UpgradeInProgress", status: "True", reason: "BothActivePendingClustersExist" },
  ];
  const upgradingDown = copy(upgrading);
  setCond(upgradingDown, { type: "Ready", status: "False", reason: "ZeroServeEndpoints", message: "no endpoints" });
  const rolling = copy(ready);
  setCond(rolling, { type: "RollbackInProgress", status: "True", reason: "GoalClusterChanged" });
  const old = copy(ready);
  delete st(old).conditions;
  const oldDown = copy(old);
  st(oldDown).serviceStatus = "";
  const oldGone = copy(old);
  delete st(oldGone).serviceStatus;
  const unhealthyWhileReady = copy(ready);
  apps(unhealthyWhileReady, "activeServiceStatus").math_app = { status: "UNHEALTHY", message: "replica health check failed" };
  const failedWhileReady = copy(ready);
  apps(failedWhileReady, "activeServiceStatus").fruit_app = { status: "DEPLOY_FAILED", message: "boom" };
  const failedDown = copy(failedWhileReady);
  setCond(failedDown, { type: "Ready", status: "False", reason: "ZeroServeEndpoints", message: "no endpoints", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const failedUnknown = copy(failedWhileReady);
  setCond(failedUnknown, { type: "Ready", status: "Unknown", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const unhealthyDown = notReady0(unhealthyWhileReady);
  const unhealthyUnnamed = copy(unhealthyDown);
  conds(unhealthyUnnamed).find((c) => c.type === "Ready")!.reason = "";
  const failedUnnamed = copy(failedDown);
  delete conds(failedUnnamed).find((c) => c.type === "Ready")!.reason;
  const pendingUnhealthy = copy(sample);
  apps(pendingUnhealthy, "pendingServiceStatus").fruit_app = { status: "UNHEALTHY", message: "unhealthy" };
  const pendingUnhealthyUnnamed = copy(pendingUnhealthy);
  delete st(pendingUnhealthyUnnamed).conditions;
  // Without an active cluster but Ready (KubeRay never says so; the rules still read it as the built-in model did).
  const pendingWhileReady = copy(sample);
  setCond(pendingWhileReady, { type: "Ready", status: "True" });
  const pendingUnhealthyWhileReady = copy(pendingUnhealthy);
  setCond(pendingUnhealthyWhileReady, { type: "Ready", status: "True" });
  const pendingUnnamed = copy(sample);
  conds(pendingUnnamed).find((c) => c.type === "Ready")!.reason = "";
  const pendingNoReady = copy(sample);
  st(pendingNoReady).conditions = [];
  const invalid = copy(ready);
  setCond(invalid, { type: "Ready", status: "False", reason: "ValidationFailed", message: "spec.serveConfigV2 is invalid", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const timedOut = copy(notReady0(ready));
  setCond(timedOut, { type: "Ready", status: "False", reason: "InitializingTimeout", message: "timed out", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const notReady = copy(ready);
  setCond(notReady, { type: "Ready", status: "False", reason: "ZeroServeEndpoints", message: "no endpoints", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const notReadyUnnamed = copy(notReady);
  delete conds(notReadyUnnamed).find((c) => c.type === "Ready")!.reason;
  const unknown = copy(ready);
  setCond(unknown, { type: "Ready", status: "Unknown", reason: "Reconciling", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const suspended = copy(notReady);
  setCond(suspended, { type: "Suspended", status: "True" });
  const suspending = copy(failedDown);
  setCond(suspending, { type: "Suspending", status: "True" });
  const deleting = copy(notReady);
  deleting.metadata.deletionTimestamp = "2026-10-22T11:00:00Z";
  // The first failed application by name gives the message, whether it failed to deploy or is unhealthy.
  const bothFailed = copy(failedDown);
  apps(bothFailed, "activeServiceStatus").a_app = { status: "UNHEALTHY", message: "a is down" };
  const bothFailedLater = copy(failedDown);
  apps(bothFailedLater, "activeServiceStatus").z_app = { status: "UNHEALTHY", message: "z is down" };
  const bothFailedWhileReady = copy(failedWhileReady);
  apps(bothFailedWhileReady, "activeServiceStatus").a_app = { status: "UNHEALTHY", message: "a is down" };
  // Invalid with a failed application: the application's message.
  const invalidWithApp = copy(sample);
  setCond(invalidWithApp, { type: "Ready", status: "False", reason: "InitializingTimeout", message: "timed out", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const invalidWithActiveApp = copy(failedDown);
  setCond(invalidWithActiveApp, { type: "Ready", status: "False", reason: "ValidationFailed", message: "invalid", lastTransitionTime: "2026-10-22T10:00:00Z" });
  const invalidWithQuietApp = copy(invalidWithApp);
  delete apps(invalidWithQuietApp, "pendingServiceStatus").fruit_app!.message;
  const invalidQuiet = copy(invalid);
  conds(invalidQuiet).find((c) => c.type === "Ready")!.message = "";
  // A failed application without a message: the False Ready's message, else its reason.
  const failedQuiet = copy(failedDown);
  delete apps(failedQuiet, "activeServiceStatus").fruit_app!.message;
  const failedQuietNoMessage = copy(failedQuiet);
  conds(failedQuietNoMessage).find((c) => c.type === "Ready")!.message = "";
  const failedQuietWhileReady = copy(failedWhileReady);
  delete apps(failedQuietWhileReady, "activeServiceStatus").fruit_app!.message;
  const pendingQuiet = copy(sample);
  delete apps(pendingQuiet, "pendingServiceStatus").fruit_app!.message;
  const pendingQuietNoMessage = copy(pendingQuiet);
  conds(pendingQuietNoMessage).find((c) => c.type === "Ready")!.message = "";
  const notReadyNoMessage = copy(notReady);
  conds(notReadyNoMessage).find((c) => c.type === "Ready")!.message = "";
  const suspendedWithApp = copy(sample);
  setCond(suspendedWithApp, { type: "Suspended", status: "True" });
  const upgradingQuiet = copy(upgradingDown);
  conds(upgradingQuiet).find((c) => c.type === "Ready")!.message = "";
  return [
    ...ofKind("RayService"),
    bothFailed,
    bothFailedLater,
    bothFailedWhileReady,
    invalidWithApp,
    invalidWithActiveApp,
    invalidWithQuietApp,
    invalidQuiet,
    failedQuiet,
    failedQuietNoMessage,
    failedQuietWhileReady,
    pendingQuiet,
    pendingQuietNoMessage,
    notReadyNoMessage,
    suspendedWithApp,
    upgradingQuiet,
    upgrading,
    upgradingDown,
    rolling,
    old,
    oldDown,
    oldGone,
    unhealthyWhileReady,
    unhealthyDown,
    unhealthyUnnamed,
    failedUnnamed,
    pendingUnhealthyUnnamed,
    pendingWhileReady,
    pendingUnhealthyWhileReady,
    failedWhileReady,
    failedDown,
    failedUnknown,
    pendingUnhealthy,
    pendingUnnamed,
    pendingNoReady,
    invalid,
    timedOut,
    notReady,
    notReadyUnnamed,
    unknown,
    suspended,
    suspending,
    deleting,
  ];
}

// ---------- The model ----------

describe("the model", () => {
  it("reads a RayCluster's state from its conditions, else from the deprecated state", () => {
    const ok = find("RayCluster", "raycluster-kuberay");
    expect(clusterState(ok)).toBe("ready");
    expect(workersOf(ok)).toMatchObject({ ready: 1, desired: 1, min: 1, max: 5 });
    expect(clusterState(find("RayCluster", "raycluster-gpu"))).toBe("failed");
    expect(clusterState(find("RayCluster", "raycluster-legacy"))).toBe("failed");
    const states = clusters().map((o) => clusterState(o));
    expect(new Set(states)).toEqual(new Set(["ready", "failed", "headNotReady", "provisioning", "suspended", "suspending"]));
  });

  it("reads a RayJob's state; Retrying comes before a failure and the submitter Job only in K8sJobMode", () => {
    const failed = find("RayJob", "rayjob-sample");
    expect(jobState(failed)).toBe("failed");
    expect(submitterJobOf(failed)).toBe("rayjob-sample");
    expect(submitterJobOf(find("RayJob", "rayjob-done"))).toBeUndefined();
    expect(jobState(find("RayJob", "rayjob-done"))).toBe("succeeded");
    expect(new Set(jobs().map(jobState))).toEqual(new Set(["failed", "succeeded", "retrying", "suspended", "running", "stopped", "pending"]));
  });

  it("reads a RayService's state; a failing pending application counts only while there is no active cluster", () => {
    const starting = find("RayService", "rayservice-sample");
    expect(serviceState(starting)).toBe("failed");
    expect(failedAppOf(starting)?.name).toBe("fruit_app");
    expect(serveServiceOf(find("RayService", "rayservice-ready"))).toBe("rayservice-ready-serve-svc");
    expect(new Set(services().map(serviceState))).toEqual(new Set(["ready", "failed", "upgrading", "notReady", "suspended"]));
  });

  it("messages lose the credentials and queries of the URIs in them", () => {
    const job = find("RayJob", "rayjob-sample");
    st(job).message = "failed to fetch working_dir https://ci:ghp_s3cr3t@github.com/org/repo.zip?token=abc";
    expect(jobMessageOf(job)).toBe("failed to fetch working_dir https://github.com/org/repo.zip");
    expect(windowProblems(RAY_JOB, job)[0]?.message).toBe("failed to fetch working_dir https://github.com/org/repo.zip");
    const svc = find("RayService", "rayservice-sample");
    const apps = (st(svc).pendingServiceStatus as { applicationStatuses: Apps }).applicationStatuses;
    apps.fruit_app!.message = "pip install git+https://oauth2:glpat-xyz@gitlab.com/org/pkg.git failed";
    expect(windowProblems(RAY_SERVICE, svc)[0]?.message).toBe("pip install git+https://gitlab.com/org/pkg.git failed");
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
});

// ---------- The problem rules ----------

describe("the problem rules, against the built-in detector", () => {
  it("find a RayCluster's problems as the built-in one: a failure, the head not ready, never while suspended", () => {
    for (const o of clusters()) expectSameProblems(RAY_CLUSTER, o);
    const [gpu] = windowProblems(RAY_CLUSTER, find("RayCluster", "raycluster-gpu"));
    expect(gpu).toMatchObject({ reason: "FailedCreateWorkerPod", graceMs: RAY_GRACE_MS, since: "2026-10-20T11:00:41Z" });
    const [legacy] = windowProblems(RAY_CLUSTER, find("RayCluster", "raycluster-legacy"));
    expect(legacy).toMatchObject({ reason: "RayClusterFailed", graceMs: undefined });
    expect(legacy?.message).toContain("image registry is not allowed");
  });

  it("find a failed RayJob for a day after it ended, by its end, else its start, else its creation", () => {
    for (const o of jobs()) expectSameProblems(RAY_JOB, o);
    const [d] = windowProblems(RAY_JOB, find("RayJob", "rayjob-sample"));
    expect(d).toMatchObject({ reason: "AppFailed", since: "2026-10-21T08:02:40Z", until: at("2026-10-21T08:02:40Z") + FAILED_JOB_MS });
    const invalid = jobs().find((o) => st(o).jobDeploymentStatus === "ValidationFailed")!;
    expect(windowProblems(RAY_JOB, invalid)[0]).toMatchObject({ reason: "ValidationFailed", until: at("2026-10-21T08:00:00Z") + FAILED_JOB_MS });
    expect(windowProblems(RAY_JOB, invalid)[0]?.since).toBe("2026-10-21T08:00:00Z");
    const started = find("RayJob", "rayjob-sample");
    delete st(started).endTime;
    expect(windowProblems(RAY_JOB, started)[0]).toMatchObject({ since: "2026-10-21T08:00:05Z", until: at("2026-10-21T08:00:05Z") + FAILED_JOB_MS });
  });

  it("notify again about a RayJob when its reason changes, as the built-in ones (notified once per reason)", () => {
    // The built-in notification was per object and reason (a problem without a group): one per reason here too.
    const identity = (o: KubeObject) => windowProblems(RAY_JOB, o).map((d) => `${d.group}|${d.notifyTag ?? ""}`)[0];
    const builtIn = (o: KubeObject) => rayProblems(RAY_JOB, o)[0]?.reason;
    const failed = jobs().filter((o) => windowProblems(RAY_JOB, o).length > 0);
    for (const a of failed) for (const b of failed) expect(identity(a) === identity(b), `${builtIn(a)} ${builtIn(b)}`).toBe(builtIn(a) === builtIn(b));
    const other = find("RayJob", "rayjob-sample");
    st(other).reason = "DeadlineExceeded";
    expect(identity(other)).not.toBe(identity(find("RayJob", "rayjob-sample")));
  });

  it("find a RayService not ready or with a failed Serve application, with the built-in reasons, graces and times", () => {
    for (const o of services()) expectSameProblems(RAY_SERVICE, o);
    const [d] = windowProblems(RAY_SERVICE, find("RayService", "rayservice-sample"));
    expect(d).toMatchObject({ reason: "Initializing", graceMs: SERVICE_GRACE_MS });
    expect(d?.message).toContain("No module named 'fruit'");
  });

  it("tell the first failed application by name, and an invalid RayService's failed application", () => {
    const both = services().find((o) => (st(o).activeServiceStatus as { applicationStatuses?: Apps }).applicationStatuses?.a_app)!;
    expect(windowProblems(RAY_SERVICE, both)[0]?.message).toBe("a is down");
    const invalid = find("RayService", "rayservice-sample");
    setCond(invalid, { type: "Ready", status: "False", reason: "InitializingTimeout", message: "timed out", lastTransitionTime: "2026-10-22T10:00:00Z" });
    expect(windowProblems(RAY_SERVICE, invalid).map((p) => [p.reason, p.graceMs])).toEqual([["InitializingTimeout", undefined]]);
    expect(windowProblems(RAY_SERVICE, invalid)[0]?.message).toContain("No module named 'fruit'");
  });

  it("give a condition's reason where its message is empty, as the built-in ones", () => {
    const gpu = find("RayCluster", "raycluster-gpu");
    conds(gpu).find((c) => c.type === "ReplicaFailure")!.message = "";
    expect(windowProblems(RAY_CLUSTER, gpu)[0]?.message).toBe("FailedCreateWorkerPod");
    const svc = find("RayService", "rayservice-ready");
    setCond(svc, { type: "Ready", status: "False", reason: "ZeroServeEndpoints", lastTransitionTime: "2026-10-22T10:00:00Z" });
    expect(windowProblems(RAY_SERVICE, svc)[0]?.message).toBe("ZeroServeEndpoints");
  });

  it("are each met by a variant", () => {
    const met = new Set<string>();
    const kinds: [KindOf, KubeObject[]][] = [
      [RAY_CLUSTER, clusters()],
      [RAY_JOB, jobs()],
      [RAY_SERVICE, services()],
    ];
    for (const [kind, list] of kinds)
      for (const o of list) for (const rule of manifest.contributes.problems) if (sameKind(rule.kind, kind) && engine.detectRule(rule, o).length > 0) met.add(rule.id);
    expect([...met].sort()).toEqual(manifest.contributes.problems.map((r) => r.id).sort());
  });

  it("notify, as every built-in one did, and count on the section", () => {
    for (const rule of manifest.contributes.problems) expect((rule as { notify?: boolean }).notify).toBeUndefined();
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "kuberay", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } }]);
  });
});

// ---------- "Only problems" ----------

const kindEntry = (kind: KindOf) => manifest.contributes.kinds.find((k) => sameKind(k, kind))!;

describe("the kinds' Only problems, against the built-in filter", () => {
  it("of RayClusters and RayJobs: every problem without a grace, a failed RayJob however long ago", () => {
    for (const [kind, list] of [
      [RAY_CLUSTER, clusters()],
      [RAY_JOB, jobs()],
    ] as const) {
      const when = (kindEntry(kind) as { problemWhen?: unknown }).problemWhen;
      for (const o of list) expect(engine.evaluate(when, o).holds, `${kind.kind} ${o.metadata.name}`).toBe(isProblem(o, kind));
    }
  });

  it("of RayServices: failed or not ready, at once", () => {
    const when = (kindEntry(RAY_SERVICE) as { problemWhen?: unknown }).problemWhen;
    for (const o of services()) expect(engine.evaluate(when, o).holds, o.metadata.name).toBe(isProblem(o, RAY_SERVICE));
    // And every RayService it shows has a problem of the rules (after their graces), and no other.
    for (const o of services()) expect(windowProblems(RAY_SERVICE, o).length > 0, o.metadata.name).toBe(isProblem(o, RAY_SERVICE));
  });

  it("list the kinds in the built-in section, without the CRDs' own columns", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "kuberay", title: "KubeRay", icon: "kuberay", after: "kueue" }]);
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.title, k.icon, k.order, k.printerColumns])).toEqual([
      ["RayCluster", "Ray Clusters", "rayCluster", 10, false],
      ["RayJob", "Ray Jobs", "rayJob", 20, false],
      ["RayService", "Ray Services", "rayService", 30, false],
    ]);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.kuberay:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-23T10:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  // An empty hover (`title=""`) shows nothing, as none.
  return { title: title || undefined, tone: node?.props?.tone };
}
const word = (key: string) => (en as Record<string, string>)[key];

describe("the columns, against the built-in ones", () => {
  it("are placed after the namespace, in the built-in order", () => {
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id]);
    expect(ids("RayCluster")).toEqual([
      ["namespace", "cluster-status"],
      ["cluster-status", "cluster-workers"],
      ["cluster-workers", "cluster-head-ip"],
      ["cluster-head-ip", "cluster-ray-version"],
    ]);
    expect(ids("RayJob")).toEqual([
      ["namespace", "job-status"],
      ["job-status", "job-job-status"],
      ["job-job-status", "job-deployment-status"],
      ["job-deployment-status", "job-cluster"],
      ["job-cluster", "job-started"],
    ]);
    expect(ids("RayService")).toEqual([
      ["namespace", "service-status"],
      ["service-status", "service-applications"],
      ["service-applications", "service-endpoints"],
      ["service-endpoints", "service-active-cluster"],
    ]);
  });

  it("have the built-in widths, and the states sort by the state, as the built-in ones", () => {
    const widths = Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, windowColumn(c.id).width]));
    expect(widths).toEqual({
      "cluster-status": "130px",
      "cluster-workers": "90px",
      "cluster-head-ip": "minmax(110px, 1fr)",
      "cluster-ray-version": "100px",
      "job-status": "110px",
      "job-job-status": "110px",
      "job-deployment-status": "130px",
      "job-cluster": "minmax(140px, 1.5fr)",
      "job-started": "100px",
      "service-status": "120px",
      "service-applications": "110px",
      "service-endpoints": "90px",
      "service-active-cluster": "minmax(160px, 1.5fr)",
    });
    // The built-in tables sorted and filtered these columns by the state's name, in every language.
    const byState = (id: string, list: KubeObject[], state: (o: KubeObject) => string) => {
      for (const o of list) {
        expect(windowColumn(id).value(o), o.metadata.name).toBe(state(o));
        expect(windowColumn(id).filter?.value(o, { now: NOW }), o.metadata.name).toBe(state(o));
      }
    };
    byState("cluster-status", clusters(), clusterState);
    byState("job-status", jobs(), jobState);
    byState("service-status", services(), serviceState);
  });

  it("of RayClusters: the state toned with the operator's reason, workers ready of desired, head IP and Ray version", () => {
    for (const o of clusters()) {
      const state = clusterState(o);
      expect(cell("cluster-status", o), o.metadata.name).toBe(word(`clusterState.${state}`));
      expect(drawn("cluster-status", o), o.metadata.name).toEqual({ title: clusterReason(o) || undefined, tone: CLUSTER_TONE[state] });
      const w = workersOf(o);
      expect(cell("cluster-workers", o), o.metadata.name).toBe(`${w.ready}/${w.desired}`);
      expect(windowColumn("cluster-workers").value(o)).toBe(`${w.ready}/${w.desired}`);
      expect(cell("cluster-head-ip", o)).toBe(headOf(o).podIP);
      expect(cell("cluster-ray-version", o)).toBe(str(get(o, "spec", "rayVersion")));
    }
  });

  it("of RayClusters before `desiredWorkerReplicas`: the replicas of the groups not suspended; words from the next condition", () => {
    const list = clusters();
    const named = (n: number) => list[list.length - n]!;
    expect([3, 2, 1].map((n) => cell("cluster-workers", named(n)))).toEqual(["1/4", "0/4", "1/0"]);
    expect(cell("cluster-workers", find("RayCluster", "raycluster-legacy"))).toBe("0/0");
    const quiet = list.find((o) => (st(o) as Record<string, unknown> | undefined)?.reason === "quota exceeded")!;
    expect(drawn("cluster-status", quiet)).toEqual({ title: "quota exceeded", tone: "danger" });
    expect(windowProblems(RAY_CLUSTER, quiet).map((p) => [p.reason, p.message])).toEqual([["ReplicaFailure", "quota exceeded"]]);
  });

  it("of RayJobs: the state toned with KubeRay's message, the two statuses, the RayCluster and the start", () => {
    for (const o of jobs()) {
      const state = jobState(o);
      expect(cell("job-status", o), o.metadata.name).toBe(word(`jobState.${state}`));
      expect(drawn("job-status", o)).toEqual({ title: jobMessageOf(o), tone: JOB_TONE[state] });
      expect(cell("job-job-status", o) || undefined).toBe(jobStatusOf(o));
      expect(cell("job-deployment-status", o)).toBe(deploymentStatusOf(o));
      expect(cell("job-cluster", o)).toBe(str(get(o, "status", "rayClusterName")));
    }
  });

  it("of RayServices: the state toned with why it is not ready, running applications, endpoints and the active cluster", () => {
    for (const o of services()) {
      const state = serviceState(o);
      expect(cell("service-status", o), o.metadata.name).toBe(word(`serviceState.${state}`));
      expect(drawn("service-status", o), o.metadata.name).toEqual({ title: serviceReason(o) || undefined, tone: SERVICE_TONE[state] });
      const apps = activeOf(o).apps;
      const running = apps.length === 0 ? undefined : `${apps.filter((a) => a.status === "RUNNING").length}/${apps.length}`;
      expect(cell("service-applications", o), o.metadata.name).toBe(running);
      expect(windowColumn("service-applications").value(o), o.metadata.name).toBe(running);
      expect(cell("service-endpoints", o)).toBe(st(o).numServeEndpoints === undefined ? undefined : String(st(o).numServeEndpoints));
      expect(cell("service-active-cluster", o)).toBe(activeOf(o).rayClusterName);
    }
  });
});

// ---------- Kinds ----------

describe("the kinds", () => {
  it("are the built-in ones", () => {
    expect(isKind(RAY_CLUSTER, { group: "ray.io", kind: "RayCluster" })).toBe(true);
    // One untitled section per kind, as the built-in one (it had no heading of its own).
    expect(manifest.contributes.detailsSections.map((d) => [d.id, d.kinds[0]!.kind, d.order, d.heading])).toEqual([
      ["ray-cluster", "RayCluster", 20, false],
      ["ray-job", "RayJob", 20, false],
      ["ray-service", "RayService", 20, false],
    ]);
  });
});
