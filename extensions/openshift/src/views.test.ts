// The details section and the two action windows, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { startAction } from "./actions";
import { MAX_BUILDS, MAX_RCS, startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const all = (kind: string): KubeObject[] => objects.filter((o) => o.kind === kind).map((o) => structuredClone(o));

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

/** The object as Sextant hands it to an extension: a Route's private key and a BuildConfig's webhook secrets blanked. */
function asHanded(o: KubeObject): KubeObject {
  const copy = structuredClone(o);
  const tls = (copy.spec as { tls?: { key?: string } } | undefined)?.tls;
  if (copy.kind === "Route" && tls?.key) {
    tls.key = "";
    copy.metadata.annotations = { ...copy.metadata.annotations, "sextant.dev/values-hidden": "spec.tls.key" };
  }
  if (copy.kind === "BuildConfig") {
    for (const t of ((copy.spec as { triggers?: Record<string, { secret?: string }>[] }).triggers ?? []))
      for (const hook of ["github", "generic", "gitlab", "bitbucket"]) if (t[hook]?.secret) t[hook]!.secret = "";
    copy.metadata.annotations = { ...copy.metadata.annotations, "sextant.dev/values-hidden": "spec.triggers[*].github.secret" };
  }
  return copy;
}

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};

async function open(obj: KubeObject, options: { view?: "details" | "action"; contribution?: string; blocks?: Record<string, boolean>; handlers?: Record<string, (params: never) => unknown> } = {}): Promise<void> {
  const { view = "details", contribution = "openshift", blocks = {}, handlers = {} } = options;
  remembered = { ...blocks };
  host = await startTestHost({
    context: { view, contribution, selection: [refOf(obj)], resourceVersion: "1", language: "en", blocks: remembered },
    handlers: {
      "resources.get": () => asHanded(obj),
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: open };
        host.setContext({ blocks: remembered });
      },
      ...handlers,
    },
  });
  setLanguage("en");
  root = document.createElement("main");
  document.body.append(root);
  stop = view === "details" ? startDetails(host.sextant, root, contribution) : startAction(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading") === null).toBe(true);
}

