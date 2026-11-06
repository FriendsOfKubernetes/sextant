// `ui.openLogs` and `ui.openUrl` of a frame (ADR-0156): the backend decides the logs, the user every address.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KubeObject, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { checkedUrl, OpenUrlHost, resetOpenUrl } from "./openUrl";
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
