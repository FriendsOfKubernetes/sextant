import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAppSettings,
  mockBackend,
  type AppSettings,
  type ClusterInfo,
  type CompareKindList,
  type DriftObject,
  type HelmDrift,
  type KindRef,
  type KubeObject,
  type MockBackend,
  type SecretComparison,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { getResourceDef } from "../../resources/registry";
import { useClustersStore } from "../clusters/clustersStore";
import { CompareDialog } from "./CompareDialog";
import { NamespaceComparePage } from "./NamespaceComparePage";
import "./index";

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const cluster = (id: string): ClusterInfo => ({ id, context: id, clusterName: id, server: `https://${id}`, user: "u", namespace: null, sourceId: "s" });
const CLUSTERS = [cluster("staging"), cluster("prod"), cluster("dr")];
const configMap: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
const secretKind: KindRef = { group: "", version: "v1", kind: "Secret" };

const cm = (mode: string, annotations: Record<string, string> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "app", namespace: "team", uid: `u-${mode}`, resourceVersion: "1", annotations },
  data: { mode },
});

let backend: MockBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  stored = defaultAppSettings();
  backend = mockBackend({
    settings_get: () => structuredClone(stored),
    settings_update: (args) => {
      stored = structuredClone(args.settings as AppSettings);
      return structuredClone(stored);
    },
    clusters_list: () => CLUSTERS,
    kubeconfig_sources: () => [],
    cluster_connect: () => undefined,
    cluster_kinds: () => [],
    resource_get: (args) => (args.clusterId === "staging" ? cm("blue") : cm("green")),
  });
  useClustersStore.setState({
    loaded: true,
    clusters: CLUSTERS,
    states: { staging: { state: "connected" }, prod: { state: "connected" }, dr: { state: "disconnected" } },
  });
});
afterEach(() => backend.restore());

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

describe("the action", () => {
  it("is offered for every kind, built-in and custom", () => {
    expect(getResourceDef(configMap).actions).toContain("compareWith");
    expect(getResourceDef({ group: "example.com", version: "v1", kind: "Widget" }).actions).toContain("compareWith");
  });
});

