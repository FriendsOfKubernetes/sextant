import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, type KubeObject, type ObjectRef } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { HpaSection } from "../../features/autoscaling/HpaSection";
import { CertManagerSection } from "../../features/cert-manager/details";
import { Block } from "../../features/details/ui";
import { PolicySection } from "../../features/netpol/details";
import { CILIUM_POLICY, NETWORK_POLICY } from "../../features/netpol/hooks";
import { netpol } from "../../features/netpol/testData";
import { watchBackend, type WatchBackend } from "../../features/details/testing";
import { resetSharedWatches, setWatchLinger } from "../../features/resource-map/watches";
import { resetClusterKinds } from "../../resources";
import { DetailsDisclosureProvider, DetailsSectionScope } from "./disclosure";
import { resetDetailsDisclosureState } from "./disclosureState";

let wb: WatchBackend;
beforeEach(async () => {
  resetSettingsCache(); resetDetailsDisclosureState(); resetSharedWatches(); resetClusterKinds(); setWatchLinger(0);
  wb = watchBackend();
  const settings = defaultAppSettings(); settings.appearance.detailsSectionMemory = "none";
  wb.backend.on("settings_get", () => settings);
  wb.backend.on("cluster_kinds", () => []);
  await loadSettings();
});
afterEach(() => {
  cleanup(); resetSharedWatches(); setWatchLinger(null); resetClusterKinds();
  wb.backend.restore(); resetSettingsCache(); resetDetailsDisclosureState();
});

function card(ref: ObjectRef, children: ReactNode) {
  return render(<DetailsDisclosureProvider clusterId="c1" objectRef={ref}><DetailsSectionScope id="review">{children}</DetailsSectionScope></DetailsDisclosureProvider>);
}

it("keeps long header actions independent of the keyboard disclosure", async () => {
  const user = userEvent.setup(); const action = vi.fn();
  const objectRef = { kind: NETWORK_POLICY, namespace: "shop", name: "web" };
  card(objectRef, <Block id="wrapped" title="Policy with a long wrapping heading" actions={<button onClick={action}>An action that can wrap onto another header row</button>}>
    <Block id="direction" title="Ingress">Rules</Block>
  </Block>);
  const heading = screen.getByRole("heading", { level: 3, name: "Policy with a long wrapping heading" });
  const button = within(heading).getByRole("button");
  const actionButton = screen.getByRole("button", { name: "An action that can wrap onto another header row" });
  expect(heading).not.toContainElement(actionButton);
  button.focus(); await user.keyboard(" ");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Ingress" })).not.toBeInTheDocument();
  await user.click(actionButton);
  expect(action).toHaveBeenCalledOnce();
  expect(button).toHaveAttribute("aria-expanded", "false");
  button.focus(); await user.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Ingress" })).toBeInTheDocument();
});

