import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../actions";
import { getAction, getActionsFor, runAction, type ActionId } from "../actions/registry";
import { fnv32a } from "../argo-workflows/model";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES, resolve, type Problem } from "../problems/model";
import { CATEGORY_SOURCES, MAX_SOURCE_OBJECTS } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import { BUILD_ACROSS, buildRow, latestFailuresOnly } from "./across";
import objectsJson from "./fixtures/objects.json";
import "./index";
import {
  BUILD,
  BUILD_CONFIG,
  buildDurationMs,
  buildPodName,
  buildSource,
  buildsOf,
  dcState,
  DEPLOYMENT_CONFIG,
  FAILED_BUILD_MS,
  IMAGE_STREAM,
  IMPORT_GRACE_MS,
  labelValue,
  openshiftProblems,
  PROJECT,
  rolloutBlock,
  rolloutsOf,
  ROUTE,
  ROUTE_GRACE_MS,
  routeBackends,
  routeState,
  routeTargetPort,
  routeTls,
  routeUrl,
  streamTags,
} from "./model";
import { rolloutLatestRequest, sortedJson, startBuildRequest } from "./requests";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const all = (kind: string): KubeObject[] => objects.filter((o) => o.kind === kind).map(copy);
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const refTo = (obj: KubeObject): ObjectRef => ({ kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" });
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const sp = (o: KubeObject) => o.spec as Record<string, unknown>;

describe("the model", () => {
  it("reads a Route's backends with their shares, its target port, TLS flags and where it answers", () => {
    const route = byName("Route", "frontend");
    expect(routeBackends(route).map((b) => [b.name, b.weight, b.percent])).toEqual([
      ["frontend", 100, 80],
      ["frontend-canary", 25, 20],
    ]);
    expect(routeTargetPort(route)).toBe("8080-tcp");
    expect(routeTargetPort(byName("Route", "api"))).toBe(8443);
    expect(routeTargetPort(byName("Route", "internal"))).toBeUndefined();
    expect(routeTls(route)).toEqual({
      termination: "edge",
      insecure: "Redirect",
      certificate: true,
      key: true,
      caCertificate: true,
      destinationCACertificate: false,
      externalCertificate: undefined,
    });
    expect(JSON.stringify(routeTls(route))).not.toMatch(/BEGIN|FIXTURE/);
    expect(routeUrl(route)).toBe("https://frontend-shop.apps.ocp.example.com/");
    expect(routeUrl(byName("Route", "internal"))).toBe("http://internal.shard2.example.com");
    const unweighted = copy(route);
    delete (sp(unweighted).to as Record<string, unknown>).weight;
    expect(routeBackends(unweighted)[0]!.weight).toBe(100);
    (sp(unweighted).to as Record<string, unknown>).weight = 0;
    (sp(unweighted).alternateBackends as Record<string, unknown>[])[0]!.weight = 0;
    expect(routeBackends(unweighted).map((b) => b.percent)).toEqual([0, 0]);
  });

  it.each([
    ["frontend", "admitted"],
    ["api", "rejected"],
    ["internal", "pending"],
  ])("Route %s is %s", (name, state) => {
    expect(routeState(byName("Route", name))).toBe(state);
  });

  it("reads a DeploymentConfig's rollout state from its conditions", () => {
    expect(dcState(byName("DeploymentConfig", "frontend"))).toBe("available");
    expect(dcState(byName("DeploymentConfig", "backend"))).toBe("failed");
    const dc = byName("DeploymentConfig", "frontend");
    const progressing = (st(dc).conditions as Record<string, unknown>[])[1]!;
    progressing.reason = "ReplicationControllerUpdated";
    expect(dcState(dc)).toBe("progressing");
    progressing.reason = "RolloutCancelled";
    progressing.status = "False";
    expect(dcState(dc)).toBe("cancelled");
    sp(dc).paused = true;
    expect(dcState(dc)).toBe("paused");
    const fresh = byName("DeploymentConfig", "frontend");
    delete st(fresh).conditions;
    st(fresh).latestVersion = 0;
    expect(dcState(fresh)).toBe("new");
  });

  it("lists a DeploymentConfig's rollouts from its ReplicationControllers and blocks Rollout latest as oc does", () => {
    const rcs = all("ReplicationController");
    const frontend = byName("DeploymentConfig", "frontend");
    expect(rolloutsOf(frontend, rcs).map((r) => [r.name, r.version, r.phase, r.deployerPod])).toEqual([
      ["frontend-2", 2, "Complete", "frontend-2-deploy"],
      ["frontend-1", 1, "Complete", "frontend-1-deploy"],
    ]);
    expect(rolloutBlock(frontend, rcs)).toBeUndefined();
    expect(rolloutBlock(byName("DeploymentConfig", "backend"), rcs)).toBe("inProgress");
    sp(frontend).paused = true;
    expect(rolloutBlock(frontend, rcs)).toBe("paused");
    // Never rolled out: no ReplicationController of the latest version, nothing blocks.
    expect(rolloutBlock(byName("DeploymentConfig", "backend"), [])).toBeUndefined();
  });

  it("names the build pod by its annotation, else as the build controller does", () => {
    expect(buildPodName(byName("Build", "ruby-ex-3"))).toBe("ruby-ex-3-build");
    expect(buildPodName(byName("Build", "nodejs-ex-1"))).toBe("nodejs-ex-1-build");
    const long = byName("Build", "nodejs-ex-1");
    const name = `${"a".repeat(55)}-12`;
    long.metadata = { ...long.metadata, name, annotations: {} };
    const expected = `${name.slice(0, 48)}-${fnv32a(name).toString(16).padStart(8, "0")}-build`;
    expect(buildPodName(long)).toBe(expected);
    expect(expected).toHaveLength(63);
    expect(labelValue(`${"b".repeat(62)}-x`)).toBe("b".repeat(62));
  });

  it("reads a BuildConfig's source without the credentials or the query of its URI, and its builds newest first", () => {
    const bc = byName("BuildConfig", "ruby-ex");
    expect(buildSource(bc)).toEqual({ type: "Git", uri: "https://github.com/sclorg/ruby-ex.git", ref: "master", contextDir: "/", dockerfile: false, secret: "github-clone" });
    expect(buildsOf(bc, all("Build")).map((b) => b.metadata?.name)).toEqual(["ruby-ex-3", "ruby-ex-2"]);
    expect(buildDurationMs(byName("Build", "ruby-ex-3"))).toBe(120_000);
    expect(buildDurationMs(byName("Build", "nodejs-ex-1"))).toBe(177_000);
  });

  it("merges an ImageStream's spec and status tags and tells a failing import", () => {
    const tags = streamTags(byName("ImageStream", "legacy-db"));
    expect(tags.map((t) => [t.name, t.image, t.importError?.reason, t.history])).toEqual([
      ["10", undefined, "NotFound", 0],
      ["11", "sha256:bb22", undefined, 1],
    ]);
    expect(streamTags(byName("ImageStream", "frontend"))[0]).toMatchObject({ name: "latest", scheduled: true, history: 2, from: { kind: "DockerImage" } });
  });

  it("builds the requests oc sends, with the same text the core sends", () => {
    const dc = rolloutLatestRequest(byName("DeploymentConfig", "frontend"));
    expect(dc.path).toBe("/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/frontend/instantiate");
    // `crates/sextant-core/src/resources/openshift.rs`, `the_bodies_are_what_oc_sends`.
    expect(sortedJson(dc.body)).toBe('{"apiVersion":"apps.openshift.io/v1","force":true,"kind":"DeploymentRequest","latest":true,"name":"frontend"}');
    const bc = startBuildRequest(byName("BuildConfig", "ruby-ex"));
    expect(bc.path).toBe("/apis/build.openshift.io/v1/namespaces/shop/buildconfigs/ruby-ex/instantiate");
    expect(sortedJson({ ...bc.body, metadata: { name: "ruby" } })).toBe(
      '{"apiVersion":"build.openshift.io/v1","dockerStrategyOptions":{},"kind":"BuildRequest","metadata":{"name":"ruby"},"sourceStrategyOptions":{},"triggeredBy":[{"message":"Manually triggered"}]}',
    );
  });
});

describe("problems", () => {
  it("a Route no router admitted counts after a grace from its rejection or creation", () => {
    expect(detect(ROUTE, byName("Route", "frontend"))).toEqual([]);
    const [rejected] = detect(ROUTE, byName("Route", "api"));
    expect(rejected).toMatchObject({ reason: "HostAlreadyClaimed", since: "2026-10-21T08:00:01Z", graceMs: ROUTE_GRACE_MS, notify: true });
    expect(rejected!.message).toContain("already exposes");
    const [pending] = detect(ROUTE, byName("Route", "internal"));
    expect(pending).toMatchObject({ reason: "NotAdmitted", since: "2026-10-20T09:00:00Z" });
    const early = resolve(ROUTE, byName("Route", "api"), Date.parse("2026-10-21T08:01:00Z"));
    expect(early[0]!.activeAt).toBe(Date.parse("2026-10-21T08:00:01Z") + ROUTE_GRACE_MS);
  });

  it("a failed rollout, a failed build for a day and a failing import", () => {
    expect(detect(DEPLOYMENT_CONFIG, byName("DeploymentConfig", "frontend"))).toEqual([]);
    expect(detect(DEPLOYMENT_CONFIG, byName("DeploymentConfig", "backend"))[0]).toMatchObject({
      reason: "ProgressDeadlineExceeded",
      message: 'replication controller "backend-3" has failed progressing',
    });
    const [failed] = detect(BUILD, byName("Build", "ruby-ex-2"));
    expect(failed).toMatchObject({ reason: "FetchSourceFailed", since: "2026-10-21T10:00:35Z", until: Date.parse("2026-10-21T10:00:35Z") + FAILED_BUILD_MS });
    expect(detect(BUILD, byName("Build", "nodejs-ex-1"))[0]?.reason).toBe("PushImageToRegistryFailed");
    expect(detect(BUILD, byName("Build", "ruby-ex-3"))).toEqual([]);
    expect(openshiftProblems(BUILD, byName("Build", "ruby-ex-2"), Date.parse("2026-10-23T00:00:00Z"))).toEqual([]);
    const [imports] = detect(IMAGE_STREAM, byName("ImageStream", "legacy-db"));
    expect(imports).toMatchObject({ reason: "ImportFailed", since: "2026-10-21T07:00:00Z", graceMs: IMPORT_GRACE_MS });
    expect(imports!.message).toContain("not found");
    expect(detect(IMAGE_STREAM, byName("ImageStream", "frontend"))).toEqual([]);
    expect(detect(PROJECT, byName("Project", "shop"))).toEqual([]);
  });

  it("only the latest failed build of a BuildConfig stays a problem", () => {
    const builds = all("Build");
    const rows = new Map(builds.map((b) => [b.metadata!.uid!, buildRow(b)]));
    const problems = builds.flatMap((b) => resolve(BUILD, b, Date.parse("2026-10-21T13:00:00Z"))) as Problem[];
    expect(problems.map((p) => p.object.name)).toEqual(["ruby-ex-2", "nodejs-ex-1"]);
    expect(latestFailuresOnly(problems, rows).map((p) => p.object.name)).toEqual(["nodejs-ex-1"]);
    rows.delete("b-ruby-3");
    expect(latestFailuresOnly(problems, rows).map((p) => p.object.name)).toEqual(["ruby-ex-2", "nodejs-ex-1"]);
  });

  it("the category: on by default, every source capped, the Builds judged across their rows, the filter", () => {
    expect(PROBLEM_CATEGORIES).toContain("openshift");
    expect(OPT_IN_CATEGORIES).not.toContain("openshift");
    expect(categoryOf(ROUTE)).toBe("openshift");
    expect(categoryOf(BUILD_CONFIG)).toBeUndefined();
    expect(categoryOf(PROJECT)).toBeUndefined();
    expect(CATEGORY_SOURCES.openshift.map((s) => [s.kind.kind, s.maxObjects, s.across === BUILD_ACROSS])).toEqual([
      ["Route", MAX_SOURCE_OBJECTS, false],
      ["DeploymentConfig", MAX_SOURCE_OBJECTS, false],
      ["Build", MAX_SOURCE_OBJECTS, true],
      ["ImageStream", MAX_SOURCE_OBJECTS, false],
    ]);
    expect(getResourceDef(BUILD).problem?.(byName("Build", "ruby-ex-2"))).toBe(true);
    expect(getResourceDef(ROUTE).problem?.(byName("Route", "frontend"))).toBe(false);
    expect(getResourceDef(PROJECT).problem).toBeUndefined();
    expect(getResourceDef(ROUTE).columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "host", "services", "tls", "age"]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const KINDS = [ROUTE, DEPLOYMENT_CONFIG, BUILD_CONFIG, BUILD, IMAGE_STREAM, PROJECT];
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: kind.kind !== "Project",
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
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, ...KINDS];
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

describe("the OpenShift section", () => {
  it("is there for a cluster that serves the kinds and counts the objects that need attention", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("OpenShift"));
    emitSnapshot(wb, await watchOf(wb, "Route"), all("Route").filter((r) => r.metadata?.name !== "internal"));
    emitSnapshot(wb, await watchOf(wb, "DeploymentConfig"), all("DeploymentConfig"));
    emitSnapshot(wb, await watchOf(wb, "ImageStream"), all("ImageStream"));
    // A Build that failed just now (a day after it ended it no longer counts).
    const failed = byName("Build", "nodejs-ex-1");
    st(failed).completionTimestamp = new Date(Date.now() - 60_000).toISOString();
    emitSnapshot(wb, await watchOf(wb, "Build"), [failed, byName("Build", "ruby-ex-3")]);
    // The rejected Route (its grace long over), the failed rollout, the failed Build, the failing import.
    await waitFor(() => expect(screen.getByTitle("4 objects need attention")).toHaveTextContent("4"));
  });

  it("is not there without the kinds", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("OpenShift");
  });
});

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='openshift']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='openshift']")!);

