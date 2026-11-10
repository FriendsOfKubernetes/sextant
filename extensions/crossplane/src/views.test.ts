// The details sections and the "Composite Resources" page, driven through the SDK's stand-in for Sextant's window, as
// the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import claimJson from "../fixtures/claim.json";
import compositeJson from "../fixtures/composite.json";
import managedJson from "../fixtures/managed.json";
import providerJson from "../fixtures/provider.json";
import xrdJson from "../fixtures/xrd.json";
import { CONCURRENCY, KINDS_SECTION, RESOURCE_SECTION, startDetails } from "./details";
import { setLanguage } from "./i18n";
import { MAX_ROWS, MAX_XRDS } from "./model";
import { startPage } from "./page";
import { MAX_CHAIN } from "./views";

const copy = <T>(value: T): T => structuredClone(value);
const xrd = () => copy(xrdJson) as unknown as KubeObject;
const claim = () => copy(claimJson) as unknown as KubeObject;
const composite = () => copy(compositeJson) as unknown as KubeObject;
const managed = () => copy(managedJson) as unknown as KubeObject;
const provider = () => copy(providerJson) as unknown as KubeObject;
type Cond = { type: string; status: string; reason?: string; message?: string };
const conditions = (o: KubeObject) => (o.status as { conditions: Cond[] }).conditions;

const kindOf = (o: KubeObject) => {
  const [group, version] = o.apiVersion!.includes("/") ? o.apiVersion!.split("/") : ["", o.apiVersion!];
  return { group: group!, version: version!, kind: o.kind! };
};
const ref = (o: KubeObject) => ({ kind: kindOf(o), namespace: o.metadata.namespace ?? null, name: o.metadata.name });

