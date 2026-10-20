import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { detect } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { sourcesFor } from "../problems/sources";
import { resetSharedWatches } from "../resource-map/watches";
import storeJson from "./fixtures/clustersecretstore.json";
import esJson from "./fixtures/externalsecret.json";
import pushJson from "./fixtures/pushsecret.json";
import "./index";
import {
  CLUSTER_EXTERNAL_SECRET,
  CLUSTER_SECRET_STORE,
  dataFromOf,
  EXTERNAL_SECRET,
  isProblem,
  providerOf,
  PUSH_SECRET,
  pushKeysOf,
  readinessOf,
  remoteKeysOf,
  SECRET_STORE,
  storeRefOf,
  targetSecretName,
} from "./model";

const es = esJson as KubeObject;
const store = storeJson as KubeObject;
const push = pushJson as KubeObject;

describe("the model", () => {
  it("reads readiness, the store, the target Secret and the key names", () => {
    expect(readinessOf(es)).toMatchObject({ state: "failed", reason: "SecretSyncedError" });
    expect(readinessOf(push).state).toBe("ready");
    expect(readinessOf({ apiVersion: "v1", kind: "X", metadata: { name: "x" } }).state).toBe("pending");
    expect(storeRefOf(es)).toEqual({ name: "vault-backend", kind: "ClusterSecretStore" });
    expect(targetSecretName(es)).toBe("secret-to-be-created");
    const noTarget = copy(es);
    delete (noTarget.spec as Record<string, unknown>).target;
    expect(targetSecretName(noTarget)).toBe("example");
    expect(remoteKeysOf(es)).toEqual([
      { secretKey: "username", remoteKey: "provider-key", property: "username" },
      { secretKey: "password", remoteKey: "provider-key", property: "password" },
    ]);
    expect(dataFromOf(es)).toEqual([{ how: "extract", what: "remote-key-in-the-provider" }]);
    expect(providerOf(store)).toBe("vault");
    expect(pushKeysOf(push)).toEqual([{ secretKey: "best-pokemon", remoteKey: "my-first-parameter", property: undefined }]);
  });

  it("a failed sync and an invalid store are problems; a synced object is not", () => {
    expect(isProblem(es)).toBe(true);
    expect(isProblem(store)).toBe(true);
    expect(isProblem(push)).toBe(false);
    expect(detect(EXTERNAL_SECRET, es)).toEqual([
      expect.objectContaining({ reason: "SecretSyncedError", message: "could not get secret data from provider", notify: true }),
    ]);
    expect(detect(CLUSTER_SECRET_STORE, store)[0]?.reason).toBe("InvalidProviderConfig");
    expect(detect(PUSH_SECRET, push)).toEqual([]);
  });

  it("watches the kinds for problems only where they are served", () => {
    expect(sourcesFor(["externalSecrets"], [served(EXTERNAL_SECRET)]).map((s) => s.kind.kind)).toEqual(["ExternalSecret"]);
    expect(sourcesFor(["externalSecrets"], [served(POD)])).toEqual([]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
const ESO: KindRef[] = [EXTERNAL_SECRET, CLUSTER_EXTERNAL_SECRET, SECRET_STORE, CLUSTER_SECRET_STORE, PUSH_SECRET];
const CLUSTER_SCOPED = new Set(["ClusterExternalSecret", "ClusterSecretStore"]);

function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: !CLUSTER_SCOPED.has(kind.kind), verbs: ["list", "watch"], printerColumns: [] };
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
  discovery = [POD, SECRET, ...ESO];
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

describe("the External Secrets section", () => {
  it("lists the kinds the cluster serves and counts the objects in trouble", async () => {
    discovery = [POD, SECRET, EXTERNAL_SECRET, SECRET_STORE];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("External Secrets"));
    const header = screen.getAllByRole("button", { name: /External Secrets/ }).find((b) => b.hasAttribute("aria-expanded"))!;
    fireEvent.click(header);
    const section = within(header.closest("li")!);
    // The header and the ExternalSecrets entry share the name.
    expect(section.getAllByRole("button", { name: "External Secrets" })).toHaveLength(2);
    expect(section.getByRole("button", { name: "Secret Stores" })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Push Secrets" })).toBeNull();
    emitSnapshot(wb, await watchOf(wb, "ExternalSecret"), [es]);
    emitSnapshot(wb, await watchOf(wb, "SecretStore"), []);
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the operator's CRDs", async () => {
    discovery = [POD, SECRET];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Config"));
    expect(sections()).not.toContain("External Secrets");
  });

  it("the table shows the state, the store and the target Secret", () => {
    const def = getResourceDef(EXTERNAL_SECRET);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "store", "target", "refresh", "lastSync", "reason", "age"]);
    expect(col("store").value(es)).toBe("ClusterSecretStore/vault-backend");
    expect(col("target").value(es)).toBe("secret-to-be-created");
    expect(def.problem?.(es)).toBe(true);
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

const section = () => document.querySelector<HTMLElement>("[data-section='externalSecrets']")!;

describe("details of an ExternalSecret", () => {
  it("says why the sync failed, whether the store is ready, links the Secret and names the keys, never their values", async () => {
    const container = await openDetails(es);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getAllByText("Failed")[0]).toHaveClass("rt-status--danger");
    expect(view.getByText("could not get secret data from provider")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open ClusterSecretStore vault-backend" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Secret secret-to-be-created" })).toBeInTheDocument();
    expect(view.getAllByText("provider-key")).toHaveLength(2);
    expect(view.getByText("Every property of remote-key-in-the-provider")).toBeInTheDocument();
    expect(view.getByText("Only the names of the keys are shown, never their values.")).toBeInTheDocument();

    // The store is watched by its name, cluster-wide (a ClusterSecretStore), and its state shown.
    const storeWatch = await watchOf(wb, "ClusterSecretStore", (s) => s.fieldSelector === "metadata.name=vault-backend");
    expect(wb.specs.get(storeWatch)?.namespaces).toBeNull();
    emitSnapshot(wb, storeWatch, [store]);
    await waitFor(() => expect(view.getAllByText("Failed")).toHaveLength(2));

    // No Secret is ever read: neither its value nor the full object.
    expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("secret_value");
    expect(wb.backend.calls.map((c) => c.cmd)).not.toContain("resource_get_full");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Secret")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a missing store is said so", async () => {
    await openDetails(es);
    emitSnapshot(wb, await watchOf(wb, "ClusterSecretStore", (s) => s.fieldSelector === "metadata.name=vault-backend"), []);
    await waitFor(() => expect(within(section()).getByText("Store not found")).toHaveClass("rt-status--danger"));
  });
});

describe("details of a store and a PushSecret", () => {
  it("a ClusterSecretStore's validation and provider", async () => {
    const container = await openDetails(store);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getByText("InvalidProviderConfig")).toBeInTheDocument();
    expect(view.getByText("vault")).toBeInTheDocument();
    expect(view.getByText("unable to validate store: invalid vault credentials")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a PushSecret's source Secret and remote keys", async () => {
    await openDetails(push);
    await waitFor(() => expect(section()).not.toBeNull());
    const view = within(section());
    expect(view.getByRole("button", { name: "Open Secret pokedex-credentials" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open SecretStore aws-parameterstore" })).toBeInTheDocument();
    expect(view.getByText("my-first-parameter")).toBeInTheDocument();
  });
});
