import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { getPage } from "../../layout/pages";
import { findResourceDef, resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { sourcesFor } from "../problems/sources";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { resetMeshChecks } from "./checkState";
import bookinfo from "./fixtures/bookinfo.json";
import "./index";
import { AUTHORIZATION_POLICY, DESTINATION_RULE, ISTIO_GATEWAY, PEER_AUTHENTICATION, SERVICE_ENTRY, VIRTUAL_SERVICE } from "./kinds";
import { MeshMembershipSection } from "./MembershipSection";
import { toProblems } from "./provider";
import { MeshRequestCheckPage } from "./RequestCheck";
import { acquireMesh, getMeshConfig, resetMeshStore } from "./store";

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const DISCOVERY = [SERVICE, POD, VIRTUAL_SERVICE, DESTINATION_RULE, ISTIO_GATEWAY, SERVICE_ENTRY, PEER_AUTHENTICATION, AUTHORIZATION_POLICY];

const fx = bookinfo as unknown as Record<string, KubeObject[]>;

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetMeshChecks();
  resetMeshStore();
  resetSharedWatches();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => DISCOVERY.map(served));
});

afterEach(() => {
  resetMeshStore();
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

const everywhere = (s: WatchSpec) => s.namespaces === null && s.fieldSelector === null;

async function feedIstio(): Promise<void> {
  emitSnapshot(wb, await watchOf(wb, "VirtualService", everywhere), fx.virtualServices!);
  emitSnapshot(wb, await watchOf(wb, "DestinationRule", everywhere), fx.destinationRules!);
  emitSnapshot(wb, await watchOf(wb, "Gateway", everywhere), fx.gateways!);
  emitSnapshot(wb, await watchOf(wb, "ServiceEntry", everywhere), []);
  emitSnapshot(wb, await watchOf(wb, "PeerAuthentication", everywhere), fx.peerAuthentications!);
  emitSnapshot(wb, await watchOf(wb, "AuthorizationPolicy", everywhere), fx.authorizationPolicies!);
  emitSnapshot(wb, await watchOf(wb, "Service", (s) => !!s.metadataOnly), fx.services!.map((s) => ({ ...s, spec: undefined })));
}

describe("registration", () => {
  it("puts the Istio and Linkerd kinds in their discovered sections, with the problem filter where problems are found", () => {
    expect(findResourceDef(VIRTUAL_SERVICE)?.sidebar?.section).toBe("istio");
    expect(findResourceDef({ group: "policy.linkerd.io", kind: "Server" })?.sidebar?.section).toBe("linkerd");
    expect(findResourceDef(VIRTUAL_SERVICE)?.problem).toBeDefined();
    expect(findResourceDef(PEER_AUTHENTICATION)?.problem).toBeUndefined();
    expect(getPage("istioRequestCheck")?.section).toBe("istio");
    expect(getDetailsSections(POD).map((s) => s.id)).toContain("meshMembership");
  });

  it("offers the mesh problems source only where VirtualServices are served", () => {
    expect(sourcesFor(["mesh"], DISCOVERY.map(served))).toHaveLength(1);
    expect(sourcesFor(["mesh"], [served(SERVICE)])).toHaveLength(0);
  });
});

describe("the shared Istio configuration", () => {
  it("finds the problems across objects and turns them into problems of the screen", async () => {
    render(<MeshRequestCheckPage clusterId="c1" />);
    await feedIstio();
    await waitFor(() => expect(getMeshConfig("c1").loading).toBe(false));
    const reasons = getMeshConfig("c1").problems.map((p) => `${p.reason}:${p.ref.name}`);
    expect(reasons).toEqual(["MissingSubset:reviews", "TlsConflict:reviews"]);
    const problems = toProblems(getMeshConfig("c1").problems, new Map(), 1000);
    expect(problems[0]).toMatchObject({ category: "mesh", uid: "vs-reviews", messageKey: "messages.meshMissingSubset", object: { name: "reviews", namespace: "shop" } });
  });

  it("watches nothing for a cluster that serves no Istio kinds", async () => {
    wb.backend.on("cluster_kinds", () => [served(SERVICE)]);
    const release = acquireMesh("c2");
    await act(async () => {
      await Promise.resolve();
    });
    expect([...wb.specs.values()].filter((s) => s.kind.group.includes("istio"))).toEqual([]);
    release();
  });
});

describe("Request routing page", () => {
  async function check(url: string, headers = ""): Promise<HTMLElement> {
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: url } });
    fireEvent.change(screen.getByRole("textbox", { name: "Caller namespace" }), { target: { value: "shop" } });
    if (headers) fireEvent.change(screen.getByRole("textbox", { name: "Headers" }), { target: { value: headers } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    return screen.findByRole("region", { name: "Where the request goes" });
  }

  it("follows a request to the route, the weighted subsets and their ready pods", async () => {
    render(<MeshRequestCheckPage clusterId="c1" />);
    await feedIstio();
    const result = await check("http://reviews:9080/x");
    expect(within(result).getByRole("status")).toHaveTextContent("Routed");
    const route = result.querySelector<HTMLElement>("[data-step='route']")!;
    expect(route).toHaveTextContent("Route 2 (default)");
    expect(route).toHaveTextContent("Route beta-users of reviews skipped: a header did not match.");
    expect(route).toHaveTextContent("Retry up to 3 times, 2s per try");
    const dest = result.querySelector<HTMLElement>("[data-step='destinations']")!;
    expect(dest).toHaveTextContent("80%");
    expect(dest).toHaveTextContent("The destination rule has no subset v3");
    // The Services and pods of the destination's namespace are watched now.
    emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.namespaces?.includes("shop") === true && !s.metadataOnly), fx.services!);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.namespaces?.includes("shop") === true), fx.pods!);
    await waitFor(() => expect(dest).toHaveTextContent("1 of 2 ready"));
  });

  it("takes the header route", async () => {
    render(<MeshRequestCheckPage clusterId="c1" />);
    await feedIstio();
    const result = await check("http://reviews.shop/", "x-user: alice");
    expect(result.querySelector("[data-step='route']")).toHaveTextContent("Header x-user is alice");
  });

  it("follows a request through an Istio gateway", async () => {
    render(<MeshRequestCheckPage clusterId="c1" />);
    await feedIstio();
    fireEvent.change(screen.getByRole("combobox", { name: "Sent from" }), { target: { value: "gateway" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Gateway" }), { target: { value: "istio-ingress/public" } });
    fireEvent.change(screen.getByRole("textbox", { name: "URL" }), { target: { value: "http://shop.example.com/reviews/1" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const result = await screen.findByRole("region", { name: "Where the request goes" });
    expect(result.querySelector("[data-step='gateway']")).toHaveTextContent("Server on port 80 (HTTP) for shop.example.com");
    expect(result.querySelector("[data-step='virtualService']")).toHaveTextContent("storefront");
    expect(result.querySelector("[data-step='destinations']")).toHaveTextContent("reviews.shop.svc.cluster.local:9080");
  });
});

describe("Service mesh section of a pod", () => {
  it("shows the membership, the mTLS mode and who may call", async () => {
    const pod = fx.pods![0]!;
    render(<MeshMembershipSection clusterId="c1" objectRef={{ kind: POD, namespace: "shop", name: "reviews-v1-a" }} obj={pod} />);
    expect(await screen.findByText("In the Istio mesh with a sidecar proxy.")).toBeInTheDocument();
    await feedIstio();
    emitSnapshot(wb, await watchOf(wb, "Namespace"), fx.namespaces!);
    expect(await screen.findByText("Set by the namespace's PeerAuthentication default:")).toBeInTheDocument();
    expect(screen.getByText("STRICT")).toBeInTheDocument();
    // Nobody described: the ALLOW policy depends on the caller's principal.
    expect(screen.getByText("Cannot tell")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Caller namespace" }), { target: { value: "shop" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Service account" }), { target: { value: "web" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Method" }), { target: { value: "GET" } });
    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Service account" }), { target: { value: "batch" } });
    expect(await screen.findByText("Denied")).toBeInTheDocument();
  });
});
