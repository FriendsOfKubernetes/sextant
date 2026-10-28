import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { DetailsDisclosureProvider, DetailsSectionScope } from "../../layout/details/disclosure";
import { resetDetailsDisclosureState } from "../../layout/details/disclosureState";
import { resetClusterKinds } from "../../resources";
import { NodeAutoscalingSection } from "../autoscaling/NodeSection";
import { WorkloadAutoscalingSection } from "../autoscaling/WorkloadSection";
import { NODE_CLAIM, NODE_POOL, HPA, SCALED_OBJECT } from "../autoscaling/model";
import { ClusterApiSection } from "../cluster-api/details";
import { CAPI_CLUSTER, MACHINE_DEPLOYMENT, MACHINE_SET, MACHINE } from "../cluster-api/model";
import { DraSection } from "../dra/details";
import { RESOURCE_CLAIM, RESOURCE_SLICE } from "../dra/model";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { ClaimUsageSection } from "../storage/UsageViews";
import { LINGER_MS, USAGE_POLL_MS, resetVolumeUsage, useVolumeUsage } from "../storage/usageStore";
import { VclusterSection } from "../vcluster/details";
import { PrometheusOperatorSection } from "../prometheus-operator/details";
import { SERVICE_MONITOR, PROMETHEUS, PROMETHEUS_AGENT } from "../prometheus-operator/model";
import { KServeSection } from "../kserve/details";
import { INFERENCE_SERVICE } from "../kserve/model";
import { KSERVICE } from "../knative/model";
import { MeshMembershipSection } from "../mesh/MembershipSection";
import { CrossplaneResourceSection } from "../crossplane/details";
import { XRD } from "../crossplane/model";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "./testing";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const PVC: KindRef = { group: "", version: "v1", kind: "PersistentVolumeClaim" };
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const refOf = (kind: KindRef, name = "example", namespace: string | null = "demo"): ObjectRef => ({ kind, name, namespace });
let wb: WatchBackend;
let settings: AppSettings;
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); resetSharedWatches(); resetVolumeUsage(); setWatchLinger(0);
  wb = watchBackend(); settings = defaultAppSettings();
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("settings_update", args => settings = args.settings as AppSettings);
  const kinds = [POD, PVC, SERVICE, DEPLOYMENT, CAPI_CLUSTER, MACHINE_DEPLOYMENT, MACHINE_SET, MACHINE, RESOURCE_CLAIM, RESOURCE_SLICE, NODE_POOL, NODE_CLAIM, HPA, SCALED_OBJECT, SERVICE_MONITOR, PROMETHEUS, PROMETHEUS_AGENT, KSERVICE, XRD];
  wb.backend.on("cluster_kinds", () => kinds.map((kindRef): ResourceKind => ({ kindRef, plural: kindRef.kind.toLowerCase() + "s", namespaced: !["NodePool", "NodeClaim", "ResourceSlice"].includes(kindRef.kind), verbs: ["list", "watch"], printerColumns: [] })));
  await loadSettings();
});
afterEach(() => {
  cleanup(); resetVolumeUsage(); resetSharedWatches(); setWatchLinger(null); resetClusterKinds(); wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState(); vi.useRealTimers();
});
function card(ref: ObjectRef, children: ReactNode) {
  return <DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="probe">{children}</DetailsSectionScope></DetailsDisclosureProvider>;
}
function toggle(path: string) {
  const button = document.querySelector(`[data-disclosure="probe/${path}"] > .dt-block__head .dt-disclosure`);
  expect(button).not.toBeNull(); fireEvent.click(button!);
}

