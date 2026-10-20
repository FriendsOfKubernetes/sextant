// The Connectivity page, the policy map and the details sections against a mock backend.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getPages } from "../../layout/pages";
import { getDetailsSections } from "../../layout/details/registry";
import { resetClusterKinds } from "../../resources";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { ConnectivityPage } from "./ConnectivityPage";
import { PodIsolationSection, PolicySection } from "./details";
import { NAMESPACE, NETWORK_POLICY, POD, SERVICE } from "./hooks";
import "./index";
import { CONNECTIVITY_PAGE, resetConnectivity, useConnectivityStore } from "./state";
import { namespace, netpol, pod, service } from "./testData";

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetSharedWatches();
  resetConnectivity();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [served(POD), served(SERVICE), served(NAMESPACE, false), served(NETWORK_POLICY)]);
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

const NAMESPACES = [namespace("shop", { team: "shop" }), namespace("payments", { team: "payments" }), namespace("kube-system")];
const client = pod("shop", "client", { app: "client" }, { ip: "10.0.1.5" });
const web = pod("shop", "web", { app: "web" }, { ip: "10.0.1.6", ports: [{ name: "http", containerPort: 8080 }] });
const web2 = pod("shop", "web-2", { app: "web" }, { ip: "10.0.1.7", ports: [{ name: "http", containerPort: 9090 }] });
const api = pod("payments", "api", { app: "api" }, { ip: "10.0.2.7" });
const dns = pod("kube-system", "coredns", { "k8s-app": "kube-dns" }, { ip: "10.0.0.10", ports: [{ name: "dns", containerPort: 53, protocol: "UDP" }] });

const inNs = (ns: string) => (spec: WatchSpec) => JSON.stringify(spec.namespaces) === JSON.stringify([ns]) && spec.labelSelector === null;
const everywhere = (spec: WatchSpec) => spec.namespaces === null;

async function feedNamespaces() {
  emitSnapshot(wb, await watchOf(wb, "Namespace", everywhere), NAMESPACES);
}

async function feed(ns: string, pods: KubeObject[], policies: KubeObject[], services?: KubeObject[]) {
  emitSnapshot(wb, await watchOf(wb, "Pod", inNs(ns)), pods);
  emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", (s) => s.kind.group === "networking.k8s.io" && inNs(ns)(s)), policies);
  if (services) emitSnapshot(wb, await watchOf(wb, "Service", inNs(ns)), services);
}

async function feedDns() {
  emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "k8s-app=kube-dns"), [dns]);
}

const combo = (name: string, index = 0) => screen.getAllByRole("combobox", { name })[index]!;
const choose = (name: string, value: string, index = 0) => fireEvent.change(combo(name, index), { target: { value } });
const result = () => screen.getByRole("region", { name: "Result" });

function setForm(form: Partial<ReturnType<typeof useConnectivityStore.getState>["clusters"][string]["form"]>) {
  useConnectivityStore.getState().patch("c1", {
    form: { ...useConnectivityStore.getState().clusters.c1?.form, ...form } as never,
  });
}