describe("details", () => {
  it("of a Route: admission, TLS fields only as set, the backends with their shares and pods", async () => {
    const container = await openDetails(byName("Route", "frontend"));
    emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.labelSelector === null && s.fieldSelector === null), all("Service"));
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === null && s.fieldSelector === null), all("Pod"));
    const v = view();
    await waitFor(() => expect(v.getByText("1 of 1 ready")).toBeInTheDocument());
    expect(v.getByText("https://frontend-shop.apps.ocp.example.com/")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open Service frontend-canary" })).toBeInTheDocument();
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("frontend10080%1 of 1 ready");
    expect(rows).toContain("frontend-canary2520%0 of 0 ready");
    expect(v.getByText("The Route holds its private key inline; this view shows only that it is set.")).toBeInTheDocument();
    expect(document.querySelector("[data-section='openshift']")!.textContent).not.toMatch(/BEGIN|FIXTURE/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a rejected Route: the router's words", async () => {
    const container = await openDetails(byName("Route", "api"));
    expect(view().getAllByText(/already exposes api.apps.ocp.example.com/).length).toBeGreaterThan(0);
    expect(view().getAllByText("Rejected")[0]).toHaveClass("rt-status--danger");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a DeploymentConfig: its triggers and rollouts", async () => {
    const container = await openDetails(byName("DeploymentConfig", "frontend"));
    emitSnapshot(wb, await watchOf(wb, "ReplicationController", (s) => s.labelSelector === "openshift.io/deployment-config.name=frontend"), all("ReplicationController"));
    const v = view();
    await waitFor(() => expect(v.getByRole("button", { name: "Open ReplicationController frontend-2" })).toBeInTheDocument());
    expect(v.queryByRole("button", { name: "Open ReplicationController backend-3" })).toBeNull();
    expect(v.getByRole("button", { name: "Open ImageStream frontend" })).toBeInTheDocument();
    // The replicas, and the pods of the current ReplicationController.
    expect(v.getAllByText("1 of 1 ready")).toHaveLength(2);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a BuildConfig: the source without credentials, no webhook secret, its builds", async () => {
    const container = await openDetails(byName("BuildConfig", "ruby-ex"));
    emitSnapshot(wb, await watchOf(wb, "Build", (s) => s.labelSelector === "openshift.io/build-config.name=ruby-ex"), all("Build"));
    const v = view();
    await waitFor(() => expect(v.getByRole("button", { name: "Open Build ruby-ex-3" })).toBeInTheDocument());
    expect(v.getByText("https://github.com/sclorg/ruby-ex.git")).toBeInTheDocument();
    expect(v.queryByRole("button", { name: "Open Build nodejs-ex-1" })).toBeNull();
    const text = document.querySelector("[data-section='openshift']")!.textContent;
    expect(text).not.toMatch(/ghp_FIXTURETOKEN|webhooksecret123|envsecret|ref=x/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a Build: why it failed, and the build pod's logs", async () => {
    const container = await openDetails(byName("Build", "ruby-ex-2"));
    expect(view().getAllByText("Failed to fetch the input source.").length).toBeGreaterThan(0);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.fieldSelector === "metadata.name=ruby-ex-2-build"), []);
    await waitFor(() => expect(view().getByText("The build pod no longer exists: its logs are gone.")).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
    document.body.innerHTML = "";
    await openDetails(byName("Build", "ruby-ex-3"));
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.fieldSelector === "metadata.name=ruby-ex-3-build"), [byName("Pod", "ruby-ex-3-build")]);
    await waitFor(() => expect(view().getByRole("button", { name: "Build logs" })).toBeInTheDocument());
    view().getByRole("button", { name: "Build logs" }).click();
    expect(useAppStore.getState().dock.tabs.some((tab) => tab.type === "logs" && tab.title === "ruby-ex-3-build")).toBe(true);
  });

  it("of an ImageStream and a Project", async () => {
    const container = await openDetails(byName("ImageStream", "legacy-db"));
    expect(view().getByText("The import of 1 tag fails.")).toBeInTheDocument();
    expect(view().getByText(/registry.example.com\/db\/legacy:10\\?" not found/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    document.body.innerHTML = "";
    const project = await openDetails(byName("Project", "shop"));
    expect(view().getByText("Web shop")).toBeInTheDocument();
    expect(view().getByRole("button", { name: "Open Namespace shop" })).toBeInTheDocument();
    expect(await axeViolations(project)).toEqual([]);
  });
});

