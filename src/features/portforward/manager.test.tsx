import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type ForwardInfo, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { PortForwardPage } from "./PortForwardPage";
import { ForwardDialog } from "./ForwardDialog";
import { axeViolations } from "../../test/axe";

const forward = (over: Partial<ForwardInfo> = {}): ForwardInfo => ({ id: "web", cluster: "c1",
  target: { type: "service", namespace: "apps", name: "web" }, remotePort: 80, localPort: 8080,
  status: { state: "active" }, source: "user", ...over });
let backend: MockBackend;
beforeEach(() => { resetAppStore(); });
afterEach(() => { cleanup(); backend.restore(); vi.restoreAllMocks(); });
const page = () => render(<PortForwardPage clusterId="c1" />);
function setup(rows: ForwardInfo[]) {
  backend = mockBackend({ portforward_list: () => rows, portforward_stop: () => undefined, portforward_start: () => forward({ id: "new" }) });
}

describe("port-forward management", () => {
  it("searches and filters only the current cluster, with separate columns and a reset", async () => {
    setup([forward(), forward({ id: "bad", localPort: 8081, status: { state: "error", code: "notFound", message: "pod deleted" } }), forward({ id: "other", cluster: "c2" })]);
    page();
    await screen.findAllByText("Service web");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "Namespace" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "8081" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Forward status"), { target: { value: "active" } });
    expect(screen.getByText("No matching port forwards.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("copies an address and stops from the successful creation dialog, updating the page", async () => {
    setup([]);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    render(<><PortForwardPage clusterId="c1" /><ForwardDialog clusterId="c1" target={forward().target} ports={[80]} close={() => undefined} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Forwarding localhost:8080"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("http://localhost:8080"));
    fireEvent.click(dialog.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(dialog.getByText("This port forward has stopped.")).toBeInTheDocument());
    expect(screen.getByText("No active port forwards.")).toBeInTheDocument();
    expect(backend.calls.filter(c => c.cmd === "portforward_list")).toHaveLength(1);
  });

  it("requires confirmation to stop an internal vcluster connection and excludes it from selection", async () => {
    setup([forward({ source: "vcluster" })]);
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("disconnect that cluster");
    expect(backend.calls.some(c => c.cmd === "portforward_stop")).toBe(false);
    expect(screen.getAllByRole("checkbox").every(c => c.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(backend.calls.some(c => c.cmd === "portforward_stop")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByText("No active port forwards.")).toBeInTheDocument());
  });

  it("bulk-stops eligible visible rows, retains partial failures and excludes other clusters", async () => {
    setup([forward(), forward({ id: "failed", localPort: 8081 }), forward({ id: "internal", source: "vcluster" }), forward({ id: "other", cluster: "c2" })]);
    backend.on("portforward_stop", ({ id }) => { if (id === "failed") throw { code: "denied", message: "stop refused" }; });
    page();
    const selectAll = await screen.findByLabelText("Select visible user forwards");
    await waitFor(() => expect(selectAll).not.toBeDisabled());
    fireEvent.click(selectAll);
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("stop refused"));
    expect(backend.calls.filter(c => c.cmd === "portforward_stop").map(c => c.args.id)).toEqual(["web", "failed"]);
    expect(document.querySelector('[data-forward="web"]')).toBeNull();
    expect(document.querySelector('[data-forward="failed"]')).toBeInTheDocument();
    expect(document.querySelector('[data-forward="internal"]')).toBeInTheDocument();
    expect(within(document.querySelector('[data-forward="failed"]') as HTMLElement).getByRole("checkbox")).toBeChecked();
  });

  it("retries a failed listener and keeps its parameters editable if starting fails", async () => {
    setup([forward({ status: { state: "error", code: "notFound", message: "pod deleted" } })]);
    backend.on("portforward_start", () => { throw { code: "portInUse", message: "port still busy" }; });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByLabelText("Local port")).toHaveValue(8080);
    expect(dialog.getByLabelText("Port to forward")).toHaveValue("80");
    expect(dialog.getByRole("alert")).toHaveTextContent("port still busy");
    expect(backend.calls.filter(c => c.cmd.startsWith("portforward_")).map(c => c.cmd)).toEqual(["portforward_list", "portforward_stop", "portforward_start"]);
    backend.on("portforward_start", () => forward({ id: "new" }));
    fireEvent.change(dialog.getByLabelText("Local port"), { target: { value: "8082" } });
    fireEvent.click(dialog.getByRole("button", { name: "Start forwarding" }));
    await waitFor(() => expect(backend.calls.at(-1)?.args.localPort).toBe(8082));
  });

  it("shows existing forwards in the creation form and opens the cluster page without stopping them", async () => {
    setup([forward()]);
    render(<ForwardDialog clusterId="c1" target={forward().target} ports={[80]} close={() => undefined} />);
    expect(await screen.findByText("Existing forwards for this port")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All port forwards" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("portforward");
    expect(backend.calls.some(c => c.cmd === "portforward_stop")).toBe(false);
  });

  it("clears stale selection when a forward disappears or the cluster changes", async () => {
    setup([forward(), forward({ id: "other", cluster: "c2" })]);
    const view = page();
    const select = await screen.findByLabelText("Select visible user forwards");
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.click(select);
    act(() => backend.emit("portforwards", [forward({ id: "other", cluster: "c2" })]));
    expect(screen.queryByRole("button", { name: "Stop selected" })).toBeNull();
    view.rerender(<PortForwardPage clusterId="c2" />);
    expect(screen.queryByRole("button", { name: "Stop selected" })).toBeNull();
    expect(await screen.findByText("Service web")).toBeInTheDocument();
  });

  it.each(["form", "result"])("keeps stop failures visible inside the %s dialog", async (mode) => {
    setup(mode === "form" ? [forward()] : []);
    backend.on("portforward_stop", () => { throw { code: "denied", message: "stop refused" }; });
    render(<ForwardDialog clusterId="c1" target={forward().target} ports={[80]} close={() => undefined} />);
    if (mode === "result") {
      fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));
      await screen.findByText("Forwarding localhost:8080 to port 80.");
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("stop refused"));
  });

  it("shows the bulk targets and skips a target removed while another stop is pending", async () => {
    const second = forward({ id: "second", target: { type: "pod", namespace: "jobs", name: "worker" }, localPort: 8081 });
    setup([forward(), second]);
    let finish!: () => void;
    backend.on("portforward_stop", () => new Promise<void>(done => { finish = done; }));
    page();
    const select = await screen.findByLabelText("Select visible user forwards");
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("button", { name: "Stop selected" }));
    const confirm = within(screen.getByRole("dialog"));
    expect(confirm.getByText(/worker/)).toBeInTheDocument();
    expect(confirm.getByText(/8081/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => backend.emit("portforwards", [forward()]));
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByText("No active port forwards.")).toBeInTheDocument());
    expect(backend.calls.filter(c => c.cmd === "portforward_stop").map(c => c.args.id)).toEqual(["web"]);
  });

  it("has accessible names and dialog semantics for populated, error and internal states", async () => {
    setup([forward(), forward({ id: "internal", source: "vcluster", localPort: 16443 }), forward({ id: "error", status: { state: "error", code: "notFound", message: "gone" } })]);
    render(<main><PortForwardPage clusterId="c1" /></main>);
    await screen.findAllByRole("button", { name: "Stop" });
    expect(await axeViolations(document)).toEqual([]);
    fireEvent.click(within(document.querySelector('[data-forward="internal"]') as HTMLElement).getByRole("button", { name: "Stop" }));
    expect(await axeViolations(document)).toEqual([]);
  }, 30_000);
});