describe("compare with another object", () => {
  it("offers only connected clusters, connects one only on click, and diffs the normalized objects", async () => {
    render(<CompareDialog clusterId="staging" kind={configMap} object={cm("blue")} onClose={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Cluster" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["staging", "prod"]);
    expect(calls("cluster_connect")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls("cluster_connect")).toHaveLength(1));
    expect(calls("cluster_connect")[0]?.args.clusterId).toBe("dr");

    fireEvent.change(select, { target: { value: "prod" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("1 field differs.")).toBeTruthy();
    const reads = calls("resource_get").map((c) => c.args.clusterId);
    expect(reads).toEqual(["staging", "prod"]);
  });

  it("says when the counterpart is the object itself", () => {
    render(<CompareDialog clusterId="staging" kind={configMap} object={cm("blue")} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByText(/That is this object/)).toBeTruthy();
    expect(calls("resource_get")).toHaveLength(0);
  });

  it("compares Secrets by hash in the backend and reads a value only on 'Show values'", async () => {
    const secret: KubeObject = { apiVersion: "v1", kind: "Secret", metadata: { name: "creds", namespace: "team" }, data: { password: "" } };
    const comparison: SecretComparison = {
      left: "found",
      right: "found",
      keys: [{ key: "password", onLeft: true, onRight: true, equal: false }],
    };
    backend.on("resource_get", () => structuredClone(secret));
    backend.on("compare_secrets", () => comparison);
    backend.on("secret_value", (args) => `value-of-${String(args.clusterId)}`);
    render(<CompareDialog clusterId="staging" kind={secretKind} object={secret} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Cluster" }), { target: { value: "prod" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("Different value")).toBeTruthy();
    expect(calls("compare_secrets")[0]?.args).toMatchObject({
      left: { clusterId: "staging", namespace: "team", name: "creds" },
      right: { clusterId: "prod", namespace: "team", name: "creds" },
    });
    expect(calls("secret_value")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show values" }));
    expect(await screen.findByText("value-of-prod")).toBeTruthy();
    expect(calls("secret_value").map((c) => c.args.clusterId)).toEqual(["staging", "prod"]);
  });
});

describe("drift", () => {
  it("shows what the last-applied configuration sets that the live object changed", async () => {
    const applied = JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app", namespace: "team" }, data: { mode: "red" } });
    const live = cm("blue", { "kubectl.kubernetes.io/last-applied-configuration": applied });
    backend.on("resource_get", () => structuredClone(live));
    render(<CompareDialog clusterId="staging" kind={configMap} object={live} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Its last-applied configuration" }));
    expect(await screen.findByText("1 field differs from the last-applied configuration.")).toBeTruthy();
    expect(screen.getByText("/data/mode")).toBeTruthy();
  });

  it("compares with the Helm release manifest and checks the whole release on request", async () => {
    const live = cm("blue", { "meta.helm.sh/release-name": "web", "meta.helm.sh/release-namespace": "team" });
    const drift: HelmDrift = {
      release: "web",
      namespace: "team",
      revision: 4,
      unreadable: 0,
      truncated: 0,
      objects: [
        { object: { kind: configMap, namespace: "team", name: "app" }, rendered: { kind: "ConfigMap", metadata: { name: "app" }, data: { mode: "red" } }, live: live as DriftObject["live"], error: null },
        { object: { kind: { group: "", version: "v1", kind: "Service" }, namespace: "team", name: "gone" }, rendered: { kind: "Service", metadata: { name: "gone" } }, live: null, error: null },
      ],
    };
    backend.on("compare_helm_drift", () => drift);
    render(<CompareDialog clusterId="staging" kind={configMap} object={live} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: "Its last-applied configuration" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Its Helm release manifest" }));
    expect(await screen.findByText("/data/mode")).toBeTruthy();
    expect(calls("compare_helm_drift")[0]?.args).toEqual({ clusterId: "staging", namespace: "team", name: "web" });
    fireEvent.click(screen.getByRole("button", { name: "Check all of Helm release web" }));
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.getByText("1 difference")).toBeTruthy();
  });
});

describe("compare namespaces", () => {
  const list = (objects: KubeObject[]): CompareKindList[] => [{ kind: configMap, objects: objects as CompareKindList["objects"], truncated: false, error: null }];
  const named = (name: string, mode: string): KubeObject => ({ ...cm(mode), metadata: { name, namespace: "x", uid: `${name}${mode}` } });

  it("lists objects per bucket and shows one object's diff on click", async () => {
    backend.on("compare_list", (args) =>
      args.clusterId === "staging" ? list([named("a", "1"), named("b", "1"), named("only-l", "1")]) : list([named("a", "1"), named("b", "2"), named("only-r", "1")]),
    );
    backend.on("compare_secret_namespaces", () => ({ secrets: [], truncated: false }));
    render(<NamespaceComparePage clusterId="staging" />);
    const [, right] = screen.getAllByRole("group");
    fireEvent.change(within(right as HTMLElement).getByRole("combobox", { name: "Cluster" }), { target: { value: "prod" } });
    fireEvent.change(within(right as HTMLElement).getByRole("textbox", { name: "Namespace" }), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("Different (1)")).toBeTruthy();
    expect(screen.getByText("Only on the left (1)")).toBeTruthy();
    expect(screen.getByText("Same (1)")).toBeTruthy();
    const kinds = calls("compare_list")[0]?.args.kinds as KindRef[];
    expect(kinds.map((k) => k.kind)).toContain("Secret");
    expect(calls("compare_secret_namespaces")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "a" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(await screen.findByText("1 field differs.")).toBeTruthy();
  });
});
