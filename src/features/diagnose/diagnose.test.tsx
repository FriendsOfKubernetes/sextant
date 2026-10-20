import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { getAction } from "../actions/registry";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { openWatchCount, resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import "./index";
import { ENDPOINT_SLICE, INGRESS, INGRESS_CLASS, POD, SERVICE } from "./objects";
import { DiagnosisView } from "./DiagnosisView";
import { diagnoseIngress } from "./ingress";
import { ingress, ingressClass, NS, pod, service, slice, view } from "./testData";

const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };
const NETWORK_POLICY: KindRef = { group: "networking.k8s.io", version: "v1", kind: "NetworkPolicy" };
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
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [
    ...[POD, SERVICE, ENDPOINT_SLICE, NETWORK_POLICY, INGRESS].map((k) => served(k)),
    served(NAMESPACE, false),
    served(INGRESS_CLASS, false),
  ]);
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

const inShop = (spec: WatchSpec) => JSON.stringify(spec.namespaces) === JSON.stringify([NS]) && spec.fieldSelector === null;
const WEB = { app: "web" };
const svc = service("web", { selector: WEB });
const svcRef: ObjectRef = { kind: SERVICE, namespace: NS, name: "web" };

/** Answers the lists the diagnosis of Service web reads: its namespace's Services, slices, pods and policies. */
async function answer(pods: KubeObject[], slices: KubeObject[]) {
  emitSnapshot(wb, await watchOf(wb, "Service", inShop), [svc]);
  emitSnapshot(wb, await watchOf(wb, "EndpointSlice", inShop), slices);
  emitSnapshot(wb, await watchOf(wb, "Pod", inShop), pods);
  emitSnapshot(wb, await watchOf(wb, "NetworkPolicy", inShop), []);
  emitSnapshot(wb, await watchOf(wb, "Namespace"), [{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, uid: "ns" } }]);
}

async function openTab() {
  useAppStore.getState().openDetails(svcRef);
  const view = render(<DetailsPanel clusterId="c1" objectRef={svcRef} />);
  emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.fieldSelector === "metadata.name=web"), [svc]);
  fireEvent.click(screen.getByRole("tab", { name: "Diagnosis" }));
  return view;
}

describe("the Diagnosis tab", () => {
  it("walks a Service's path, stops at the broken link and passes axe", async () => {
    await openTab();
    await answer([pod("web-1", WEB, { ready: false, waiting: "CrashLoopBackOff" })], []);
    const summary = await screen.findByText(/^Traffic stops here:/);
    expect(summary.textContent).toBe("Traffic stops here: The selector matches 1 pod, and it is not Ready, so it gets no traffic.");
    expect(screen.getByText("CrashLoopBackOff: 1 pod")).toBeInTheDocument();
    expect(screen.getByText("The checks after the broken link were not run.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open Pod web-1" }).length).toBeGreaterThan(0);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("says when nothing is broken, opens linked objects, and watches only the Service's namespace", async () => {
    const view = await openTab();
    await answer([pod("web-1", WEB)], [slice("web", [{ pod: "web-1" }])]);
    await screen.findByText("No broken link found on the path.");
    const steps = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-check")).filter(Boolean);
    expect(steps).toEqual(["service.selector", "service.ready", "service.targetPort.0", "service.slices", "policies", "service.clusterIp"]);
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Open Pod web-1" }));
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: NS, name: "web-1" });
    const namespaces = [...wb.specs.values()].map((s) => JSON.stringify(s.namespaces));
    expect(new Set(namespaces)).toEqual(new Set([JSON.stringify([NS]), "null"]));
    // Only the Namespaces are listed cluster-wide (for the policies' namespace selectors).
    expect([...wb.specs.values()].filter((s) => s.namespaces === null).map((s) => s.kind.kind)).toEqual(["Namespace"]);
    view.unmount();
    await waitFor(() => expect(openWatchCount()).toBe(0));
  });
});

describe("the path view", () => {
  it("folds the branches that are fine, opens the broken ones, and passes axe", async () => {
    const backend = (name: string) => ({ service: { name, port: { number: 80 } } });
    const obj = ingress("shop", {
      ingressClassName: "nginx",
      rules: [{ host: "shop.example.com", http: { paths: [{ path: "/api", pathType: "Prefix", backend: backend("api") }, { path: "/", pathType: "Prefix", backend: backend("web") }] } }],
    });
    const chain = diagnoseIngress(
      obj,
      view({ services: [svc], pods: [pod("web-1", WEB)], slices: [slice("web", [{ pod: "web-1" }])], classes: [ingressClass("nginx", "example.com/other")] }),
    );
    render(<DiagnosisView chain={chain} onOpen={() => undefined} />);
    const branches = [...document.querySelectorAll("details")];
    expect(branches.map((d) => [d.querySelector(".dg-branch__title")?.textContent, d.open])).toEqual([
      ["shop.example.com/api", true],
      ["shop.example.com/", false],
    ]);
    expect(screen.getByRole("status").textContent).toContain("Service api does not exist in namespace shop");
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe("the Diagnose action", () => {
  it("is offered for Services, Ingresses and routes, and opens the diagnosis in a dialog", async () => {
    expect(getResourceDef(SERVICE).actions).toContain("diagnose");
    expect(getResourceDef(INGRESS).actions).toContain("diagnose");
    expect(getResourceDef({ group: "gateway.networking.k8s.io", version: "v1", kind: "HTTPRoute" }).actions).toContain("diagnose");
    const action = getAction("diagnose")!;
    expect(action.appliesTo(svc, SERVICE)).toBe(true);
    expect(action.appliesTo(pod("p", {}), POD)).toBe(false);
    let dialog: React.ReactNode = null;
    await action.run({ clusterId: "c1", kind: SERVICE, objects: [svc], refs: [svcRef], openDialog: (r) => ((dialog = r(() => undefined)), () => undefined) });
    render(<>{dialog}</>);
    expect(screen.getByRole("dialog", { name: "Why Service web gets no traffic" })).toBeInTheDocument();
    await answer([pod("web-1", WEB)], []);
    await screen.findByText(/^Traffic stops here: The Service has no EndpointSlice yet/);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