describe("the Connectivity page", () => {
  it("is a page of the Network section after NetworkPolicies", () => {
    expect(getPages("network").find((p) => p.id === CONNECTIVITY_PAGE)).toMatchObject({ order: 55, labelKey: "netpol:sidebar", icon: "connectivity" });
  });

  it("checks pod to pod: the ingress rule that allows, by index, peer and port", async () => {
    render(<ConnectivityPage clusterId="c1" />);
    expect(screen.getByRole("note")).toHaveTextContent(/not from live traffic/);
    await feedNamespaces();
    await screen.findAllByRole("option", { name: "payments" });
    choose("Namespace", "shop", 0);
    choose("Namespace", "shop", 1);
    const allow = netpol("shop", "web-in", {
      podSelector: { matchLabels: { app: "web" } },
      ingress: [
        { from: [{ podSelector: { matchLabels: { app: "admin" } } }] },
        { from: [{ namespaceSelector: { matchLabels: { team: "ops" } } }, { podSelector: { matchLabels: { app: "client" } } }], ports: [{ port: "http" }] },
      ],
    });
    await feed("shop", [client, web], [allow]);
    await screen.findAllByRole("option", { name: "client" });
    choose("Pod", "client", 0);
    choose("Pod", "web", 1);
    fireEvent.change(screen.getByRole("textbox", { name: "Port" }), { target: { value: "http" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await feedDns();
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Allowed: the policies allow this traffic."));
    const ingress = within(result()).getByRole("region", { name: "Ingress to shop/web" });
    expect(ingress).toHaveTextContent("shop/web-in");
    expect(ingress).toHaveTextContent("Ingress rule 2 · peer 2: Pods matching app=client in namespace shop · port 1: TCP port named http");
    expect(within(result()).getByRole("region", { name: "Egress from shop/client" })).toHaveTextContent("No policy selects the source for egress");
    // Only the namespaces of the question are watched.
    const podWatches = [...wb.specs.values()].filter((s) => s.kind.kind === "Pod").map((s) => s.namespaces);
    expect(podWatches.every((ns) => ns !== null)).toBe(true);
  });

  it("says why a namespaceSelector does not match, with the namespace's labels", async () => {
    setForm({ sourceType: "pod", sourceNamespace: "payments", sourcePod: "api", destinationType: "pod", destinationNamespace: "shop", destinationPod: "web", port: "8080", protocol: "TCP" });
    useConnectivityStore.getState().patch("c1", { checked: useConnectivityStore.getState().clusters.c1!.form });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    const deny = netpol("shop", "from-ops", { podSelector: {}, ingress: [{ from: [{ namespaceSelector: { matchLabels: { team: "ops" } } }] }] });
    await feed("shop", [client, web], [deny]);
    await feed("payments", [api], []);
    await feedDns();
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Denied"));
    const ingress = within(result()).getByRole("region", { name: "Ingress to shop/web" });
    expect(ingress).toHaveTextContent("Policies select this pod, and none of their rules allow this traffic.");
    expect(ingress).toHaveTextContent("Namespace payments has the labels team=payments, kubernetes.io/metadata.name=payments, which do not match team=ops.");
    // The page reads with the user's own permissions: both namespaces' policies, the Namespaces and the DNS pods.
    const watched = [...wb.specs.values()].map((s) => `${s.kind.kind} ${JSON.stringify(s.namespaces)}`);
    expect(watched).toEqual(expect.arrayContaining(['NetworkPolicy ["shop"]', 'NetworkPolicy ["payments"]', "Namespace null", 'Pod ["kube-system"]']));
  });

  it("checks a Service: each pod behind it at its target port", async () => {
    setForm({ sourceType: "labels", sourceNamespace: "shop", sourceLabels: "app=client", destinationType: "service", destinationNamespace: "shop", service: "web", servicePort: "0" });
    useConnectivityStore.getState().patch("c1", { checked: useConnectivityStore.getState().clusters.c1!.form });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    const only8080 = netpol("shop", "web", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ ports: [{ port: 8080 }] }] });
    await feed("shop", [client, web, web2], [only8080], [service("shop", "web", { app: "web" }, [{ name: "http", port: 80, targetPort: "http" }], "NodePort")]);
    await feedDns();
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Allowed to 1 of 2 pods behind the Service."));
    const table = within(result()).getByRole("table", { name: "Pods behind the Service" });
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual(["PodPod portResult", "web8080Allowed", "web-29090Denied"]);
    expect(result()).toHaveTextContent("Details for pod web-2");
    expect(result()).toHaveTextContent("This NodePort Service is also reachable from outside through node ports.");
  });

  it("warns when an egress-isolated source cannot reach DNS, though the target is allowed", async () => {
    setForm({ sourceType: "pod", sourceNamespace: "shop", sourcePod: "client", destinationType: "pod", destinationNamespace: "shop", destinationPod: "web", port: "8080" });
    useConnectivityStore.getState().patch("c1", { checked: useConnectivityStore.getState().clusters.c1!.form });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    const egress = netpol("shop", "client-out", { podSelector: { matchLabels: { app: "client" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "web" } } }] }] });
    await feed("shop", [client, web], [egress]);
    await feedDns();
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Allowed"));
    expect(result()).toHaveTextContent("its policies do not allow DNS");
  });

  it("explains a form it cannot check", async () => {
    setForm({ sourceType: "external", sourceIp: "not-an-ip", destinationType: "pod", destinationNamespace: "", port: "" });
    useConnectivityStore.getState().patch("c1", { checked: useConnectivityStore.getState().clusters.c1!.form });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    const errors = await screen.findByRole("alert");
    expect(errors).toHaveTextContent("Enter an IPv4 or IPv6 address.");
    expect(errors).toHaveTextContent("Choose a namespace.");
  });

  it("maps a namespace: isolation per pod and the policies in plain words", async () => {
    useConnectivityStore.getState().patch("c1", { tab: "map", mapNamespace: "shop" });
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    await feed("shop", [client, web], [netpol("shop", "web-in", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "client" } } }] }] })]);
    await feedDns();
    expect(await screen.findByText("2 pods: isolated for ingress: 1; for egress: 0.")).toBeInTheDocument();
    const rows = within(screen.getByRole("table", { name: "Pods and their isolation" })).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("clientNot isolated: all ingress allowedNot isolated: all egress allowed");
    expect(rows[2]).toHaveTextContent("webIsolated by: shop/web-in");
    const policy = screen.getByRole("region", { name: "shop/web-in" });
    expect(policy).toHaveTextContent("Pods matching app=web in namespace shop — 1 pod selected now");
    expect(policy).toHaveTextContent("Pods matching app=client in namespace shop");
    expect(policy).toHaveTextContent("Does not restrict egress.");
  });
});

