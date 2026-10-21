import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchState } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { judgedByRules, sourcesFor } from "../problems/sources";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import {
  base64Bytes,
  failureHint,
  isProblem,
  scopeOf,
  SEALED_SECRET,
  sealedKeys,
  syncOf,
  targetRelation,
  templateOf,
} from "./model";
import { MAX_SECRET_NAMESPACES, namespacesToCheck, secretExists, SYNC_GRACE_MS, TARGET_GRACE_MS, toProblems } from "./provider";

const synced = fixtures.synced as KubeObject;
const failed = fixtures.failed as KubeObject;
const clusterWide = fixtures.clusterWide as KubeObject;
const controller = fixtures.controller as KubeObject;
const target = fixtures.target as KubeObject;
const sealingKey = fixtures.sealingKey as KubeObject;

const ready = (items: KubeObject[]): WatchState => ({ status: "ready", items: new Map(items.map((o) => [o.metadata?.uid ?? "", o])) });

describe("the model", () => {
  it("reads the Synced condition as the controller writes it, and a status of an older generation as pending", () => {
    expect(syncOf(synced)).toMatchObject({ state: "ready", noStatus: false, stale: false });
    expect(syncOf(failed)).toMatchObject({ state: "failed", message: "no key could decrypt secret (password, username)" });
    // observedGeneration 2 of generation 3: the status is of the old spec.
    expect(syncOf(clusterWide)).toMatchObject({ state: "progressing", stale: true });
    const none = copy(synced);
    delete none.status;
    expect(syncOf(none)).toMatchObject({ state: "progressing", noStatus: true });
    expect(isProblem(failed)).toBe(true);
    expect(isProblem(synced)).toBe(false);
  });

  it("reads the scope from the SealedSecret's own annotations, cluster-wide first", () => {
    expect(scopeOf(synced)).toBe("strict");
    expect(scopeOf(clusterWide)).toBe("clusterWide");
    const ns = copy(synced);
    ns.metadata = { ...ns.metadata, annotations: { "sealedsecrets.bitnami.com/namespace-wide": "true" } };
    expect(scopeOf(ns)).toBe("namespaceWide");
    ns.metadata.annotations = { "sealedsecrets.bitnami.com/namespace-wide": "yes" };
    expect(scopeOf(ns)).toBe("strict");
  });

  it("names the keys with their sealed sizes and the template's keys, never a value", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AA==")).toBe(1);
    expect(sealedKeys(failed)).toEqual([
      { name: "password", sealedBytes: base64Bytes("AgA1b2c3d4e5f6g7h8i9j0kLmNoPqRsTuVwXyZ0123456789+/==") },
      { name: "username", sealedBytes: 19 },
    ]);
    expect(templateOf(clusterWide)).toEqual({
      type: "kubernetes.io/dockerconfigjson",
      immutable: true,
      skipOwnerReferences: true,
      dataKeys: [
        { name: "config.yaml", omitted: false },
        { name: "legacy", omitted: true },
      ],
    });
  });

  it("tells how the Secret stands by the controller's own test", () => {
    expect(targetRelation(synced, target)).toBe("owned");
    const other = copy(target);
    (other.metadata!.ownerReferences as { uid: string }[])[0]!.uid = "someone-else";
    expect(targetRelation(synced, other)).toBe("ownedByOther");
    const plain = copy(target);
    delete plain.metadata!.ownerReferences;
    expect(targetRelation(synced, plain)).toBe("unmanaged");
    plain.metadata!.annotations = { "sealedsecrets.bitnami.com/managed": "true" };
    expect(targetRelation(synced, plain)).toBe("managed");
  });

  it("explains the controller's errors by their texts", () => {
    expect(failureHint("no key could decrypt secret (password)")).toBe("noKey");
    expect(failureHint('failed update: Resource "x" already exists and is not managed by SealedSecret')).toBe("unmanaged");
    expect(failureHint("Secret \"x\" is invalid: data: Forbidden: field is immutable when `immutable` is set")).toBe("immutable");
    expect(failureHint("using deprecated 'data' field, use 'encryptedData' or flip the feature flag")).toBe("legacyData");
    expect(failureHint("something else")).toBeUndefined();
  });
});

