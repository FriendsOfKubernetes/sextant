// `ui.openLogs` and `ui.openUrl` of a frame (ADR-0156): the backend decides the logs, the user every address.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KubeObject, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { checkedTarget, OpenClusterHost, resetOpenCluster, serverIs } from "./openCluster";
import { checkedUrl, OpenUrlHost, resetOpenUrl } from "./openUrl";
import { useClustersStore } from "../features/clusters/clustersStore";
import type { ClusterInfo } from "../api";
import { resetSignIns, SignInHost } from "./signIn";
import { hostUi } from "./ui";

let backend: MockBackend;
const pod: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-1", namespace: "team-a", uid: "p1" },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
};

beforeEach(() => {
  resetAppStore();
  resetOpenUrl();
  resetSignIns();
  backend = mockBackend({ resource_get: () => pod, extension_call: () => null });
});

afterEach(() => backend.restore());

const ui = () => hostUi({ extensionId: "demo.ext", extensionName: () => "Demo", clusterId: () => "c1" });

describe("ui.openLogs", () => {
  it("asks the backend as the extension, then opens Sextant's logs tab of the pod's container", async () => {
    await ui().openLogs({ namespace: "team-a", pod: "web-1", container: "sidecar" });
    const asked = backend.calls.filter((c) => c.cmd === "extension_call");
    expect(asked[0]!.args).toMatchObject({
      extensionId: "demo.ext",
      method: "logs.open",
      params: { clusterId: "c1", namespace: "team-a", pod: "web-1", container: "sidecar" },
    });
    const tab = useAppStore.getState().dock.tabs[0]!;
    expect(tab).toMatchObject({ type: "logs", title: "web-1" });
    expect(tab.payload).toMatchObject({ container: "sidecar" });
  });

  it("opens the merged logs of a label selector", async () => {
    await ui().openLogs({ namespace: "team-a", labelSelector: "app=web" });
    expect(useAppStore.getState().dock.tabs[0]).toMatchObject({ id: "logs:c1:selector:team-a:app=web" });
  });

  it("titles a merged tab as asked (#407)", async () => {
    await ui().openLogs({ namespace: "ray", labelSelector: "ray.io/cluster=demo,ray.io/node-type=worker", title: "raycluster/demo" });
    expect(useAppStore.getState().dock.tabs[0]).toMatchObject({ title: "raycluster/demo" });
    await expect(ui().openLogs({ namespace: "ray", labelSelector: "a=b", title: "bad\u0007" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("opens nothing when the backend refuses, and refuses a malformed call before asking", async () => {
    backend.on("extension_call", () => {
      throw { code: "denied", message: "no logs" };
    });
    await expect(ui().openLogs({ namespace: "team-a", pod: "web-1" })).rejects.toMatchObject({ code: "denied" });
    expect(useAppStore.getState().dock.tabs).toEqual([]);
    const before = backend.calls.length;
    await expect(ui().openLogs({ namespace: "team-a", pod: "web-1", labelSelector: "a=b" })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(backend.calls.length).toBe(before);
  });
});

describe("ui.openUrl", () => {
  it("opens an address only after the user says so, every time", async () => {
    render(<OpenUrlHost />);
    let answer: Promise<{ opened: boolean }> | undefined;
    act(() => {
      answer = ui().openUrl({ url: "https://localhost:8443/applications" });
    });
    expect(await screen.findByText("https://localhost:8443/applications")).toBeInTheDocument();
    expect(screen.getByText("Extension Demo wants to open this address in your browser:")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await expect(answer).resolves.toEqual({ opened: true });
    await waitFor(() => expect(backend.openedUrls).toEqual(["https://localhost:8443/applications"]));

    act(() => {
      answer = ui().openUrl("https://example.com/");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toEqual({ opened: false });
    expect(backend.openedUrls).toHaveLength(1);
  });

  it("refuses anything but a plain http(s) address", () => {
    expect(checkedUrl("http://127.0.0.1:8080/x?y=1")).toBe("http://127.0.0.1:8080/x?y=1");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/", "", 42, "not a url"]) {
      expect(() => checkedUrl(bad), String(bad)).toThrow();
    }
  });
});

describe("ui.signIn", () => {
  const service = {
    id: "api",
    title: "Argo CD API",
    name: "argocd-server",
    port: "https",
    scheme: "https" as const,
    signIn: {
      fields: [
        { id: "username", label: "Username", secret: false },
        { id: "password", label: "Password", secret: true },
      ],
    },
  };
  const withServices = () =>
    hostUi({ extensionId: "demo.ext", extensionName: () => "Demo", clusterId: () => "c1", services: () => [service] });

  it("asks in Sextant's own dialog and sends the values to Rust, never back to the frame", async () => {
    render(<SignInHost />);
    let answer: Promise<{ signedIn: boolean }> | undefined;
    act(() => {
      answer = withServices().signIn({ namespace: "argocd", service: "api" });
    });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Argo CD API" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember for this cluster" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await expect(answer).resolves.toEqual({ signedIn: true });
    const sent = backend.calls.find((c) => c.cmd === "extension_service_sign_in")!;
    expect(sent.args).toMatchObject({
      extensionId: "demo.ext",
      clusterId: "c1",
      namespace: "argocd",
      service: "api",
      values: { username: "admin", password: "hunter2" },
      remember: true,
    });
  });

  it("answers false when the user cancels, and refuses a service without a sign-in", async () => {
    render(<SignInHost />);
    let answer: Promise<{ signedIn: boolean }> | undefined;
    act(() => {
      answer = withServices().signIn({ namespace: "argocd", service: "api" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toEqual({ signedIn: false });
    await expect(withServices().signIn({ namespace: "argocd", service: "other" })).rejects.toMatchObject({ code: "notFound" });
  });
});

describe("ui.openCluster (#413)", () => {
  afterEach(() => resetOpenCluster());

  it("compares a kubeconfig server with an endpoint, and checks what is asked", () => {
    expect(serverIs("https://10.0.0.5:6443", { host: "10.0.0.5", port: 6443 })).toBe(true);
    expect(serverIs("https://api.example.com", { host: "API.example.com", port: 443 })).toBe(true);
    expect(serverIs("https://[fd00::1]:6443", { host: "fd00::1", port: 6443 })).toBe(true);
    expect(serverIs("https://10.0.0.5:6443", { host: "10.0.0.5", port: 443 })).toBe(false);
    expect(() => checkedTarget({ host: "a/b", port: 443 })).toThrow(/host/);
    expect(() => checkedTarget({ host: "a", port: 0 })).toThrow(/port/);
    expect(() => checkedTarget({ host: "a", port: 6443, node: "Bad Node" })).toThrow(/node/);
  });

  it("asks nothing and says found: 0 where Sextant has no cluster at the address; else lets the user pick", async () => {
    const cluster = { id: "workload-1", context: "capi-quickstart", server: "https://172.18.0.4:6443" } as ClusterInfo;
    useClustersStore.setState({ clusters: [cluster] });
    await expect(ui().openCluster({ host: "10.9.9.9", port: 6443 })).resolves.toEqual({ opened: false, found: 0 });
    render(<OpenClusterHost />);
    let answer: Promise<{ opened: boolean; found?: number }> | undefined;
    act(() => {
      answer = ui().openCluster({ host: "172.18.0.4", port: 6443 });
    });
    expect(await screen.findByText("Extension Demo wants to open the cluster at 172.18.0.4:6443. Sextant connects it if it is not connected.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toEqual({ opened: false });
    act(() => {
      answer = ui().openCluster({ host: "172.18.0.4", port: 6443 });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open cluster capi-quickstart" }));
    await expect(answer).resolves.toEqual({ opened: true });
  });
});
