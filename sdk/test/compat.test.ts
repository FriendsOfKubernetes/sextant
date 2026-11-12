// Extensions released by earlier SDKs keep working with today's Sextant (ADR-0142). Each frozen package of
// `fixtures/compat/` carries the SDK it was built with, inlined in its page: that very script runs here against
// Sextant's real host side (src/extensions/bridge.ts) with a mock backend, and must connect, call, watch and draw.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../../src/api";
import { createBridge, type Bridge } from "../../src/extensions/bridge";
import type { HostContext } from "../../src/extensions/protocol";
import { buildExtension } from "../scripts/build.mjs";
import { validateManifest } from "../scripts/manifest.mjs";
import { unzip } from "../scripts/zip.mjs";

const COMPAT = join(import.meta.dirname, "fixtures/compat");
const ROOK_OBJECTS = join(import.meta.dirname, "../../extensions/rook-ceph/fixtures/objects.json");
const EXTENSIONS = join(import.meta.dirname, "../../extensions");
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(EXTENSIONS, path), "utf8"));

interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid?: string };
}

/** The files of a frozen package, by path. */
function packageFiles(path: string): Map<string, string> {
  const entries = unzip(readFileSync(join(COMPAT, path))) as { path: string; data: Buffer }[];
  return new Map(entries.map((e) => [e.path, e.data.toString("utf8")]));
}

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");

/** Every object in a fixture file, wherever it is nested. */
function objectsIn(value: unknown, into: KubeObject[] = []): KubeObject[] {
  if (Array.isArray(value)) for (const v of value) objectsIn(v, into);
  else if (typeof value === "object" && value !== null) {
    const o = value as Partial<KubeObject>;
    if (typeof o.apiVersion === "string" && typeof o.kind === "string" && o.metadata) into.push(o as KubeObject);
    else for (const v of Object.values(value)) objectsIn(v, into);
  }
  return into;
}

let backend: MockBackend;
let bridge: Bridge | null;
let frameElement: HTMLIFrameElement;
let hostElement: HTMLIFrameElement;
let onFrameError: ReturnType<typeof vi.fn<(message: string) => void>>;
/** The context Sextant has now, when a test changes it after opening. */
let bridgeContext: (() => HostContext) | null;
const calls = () => backend.calls.filter((c) => c.cmd === "extension_call").map((c) => c.args.method as string);

beforeEach(() => {
  backend = mockBackend();
  bridge = null;
  bridgeContext = null;
  onFrameError = vi.fn<(message: string) => void>();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  bridge?.dispose();
  frameElement?.remove();
  hostElement?.remove();
  backend.restore();
});

/**
 * Serves `objects` to the extension: `kinds` names their kinds, `resources.list`/`watch` give those of the asked
 * kind (a watch as its first snapshot), `resources.get` the one named; storage is empty, anything else is refused.
 */
function serve(objects: KubeObject[]) {
  const ofKind = (params: { kind?: { group?: string; kind?: string } }) =>
    objects.filter((o) => o.kind === params.kind?.kind && groupOf(o.apiVersion) === (params.kind?.group ?? ""));
  backend.on("extension_call", (args) => {
    const params = (args.params ?? {}) as { kind?: { group?: string; kind?: string }; ref?: { name: string } };
    switch (args.method) {
      case "kinds": {
        const seen = new Map<string, unknown>();
        for (const o of objects) {
          const group = groupOf(o.apiVersion);
          const version = o.apiVersion.split("/").pop()!;
          seen.set(`${group}/${o.kind}`, {
            kindRef: { group, version, kind: o.kind },
            plural: `${o.kind.toLowerCase()}s`,
            namespaced: o.metadata.namespace !== undefined,
            verbs: ["get", "list", "watch"],
            printerColumns: [],
          });
        }
        return [...seen.values()];
      }
      case "resources.list":
        return { items: ofKind(params), truncated: false };
      case "resources.get": {
        const found = ofKind(params.ref as never).find((o) => o.metadata.name === params.ref?.name);
        if (!found) throw { code: "notFound", message: "not found" };
        return found;
      }
      case "resources.watch": {
        const items = ofKind(params);
        setTimeout(() => backend.emit(`ext-watch:${String(args.streamId)}`, { type: "snapshot", items }), 0);
        return null;
      }
      case "storage.get":
        return null;
      case "storage.set":
      case "storage.remove":
        return null;
      default:
        throw { code: "denied", message: `${String(args.method)} is not granted in this test` };
    }
  });
}

