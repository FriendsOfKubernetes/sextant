import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultAppSettings, loadSettings, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { DetailsDisclosureProvider, DetailsSectionScope } from "../../layout/details/disclosure";
import { resetDetailsDisclosureState } from "../../layout/details/disclosureState";
import { resetClusterKinds } from "../../resources";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { RoleAccessSection } from "../rbac/details";
import { NodeClaimSection } from "./NodeSection";
import { HpaSection } from "./HpaSection";
import { WorkloadAutoscalingSection } from "./WorkloadSection";
import { DEPLOYMENT, EVENT, HPA, SCALED_OBJECT } from "./model";

let wb: WatchBackend;
const obj: KubeObject = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "shop" } };
const ref: ObjectRef = { kind: DEPLOYMENT, namespace: "shop", name: "web" };
const props = { clusterId: "c1", obj, objectRef: ref };
const kinds: ResourceKind[] = [DEPLOYMENT, EVENT, HPA, SCALED_OBJECT].map(kindRef => ({ kindRef, namespaced: true, plural: kindRef.kind.toLowerCase() + "s", verbs: ["list", "watch"], printerColumns: [] }));
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); resetSharedWatches(); setWatchLinger(0);
  wb = watchBackend();
  const settings = defaultAppSettings(); settings.appearance.detailsSectionMemory = "none";
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("cluster_kinds", () => kinds);
  await loadSettings();
});
afterEach(() => { cleanup(); resetSharedWatches(); setWatchLinger(null); wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState(); resetClusterKinds(); });
function card(children: React.ReactNode) {
  return <DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="feature">{children}</DetailsSectionScope></DetailsDisclosureProvider>;
}
function toggle(id: string) {
  const el = document.querySelector(`[data-disclosure="feature/${id}"] > .dt-block__head button`);
  expect(el).not.toBeNull(); fireEvent.click(el!);
}
it("releases workload list subscriptions while retaining its collapsed header and resumes on reopen", async () => {
  render(card(<WorkloadAutoscalingSection {...props} />));
  const hpa = await watchOf(wb, "HorizontalPodAutoscaler");
  const so = await watchOf(wb, "ScaledObject");
  emitSnapshot(wb, hpa, [{ apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "web" } } }]);
  await waitFor(() => expect(document.querySelector('[data-disclosure="feature/autoscaling:title"]')).not.toBeNull());
  toggle("autoscaling:title");
  await waitFor(() => { expect(wb.backend.listenerCount(`watch:${hpa}`)).toBe(0); expect(wb.backend.listenerCount(`watch:${so}`)).toBe(0); });
  toggle("autoscaling:title");
  await watchOf(wb, "HorizontalPodAutoscaler");
});
it("unmounts HPA source hooks and retains a nested choice through closing the primary block", async () => {
  const hpa: KubeObject = { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" }, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } }] } };
  render(card(<HpaSection {...props} obj={hpa} />));
  const target = await watchOf(wb, "Deployment");
  const events = await watchOf(wb, "Event");
  toggle("autoscaling:hpa.title/autoscaling:hpa.metrics");
  toggle("autoscaling:hpa.title");
  await waitFor(() => { expect(wb.backend.listenerCount(`watch:${target}`)).toBe(0); expect(wb.backend.listenerCount(`watch:${events}`)).toBe(0); });
  toggle("autoscaling:hpa.title");
  expect(document.querySelector('[data-disclosure="feature/autoscaling:hpa.title/autoscaling:hpa.metrics"] button')).toHaveAttribute("aria-expanded", "false");
  await watchOf(wb, "Deployment");
});
it("releases RBAC bindings independently while keeping aggregated rules subscribed", async () => {
  const role: KubeObject = { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "read" }, aggregationRule: { clusterRoleSelectors: [{ matchLabels: { aggregate: "yes" } }] } };
  render(card(<RoleAccessSection {...props} obj={role} />));
  const cr = await watchOf(wb, "ClusterRole"); const rb = await watchOf(wb, "RoleBinding"); const crb = await watchOf(wb, "ClusterRoleBinding");
  toggle("rbac:details.boundTo");
  await waitFor(() => { expect(wb.backend.listenerCount(`watch:${rb}`)).toBe(0); expect(wb.backend.listenerCount(`watch:${crb}`)).toBe(0); });
  expect(wb.backend.listenerCount(`watch:${cr}`)).toBe(1);
  toggle("rbac:details.rulesExplained");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${cr}`)).toBe(0));
  toggle("rbac:details.boundTo"); await watchOf(wb, "RoleBinding");
});
it("closing one card preserves a real shared-list consumer outside the disclosure context", async () => {
  const view = render(<>{card(<WorkloadAutoscalingSection {...props} />)}<WorkloadAutoscalingSection {...props} /></>);
  const hpa = await watchOf(wb, "HorizontalPodAutoscaler");
  emitSnapshot(wb, hpa, [{ apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "web" } } }]);
  await waitFor(() => expect(document.querySelector('[data-disclosure="feature/autoscaling:title"]')).not.toBeNull());
  toggle("autoscaling:title");
  expect(wb.backend.listenerCount(`watch:${hpa}`)).toBe(1);
  view.rerender(card(<WorkloadAutoscalingSection {...props} />));
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${hpa}`)).toBe(0));
});
it("stops HPA requests and events sources when their nested blocks close while primary stays open", async () => {
  const hpa: KubeObject = { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "shop" }, spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" }, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } }] } };
  render(card(<HpaSection {...props} obj={hpa} />));
  const target = await watchOf(wb, "Deployment");
  const events = await watchOf(wb, "Event");
  emitSnapshot(wb, events, [{ apiVersion: "v1", kind: "Event", metadata: { name: "scale", namespace: "shop" }, reason: "SuccessfulRescale", message: "New size: 3; reason: cpu" }]);
  await waitFor(() => expect(document.querySelector('[data-disclosure="feature/autoscaling:hpa.title/autoscaling:hpa.events"]')).not.toBeNull());
  toggle("autoscaling:hpa.title/autoscaling:hpa.requests");
  toggle("autoscaling:hpa.title/autoscaling:hpa.events");
  await waitFor(() => { expect(wb.backend.listenerCount(`watch:${target}`)).toBe(0); expect(wb.backend.listenerCount(`watch:${events}`)).toBe(0); });
  expect(document.querySelector('[data-disclosure="feature/autoscaling:hpa.title"] button')).toHaveAttribute("aria-expanded", "true");
  toggle("autoscaling:hpa.title/autoscaling:hpa.requests");
  toggle("autoscaling:hpa.title/autoscaling:hpa.events");
  await watchOf(wb, "Deployment"); await watchOf(wb, "Event");
});
it("stops only NodeClaim disruption events when its nested block closes", async () => {
  const claim: KubeObject = { apiVersion: "karpenter.sh/v1", kind: "NodeClaim", metadata: { name: "claim", labels: { "karpenter.sh/nodepool": "pool" } } };
  render(card(<NodeClaimSection {...props} obj={claim} />));
  const events = await watchOf(wb, "Event");
  emitSnapshot(wb, events, [{ apiVersion: "v1", kind: "Event", metadata: { name: "disrupt" }, reason: "DisruptionBlocked", message: "Blocked by pdb" }]);
  await waitFor(() => expect(document.querySelector('[data-disclosure="feature/autoscaling:karpenter.claimTitle/autoscaling:karpenter.disruptions"]')).not.toBeNull());
  toggle("autoscaling:karpenter.claimTitle/autoscaling:karpenter.disruptions");
  await waitFor(() => expect(wb.backend.listenerCount(`watch:${events}`)).toBe(0));
  expect(document.querySelector('[data-disclosure="feature/autoscaling:karpenter.claimTitle"] button')).toHaveAttribute("aria-expanded", "true");
  toggle("autoscaling:karpenter.claimTitle/autoscaling:karpenter.disruptions");
  await watchOf(wb, "Event");
});
