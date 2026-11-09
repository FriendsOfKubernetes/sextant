// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import objectsJson from "../fixtures/objects.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";

const objects = objectsJson as unknown as KubeObject[];
const find = (kind: string, name: string, namespace?: string): KubeObject =>
  structuredClone(objects.find((o) => o.kind === kind && o.metadata.name === name && (namespace === undefined || o.metadata.namespace === namespace))!);

const SECTION: Record<string, string> = {
  Subscription: "subscription",
  ClusterServiceVersion: "csv",
  InstallPlan: "install-plan",
  CatalogSource: "catalog-source",
  OperatorGroup: "operator-group",
  Operator: "operator",
  ClusterExtension: "cluster-extension",
  ClusterCatalog: "cluster-catalog",
};

const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: SECTION[obj.kind!], selection: [ref(obj)], resourceVersion: "1" },
    handlers: { "resources.get": () => structuredClone(obj) },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, SECTION[obj.kind!]!);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; fieldSelector?: string; labelSelector?: string };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });

describe("details", () => {
  it("of a Subscription waiting for approval: the plan, the CSVs and the pending upgrade", async () => {
    await open(find("Subscription", "etcd"));
    expect(text()).toContain("The InstallPlan install-q9w4m waits for a manual approval");
    expect(text()).toContain("An upgrade from etcdoperator.v0.9.2 to etcdoperator.v0.9.4-clusterwide is pending.");
    await expect.poll(() => watchOf("InstallPlan")).toBeDefined();
    expect(watchParams(watchOf("InstallPlan")!)).toMatchObject({ namespaces: ["operators"], fieldSelector: "metadata.name=install-q9w4m" });
    expect(watchParams(watchOf("ClusterServiceVersion")!)).toMatchObject({ namespaces: ["operators"], fieldSelector: "metadata.name=etcdoperator.v0.9.2" });
    watchOf("InstallPlan")!.emit(snapshot([find("InstallPlan", "install-q9w4m")]));
    watchOf("ClusterServiceVersion")!.emit(snapshot([find("ClusterServiceVersion", "etcdoperator.v0.9.2")]));
    await expect.poll(text).toContain("RequiresApproval");
    expect(text()).toContain("Succeeded");
    expect(byLabel("Open InstallPlan install-q9w4m")).toHaveLength(1);
    expect(byLabel("Open ClusterServiceVersion etcdoperator.v0.9.2")).toHaveLength(1);
    // In the fields and in the catalog health.
    expect(byLabel("Open CatalogSource operatorhubio-catalog")).toHaveLength(2);
    expect(root.querySelector(".sx-status--warning")?.textContent).toBe("Waiting for approval");
    byLabel("Open InstallPlan install-q9w4m")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "operators.coreos.com", version: "v1alpha1", kind: "InstallPlan" },
      namespace: "operators",
      name: "install-q9w4m",
    });
  });

  it("of a failed CSV: why, the unmet requirement, its Deployments by OLM's labels", async () => {
    await open(find("ClusterServiceVersion", "broken-operator.v1.0.0", "operators"));
    expect(text()).toContain("InstallCheckFailed: install timeout");
    expect(text()).toContain("1 requirement is not met.");
    await expect.poll(() => watchOf("Deployment")).toBeDefined();
    expect(watchParams(watchOf("Deployment")!)).toMatchObject({
      namespaces: ["operators"],
      labelSelector: "olm.owner=broken-operator.v1.0.0,olm.owner.kind=ClusterServiceVersion",
    });
    expect(text()).toContain("Loading…");
    watchOf("Deployment")!.emit(snapshot([find("Deployment", "broken-operator")]));
    await expect.poll(text).toContain("Not available");
    expect(text()).toContain("Not found");
    expect(byLabel("Open CustomResourceDefinition widgets.example.com")).toHaveLength(1);
    // The Subscription that installed it.
    watchOf("Subscription")!.emit(snapshot([find("Subscription", "prometheus"), find("Subscription", "broken-operator")]));
    await expect.poll(() => byLabel("Open Subscription broken-operator")).toHaveLength(0);
    const installed = find("Subscription", "broken-operator");
    (installed.status as Record<string, unknown>).installedCSV = "broken-operator.v1.0.0";
    watchOf("Subscription")!.emit(snapshot([installed]));
    await expect.poll(() => byLabel("Open Subscription broken-operator")).toHaveLength(1);
  });

  it("of a CSV whose Deployments cannot be listed: cannot tell", async () => {
    await open(find("ClusterServiceVersion", "broken-operator.v1.0.0", "operators"));
    await expect.poll(() => watchOf("Deployment")).toBeDefined();
    watchOf("Deployment")!.emit({ type: "error", code: "forbidden", message: "no" } as WatchUpdate);
    await expect.poll(text).toContain("Cannot tell");
  });

  it("of a CSV copy: says it is one and links the original, with no Deployments of its own", async () => {
    await open(find("ClusterServiceVersion", "prometheusoperator.0.70.0", "default"));
    expect(text()).toContain("the operator runs in operators");
    const original = byLabel("Open ClusterServiceVersion prometheusoperator.0.70.0");
    expect(original[0]?.textContent).toBe("operators/prometheusoperator.0.70.0");
    expect(host.watches).toHaveLength(0);
  });

  it("of an InstallPlan: approval, steps without manifests; nothing to approve it with", async () => {
    await open(find("InstallPlan", "install-q9w4m"));
    expect(text()).toContain("Sextant shows install plans but does not approve them");
    expect(text()).toContain("etcd-operator-webhook-cert");
    expect(text()).not.toContain("c2VjcmV0LXZhbHVl");
    expect([...root.querySelectorAll("button")].some((b) => /approve/i.test(b.textContent ?? ""))).toBe(false);
    expect(host.watches).toHaveLength(0);
  });

  it("of a failed InstallPlan: the reason and the bundle lookup", async () => {
    await open(find("InstallPlan", "install-z3v8b"));
    expect(text()).toContain("InstallComponentFailed: error creating clusterrole broken-operator: forbidden");
    expect(text()).toContain("BundleLookupFailed: unpack job not completed: DeadlineExceeded");
  });

  it("of a CatalogSource, an OperatorGroup and an Operator", async () => {
    await open(find("CatalogSource", "broken-catalog"));
    expect(text()).toContain("The catalog's registry connection is TRANSIENT_FAILURE: Subscriptions cannot resolve from it.");
    expect(byLabel("Open Service broken-catalog")).toHaveLength(1);
    stop();
    host.close();
    await open(find("OperatorGroup", "team-a"));
    expect(text()).toContain("TechPreviewUnsafeFailForward: OLM upgrades past failed installs");
    stop();
    host.close();
    await open(find("Operator", "prometheus.operators"));
    expect(byLabel("Open Subscription prometheus")).toHaveLength(1);
    expect(text()).toContain("Succeeded=True");
  });

  it("of OLM v1's ClusterExtension and ClusterCatalog", async () => {
    await open(find("ClusterExtension", "cert-manager"));
    expect(text()).toContain("error upgrading from currently installed version: no bundles found");
    expect(text()).toContain("True (Retrying)");
    stop();
    host.close();
    await open(find("ClusterCatalog", "operatorhubio"));
    expect(text()).toContain("True (Available)");
    expect(text()).toContain("quay.io/operatorhubio/catalog:latest");
  });

  it("in another language", async () => {
    setLanguage("de");
    await open(find("Subscription", "prometheus"));
    expect(text()).toContain("Paket");
  });
});