it("keeps ordinary policy directions together in the non-frame guide group", () => {
  const obj = netpol("shop", "web", { podSelector: {}, ingress: [{}] });
  const objectRef = { kind: NETWORK_POLICY, namespace: "shop", name: "web" };
  const { container } = card(objectRef, <PolicySection clusterId="c1" objectRef={objectRef} obj={obj} />);
  const group = container.querySelector(".np-details-policy[data-policy]");
  expect(group).toHaveClass("dt-disclosure-group");
  expect(group?.querySelectorAll(":scope > .dt-disclosure-nested")).toHaveLength(2);
  expect(within(group as HTMLElement).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Ingress", "Egress"]);
  fireEvent.click(screen.getByRole("button", { name: "Ingress" }));
  expect(screen.getByRole("button", { name: "Ingress" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "Egress" })).toHaveAttribute("aria-expanded", "true");
  expect(group).not.toHaveClass("dt-container");
});

it("makes Cilium parts keyboard disclosures with directions one heading level deeper", async () => {
  const user = userEvent.setup();
  const obj: KubeObject = {
    apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "web", namespace: "shop" },
    specs: [{ endpointSelector: {}, ingress: [{}] }, { endpointSelector: {}, egress: [{}] }],
  };
  const objectRef = { kind: CILIUM_POLICY, namespace: "shop", name: "web" };
  const { container } = card(objectRef, <PolicySection clusterId="c1" objectRef={objectRef} obj={obj} />);
  const first = screen.getByRole("button", { name: "Spec 1" });
  const second = screen.getByRole("button", { name: "Spec 2" });
  expect(screen.getByRole("heading", { level: 4, name: "Spec 1" })).toContainElement(first);
  expect(screen.getAllByRole("heading", { level: 5 }).map((h) => h.textContent)).toEqual(["Ingress", "Egress", "Ingress", "Egress"]);
  expect(first.getAttribute("aria-controls")).not.toBe(second.getAttribute("aria-controls"));
  const parts = [...container.querySelectorAll(".np-details-policy[data-policy]")];
  expect(parts).toHaveLength(2);
  expect(parts.every((part) => part.classList.contains("dt-disclosure-group"))).toBe(true);
  expect(within(parts[1] as HTMLElement).getByText("Does not restrict ingress.")).toBeInTheDocument();
  expect(first.closest("[data-disclosure]")?.getAttribute("data-disclosure")).toBe("review/netpol:details.plainWords/policyPart");
  first.focus(); await user.keyboard(" ");
  // Repeated parts deliberately share the semantic preference, independent of their translated title or position.
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(second).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("heading", { level: 5 })).not.toBeInTheDocument();
  expect(container.querySelectorAll(".np-details-policy[data-policy]")).toHaveLength(2);
  await user.keyboard("{Enter}");
  expect(screen.getAllByRole("heading", { level: 5 })).toHaveLength(4);
});

it("keeps HPA verdicts, causes and fields in one leading flow before the metrics heading", () => {
  const obj: KubeObject = {
    apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: "shop" },
    spec: { minReplicas: 1, maxReplicas: 3 }, status: { currentReplicas: 1, desiredReplicas: 1 },
  };
  const objectRef = { kind: { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" }, namespace: "shop", name: "web" };
  const { container } = card(objectRef, <HpaSection clusterId="c1" objectRef={objectRef} obj={obj} />);
  const body = container.querySelector('[data-disclosure="review/autoscaling:hpa.title"] > .dt-block__body');
  const leading = body?.firstElementChild;
  expect(leading).toHaveClass("dt-disclosure-lead");
  expect(leading?.querySelector(".as-phrase")).not.toBeNull();
  expect(leading?.querySelector(".dt-fields")).not.toBeNull();
  expect(leading?.nextElementSibling).toHaveAttribute("data-disclosure", "review/autoscaling:hpa.title/autoscaling:hpa.metrics");
});

it("keeps a Certificate explanation and fields in one leading flow before Last failure", () => {
  const obj: KubeObject = {
    apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: { name: "web", namespace: "shop" },
    spec: { secretName: "web-tls", issuerRef: { name: "issuer" }, dnsNames: ["web.example.test"] },
    status: { lastFailureTime: "2026-10-10T00:00:00Z", conditions: [{ type: "Ready", status: "False", reason: "Failed" }] },
  };
  const objectRef = { kind: { group: "cert-manager.io", version: "v1", kind: "Certificate" }, namespace: "shop", name: "web" };
  const { container } = card(objectRef, <CertManagerSection clusterId="c1" objectRef={objectRef} obj={obj} />);
  const body = container.querySelector('[data-disclosure="review/details:sections.fields"] > .dt-block__body');
  const leading = body?.firstElementChild;
  expect(leading).toHaveClass("dt-disclosure-lead");
  expect(leading?.querySelector(".cm-explain")).not.toBeNull();
  expect(leading?.querySelector(".dt-fields")).not.toBeNull();
  expect(leading?.nextElementSibling).toHaveAttribute("data-disclosure", "review/details:sections.fields/certmanager:lastFailure.title");
});