it("stops the last volume poll after its linger, preserves another consumer, and refreshes on reopen", async () => {
  vi.useFakeTimers();
  let bytes = 1;
  wb.backend.on("storage_volume_usage", () => ({ source: "kubelet", volumes: [{ namespace: "demo", claim: "claim", usedBytes: bytes, capacityBytes: 10 }], nodesFailed: 0, kubeletForbidden: false, truncated: false }));
  function Other() { const state = useVolumeUsage("c1"); return <span data-testid="other">{state.report?.volumes[0]?.usedBytes}</span>; }
  const other = render(<Other />);
  const ref = refOf(PVC, "claim");
  render(card(ref, <ClaimUsageSection clusterId="c1" objectRef={ref} obj={null} />));
  await act(async () => {});
  const count = () => wb.backend.calls.filter(c => c.cmd === "storage_volume_usage").length;
  toggle("storage:usage.title"); bytes = 2;
  await act(async () => { await vi.advanceTimersByTimeAsync(USAGE_POLL_MS); });
  expect(screen.getByTestId("other")).toHaveTextContent("2"); expect(count()).toBe(2);
  other.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(LINGER_MS + USAGE_POLL_MS * 2); });
  expect(count()).toBe(2);
  bytes = 7; toggle("storage:usage.title"); await act(async () => {});
  expect(count()).toBe(3); expect(screen.getByText(/7B/)).toBeInTheDocument();
});

it("releases every Machine chain list and renders a fresh snapshot after reopening", async () => {
  const ref = refOf(CAPI_CLUSTER, "management");
  const obj: KubeObject = { apiVersion: "cluster.x-k8s.io/v1beta2", kind: "Cluster", metadata: { name: ref.name, namespace: ref.namespace! } };
  render(card(ref, <ClusterApiSection clusterId="c1" objectRef={ref} obj={obj} />));
  const ids = await Promise.all(["MachineDeployment", "MachineSet", "Machine"].map(k => watchOf(wb, k)));
  toggle("clusterapi:chain.title");
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  toggle("clusterapi:chain.title");
  const next = await watchOf(wb, "Machine"); expect(ids).not.toContain(next);
  emitSnapshot(wb, next, [{ apiVersion: "cluster.x-k8s.io/v1beta2", kind: "Machine", metadata: { name: "fresh-machine", namespace: "demo" } }]);
  expect(await screen.findByText("fresh-machine")).toBeInTheDocument();
});

it("releases ResourceSlice allocation claims and accepts a new allocation after reopening", async () => {
  const ref = refOf(RESOURCE_SLICE, "slice", null);
  const obj: KubeObject = { apiVersion: "resource.k8s.io/v1", kind: "ResourceSlice", metadata: { name: "slice" }, spec: { driver: "test", pool: { name: "pool" }, devices: [{ name: "gpu" }] } };
  render(card(ref, <DraSection clusterId="c1" objectRef={ref} obj={obj} />));
  const id = await watchOf(wb, "ResourceClaim"); toggle("dra:devices.title");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0));
  toggle("dra:devices.title"); const next = await watchOf(wb, "ResourceClaim"); expect(next).not.toBe(id);
  emitSnapshot(wb, next, [{ apiVersion: "resource.k8s.io/v1", kind: "ResourceClaim", metadata: { name: "fresh-claim", namespace: "demo" }, status: { allocation: { devices: { results: [{ request: "gpu", driver: "test", pool: "pool", device: "gpu" }] } } } }]);
  expect(await screen.findByText("demo/fresh-claim")).toBeInTheDocument();
});