afterEach(() => {
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const button = (name: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === name);
type Params = { kind: { group: string; kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string; maxObjects?: number };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string, test: (p: Params) => boolean = () => true) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped && test(watchParams(w)));
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tr")].map((r) => r.textContent);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);

describe("details", () => {
  it("of a Route: admission, TLS fields only as set, the backends with their shares and pods", async () => {
    await open(find("Route", "frontend"));
    // The namespace's Services and pods, while the details are open.
    await expect.poll(() => watchOf("Service")).toBeDefined();
    expect(watchParams(watchOf("Service")!)).toMatchObject({ kind: { group: "", version: "v1", kind: "Service" }, namespaces: ["shop"] });
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ namespaces: ["shop"] });
    expect(watchParams(watchOf("Pod")!).labelSelector).toBeUndefined();
    watchOf("Service")!.emit(snapshot(all("Service")));
    watchOf("Pod")!.emit(snapshot(all("Pod")));
    await expect.poll(() => rows()).toContain("frontend10080%1 of 1 ready");
    expect(rows()).toContain("frontend-canary2520%0 of 0 ready");
    expect(text()).toContain("https://frontend-shop.apps.ocp.example.com/");
    expect(byLabel("Open Service frontend-canary")).toHaveLength(1);
    expect(text()).toContain("The Route holds its private key inline; this view shows only that it is set.");
    expect(text()).not.toMatch(/BEGIN|FIXTURE/);
    // No heading of its own, as the built-in section had none.
    expect(root.querySelector("h1, h2")).toBeNull();
    byLabel("Open Service frontend-canary")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({ kind: { group: "", version: "v1", kind: "Service" }, namespace: "shop", name: "frontend-canary" });
  });

  it("of a Route whose Service is not there", async () => {
    await open(find("Route", "internal"));
    await expect.poll(() => watchOf("Service")).toBeDefined();
    watchOf("Service")!.emit(snapshot([]));
    watchOf("Pod")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("The Service does not exist");
    expect(text()).toContain("No router has admitted the Route yet");
    expect(text()).toContain("No router has reported on the Route.");
  });

  it("of a rejected Route: the router's words", async () => {
    await open(find("Route", "api"));
    expect(root.querySelector(".os-note--danger")?.textContent).toContain("already exposes api.apps.ocp.example.com");
    const rejected = [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === "Rejected");
    expect(rejected?.className).toContain("sx-status--danger");
  });

  it("of a DeploymentConfig: its triggers and rollouts, the ReplicationControllers watched while the block is open", async () => {
    await open(find("DeploymentConfig", "frontend"));
    await expect.poll(() => watchOf("ReplicationController")).toBeDefined();
    expect(watchParams(watchOf("ReplicationController")!)).toMatchObject({
      namespaces: ["shop"],
      labelSelector: "openshift.io/deployment-config.name=frontend",
      maxObjects: MAX_RCS,
    });
    expect(text()).toContain("Loading…");
    watchOf("ReplicationController")!.emit(snapshot(all("ReplicationController")));
    await expect.poll(() => byLabel("Open ReplicationController frontend-2")).toHaveLength(1);
    expect(byLabel("Open ReplicationController backend-3")).toHaveLength(0);
    expect(byLabel("Open ImageStream frontend")).toHaveLength(1);
    // The replicas, and the pods of the current ReplicationController.
    expect(text().match(/1 of 1 ready/g)).toHaveLength(2);
    // Closed, nothing is watched; Sextant remembers it.
    toggle("rollouts")!.click();
    await expect.poll(() => watchOf("ReplicationController")).toBeUndefined();
    expect(remembered).toEqual({ rollouts: false });
  });

  it("of a failed DeploymentConfig: why, in the controller's words", async () => {
    await open(find("DeploymentConfig", "backend"), { blocks: { rollouts: false } });
    expect(root.querySelector(".os-note--danger")?.textContent).toBe('replication controller "backend-3" has failed progressing');
    expect(watchOf("ReplicationController")).toBeUndefined();
  });

  it("of a BuildConfig: the source without credentials, no webhook secret, its builds", async () => {
    await open(find("BuildConfig", "ruby-ex"));
    await expect.poll(() => watchOf("Build")).toBeDefined();
    expect(watchParams(watchOf("Build")!)).toMatchObject({
      kind: { group: "build.openshift.io", version: "v1", kind: "Build" },
      namespaces: ["shop"],
      labelSelector: "openshift.io/build-config.name=ruby-ex",
      maxObjects: MAX_BUILDS,
    });
    watchOf("Build")!.emit(snapshot(all("Build")));
    await expect.poll(() => byLabel("Open Build ruby-ex-3")).toHaveLength(1);
    expect(text()).toContain("https://github.com/sclorg/ruby-ex.git");
    expect(byLabel("Open Build nodejs-ex-1")).toHaveLength(0);
    expect(byLabel("Open Secret github-clone")).toHaveLength(1);
    expect(text()).not.toMatch(/ghp_FIXTURETOKEN|webhooksecret123|envsecret|ref=x/);
    expect(rows().find((r) => r?.startsWith("ruby-ex-2"))).toContain("Failed to fetch the input source.");
  });

  it("of a Build: why it failed, and the build pod's logs", async () => {
    await open(find("Build", "ruby-ex-2"));
    expect(root.querySelector(".os-note--danger")?.textContent).toBe("Failed to fetch the input source.");
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    expect(watchParams(watchOf("Pod")!)).toMatchObject({ namespaces: ["shop"], fieldSelector: "metadata.name=ruby-ex-2-build" });
    watchOf("Pod")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("The build pod no longer exists: its logs are gone.");
    expect(text()).toContain("error: failed to fetch requested repository");
    stop();
    root.remove();
    host.close();
    await open(find("Build", "ruby-ex-3"));
    await expect.poll(() => watchOf("Pod")).toBeDefined();
    watchOf("Pod")!.emit(snapshot([find("Pod", "ruby-ex-3-build")]));
    await expect.poll(() => button("Build logs")).toBeDefined();
    button("Build logs")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openLogs")?.params).toEqual({ namespace: "shop", pod: "ruby-ex-3-build" });
    // The built-in button's icon.
    expect(host.calls.some((c) => c.method === "ui.icon" && (c.params as { name: string }).name === "logs")).toBe(true);
    expect(text()).toContain("2m");
  });

  it("of an ImageStream and a Project", async () => {
    await open(find("ImageStream", "legacy-db"));
    expect(text()).toContain("The import of 1 tag fails.");
    expect(text()).toMatch(/registry.example.com\/db\/legacy:10\\?" not found/);
    const tag11 = rows().find((r) => r?.startsWith("11"));
    expect(tag11).toMatch(/^11DockerImage registry.example.com\/db\/legacy:11sha256:bb22.*No1 image$/);
    stop();
    root.remove();
    host.close();
    await open(find("Project", "shop"));
    expect(text()).toContain("Web shop");
    expect(byLabel("Open Namespace shop")).toHaveLength(1);
  });
});

