import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ClusterInfo, type KubeObject, type MockBackend, type ObjectRef, type TrafficEdge } from "../../api";
import type { ObservabilityLinks } from "../../api/generated/ObservabilityLinks";
import { getDetailsSections } from "../../layout/details/registry";
import { axeViolations } from "../../test/axe";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { getClusterSettingsTabs } from "../clusters/settingsRegistry";
import { SelectionPanel } from "../resource-map/traffic/EdgePanel";
import { MIXIN_UIDS } from "./presets";
import "./index";

const cluster: ClusterInfo = {
  id: "c1",
  context: "kind-sextant-test",
  clusterName: "kind-sextant-test",
  server: "https://127.0.0.1:6443",
  user: "admin",
  namespace: null,
  sourceId: "default",
};

const GRAFANA = "https://grafana.example.com";
const configured: ObservabilityLinks = {
  grafanaUrl: GRAFANA,
  dashboards: {
    pod: `/d/${MIXIN_UIDS.pod}?var-namespace={namespace}&var-pod={pod}&from={from}&to={to}`,
    edge: "/d/edge?src={source}&dst={destination}",
  },
  tracesUrl: "https://jaeger.example.com",
  traces: "/search?service={service}",
};

let backend: MockBackend;
function start(links: ObservabilityLinks | null) {
  backend?.restore();
  backend = mockBackend({}, { settings: { clusters: { c1: { ...defaultClusterSettings(), observabilityLinks: links } } } });
}
beforeEach(() => start(null));
afterEach(() => backend.restore());

function SettingsTab() {
  const tab = getClusterSettingsTabs().find((t) => t.id === "observabilityLinks")!;
  return (
    <>
      {tab.sections.map(({ id, Component }) => (
        <Component key={id} clusterId="c1" cluster={cluster} />
      ))}
    </>
  );
}

const podRef: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "shop", name: "web-1" };
const pod: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-1", namespace: "shop", labels: { "app.kubernetes.io/name": "web" } },
  spec: { containers: [{ name: "app" }] },
};

function Details({ obj, objectRef }: { obj: KubeObject; objectRef: ObjectRef }) {
  const section = getDetailsSections(objectRef.kind).find((s) => s.id === "observabilityLinks")!;
  const { Component } = section;
  return <Component clusterId="c1" objectRef={objectRef} obj={obj} />;
}

describe("cluster settings", () => {
  it("has its own tab, passes axe and saves checked links", async () => {
    const { container } = render(<SettingsTab />);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.change(screen.getByLabelText("Grafana URL"), { target: { value: `${GRAFANA}/` } });
    fireEvent.change(screen.getByRole("combobox", { name: "Preset for Pods" }), { target: { value: "mixinPod" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.clusters.c1?.observabilityLinks?.grafanaUrl).toBe(GRAFANA));
    expect(backend.settings.clusters.c1?.observabilityLinks?.dashboards.pod).toContain(MIXIN_UIDS.pod);
  });

  it("refuses a template of another site and saves nothing", async () => {
    render(<SettingsTab />);
    fireEvent.change(screen.getByLabelText("Grafana URL"), { target: { value: GRAFANA } });
    fireEvent.change(screen.getByLabelText("Nodes"), { target: { value: "https://evil.example.com/{node}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The template must stay on the site of the base URL.")).toBeTruthy();
    expect(backend.settings.clusters.c1?.observabilityLinks ?? null).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("refuses plain http to another host and a URL with credentials", async () => {
    render(<SettingsTab />);
    const input = screen.getByLabelText("Grafana URL");
    fireEvent.change(input, { target: { value: "http://grafana.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Use https; plain http is accepted only for localhost.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "https://admin:pw@grafana.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The URL must not contain a user name or password.")).toBeTruthy();
  });
});

describe("details", () => {
  it("shows nothing without links", () => {
    const { container } = render(<Details obj={pod} objectRef={podRef} />);
    expect(container.textContent).toBe("");
  });

  it("opens the pod's dashboard and traces in the browser", async () => {
    start(configured);
    const { container } = render(<Details obj={pod} objectRef={podRef} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Grafana" }));
    const url = new URL(backend.openedUrls[0]!);
    expect(url.origin).toBe(GRAFANA);
    expect(url.searchParams.get("var-pod")).toBe("web-1");
    expect(Number(url.searchParams.get("to")) - Number(url.searchParams.get("from"))).toBe(3_600_000);
    fireEvent.click(screen.getByRole("button", { name: "Find traces" }));
    expect(backend.openedUrls[1]).toBe("https://jaeger.example.com/search?service=web");
    expect(backend.calls.filter((c) => c.cmd !== "settings_get")).toEqual([]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("gives a node no trace link", async () => {
    start({ ...configured, dashboards: { node: "/d/n?var-node={node}" } });
    render(<Details obj={{ metadata: { name: "n1" } }} objectRef={{ kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: "n1" }} />);
    expect(await screen.findByRole("button", { name: "Open in Grafana" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Find traces" })).toBeNull();
  });
});

describe("traffic graph", () => {
  it("links an edge by both ends", async () => {
    start(configured);
    const edge = {
      from: { kind: "workload" as const, namespace: "shop", name: "web" },
      to: { kind: "workload" as const, namespace: "shop", name: "api" },
    };
    const full: TrafficEdge = {
      ...edge,
      source: "istio",
      via: "cluster",
      protocol: "http",
      rate: 1,
      errorRatio: 0,
      p50Ms: null,
      p95Ms: null,
      statusClasses: [],
      missing: [],
    };
    const link = { id: "l1", from: "a", to: "b", edges: [full] };
    const { container } = render(
      <SelectionPanel
        clusterId="c1"
        selection={{ type: "link", link: link as never }}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open in Grafana" }));
    expect(backend.openedUrls[0]).toBe(`${GRAFANA}/d/edge?src=web&dst=api`);
    fireEvent.click(screen.getByRole("button", { name: "Find traces" }));
    expect(backend.openedUrls[1]).toBe("https://jaeger.example.com/search?service=api");
    expect(await axeViolations(container)).toEqual([]);
  });
});
