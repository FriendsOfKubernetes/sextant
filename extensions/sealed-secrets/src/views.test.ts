// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { CONTROLLER_BLOCK, MAX_KEY_NAMESPACES, SEALING_KEYS_BLOCK, startDetails } from "./details";
import { formatBytes } from "./dom";
import { setLanguage } from "./i18n";
import { base64Bytes } from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const synced = fixtures.synced as unknown as KubeObject;
const failed = fixtures.failed as unknown as KubeObject;
const clusterWide = fixtures.clusterWide as unknown as KubeObject;
const controller = fixtures.controller as unknown as KubeObject;
const target = fixtures.target as unknown as KubeObject;
const sealingKey = fixtures.sealingKey as unknown as KubeObject;

const SEALED = { group: "bitnami.com", version: "v1alpha1", kind: "SealedSecret" };
const ref = (o: KubeObject) => ({ kind: SEALED, namespace: o.metadata.namespace ?? null, name: o.metadata.name });

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, options: { language?: string; blocks?: Record<string, boolean>; kind?: typeof SEALED } = {}): Promise<void> {
  const language = options.language ?? "en";
  let blocks = options.blocks ?? {};
  host = await startTestHost({
    context: {
      view: "details",
      contribution: "sealed-secret",
      selection: [{ ...ref(obj), kind: options.kind ?? SEALED }],
      resourceVersion: "1",
      language,
      blocks,
      ...(obj.metadata.uid ? { uid: obj.metadata.uid } : {}),
    },
    handlers: {
      "resources.get": () => copy(obj),
      // Sextant's memory: `ui.setBlockOpen` writes it, the context tells it back, as the window does.
      "ui.setBlockOpen": (params) => {
        const { id, open: isOpen } = params as { id: string; open: boolean };
        blocks = { ...blocks, [id]: isOpen };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "sealed-secret");
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string; metadataOnly?: boolean };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchWhere = (test: (p: Params) => boolean) => live().find((w) => test(params(w)));
const targetWatch = (name: string) => watchWhere((p) => p.kind.kind === "Secret" && p.fieldSelector === `metadata.name=${name}`);
const byName = () => watchWhere((p) => p.kind.kind === "Deployment" && p.fieldSelector === "metadata.name=sealed-secrets-controller");
const byLabelWatch = () => watchWhere((p) => p.kind.kind === "Deployment" && p.labelSelector === "app.kubernetes.io/name=sealed-secrets");
const keysWatch = () => watchWhere((p) => p.kind.kind === "Secret" && p.labelSelector === "sealedsecrets.bitnami.com/sealed-secrets-key");
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const toggle = (title: string) => [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")].find((b) => b.textContent === title)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function answerController(deployments: KubeObject[]): Promise<void> {
  await expect.poll(() => byName() && byLabelWatch()).toBeTruthy();
  byName()!.emit(snapshot(deployments));
  byLabelWatch()!.emit(snapshot(deployments));
}

/** Every Secret watch is metadata only, and nothing but the SealedSecret itself is read. */
function expectNoSecretData(): void {
  for (const w of host.watches.filter((w) => params(w).kind.kind === "Secret")) expect(params(w).metadataOnly).toBe(true);
  const reads = host.calls.filter((c) => c.method === "resources.get").map((c) => (c.params as { ref: { kind: { kind: string } } }).ref.kind.kind);
  expect(new Set(reads)).toEqual(new Set(["SealedSecret"]));
}

describe("details of a SealedSecret", () => {
  it("says it is synced, links its Secret and how it stands, names the keys and finds the controller", async () => {
    await open(synced);
    await expect.poll(() => statusOf("Synced")).toBeDefined();
    expect(statusOf("Synced")!.classList).toContain("sx-status--success");
    expect(text()).toContain("Strict: unseals only under this name in this namespace");
    expect(byLabel("Open Secret mysecret")).toHaveLength(1);
    await expect.poll(() => targetWatch("mysecret")).toBeDefined();
    expect(params(targetWatch("mysecret")!)).toMatchObject({ kind: { kind: "Secret", version: "v1" }, namespaces: ["mynamespace"], metadataOnly: true });
    expect(text()).toContain("Loading…");
    targetWatch("mysecret")!.emit(snapshot([target]));
    await expect.poll(() => statusOf("Managed by this SealedSecret")?.classList.contains("sx-status--success")).toBe(true);
    expect(text()).toContain("Only the names of the keys and the sizes of their sealed values are shown, never the values.");
    const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
    expect(rows().slice(0, 2)).toEqual([
      ["bar", formatBytes(base64Bytes((synced.spec as { encryptedData: Record<string, string> }).encryptedData.bar!))],
      ["foo", formatBytes(base64Bytes((synced.spec as { encryptedData: Record<string, string> }).encryptedData.foo!))],
    ]);
    // The ciphertext itself is not in the section.
    expect(text()).not.toContain("AgBy3i4OJSWK");
    expect(text()).toContain("1 of 1 observed by the controller");

    await answerController([controller]);
    await expect.poll(() => byLabel("Open Deployment sealed-secrets-controller")).toHaveLength(1);
    expect(statusOf("1 of 1 ready")!.classList).toContain("sx-status--success");
    expect(text()).toContain("docker.io/bitnami/sealed-secrets-controller:0.32.2");
    await expect.poll(() => keysWatch()).toBeDefined();
    expect(params(keysWatch()!)).toMatchObject({ namespaces: ["kube-system"], metadataOnly: true });
    keysWatch()!.emit(snapshot([sealingKey]));
    await expect.poll(() => byLabel("Open Secret sealed-secrets-keyx7k2p")).toHaveLength(1);
    expect(text()).toContain("active");
    expect(text()).toContain("The certificate is not shown: it is kept in the same Secret as the private key, which Sextant does not read.");
    expectNoSecretData();
  });

  it("says why the unseal failed and what it means; a missing Secret and controller are said so", async () => {
    await open(failed);
    await expect.poll(() => statusOf("Failed")).toBeDefined();
    expect(statusOf("Failed")!.classList).toContain("sx-status--danger");
    expect(root.querySelector(".ss-message")?.textContent).toBe("no key could decrypt secret (password, username)");
    expect(text()).toMatch(/No sealing key of this controller decrypts it/);
    expect(toggle("Last error")).toBeDefined();
    // The message on hover, as the built-in cell.
    expect(statusOf("Failed")!.parentElement!.title).toBe("no key could decrypt secret (password, username)");
    await expect.poll(() => targetWatch("db-credentials")).toBeDefined();
    targetWatch("db-credentials")!.emit(snapshot([]));
    await expect.poll(() => statusOf("Not found")?.classList.contains("sx-status--danger")).toBe(true);
    await answerController([]);
    await expect.poll(text).toMatch(/No controller found as Deployment sealed-secrets-controller/);
    // No controller: no sealing keys looked for.
    expect(keysWatch()).toBeUndefined();
    expectNoSecretData();
  });

  it("a cluster-wide one with a status of an older generation, its template keys and no owner reference", async () => {
    await open(clusterWide);
    await expect.poll(() => statusOf("Pending")).toBeDefined();
    expect(statusOf("Pending")!.classList).toContain("sx-status--warning");
    expect(text()).toContain("The controller has not processed the latest change yet: the status is of an older generation.");
    expect(text()).toContain("Cluster-wide: unseals under any name in any namespace");
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["config.yaml", "legacy (left out)"]);
    expect(text()).toContain("Not set (annotation skip-set-owner-references)");
    expect(text()).toContain("2 of 3 observed by the controller");
    expect(text()).toContain("kubernetes.io/dockerconfigjson");
    expect(text()).toContain("Immutable");
  });

  it("notes a SealedSecret without a status, and one still on the deprecated spec.data", async () => {
    const none = copy(synced);
    delete none.status;
    await open(none);
    await expect.poll(text).toContain("The controller has written no status.");
    stop();
    host.close();
    root.remove();
    const legacy = copy(synced);
    (legacy.spec as Record<string, unknown>).data = "AgLegacy";
    await open(legacy);
    await expect.poll(text).toContain("It uses the deprecated field spec.data.");
  });

  it("cannot tell how the Secret stands, or find a controller, where the lists cannot be read", async () => {
    await open(synced);
    await expect.poll(() => targetWatch("mysecret")).toBeDefined();
    targetWatch("mysecret")!.emit({ type: "forbidden", namespaces: ["mynamespace"] });
    await expect.poll(text).toContain("Cannot tell");
    await expect.poll(() => byName() && byLabelWatch()).toBeTruthy();
    byName()!.emit({ type: "error", code: "forbidden", message: "no" } as unknown as WatchUpdate);
    byLabelWatch()!.emit(snapshot([]));
    await expect.poll(text).toContain("The Deployments cannot be read, so the controller cannot be found.");
  });

  it("watches the controller only while its block is open, and its keys only while theirs is", async () => {
    await open(synced, { blocks: { [CONTROLLER_BLOCK]: false } });
    await expect.poll(() => targetWatch("mysecret")).toBeDefined();
    await settle();
    expect(byName()).toBeUndefined();
    expect(byLabelWatch()).toBeUndefined();
    toggle("Controller").click();
    await answerController([controller]);
    await expect.poll(() => keysWatch()).toBeDefined();
    toggle("Sealing keys").click();
    await expect.poll(() => keysWatch()).toBeUndefined();
    expect(host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params)).toEqual([
      { id: CONTROLLER_BLOCK, open: true },
      { id: SEALING_KEYS_BLOCK, open: false },
    ]);
    toggle("Controller").click();
    await expect.poll(() => byName()).toBeUndefined();
    expect(byLabelWatch()).toBeUndefined();
    // The target Secret is a field: always watched.
    expect(targetWatch("mysecret")).toBeDefined();
  });

  it("follows the panel's \"Collapse all\"", async () => {
    await open(synced);
    await answerController([controller]);
    await expect.poll(() => keysWatch()).toBeDefined();
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => byName()).toBeUndefined();
    expect(keysWatch()).toBeUndefined();
    expect(toggle("Keys").getAttribute("aria-expanded")).toBe("false");
  });

  it("reads the keys of at most five controllers' namespaces", async () => {
    await open(synced);
    const many = Array.from({ length: 7 }, (_, i) => {
      const d = copy(controller);
      d.metadata.uid = `dep-${i}`;
      d.metadata.namespace = `ns-${i}`;
      return d;
    });
    await answerController(many);
    await expect.poll(() => keysWatch()).toBeDefined();
    expect(params(keysWatch()!).namespaces).toEqual(["ns-0", "ns-1", "ns-2", "ns-3", "ns-4"].slice(0, MAX_KEY_NAMESPACES));
  });

  it("speaks the UI language", async () => {
    await open(failed, { language: "ru" });
    await expect.poll(() => statusOf("Ошибка")).toBeDefined();
    expect(toggle("Последняя ошибка")).toBeDefined();
  });

  it("shows nothing of another kind", async () => {
    await open(synced, { kind: { group: "", version: "v1", kind: "Secret" } });
    await expect.poll(text).toContain("Nothing to show");
    expect(live()).toEqual([]);
  });
});