describe("the actions", () => {
  const madeRc = { kind: { group: "", version: "v1", kind: "ReplicationController" }, namespace: "shop", name: "frontend-3" };
  const madeBuild = { kind: { group: "build.openshift.io", version: "v1", kind: "Build" }, namespace: "shop", name: "ruby-ex-4" };

  it("Rollout latest shows the request, checks the latest rollout ended, then sends once", async () => {
    const dc = find("DeploymentConfig", "frontend");
    await open(dc, { view: "action", contribution: "rollout-latest", handlers: { "resources.instantiate": () => madeRc } });
    expect(text()).toContain("Roll out DeploymentConfig frontend?");
    expect(text()).toMatch(/POST \/apis\/apps.openshift.io\/v1\/namespaces\/shop\/deploymentconfigs\/frontend\/instantiate/);
    await expect.poll(() => watchOf("ReplicationController")).toBeDefined();
    expect(watchParams(watchOf("ReplicationController")!)).toMatchObject({ namespaces: ["shop"], fieldSelector: "metadata.name=frontend-2" });
    expect(button("Roll out")!.disabled).toBe(true);
    watchOf("ReplicationController")!.emit(snapshot([find("ReplicationController", "frontend-2")]));
    await expect.poll(() => button("Roll out")!.disabled).toBe(false);
    button("Roll out")!.click();
    await expect.poll(() => text()).toContain("The rollout started: ReplicationController frontend-3.");
    expect(host.calls.filter((c) => c.method === "resources.instantiate").map((c) => (c.params as { ref: unknown }).ref)).toEqual([refOf(dc)]);
    button("Close")!.click();
    await expect.poll(() => host.calls.some((c) => c.method === "ui.close")).toBe(true);
  });

  it("Rollout latest waits while the latest rollout runs, and for a paused DeploymentConfig", async () => {
    await open(find("DeploymentConfig", "backend"), { view: "action", contribution: "rollout-latest" });
    await expect.poll(() => watchOf("ReplicationController")).toBeDefined();
    watchOf("ReplicationController")!.emit(snapshot([find("ReplicationController", "backend-3")]));
    await expect.poll(() => text()).toContain("Rollout backend-3 is still in progress: wait until it ends.");
    expect(button("Roll out")!.disabled).toBe(true);
    stop();
    root.remove();
    host.close();
    const paused = find("DeploymentConfig", "frontend");
    (paused.spec as Record<string, unknown>).paused = true;
    await open(paused, { view: "action", contribution: "rollout-latest" });
    await expect.poll(() => watchOf("ReplicationController")).toBeDefined();
    watchOf("ReplicationController")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("The DeploymentConfig is paused: it cannot be rolled out.");
    expect(button("Roll out")!.disabled).toBe(true);
    expect(host.calls.some((c) => c.method === "resources.instantiate")).toBe(false);
  });

  it("Start build shows the request and sends once; a failure stays in the window", async () => {
    const bc = find("BuildConfig", "ruby-ex");
    let fail = true;
    await open(bc, {
      view: "action",
      contribution: "start-build",
      handlers: {
        "resources.instantiate": () => {
          if (fail) throw Object.assign(new Error("builds are forbidden"), { code: "forbidden" });
          return madeBuild;
        },
      },
    });
    expect(text()).toContain("Start a build of BuildConfig ruby-ex?");
    expect(text()).toContain('"message": "Manually triggered"');
    button("Start build")!.click();
    await expect.poll(() => text()).toContain("builds are forbidden");
    fail = false;
    button("Start build")!.click();
    await expect.poll(() => text()).toContain("Build ruby-ex-4 started.");
    expect(host.calls.filter((c) => c.method === "resources.instantiate")).toHaveLength(2);
  });
});