it("releases only NodeClaim event ownership when the Node Disruptions child closes", async () => {
  const ref = refOf({ group: "", version: "v1", kind: "Node" }, "worker", null);
  const obj: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: "worker", labels: { "karpenter.sh/nodepool": "pool" } } };
  render(card(ref, <NodeAutoscalingSection clusterId="c1" objectRef={ref} obj={obj} />));
  const claim = await watchOf(wb, "NodeClaim"); const pool = await watchOf(wb, "NodePool");
  emitSnapshot(wb, claim, [{ apiVersion: "karpenter.sh/v1", kind: "NodeClaim", metadata: { name: "claim", labels: { "karpenter.sh/nodepool": "pool" } }, status: { nodeName: "worker" } }]);
  const eventMatch = (spec: import("../../api").WatchSpec) => spec.fieldSelector?.includes("involvedObject.kind=NodeClaim") === true;
  const event = await watchOf(wb, "Event", eventMatch);
  emitSnapshot(wb, event, [{ apiVersion: "v1", kind: "Event", metadata: { name: "blocked" }, reason: "DisruptionBlocked", message: "Blocked by pdb", involvedObject: { kind: "NodeClaim", name: "claim" } }]);
  await screen.findByText("Blocked by pdb"); toggle("autoscaling:title/autoscaling:karpenter.disruptions");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${event}`)).toBe(0));
  expect(wb.backend.listenerCount(`watch:${claim}`)).toBe(1); expect(wb.backend.listenerCount(`watch:${pool}`)).toBe(1);
  toggle("autoscaling:title/autoscaling:karpenter.disruptions"); const next = await watchOf(wb, "Event", eventMatch); expect(next).not.toBe(event);
  emitSnapshot(wb, next, [{ apiVersion: "v1", kind: "Event", metadata: { name: "new-event" }, reason: "DisruptionBlocked", message: "Fresh disruption", involvedObject: { kind: "NodeClaim", name: "claim" } }]);
  expect(await screen.findByText("Fresh disruption")).toBeInTheDocument();
});

it("keeps synced kind choices independent and stops only the closed vcluster kind", async () => {
  const ref = refOf({ group: "apps", version: "v1", kind: "StatefulSet" }, "vc");
  const obj: KubeObject = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "vc", namespace: "demo", labels: { app: "vcluster", release: "vc" } }, spec: { replicas: 1 } };
  render(card(ref, <VclusterSection clusterId="c1" objectRef={ref} obj={obj} />));
  const match = (spec: import("../../api").WatchSpec) => spec.labelSelector === "vcluster.loft.sh/managed-by=vc";
  const pod = await watchOf(wb, "Pod", match); const service = await watchOf(wb, "Service", match);
  const synced = (kind: string, name: string): KubeObject => ({ apiVersion: "v1", kind, metadata: { name, namespace: "demo", labels: { "vcluster.loft.sh/managed-by": "vc" } } });
  emitSnapshot(wb, pod, [synced("Pod", "old-pod")]); emitSnapshot(wb, service, [synced("Service", "old-service")]);
  fireEvent.click(await screen.findByRole("button", { name: /^Pod/ }));
  expect(screen.getByRole("button", { name: /^Service/ })).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${pod}`)).toBe(0));
  expect(wb.backend.listenerCount(`watch:${service}`)).toBe(1);
  toggle("vcluster:synced.title"); toggle("vcluster:synced.title");
  const probe = await watchOf(wb, "Pod", match);
  emitSnapshot(wb, probe, [synced("Pod", "while-closed")]);
  expect(await screen.findByRole("button", { name: /^Pod/ })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: /^Pod/ }));
  const next = await watchOf(wb, "Pod", match); emitSnapshot(wb, next, [synced("Pod", "fresh-pod")]);
  expect(await screen.findByText("fresh-pod")).toBeInTheDocument();
});

it.each(["empty", "error"] as const)("settles a saved-closed workload applicability probe after %s, without remounting it", async result => {
  settings.appearance.detailsSections = { "apps/Deployment": { "probe/autoscaling:title": false } };
  const ref = refOf(DEPLOYMENT);
  const obj: KubeObject = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: ref.name, namespace: "demo" } };
  render(card(ref, <WorkloadAutoscalingSection clusterId="c1" objectRef={ref} obj={obj} />));
  const hpa = await watchOf(wb, "HorizontalPodAutoscaler"); const so = await watchOf(wb, "ScaledObject");
  if (result === "empty") { emitSnapshot(wb, hpa, []); emitSnapshot(wb, so, []); }
  // A failed required list already makes applicability unknown; a second pending list need not keep a closed card alive.
  else act(() => wb.backend.emit(`watch:${hpa}`, { type: "error", error: { code: "forbidden", message: "denied" } }));
  await waitFor(() => { expect(wb.backend.listenerCount(`watch:${hpa}`)).toBe(0); expect(wb.backend.listenerCount(`watch:${so}`)).toBe(0); });
  await act(async () => {});
  expect(wb.specs.size).toBe(2);
  const heading = screen.queryByRole("button", { name: "Autoscaling" });
  if (result === "empty") expect(heading).not.toBeInTheDocument();
  else { expect(heading).toHaveAttribute("aria-expanded", "false"); fireEvent.click(heading!); expect(await watchOf(wb, "HorizontalPodAutoscaler")).not.toBe(hpa); }
});