const SERVED = [
  ["apiextensions.crossplane.io", "v1", "CompositeResourceDefinition"],
  ["apiextensions.crossplane.io", "v1", "Composition"],
  ["pkg.crossplane.io", "v1", "Provider"],
  ["database.example.org", "v1alpha1", "PostgreSQLInstance"],
  ["database.example.org", "v1alpha1", "XPostgreSQLInstance"],
  ["rds.aws.upbound.io", "v1beta1", "Instance"],
  ["", "v1", "Pod"],
] as const;
type Served = readonly (readonly [string, string, string])[];
const kinds = (served: Served) =>
  served.map(([group, version, kind]) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: kind === "PostgreSQLInstance" || kind === "Pod", verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
/** The objects the chain's `resources.get` calls find (the shown object is found too). */
let objects: KubeObject[] = [];
/** The object shown in the details. */
let shownObject: KubeObject | undefined;

type GetParams = { ref: { kind: { kind: string }; name: string } };
const sameRef = (o: KubeObject, r: GetParams["ref"]) => o.kind === r.kind.kind && o.metadata.name === r.name;
function get({ ref: r }: GetParams) {
  if (shownObject && sameRef(shownObject, r)) return copy(shownObject);
  const found = objects.find((o) => sameRef(o, r));
  if (!found) throw { code: "notFound", message: "not found" };
  return copy(found);
}

async function open(obj: KubeObject, contribution: string, options: TestHostOptions & { served?: Served } = {}): Promise<void> {
  shownObject = obj;
  host = await startTestHost({
    context: { view: "details", contribution, selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: {
      "resources.get": get,
      kinds: () => kinds(options.served ?? SERVED),
      "ui.setHidden": () => null,
      "ui.setBlockOpen": () => null,
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
}

async function openPage(options: TestHostOptions & { served?: Served } = {}): Promise<void> {
  host = await startTestHost({ context: { view: "page", contribution: "composites", ...options.context }, handlers: { kinds: () => kinds(options.served ?? SERVED), ...options.handlers } });
  root = document.createElement("main");
  document.body.append(root);
  stop = startPage(host.sextant, root);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
  objects = [];
  shownObject = undefined;
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { group?: string; kind: string }; maxObjects?: number };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const hiddenCalls = () => host.calls.filter((c) => c.method === "ui.setHidden").map((c) => (c.params as { hidden: boolean }).hidden);
const calls = (method: string) => host.calls.filter((c) => c.method === method);
/** The chain's reads: `resources.get` of another object than the shown one. */
const chainReads = () => calls("resources.get").filter((c) => !sameRef(shownObject!, (c.params as GetParams).ref));

describe("details of a claim, a composite or a managed resource", () => {
  it("of a claim: the chain to the composite and its resources, with what fails first", async () => {
    objects = [composite(), managed()];
    await open(claim(), RESOURCE_SECTION);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    expect(hiddenCalls()).toEqual([]);
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(text).toContain("Not ready yet: Crossplane is still creating it or its resources.");
    expect(hiddenCalls()).toEqual([false]);
    expect(text()).toContain("PostgreSQLInstance");
    expect(text()).toContain("Claim");
    expect(byLabel("Open Secret db-conn")).toHaveLength(1);
    expect(byLabel("Open Composition xpostgresqlinstances.aws.database.example.org")).toHaveLength(1);
    await expect.poll(() => byLabel("Open XPostgreSQLInstance my-db-x7k2p")).toHaveLength(1);
    await expect.poll(() => byLabel("Open Instance my-db-x7k2p-9fz2l")).toHaveLength(1);
    expect(byLabel("Open Instance my-db-x7k2p-9fz2l")[0]!.textContent).toBe("Instance/my-db-x7k2p-9fz2l");
    await expect.poll(text).toMatch(/Cannot find version 9.1 for postgres/);
    // A named resource that is gone says so.
    expect(text()).toContain("Not found");
    expect(text()).toContain("Synced: False");
    // The claim itself is the current item of the chain, without a link.
    expect(root.querySelector('[aria-current="true"]')?.textContent).toContain("my-db");
    expect(byLabel("Open PostgreSQLInstance my-db")).toHaveLength(0);
  });

  it("reads the chain once per change of the shown object, and only while its block is open", async () => {
    objects = [composite(), managed()];
    const shown = claim();
    await open(shown, RESOURCE_SECTION, { context: { blocks: { chain: false } } });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(text).toContain("Not ready yet");
    expect(chainReads()).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('[data-block="chain"] .sx-block__toggle')!.click();
    await expect.poll(() => byLabel("Open Instance my-db-x7k2p-9fz2l")).toHaveLength(1);
    expect(calls("ui.setBlockOpen").at(-1)?.params).toEqual({ id: "chain", open: true });
    // The composite, then its two composed resources, each read once.
    await expect.poll(() => chainReads().length).toBe(3);
    shown.metadata.resourceVersion = "101";
    host.setContext({ resourceVersion: "101", blocks: { chain: true } });
    await expect.poll(() => chainReads().length).toBe(6);
  });

  it("reads at most MAX_CHAIN composed resources, 4 at a time, each shown as it comes", async () => {
    const big = composite();
    (big.spec as Record<string, unknown>).resourceRefs = Array.from({ length: MAX_CHAIN + 3 }, (_, i) => ({ apiVersion: "rds.aws.upbound.io/v1beta1", kind: "Instance", name: `db-${i}` }));
    objects = Array.from({ length: MAX_CHAIN }, (_, i) => ({ ...managed(), metadata: { ...managed().metadata, name: `db-${i}` } }));
    const waiting: (() => void)[] = [];
    let running = 0;
    let most = 0;
    await open(big, RESOURCE_SECTION, {
      handlers: {
        "resources.get": async (params: unknown) => {
          const r = (params as GetParams).ref;
          if (sameRef(big, r)) return copy(big);
          running++;
          most = Math.max(most, running);
          await new Promise<void>((resolve) => waiting.push(resolve));
          running--;
          return get(params as GetParams);
        },
      },
    });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(() => waiting.length).toBe(CONCURRENCY);
    // The first one read shows before the others come.
    waiting.shift()!();
    await expect.poll(() => text()).toContain("Synced: False");
    // The others are listed by name until they come.
    expect(text().match(/Synced: False/g)).toHaveLength(1);
    expect(byLabel("Open Instance db-29")).toHaveLength(1);
    while (chainReads().length < MAX_CHAIN || waiting.length > 0) {
      waiting.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(most).toBe(CONCURRENCY);
    expect(chainReads()).toHaveLength(MAX_CHAIN);
  });

  it("of a composite: its claim and its composed resources", async () => {
    objects = [managed()];
    await open(composite(), RESOURCE_SECTION);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(text).toContain("Composite resource");
    expect(byLabel("Open PostgreSQLInstance my-db")[0]!.textContent).toBe("PostgreSQLInstance/my-db");
    await expect.poll(() => byLabel("Open Instance my-db-x7k2p-9fz2l")).toHaveLength(1);
    expect(text()).toContain("Not found");
  });

  it("with more composed resources than it lists: says how many are left out", async () => {
    const big = composite();
    (big.spec as Record<string, unknown>).resourceRefs = Array.from({ length: MAX_CHAIN + 3 }, (_, i) => ({ apiVersion: "rds.aws.upbound.io/v1beta1", kind: "Instance", name: `db-${i}` }));
    await open(big, RESOURCE_SECTION);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(text).toContain("Not shown: 3");
    expect(byLabel("Open Instance db-29")).toHaveLength(1);
    expect(byLabel("Open Instance db-30")).toHaveLength(0);
  });

  it("of a managed resource: its state, ProviderConfig and composite", async () => {
    await open(managed(), RESOURCE_SECTION);
    await expect.poll(text).toMatch(/Crossplane cannot reconcile it \(ReconcileError\)/);
    expect(text()).toContain("Managed resource");
    expect(byLabel("Open XPostgreSQLInstance my-db-x7k2p")).toHaveLength(1);
    expect(text()).toContain("default/my-db");
    expect(text()).toContain("my-db-x7k2p-9fz2l");
    expect(root.querySelector(".xp-explain--danger")).not.toBeNull();
    expect(root.querySelector(".xp-message")?.textContent).toContain("First failing condition: Synced (ReconcileError): create failed");
  });

  it("of a paused claim: says it is paused, with nothing failing", async () => {
    const paused = claim();
    paused.metadata.annotations = { "crossplane.io/paused": "true" };
    (paused.status as { conditions: unknown[] }).conditions = [{ type: "Synced", status: "False", reason: "ReconcilePaused" }];
    await open(paused, RESOURCE_SECTION);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(() => root.querySelector(".xp-explain")?.textContent).toMatch(/^Paused: Crossplane does not reconcile it/);
    expect(text()).not.toMatch(/ReconcilePaused/);
  });

  it("stays hidden on a kind that cannot be Crossplane's, and reads nothing", async () => {
    const pod: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "web", namespace: "default" } };
    await open(pod, RESOURCE_SECTION);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls("resources.get")).toHaveLength(0);
    expect(calls("kinds")).toHaveLength(0);
    expect(hiddenCalls()).toEqual([]);
    expect(text()).toBe("");
  });

  it("stays hidden on an object of an installed API that the XRDs do not define and that is not managed", async () => {
    const other: KubeObject = { apiVersion: "example.org/v1", kind: "Widget", metadata: { name: "w" }, spec: { size: 1 } };
    await open(other, RESOURCE_SECTION, { served: [...SERVED, ["example.org", "v1", "Widget"]] });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await new Promise((r) => setTimeout(r, 20));
    expect(hiddenCalls()).toEqual([]);
    expect(text()).toBe("");
  });

  it("without XRDs in the cluster: a managed resource still shows, nothing is watched", async () => {
    await open(managed(), RESOURCE_SECTION, { served: [["rds.aws.upbound.io", "v1beta1", "Instance"]] });
    await expect.poll(text).toContain("Managed resource");
    await new Promise((r) => setTimeout(r, 20));
    expect(watchOf("CompositeResourceDefinition")).toBeUndefined();
  });

  it("says when the XRDs cannot be read", async () => {
    const other: KubeObject = { apiVersion: "example.org/v1", kind: "Widget", metadata: { name: "w" }, spec: {} };
    await open(other, RESOURCE_SECTION);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit({ type: "error", code: "forbidden", message: "xrds are forbidden" } as WatchUpdate);
    await expect.poll(text).toContain("xrds are forbidden");
    expect(text()).toContain("Widget");
    expect(hiddenCalls()).toEqual([false]);
  });

  it("watches the XRDs only while a block that needs them is open", async () => {
    await open(managed(), RESOURCE_SECTION, { context: { blocks: { fields: false, chain: true } } });
    await expect.poll(text).toContain("Instance");
    await new Promise((r) => setTimeout(r, 20));
    expect(watchOf("CompositeResourceDefinition")).toBeUndefined();
  });
});

describe("details of Crossplane's own kinds", () => {
  it("of an XRD: the kinds it defines, its versions with their flags, Established and Offered", async () => {
    await open(xrd(), KINDS_SECTION);
    await expect.poll(text).toContain("Established: defines the composite resource XPostgreSQLInstance and the claim PostgreSQLInstance.");
    expect(text()).toContain("v1alpha1 (served, referenceable)");
    expect(byLabel("Open Composition xpostgresqlinstances.aws.database.example.org")).toHaveLength(1);
    expect(root.querySelector('[data-block="fields"] .sx-block__toggle')?.textContent).toBe("CompositeResourceDefinition");
  });

  it("of a version in another language: its flags joined by that language's list", async () => {
    setLanguage("ja");
    await open(xrd(), KINDS_SECTION);
    await expect.poll(text).toContain("v1alpha1");
    expect(root.querySelector(".sx-chip")?.textContent).toBe("v1alpha1（提供中、参照可能）");
  });

  it("of a Provider: why the package is not healthy", async () => {
    await open(provider(), KINDS_SECTION);
    await expect.poll(text).toContain("The package is installed but not healthy (UnhealthyPackageRevision).");
    expect(text()).toMatch(/incompatible dependencies/);
    expect(text()).toContain("xpkg.upbound.io/upbound/provider-aws-rds:v1.14.0");
  });

  it("of a Composition: the type, the mode and the pipeline with links to the Functions", async () => {
    const composition: KubeObject = {
      apiVersion: "apiextensions.crossplane.io/v1",
      kind: "Composition",
      metadata: { name: "xpostgresqlinstances.aws.database.example.org" },
      spec: { compositeTypeRef: { apiVersion: "database.example.org/v1alpha1", kind: "XPostgreSQLInstance" }, mode: "Pipeline", pipeline: [{ step: "patch-and-transform", functionRef: { name: "function-patch-and-transform" } }] },
    };
    await open(composition, KINDS_SECTION);
    await expect.poll(text).toContain("XPostgreSQLInstance.database.example.org/v1alpha1");
    expect(text()).toContain("Pipeline");
    expect([...root.querySelectorAll("tbody tr")].map((r) => r.textContent)).toEqual(["patch-and-transformfunction-patch-and-transform"]);
    expect(byLabel("Open Function function-patch-and-transform")).toHaveLength(1);
  });

  it("closes its block as Sextant remembers, and draws nothing inside then", async () => {
    await open(provider(), KINDS_SECTION, { context: { blocks: { fields: false } } });
    await expect.poll(() => root.querySelector('[data-block="fields"]')).not.toBeNull();
    expect(text()).not.toContain("not healthy");
    host.setContext({ blocks: { "*": true } });
    await expect.poll(text).toContain("not healthy");
  });
});

describe("the Composite Resources page", () => {
  it("watches the kinds the XRDs define and lists claims and composites, problems first", async () => {
    await openPage();
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(() => watchOf("XPostgreSQLInstance")).toBeDefined();
    expect(watchParams(watchOf("PostgreSQLInstance")!)).toMatchObject({ maxObjects: MAX_ROWS });
    expect(text()).toContain("Reading claims and composite resources…");
    const failing = claim();
    conditions(failing)[0] = { type: "Synced", status: "False", reason: "ReconcileError", message: "boom" };
    watchOf("PostgreSQLInstance")!.emit(snapshot([failing]));
    watchOf("XPostgreSQLInstance")!.emit(snapshot([composite()]));
    await expect.poll(() => byLabel("Open PostgreSQLInstance my-db")).toHaveLength(1);
    const rows = [...root.querySelectorAll("tbody tr")];
    expect(rows[0]!.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(rows[0]!.textContent).toContain("ReconcileError");
    expect(rows[0]!.querySelector(".xp-message")?.textContent).toBe("boom");
    expect(rows[1]!.textContent).toContain("XPostgreSQLInstance (composite)");
    expect(text()).toContain("Shown: 2");
    const only = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    // Sextant's own checkbox, from the SDK's UI kit.
    expect(only.closest("label")?.classList.contains("sx-checkbox")).toBe(true);
    expect(only.closest("label")?.textContent).toBe("Only problems");
    only.click();
    await expect.poll(() => byLabel("Open XPostgreSQLInstance my-db-x7k2p")).toHaveLength(0);
    expect(text()).toContain("Shown: 1");
  });

  it("says when a list is cut and when there are more XRDs than it watches", async () => {
    await openPage();
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    const many = Array.from({ length: MAX_XRDS + 1 }, (_, i) => {
      const x = xrd();
      x.metadata.name = `x${String(i).padStart(2, "0")}`;
      x.metadata.uid = `uid-${i}`;
      return x;
    });
    watchOf("CompositeResourceDefinition")!.emit(snapshot(many));
    await expect.poll(text).toContain(`Only the kinds of the first ${MAX_XRDS} XRDs are listed.`);
    await expect.poll(() => watchOf("PostgreSQLInstance")).toBeDefined();
    watchOf("PostgreSQLInstance")!.emit(snapshot([claim()]));
    watchOf("XPostgreSQLInstance")!.emit(snapshot([]));
    watchOf("PostgreSQLInstance")!.emit({ type: "capped", total: MAX_ROWS + 1 } as unknown as WatchUpdate);
    await expect.poll(text).toContain("Only the first 1 are listed.");
  });

  it("without XRDs: says the cluster defines no composite resources, and looks again for kinds not served yet", async () => {
    let served: Served = SERVED.filter(([, , kind]) => kind !== "PostgreSQLInstance" && kind !== "XPostgreSQLInstance");
    await openPage({ handlers: { kinds: () => kinds(served) } });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([]));
    await expect.poll(text).toContain("No XRDs: the cluster defines no composite resources.");
    served = SERVED;
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(() => watchOf("PostgreSQLInstance"), { timeout: 3000 }).toBeDefined();
    expect(calls("kinds").length).toBe(2);
  });

  it("asks discovery again when the cluster's kinds change, and lets go of what it no longer serves", async () => {
    let served: Served = SERVED;
    await openPage({ handlers: { kinds: () => kinds(served) }, context: { kindsVersion: 1 } });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(() => watchOf("PostgreSQLInstance")).toBeDefined();
    expect(calls("kinds")).toHaveLength(1);
    served = SERVED.filter(([group]) => group !== "apiextensions.crossplane.io");
    host.setContext({ kindsVersion: 2 });
    await expect.poll(() => calls("kinds").length).toBe(2);
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeUndefined();
    expect(watchOf("PostgreSQLInstance")).toBeUndefined();
  });
});

describe("the details follow discovery", () => {
  it("look up the XRDs' kind again when the cluster's kinds change", async () => {
    let served: Served = SERVED.filter(([group]) => group !== "apiextensions.crossplane.io");
    const other: KubeObject = { apiVersion: "database.example.org/v1alpha1", kind: "XPostgreSQLInstance", metadata: { name: "x" }, spec: {} };
    await open(other, RESOURCE_SECTION, { handlers: { kinds: () => kinds(served) }, context: { kindsVersion: 1 } });
    await expect.poll(() => calls("kinds").length).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(watchOf("CompositeResourceDefinition")).toBeUndefined();
    served = SERVED;
    host.setContext({ kindsVersion: 2 });
    await expect.poll(() => watchOf("CompositeResourceDefinition")).toBeDefined();
    watchOf("CompositeResourceDefinition")!.emit(snapshot([xrd()]));
    await expect.poll(text).toContain("Composite resource");
  });
});