// ---------- Actions ----------

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

async function run(id: ActionId, obj: KubeObject) {
  await act(async () => {
    await runAction(getAction(id)!, "c1", kindOf(obj), [obj]);
  });
}

describe("the actions", () => {
  beforeEach(() => {
    wb.backend.on("openshift_rollout_latest", () => ({ kind: { group: "", version: "v1", kind: "ReplicationController" }, namespace: "shop", name: "frontend-3" }));
    wb.backend.on("openshift_start_build", () => ({ kind: { group: "build.openshift.io", version: "v1", kind: "Build" }, namespace: "shop", name: "ruby-ex-4" }));
    render(<ActionDialogHost />);
  });

  afterEach(() => {
    // Each test leaves its dialog closed for the next.
    for (const dialog of screen.queryAllByRole("dialog")) fireEvent.click(within(dialog).getAllByRole("button", { name: /^(Cancel|Close)$/ })[0]!);
  });

  it("are offered on their kinds only", () => {
    const ids: ActionId[] = ["openshiftRolloutLatest", "openshiftStartBuild"];
    expect(getActionsFor([byName("DeploymentConfig", "frontend")], DEPLOYMENT_CONFIG, ids).map((a) => a.id)).toEqual(["openshiftRolloutLatest"]);
    expect(getActionsFor([byName("BuildConfig", "ruby-ex")], BUILD_CONFIG, ids).map((a) => a.id)).toEqual(["openshiftStartBuild"]);
    expect(getResourceDef(DEPLOYMENT_CONFIG).actions).toEqual(["edit", "delete", "openshiftRolloutLatest"]);
    expect(getResourceDef(ROUTE).actions).toContain("diagnose");
  });

  it("Rollout latest shows the request, checks the latest rollout ended, then sends once", async () => {
    const dc = byName("DeploymentConfig", "frontend");
    await run("openshiftRolloutLatest", dc);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/POST \/apis\/apps.openshift.io\/v1\/namespaces\/shop\/deploymentconfigs\/frontend\/instantiate/)).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "ReplicationController", (s) => s.fieldSelector === "metadata.name=frontend-2"), [byName("ReplicationController", "frontend-2")]);
    const confirm = within(dialog).getByRole("button", { name: "Roll out" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).getByText("The rollout started: ReplicationController frontend-3.")).toBeInTheDocument());
    expect(calls("openshift_rollout_latest")).toEqual([{ clusterId: "c1", ref: refTo(dc) }]);
  });

  it("Rollout latest waits while the latest rollout runs", async () => {
    await run("openshiftRolloutLatest", byName("DeploymentConfig", "backend"));
    const dialog = await screen.findByRole("dialog");
    emitSnapshot(wb, await watchOf(wb, "ReplicationController", (s) => s.fieldSelector === "metadata.name=backend-3"), [byName("ReplicationController", "backend-3")]);
    await waitFor(() => expect(within(dialog).getByText("Rollout backend-3 is still in progress: wait until it ends.")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Roll out" })).toBeDisabled();
    expect(calls("openshift_rollout_latest")).toEqual([]);
  });

  it("Start build shows the request and sends once", async () => {
    const bc = byName("BuildConfig", "ruby-ex");
    await run("openshiftStartBuild", bc);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/"message": "Manually triggered"/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start build" }));
    await waitFor(() => expect(within(dialog).getByText("Build ruby-ex-4 started.")).toBeInTheDocument());
    expect(calls("openshift_start_build")).toEqual([{ clusterId: "c1", ref: refTo(bc) }]);
  });
});