it("retains a known conditional header while reacquiring, then shows the fresh HPA", async () => {
  const ref = refOf(DEPLOYMENT);
  const obj: KubeObject = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: ref.name, namespace: "demo" } };
  render(card(ref, <WorkloadAutoscalingSection clusterId="c1" objectRef={ref} obj={obj} />));
  const hpa = await watchOf(wb, "HorizontalPodAutoscaler");
  const scaled = (name: string): KubeObject => ({ apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name, namespace: "demo" }, spec: { scaleTargetRef: { kind: "Deployment", name: ref.name } } });
  emitSnapshot(wb, hpa, [scaled("old-hpa")]);
  await screen.findByRole("button", { name: "Autoscaling" });
  toggle("autoscaling:title"); await waitFor(() => expect(wb.backend.listenerCount(`watch:${hpa}`)).toBe(0));
  toggle("autoscaling:title");
  expect(screen.getByRole("button", { name: "Autoscaling" })).toHaveAttribute("aria-expanded", "true");
  const next = await watchOf(wb, "HorizontalPodAutoscaler"); emitSnapshot(wb, next, [scaled("fresh-hpa")]);
  expect(await screen.findByText("fresh-hpa")).toBeInTheDocument();
});

it("keeps a retry header when the missing NodeClaim could be in a forbidden list", async () => {
  settings.appearance.detailsSections = { "/Node": { "probe/autoscaling:title/autoscaling:karpenter.disruptions": false } };
  const ref = refOf({ group: "", version: "v1", kind: "Node" }, "worker", null);
  const obj: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: ref.name, labels: { "karpenter.sh/nodepool": "pool" } } };
  render(card(ref, <NodeAutoscalingSection clusterId="c1" objectRef={ref} obj={obj} />));
  const claims = await watchOf(wb, "NodeClaim");
  const events = await watchOf(wb, "Event", spec => spec.fieldSelector === "involvedObject.kind=Node,involvedObject.name=worker");
  act(() => wb.backend.emit(`watch:${claims}`, { type: "error", error: { code: "forbidden", message: "no claims access" } }));
  emitSnapshot(wb, events, []);
  await waitFor(() => expect(document.querySelector('[data-disclosure="probe/autoscaling:title/autoscaling:karpenter.disruptions"] .dt-disclosure')).not.toBeNull());
  const button = document.querySelector('[data-disclosure="probe/autoscaling:title/autoscaling:karpenter.disruptions"] .dt-disclosure')!;
  expect(button).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

it("unmounts the monitor-target body while preserving the namespace resolver, then renders fresh targets", async () => {
  const ref = refOf(SERVICE_MONITOR);
  const obj: KubeObject = { apiVersion: "monitoring.coreos.com/v1", kind: "ServiceMonitor", metadata: { name: ref.name, namespace: "demo" }, spec: { selector: { matchLabels: { app: "web" } }, endpoints: [{ port: "http" }] } };
  render(card(ref, <PrometheusOperatorSection clusterId="c1" objectRef={ref} obj={obj} />));
  const target = await watchOf(wb, "Service", spec => spec.labelSelector === "app=web");
  const server = await watchOf(wb, "Prometheus");
  toggle("targets"); await waitFor(() => expect(wb.backend.listenerCount(`watch:${target}`)).toBe(0));
  expect(wb.backend.listenerCount(`watch:${server}`)).toBe(1);
  toggle("targets"); const next = await watchOf(wb, "Service", spec => spec.labelSelector === "app=web"); expect(next).not.toBe(target);
  emitSnapshot(wb, next, [{ apiVersion: "v1", kind: "Service", metadata: { name: "fresh-target", namespace: "demo" }, spec: { ports: [{ name: "http", port: 80 }] } }]);
  expect(await screen.findByText("demo/fresh-target")).toBeInTheDocument();
});