/**
 * Opens the package's page in a frame and runs its inlined script — the SDK it was built with, as it was published
 * — as the frame's own code: `window` is the frame, whose parent is Sextant's window.
 */
function open(path: string, context: HostContext): Document {
  return openPage(packageFiles(path).get("index.html")!, context);
}

/** Opens a built page (one inlined module script) in a frame, as {@link open} does. */
function openPage(html: string, context: HostContext): Document {
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts).toHaveLength(1);
  frameElement = document.createElement("iframe");
  hostElement = document.createElement("iframe");
  document.body.append(frameElement, hostElement);
  const frameWindow = frameElement.contentWindow!;
  const hostWindow = hostElement.contentWindow!;
  const frameDocument = frameElement.contentDocument!;
  frameDocument.body.innerHTML = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html.replace(/<script[\s\S]*?<\/script>/g, ""))![1]!;
  // The frame posts to its parent, Sextant's window; Sextant posts to the frame. Both carry a copy, as a browser does.
  vi.spyOn(hostWindow, "postMessage").mockImplementation((message: unknown) => {
    bridge!.handle(new MessageEvent("message", { data: structuredClone(message), source: frameWindow }));
  });
  vi.spyOn(frameWindow, "postMessage").mockImplementation((message: unknown) => {
    frameWindow.dispatchEvent(new MessageEvent("message", { data: structuredClone(message), source: hostWindow }));
  });
  // The frame's own `window`, whose parent is Sextant's.
  const ownWindow = new Proxy(frameWindow, {
    get(target, key) {
      if (key === "parent") return hostWindow;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  bridge = createBridge({
    extensionId: context.extensionId,
    frame: () => frameWindow,
    context: () => bridgeContext?.() ?? context,
    ui: {
      openDetails: vi.fn(),
      navigate: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
      openLogs: vi.fn(() => Promise.resolve()),
      openUrl: vi.fn(() => Promise.resolve({ opened: false })),
      openCluster: vi.fn(() => Promise.resolve({ opened: false })),
      setBlockOpen: vi.fn(),
      setColumnWidth: vi.fn(),
      revealSection: vi.fn(),
  signIn: vi.fn(() => Promise.resolve({ signedIn: false })),
  setHidden: vi.fn(),
    },
    onFrameError,
    onResize: vi.fn(),
  });
  const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;
  const run = new AsyncFunction("window", "self", "document", `"use strict";\n${scripts[0]!}`);
  void run(ownWindow, ownWindow, frameDocument).catch((error: unknown) => onFrameError(String(error)));
  return frameDocument;
}

const context = (extensionId: string, rest: Partial<HostContext>): HostContext => ({
  apiVersion: 1,
  extensionId,
  view: "page",
  contribution: "",
  clusterId: "kind-test",
  namespaces: null,
  theme: "dark",
  language: "en",
  tokens: { "--color-text": "#dcddde" },
  selection: [],
  resourceVersion: null,
  ...rest,
});

const POD: KubeObject & Record<string, unknown> = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-7d9f", namespace: "default", uid: "p1" },
  status: { phase: "Running", containerStatuses: [{ name: "web", ready: true, restartCount: 2 }] },
};
const NAMESPACE: KubeObject = { apiVersion: "v1", kind: "Namespace", metadata: { name: "default", uid: "n1" } };
const WIDGET: KubeObject & Record<string, unknown> = {
  apiVersion: "demo.sextant.dev/v1",
  kind: "Widget",
  metadata: { name: "blue", namespace: "default", uid: "w1", generation: 7 } as KubeObject["metadata"],
  spec: { size: "large", replicas: 3 },
};

describe("frozen packages: their own SDK against today's Sextant", () => {
  it("every frozen package is covered here", () => {
    const covered = [
      "sdk-0.6.0/sextant.example.hello-page-1.0.0.sextant-ext",
      "sdk-0.6.0/sextant.example.crd-view-1.0.0.sextant-ext",
      "sdk-0.26.0/sextant.example.backend-rust-1.0.0.sextant-ext",
      "published/sextant.example.hello-page-1.0.0.sextant-ext",
      "published/sextant.example.crd-view-1.0.0.sextant-ext",
      "published/sextant.rook-ceph-1.0.0.sextant-ext",
      "published/sextant.rook-ceph-1.1.1.sextant-ext",
      "sdk-0.29.0/sextant.example.crd-view-1.1.0.sextant-ext",
      "published/sextant.rook-ceph-1.2.0.sextant-ext",
      "published/sextant.argo-rollouts-1.4.0.sextant-ext",
      "published/sextant.cert-manager-1.0.0.sextant-ext",
      "sdk-0.30.1/sextant.karpenter-1.1.0.sextant-ext",
      "sdk-0.30.1/sextant.k3s-1.1.0.sextant-ext",
    ];
    const found = readdirSync(COMPAT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => readdirSync(join(COMPAT, e.name)).map((f) => `${e.name}/${f}`))
      .filter((f) => f.endsWith(".sextant-ext"))
      .sort();
    expect(found).toEqual([...covered].sort());
  });

  for (const path of [
    "sdk-0.6.0/sextant.example.hello-page-1.0.0.sextant-ext",
    "published/sextant.example.hello-page-1.0.0.sextant-ext",
    "sdk-0.26.0/sextant.example.backend-rust-1.0.0.sextant-ext",
  ]) {
    it(`${path}: connects, watches and draws`, async () => {
      serve([NAMESPACE, POD]);
      const manifest = JSON.parse(packageFiles(path).get("sextant-extension.json")!) as { id: string; contributes: { pages: { id: string }[] } };
      const doc = open(path, context(manifest.id, { contribution: manifest.contributes.pages[0]!.id }));
      if (path.includes("backend-rust")) {
        // Its page asks its backend; the backend itself is run by sextant-ext-runtime's own compat test.
        await vi.waitFor(() => expect(calls()).toContain("backend.call"));
      } else {
        await vi.waitFor(() => expect(doc.body.textContent).toContain("web-7d9f"));
        expect(calls()).toContain("resources.watch");
      }
      expect(onFrameError).not.toHaveBeenCalled();
    });
  }

  for (const path of [
    "sdk-0.6.0/sextant.example.crd-view-1.0.0.sextant-ext",
    "published/sextant.example.crd-view-1.0.0.sextant-ext",
    "sdk-0.29.0/sextant.example.crd-view-1.1.0.sextant-ext",
  ]) {
    it(`${path}: a details section reads the shown object and follows its changes`, async () => {
      serve([WIDGET]);
      const ref = { kind: { group: "demo.sextant.dev", version: "v1", kind: "Widget" }, namespace: "default", name: "blue" };
      let shown = context("sextant.example.crd-view", {
        view: "details",
        contribution: "summary",
        selection: [ref],
        resourceVersion: "1",
      });
      bridgeContext = () => shown;
      const doc = open(path, shown);
      await vi.waitFor(() => expect(doc.body.textContent).toContain("large"));
      expect(doc.body.textContent).toContain("7");
      expect(calls().filter((m) => m === "resources.get")).toHaveLength(1);
      // The object changed: Sextant sends the new resourceVersion and the section reads it again.
      shown = { ...shown, resourceVersion: "2" };
      bridge!.pushContext();
      await vi.waitFor(() => expect(calls().filter((m) => m === "resources.get")).toHaveLength(2));
      expect(onFrameError).not.toHaveBeenCalled();
    });
  }

  it("sdk-0.29.0/sextant.example.crd-view-1.1.0.sextant-ext: its page in a section of its own lists the widgets", async () => {
    serve([WIDGET]);
    const doc = open("sdk-0.29.0/sextant.example.crd-view-1.1.0.sextant-ext", context("sextant.example.crd-view", { contribution: "widgets" }));
    await vi.waitFor(() => expect(doc.body.textContent).toContain("1 widget"));
    expect(doc.body.textContent).toContain("blue");
    expect(calls()).toContain("resources.watch");
    expect(onFrameError).not.toHaveBeenCalled();
  });

  for (const path of [
    "published/sextant.rook-ceph-1.0.0.sextant-ext",
    "published/sextant.rook-ceph-1.1.1.sextant-ext",
    "published/sextant.rook-ceph-1.2.0.sextant-ext",
  ]) {
    it(`${path}: the Rook Ceph page draws the fixtures' CephClusters`, async () => {
      serve(objectsIn(JSON.parse(readFileSync(ROOK_OBJECTS, "utf8"))));
      const doc = open(path, context("sextant.rook-ceph", { contribution: "overview" }));
      await vi.waitFor(() => expect(doc.body.textContent).toContain("my-cluster"), { timeout: 4000 });
      expect(calls()).toEqual(expect.arrayContaining(["kinds", "resources.watch"]));
      expect(onFrameError).not.toHaveBeenCalled();
    });
  }
});

describe("extensions of API 4 (Sextant 0.30.0)", () => {
  const refOf = (o: KubeObject) => ({
    kind: { group: groupOf(o.apiVersion), version: o.apiVersion.split("/").pop()!, kind: o.kind },
    namespace: o.metadata.namespace ?? null,
    name: o.metadata.name,
  });

  it("published/sextant.argo-rollouts-1.4.0.sextant-ext: a Rollout's details section draws its steps and ReplicaSets", async () => {
    const rollout = fixture("argo-rollouts/fixtures/rollout-canary-paused.json") as KubeObject;
    serve([rollout, ...(fixture("argo-rollouts/fixtures/replicasets.json") as KubeObject[])]);
    const doc = open(
      "published/sextant.argo-rollouts-1.4.0.sextant-ext",
      context("sextant.argo-rollouts", { view: "details", contribution: "rollout", selection: [refOf(rollout)], resourceVersion: "1" }),
    );
    await vi.waitFor(() => expect(doc.body.textContent).toContain("rollout-canary-7d8c6f9b5"), { timeout: 4000 });
    expect(doc.body.textContent).toContain("CanaryPauseStep");
    expect(calls()).toEqual(expect.arrayContaining(["resources.get", "resources.watch"]));
    expect(onFrameError).not.toHaveBeenCalled();
  });

  it("published/sextant.cert-manager-1.0.0.sextant-ext: a Certificate's details section draws its names and issuer", async () => {
    const certificate = fixture("cert-manager/fixtures/certificate.json") as KubeObject;
    serve([certificate]);
    const doc = open(
      "published/sextant.cert-manager-1.0.0.sextant-ext",
      context("sextant.cert-manager", { view: "details", contribution: "certmanager", selection: [refOf(certificate)], resourceVersion: "1" }),
    );
    await vi.waitFor(() => expect(doc.body.textContent).toContain("shop.example.com"), { timeout: 4000 });
    expect(doc.body.textContent).toContain("letsencrypt");
    expect(onFrameError).not.toHaveBeenCalled();
  });
});

describe("extensions of API 5 (Sextant 0.30.1)", () => {
  const refOf = (o: KubeObject) => ({
    kind: { group: groupOf(o.apiVersion), version: o.apiVersion.split("/").pop()!, kind: o.kind },
    namespace: o.metadata.namespace ?? null,
    name: o.metadata.name,
  });

  it("sdk-0.30.1/sextant.karpenter-1.1.0.sextant-ext: a NodePool's details section draws it", async () => {
    const objects = objectsIn(fixture("karpenter/fixtures/objects.json"));
    serve(objects);
    const pool = objects.find((o) => o.kind === "NodePool" && o.metadata.name === "default")!;
    const doc = open(
      "sdk-0.30.1/sextant.karpenter-1.1.0.sextant-ext",
      context("sextant.karpenter", { view: "details", contribution: "node-pool", selection: [refOf(pool)], resourceVersion: "1" }),
    );
    await vi.waitFor(() => expect(doc.body.textContent).toContain("Limits and disruption"), { timeout: 4000 });
    expect(onFrameError).not.toHaveBeenCalled();
  });

  it("sdk-0.30.1/sextant.k3s-1.1.0.sextant-ext: the Distribution page lists the k3s and RKE2 nodes", async () => {
    serve(objectsIn(fixture("k3s/fixtures/objects.json")));
    const doc = open("sdk-0.30.1/sextant.k3s-1.1.0.sextant-ext", context("sextant.k3s", { contribution: "distribution" }));
    await vi.waitFor(() => expect(doc.body.textContent).toContain("k3s-server-1"), { timeout: 4000 });
    expect(calls()).toContain("resources.watch");
    expect(onFrameError).not.toHaveBeenCalled();
  });
});

describe("old projects: today's SDK builds them unchanged", () => {
  it("builds the hello-page project of the 0.6.0 SDK, and the page works", async () => {
    const out = mkdtempSync(join(tmpdir(), "sextant-compat-"));
    try {
      const project = join(COMPAT, "projects/hello-page-0.6.0");
      const dist = await buildExtension(project, { out: join(out, "dist"), quiet: true });
      const manifest = JSON.parse(readFileSync(join(dist, "sextant-extension.json"), "utf8")) as { sextantApi: number };
      expect(manifest.sextantApi).toBe(1);
      expect(validateManifest(manifest)).toBeNull();
      serve([NAMESPACE, POD]);
      const doc = openPage(readFileSync(join(dist, "index.html"), "utf8"), context("sextant.example.hello-page", { contribution: "pods" }));
      await vi.waitFor(() => expect(doc.body.textContent).toContain("web-7d9f"));
      expect(onFrameError).not.toHaveBeenCalled();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