describe("policies Sextant cannot see or evaluate", () => {
  function checked() {
    setForm({ sourceType: "pod", sourceNamespace: "shop", sourcePod: "client", destinationType: "pod", destinationNamespace: "shop", destinationPod: "web", port: "8080" });
    useConnectivityStore.getState().patch("c1", { checked: useConnectivityStore.getState().clusters.c1!.form });
  }

  it("discovery failed: Cilium or Calico policies may exist, so nothing is allowed", async () => {
    wb.backend.on("cluster_kinds", () => {
      throw new Error("discovery failed");
    });
    checked();
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    await feed("shop", [client, web], []);
    await feedDns();
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Unknown"));
    expect(result()).toHaveTextContent("Could not read the CiliumNetworkPolicy objects.");
  });

  it("an Antrea NetworkPolicy in the destination's namespace makes its ingress unknown", async () => {
    const antrea: KindRef = { group: "crd.antrea.io", version: "v1beta1", kind: "NetworkPolicy" };
    wb.backend.on("cluster_kinds", () => [served(POD), served(SERVICE), served(NAMESPACE, false), served(NETWORK_POLICY), served(antrea)]);
    checked();
    render(<ConnectivityPage clusterId="c1" />);
    await feedNamespaces();
    await feed("shop", [client, web], []);
    await feedDns();
    const id = await watchOf(wb, "NetworkPolicy", (s) => s.kind.group === "crd.antrea.io" && inNs("shop")(s));
    emitSnapshot(wb, id, [{ apiVersion: "crd.antrea.io/v1beta1", kind: "NetworkPolicy", metadata: { name: "deny-web", namespace: "shop", uid: "antrea-1" }, spec: {} }]);
    await waitFor(() => expect(within(result()).getAllByRole("status")[0]).toHaveTextContent("Unknown"));
    expect(within(result()).getByRole("region", { name: "Ingress to shop/web" })).toHaveTextContent(
      "NetworkPolicy (crd.antrea.io) deny-web may apply, and Sextant does not evaluate NetworkPolicy (crd.antrea.io) objects.",
    );
  });
});

describe("details", () => {
  it("are registered for NetworkPolicies, Cilium and Calico policies, and pods", () => {
    const ids = (kind: KindRef) => getDetailsSections(kind).map((s) => s.id);
    expect(ids(NETWORK_POLICY)).toContain("netpolPolicy");
    expect(ids({ group: "cilium.io", version: "v2", kind: "CiliumNetworkPolicy" })).toContain("netpolPolicy");
    expect(ids({ group: "projectcalico.org", version: "v3", kind: "GlobalNetworkPolicy" })).toContain("netpolPolicy");
    expect(ids(POD)).toContain("netpolPodIsolation");
    expect(ids(SERVICE)).not.toContain("netpolPolicy");
  });

  it("a NetworkPolicy in plain words: selected pods, defaulted types, rules, the DNS warning", async () => {
    const policy = netpol("shop", "client-out", { podSelector: { matchLabels: { app: "client" } }, egress: [{ to: [{ ipBlock: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] } }], ports: [{ port: 443, endPort: 445 }] }] });
    render(<PolicySection clusterId="c1" objectRef={{ kind: NETWORK_POLICY, namespace: "shop", name: "client-out" }} obj={policy} />);
    await feedNamespaces();
    await feed("shop", [client, web], [policy]);
    expect(await screen.findByRole("button", { name: "Open Pod client" })).toBeInTheDocument();
    expect(screen.getByText("Ingress, Egress (policyTypes not set: defaulted)")).toBeInTheDocument();
    expect(screen.getByText("No ingress rules: all ingress to the selected pods is denied.")).toBeInTheDocument();
    expect(screen.getByText("Addresses in 10.0.0.0/8 except 10.1.0.0/16")).toBeInTheDocument();
    expect(screen.getByText("TCP 443–445")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("This policy does not allow DNS");
    fireEvent.click(screen.getByRole("button", { name: "Namespace policy map" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(CONNECTIVITY_PAGE);
    expect(useConnectivityStore.getState().clusters.c1).toMatchObject({ tab: "map", mapNamespace: "shop" });
  });

  it("a pod's isolation for ingress and egress, and a check prefilled from it", async () => {
    render(<PodIsolationSection clusterId="c1" objectRef={{ kind: POD, namespace: "shop", name: "web" }} obj={web} />);
    await feedNamespaces();
    emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inNs("shop")), [netpol("shop", "deny", { podSelector: {}, policyTypes: ["Ingress"] })]);
    await feedDns();
    expect(await screen.findByText("Isolated by:")).toBeInTheDocument();
    // A pod's isolation needs the policies only: the namespace's pods are not listed.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod" && s.labelSelector === null)).toBe(false);
    expect(screen.getByRole("button", { name: "Open NetworkPolicy deny" })).toBeInTheDocument();
    expect(screen.getByText("Not isolated: all egress is allowed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check connectivity…" }));
    expect(useConnectivityStore.getState().clusters.c1?.form).toMatchObject({ sourceType: "pod", sourceNamespace: "shop", sourcePod: "web" });
  });
});