describe("the problems", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("a failed unseal counts after the grace from its transition, with the controller's message", () => {
    const [p] = toProblems([failed], () => true, new Map(), now);
    expect(p).toMatchObject({
      category: "sealedSecrets",
      reason: "SyncFailed",
      message: "no key could decrypt secret (password, username)",
      activeAt: Date.parse("2025-10-15T08:00:00Z") + SYNC_GRACE_MS,
      object: { kind: SEALED_SECRET, namespace: "shop", name: "db-credentials" },
    });
  });

  it("a synced SealedSecret whose Secret is missing counts after its own grace; one not known is not judged", () => {
    const [p] = toProblems([synced], () => false, new Map(), now);
    expect(p).toMatchObject({ reason: "TargetMissing", messageKey: "messages.sealedSecretTargetMissing", messageParams: { name: "mysecret" } });
    expect(p!.activeAt).toBe(now + TARGET_GRACE_MS);
    expect(toProblems([synced], () => undefined, new Map(), now)).toEqual([]);
    expect(toProblems([synced], () => true, new Map(), now)).toEqual([]);
    // A pending one (a status of an older generation) is not judged against its Secret.
    expect(toProblems([clusterWide], () => false, new Map(), now)).toEqual([]);
  });

  it("looks at the Secrets of the synced SealedSecrets' namespaces only, and only in lists read in full", () => {
    expect(namespacesToCheck([synced, failed, clusterWide])).toEqual(["mynamespace"]);
    expect(secretExists(ready([target]), "mynamespace", "mysecret")).toBe(true);
    expect(secretExists(ready([]), "mynamespace", "mysecret")).toBe(false);
    expect(secretExists({ ...ready([]), forbidden: ["mynamespace"] }, "mynamespace", "mysecret")).toBeUndefined();
    expect(secretExists({ ...ready([]), total: 6000 }, "mynamespace", "mysecret")).toBeUndefined();
    expect(secretExists(undefined, "mynamespace", "mysecret")).toBeUndefined();
    expect(MAX_SECRET_NAMESPACES).toBe(20);
  });

  it("is a category of its own, judged by its provider only where SealedSecrets are served", () => {
    expect(categoryOf(SEALED_SECRET)).toBe("sealedSecrets");
    // Opt-in like Traefik and Reflector (ADR-0109, amended): a cluster-wide SealedSecret list and Secret metadata.
    expect(OPT_IN_CATEGORIES).toContain("sealedSecrets");
    expect(detect(SEALED_SECRET, failed)).toEqual([]);
    expect(judgedByRules(SEALED_SECRET)).toBe(false);
    expect(sourcesFor(["sealedSecrets"], [served(SEALED_SECRET)])).toEqual([expect.objectContaining({ external: true })]);
    expect(sourcesFor(["sealedSecrets"], [served(POD)])).toEqual([]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
}

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
  discovery = [POD, SECRET, DEPLOYMENT, SEALED_SECRET];
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

/** Every Secret watch is metadata only, and no Secret value or full Secret is ever asked for. */
function expectNoSecretData(): void {
  const secretSpecs = [...wb.specs.values()].filter((s) => s.kind.kind === "Secret");
  expect(secretSpecs.every((s) => s.metadataOnly === true)).toBe(true);
  expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("secret_value");
  expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("resource_get_full");
}

describe("the Sealed Secrets section", () => {
  it("is there where the cluster serves SealedSecrets; its counter watches nothing while the opt-in category is off", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Sealed Secrets"));
    await new Promise((r) => setTimeout(r, 100));
    expect([...wb.specs.values()].some((s) => s.kind.kind === "SealedSecret" || s.kind.kind === "Secret")).toBe(false);
    expect(screen.queryByTitle("1 object needs attention")).toBeNull();
  });

  it("turned on, counts the failed ones and missing Secrets", async () => {
    stored = { ...stored, notifications: { ...stored.notifications, enabledCategories: ["sealedSecrets"] } };
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Sealed Secrets"));
    const header = screen.getAllByRole("button", { name: /Sealed Secrets/ }).find((b) => b.hasAttribute("aria-expanded"))!;
    fireEvent.click(header);
    expect(within(header.closest("li")!).getAllByRole("button", { name: "Sealed Secrets" })).toHaveLength(2);
    const sealedWatch = await watchOf(wb, "SealedSecret", (s) => s.namespaces === null);
    const start = wb.backend.calls.find((c) => c.cmd === "watch_start" && (c.args.spec as { kind: KindRef }).kind.kind === "SealedSecret")!;
    expect(start.args.options).toEqual({ progressive: false, maxObjects: 5000 });
    const old = copy(synced);
    old.metadata!.creationTimestamp = "2025-01-01T00:00:00Z";
    emitSnapshot(wb, sealedWatch, [failed, old]);
    // The Secrets of the synced one's namespace, metadata only; its Secret is not there.
    const secrets = await watchOf(wb, "Secret", (s) => s.namespaces?.join() === "mynamespace");
    emitSnapshot(wb, secrets, []);
    // The failed one counts at once (its grace is long over); the missing Secret only after its own grace.
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
    expectNoSecretData();
  });

  it("is not there without the controller's CRD", async () => {
    discovery = [POD, SECRET];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Config"));
    expect(sections()).not.toContain("Sealed Secrets");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "SealedSecret" || s.kind.kind === "Secret")).toBe(false);
  });

  it("the table shows the state, the scope and the number of keys", () => {
    const def = getResourceDef(SEALED_SECRET);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "scope", "keys", "message", "age"]);
    expect(col("status").value(failed)).toBe("failed");
    expect(col("scope").value(clusterWide)).toBe("clusterWide");
    expect(col("keys").value(synced)).toBe(2);
    expect(def.problem?.(failed)).toBe(true);
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return { kind: { group: group ?? "", version: version ?? "", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  return container;
}

const section = () => document.querySelector<HTMLElement>("[data-section='sealedSecrets']")!;

async function answerController(deployments: KubeObject[]): Promise<void> {
  emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=sealed-secrets-controller"), deployments);
  emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.labelSelector === "app.kubernetes.io/name=sealed-secrets"), deployments);
}

describe("details of a SealedSecret", () => {
  it("says it is synced, links its Secret and how it stands, names the keys and finds the controller", async () => {
    const container = await openDetails(synced);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getAllByText("Synced")[0]).toHaveClass("rt-status--success");
    expect(view.getByText("Strict: unseals only under this name in this namespace")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Secret mysecret" })).toBeInTheDocument();
    const secretWatch = await watchOf(wb, "Secret", (s) => s.fieldSelector === "metadata.name=mysecret");
    expect(wb.specs.get(secretWatch)).toMatchObject({ namespaces: ["mynamespace"], metadataOnly: true });
    emitSnapshot(wb, secretWatch, [target]);
    await waitFor(() => expect(view.getByText("Managed by this SealedSecret")).toHaveClass("rt-status--success"));
    expect(view.getByText("foo")).toBeInTheDocument();
    expect(view.getByText("Only the names of the keys and the sizes of their sealed values are shown, never the values.")).toBeInTheDocument();
    // The ciphertext itself is not in the section.
    expect(section().textContent).not.toContain("AgBy3i4OJSWK");

    await answerController([controller]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open Deployment sealed-secrets-controller" })).toBeInTheDocument());
    expect(view.getByText("1 of 1 ready")).toHaveClass("rt-status--success");
    expect(view.getByText("docker.io/bitnami/sealed-secrets-controller:0.32.2")).toBeInTheDocument();
    const keys = await watchOf(wb, "Secret", (s) => s.labelSelector === "sealedsecrets.bitnami.com/sealed-secrets-key");
    expect(wb.specs.get(keys)).toMatchObject({ namespaces: ["kube-system"], metadataOnly: true });
    emitSnapshot(wb, keys, [sealingKey]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open Secret sealed-secrets-keyx7k2p" })).toBeInTheDocument());
    expect(view.getByText("active")).toBeInTheDocument();
    expectNoSecretData();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says why the unseal failed and what it means; a missing Secret and controller are said so", async () => {
    const container = await openDetails(failed);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getAllByText("Failed")[0]).toHaveClass("rt-status--danger");
    expect(view.getByText("no key could decrypt secret (password, username)")).toBeInTheDocument();
    expect(view.getByText(/No sealing key of this controller decrypts it/)).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "Secret", (s) => s.fieldSelector === "metadata.name=db-credentials"), []);
    await waitFor(() => expect(view.getByText("Not found")).toHaveClass("rt-status--danger"));
    await answerController([]);
    await waitFor(() => expect(view.getByText(/No controller found as Deployment sealed-secrets-controller/)).toBeInTheDocument());
    expectNoSecretData();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a cluster-wide one with a status of an older generation, its template keys and no owner reference", async () => {
    await openDetails(clusterWide);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getAllByText("Pending")[0]).toHaveClass("rt-status--warning");
    expect(view.getByText("The controller has not processed the latest change yet: the status is of an older generation.")).toBeInTheDocument();
    expect(view.getByText("Cluster-wide: unseals under any name in any namespace")).toBeInTheDocument();
    expect(view.getByText("legacy (left out)")).toBeInTheDocument();
    expect(view.getByText("Not set (annotation skip-set-owner-references)")).toBeInTheDocument();
    expect(view.getByText("2 of 3 observed by the controller")).toBeInTheDocument();
  });
});