it("holds KServe underlying lists for either visible component and releases the last component", async () => {
  const ref = refOf(INFERENCE_SERVICE);
  const obj: KubeObject = { apiVersion: "serving.kserve.io/v1beta1", kind: "InferenceService", metadata: { name: ref.name, namespace: "demo" }, spec: { predictor: { model: { modelFormat: { name: "onnx" } } }, transformer: { containers: [{ name: "transformer", image: "example" }] } } };
  render(card(ref, <KServeSection clusterId="c1" objectRef={ref} obj={obj} />));
  const selector = `serving.kserve.io/inferenceservice=${ref.name}`;
  await waitFor(() => expect([...wb.specs].filter(([, spec]) => spec.labelSelector === selector)).toHaveLength(3));
  const ids = [...wb.specs].filter(([, spec]) => spec.labelSelector === selector).map(([id]) => id);
  toggle("component.predictor");
  for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(1);
  toggle("component.transformer");
  await waitFor(() => { for (const id of ids) expect(wb.backend.listenerCount(`watch:${id}`)).toBe(0); });
  toggle("component.predictor");
  const next = await watchOf(wb, "Deployment", spec => spec.labelSelector === selector); expect(ids).not.toContain(next);
  emitSnapshot(wb, next, [{ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "fresh-predictor", namespace: "demo", labels: { component: "predictor" } } }]);
  expect(await screen.findByText("fresh-predictor")).toBeInTheDocument();
});

it("ignores inapplicable mesh headings when the only visible Linkerd block closes", async () => {
  const ref = refOf(POD);
  const obj: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: ref.name, namespace: "demo" }, spec: { containers: [{ name: "linkerd-proxy", image: "proxy" }] } };
  render(card(ref, <MeshMembershipSection clusterId="c1" objectRef={ref} obj={obj} />));
  const match = (spec: import("../../api").WatchSpec) => spec.fieldSelector === "metadata.name=demo";
  const namespace = await watchOf(wb, "Namespace", match);
  emitSnapshot(wb, namespace, [{ apiVersion: "v1", kind: "Namespace", metadata: { name: "demo" } }]);
  await waitFor(() => expect(document.querySelector('[data-disclosure="probe/mesh:blocks.linkerdMembership"]')).not.toBeNull());
  toggle("mesh:blocks.linkerdMembership");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${namespace}`)).toBe(0));
  toggle("mesh:blocks.linkerdMembership");
  expect(await watchOf(wb, "Namespace", match)).not.toBe(namespace);
});

it("ignores a nonexistent Crossplane chain consumer when managed fields close", async () => {
  const ref = refOf({ group: "s3.aws.upbound.io", version: "v1beta1", kind: "Bucket" });
  const obj: KubeObject = { apiVersion: "s3.aws.upbound.io/v1beta1", kind: "Bucket", metadata: { name: ref.name, namespace: "demo" }, spec: { forProvider: {} } };
  render(card(ref, <CrossplaneResourceSection clusterId="c1" objectRef={ref} obj={obj} />));
  const xrd = await watchOf(wb, "CompositeResourceDefinition"); emitSnapshot(wb, xrd, []);
  await waitFor(() => expect(document.querySelector('[data-disclosure="probe/details:sections.fields"]')).not.toBeNull());
  expect(document.querySelector('[data-disclosure="probe/crossplane:chain.title"]')).toBeNull();
  toggle("details:sections.fields");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${xrd}`)).toBe(0));
  toggle("details:sections.fields"); expect(await watchOf(wb, "CompositeResourceDefinition")).not.toBe(xrd);
});
