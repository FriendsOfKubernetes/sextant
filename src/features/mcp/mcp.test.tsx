import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockBackend,
  type AuditEntry,
  type ClusterInfo,
  type ConfirmRequest,
  type McpStatus,
  type MockBackend,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { getPage } from "../../layout/pages";
import { getSlot } from "../../layout/slots";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { SETTINGS_PAGE_ID } from "../settings";
import { ConfirmHost } from "./ConfirmHost";
import { resetMcpUi } from "./store";
import "./index";

// A made-up token: the real one is never printed or needed by a test.
const TOKEN = "tk_FAKE_0123456789abcdef";
const RUNNING: McpStatus = { state: "running", url: "http://127.0.0.1:47391/mcp", error: null };
const prod: ClusterInfo = {
  id: "prod",
  context: "prod-admin",
  clusterName: "prod",
  server: "https://prod",
  user: "me",
  namespace: null,
  sourceId: "s",
};
const staging: ClusterInfo = { ...prod, id: "staging", context: "staging", clusterName: "staging" };

let backend: MockBackend;
let clipboard: string[];

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  at: Date.UTC(2026, 9, 13, 10, 30, 0),
  source: "agent",
  principal: "claude-code",
  client: "claude-code",
  clusterId: "prod",
  clusterName: "prod-admin",
  tool: "get_resource",
  target: "Pod team-a/web-1",
  decision: "allowed",
  result: "ok",
  durationMs: 42,
  ...over,
});

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  id: "r1",
  source: "agent",
  principal: "claude-code",
  client: "claude-code",
  clusterId: "prod",
  clusterName: "prod-admin",
  tool: "delete_resource",
  target: "Deployment team-a/web",
  details: null,
  ...over,
});

function setup(mcp = { enabled: true, port: 47391 }, handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  backend = mockBackend(
    {
      clusters_list: () => [prod, staging],
      kubeconfig_sources: () => [],
      cluster_state: () => ({ state: "disconnected" }),
      helm_status: () => ({ available: false, version: null, path: null }),
      mcp_status: () => (mcp.enabled ? RUNNING : { state: "off", url: null, error: null }),
      mcp_token: () => TOKEN,
      mcp_regenerate_token: () => "tk_FAKE_NEW",
      mcp_binary_path: () => "/opt/Sextant/sextant",
      mcp_audit_list: () => [],
      mcp_audit_clear: () => undefined,
      mcp_confirm_answer: () => undefined,
      ...handlers,
    },
    { settings: { mcp } },
  );
}

function renderSettings() {
  const page = getPage(SETTINGS_PAGE_ID);
  if (!page) throw new Error("the settings page is not registered");
  return render(<page.Component clusterId="c1" />);
}

function renderConfirm() {
  return render(<ConfirmHost />);
}

function renderFooter() {
  const Footer = getSlot("railFooter");
  if (!Footer) throw new Error("no rail footer");
  return render(<Footer />);
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
const listening = (event: string) => waitFor(() => expect(backend.listenerCount(event)).toBeGreaterThan(0));

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetHelmStatus();
  resetMcpUi();
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => void clipboard.push(text)) },
  });
});
afterEach(() => {
  vi.useRealTimers();
  backend.restore();
});

describe("Settings → AI agents (MCP)", () => {
  it("is off by default; the switch turns it on and saves it", async () => {
    setup({ enabled: false, port: 47391 });
    renderSettings();
    const section = screen.getByRole("region", { name: "AI agents (MCP)" });
    const toggle = within(section).getByRole("checkbox", { name: "Enable MCP server" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(within(section).getByRole("status")).toHaveTextContent("Off");
    expect(within(section).queryByText("Token")).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(backend.settings.mcp.enabled).toBe(true));
    expect(backend.settings.mcp.port).toBe(47391);
  });

  it("shows the address while running and the backend's text when the port is taken", async () => {
    setup();
    renderSettings();
    expect(await screen.findByText("Running at http://127.0.0.1:47391/mcp")).toBeInTheDocument();

    await listening("mcp-status");
    act(() =>
      backend.emit("mcp-status", {
        state: "error",
        url: null,
        error: "Port 47391 is in use — another Sextant or program?",
      } satisfies McpStatus),
    );
    expect(screen.getByText("Port 47391 is in use — another Sextant or program?")).toBeInTheDocument();
  });

  it("saves a port from 1024 to 65535 and refuses anything else", async () => {
    setup();
    renderSettings();
    const port = await screen.findByRole("textbox", { name: "Port" });
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(port).toHaveValue("47391"));
    expect(apply).toBeDisabled();

    for (const bad of ["80", "1023", "65536", "abc", "4.5", ""]) {
      fireEvent.change(port, { target: { value: bad } });
      expect(apply, bad).toBeDisabled();
    }
    fireEvent.change(port, { target: { value: "80" } });
    expect(screen.getByText("Enter a whole number from 1024 to 65535.")).toBeInTheDocument();
    expect(port).toBeInvalid();

    for (const good of ["1024", "65535"]) {
      fireEvent.change(port, { target: { value: good } });
      expect(apply, good).toBeEnabled();
    }
    fireEvent.change(port, { target: { value: "5000" } });
    fireEvent.click(apply);
    await waitFor(() => expect(backend.settings.mcp.port).toBe(5000));
    expect(backend.settings.mcp.enabled).toBe(true);
  });

  it("keeps the token hidden until Show, copies the real one and forgets it on Hide", async () => {
    setup();
    renderSettings();
    const token = await screen.findByTestId("mcp-token");
    expect(token).not.toHaveTextContent(TOKEN);
    expect(calls("mcp_token")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(token).toHaveTextContent(TOKEN));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(token).not.toHaveTextContent(TOKEN);

    const tokenField = token.closest(".settings__field") as HTMLElement;
    fireEvent.click(within(tokenField).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toEqual([TOKEN]));
    expect(token).not.toHaveTextContent(TOKEN);
    expect(await within(tokenField).findByText("Token copied.")).toBeInTheDocument();
  });

  it("regenerates the token only after the user confirms", async () => {
    setup();
    renderSettings();
    await screen.findByTestId("mcp-token");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const dialog = screen.getByRole("dialog", { name: "Regenerate the token?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls("mcp_regenerate_token")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(calls("mcp_regenerate_token")).toHaveLength(1));
    expect(await screen.findByText(/A new token was created/)).toBeInTheDocument();
    // It was hidden, so the new one stays hidden too.
    expect(screen.getByTestId("mcp-token")).not.toHaveTextContent("tk_FAKE_NEW");
  });

  it("shows the new token at once when the old one was shown", async () => {
    setup();
    renderSettings();
    await screen.findByTestId("mcp-token");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(screen.getByTestId("mcp-token")).toHaveTextContent(TOKEN));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(screen.getByTestId("mcp-token")).toHaveTextContent("tk_FAKE_NEW"));
  });

  it("offers a ready command for Claude Code: masked on screen, with the real token when copied", async () => {
    setup();
    renderSettings();
    const snippet = await screen.findByTestId("mcp-snippet");
    expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveAttribute("aria-selected", "true");
    expect(snippet.textContent).toMatch(
      /^claude mcp add --transport http sextant http:\/\/127\.0\.0\.1:47391\/mcp --header "Authorization: Bearer •+"$/,
    );
    expect(snippet).not.toHaveTextContent(TOKEN);

    fireEvent.click(screen.getByRole("button", { name: "Copy Claude Code configuration" }));
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toBe(
      `claude mcp add --transport http sextant http://127.0.0.1:47391/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("offers the Cursor JSON with the url and the header", async () => {
    setup({ enabled: true, port: 5000 });
    renderSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Cursor" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Cursor configuration" }));
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(JSON.parse(clipboard[0]!)).toEqual({
      mcpServers: {
        sextant: { url: "http://127.0.0.1:5000/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
  });

  it("offers the Claude Desktop JSON with the path of the executable and no token", async () => {
    setup();
    renderSettings();
    fireEvent.click(await screen.findByRole("tab", { name: "Claude Desktop" }));
    const snippet = screen.getByTestId("mcp-snippet");
    await waitFor(() => expect(snippet).toHaveTextContent("/opt/Sextant/sextant"));
    expect(JSON.parse(snippet.textContent!)).toEqual({
      mcpServers: { sextant: { command: "/opt/Sextant/sextant", args: ["mcp"] } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy Claude Desktop configuration" }));
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(JSON.parse(clipboard[0]!)).toEqual(JSON.parse(snippet.textContent!));
    expect(clipboard[0]).not.toContain(TOKEN);
    expect(calls("mcp_token")).toHaveLength(0);
  });

  it("says so when the clipboard refuses", async () => {
    setup();
    renderSettings();
    await screen.findByTestId("mcp-snippet");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied by the system");
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy Claude Code configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy: denied by the system");
  });

  it("opens the activity log", async () => {
    setup({ enabled: false, port: 47391 });
    renderSettings();
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Open activity log" }));
    expect(await screen.findByRole("dialog", { name: "Agent activity" })).toBeInTheDocument();
  });
});

describe("Confirmation of what an agent asks to do", () => {
  it("shows who asks, where, what and on what, and sends the answer", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    act(() =>
      backend.emit(
        "mcp-confirm",
        request({ tool: "apply_yaml", target: "Deployment team-a/web", details: "kind: Deployment\nmetadata:\n  name: web" }),
      ),
    );
    const dialog = screen.getByRole("alertdialog", { name: "An AI agent asks to act" });
    expect(dialog).toHaveTextContent("claude-code");
    expect(dialog).toHaveTextContent("prod-admin");
    expect(dialog).toHaveTextContent("Apply YAML");
    expect(dialog).toHaveTextContent("apply_yaml");
    expect(dialog).toHaveTextContent("Deployment team-a/web");
    expect(dialog.querySelector("pre")?.textContent).toBe("kind: Deployment\nmetadata:\n  name: web");

    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(1));
    expect(calls("mcp_confirm_answer")[0]!.args).toEqual({ id: "r1", approved: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("puts Deny first in the focus order and sends a refusal", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    act(() => backend.emit("mcp-confirm", request()));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Deny" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(1));
    expect(calls("mcp_confirm_answer")[0]!.args).toEqual({ id: "r1", approved: false });
  });

  it("treats Escape as a refusal", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    act(() => backend.emit("mcp-confirm", request()));
    fireEvent.keyDown(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Deny" }), { key: "Escape" });
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(1));
    expect(calls("mcp_confirm_answer")[0]!.args).toEqual({ id: "r1", approved: false });
  });

  it("asks one request at a time, in the order they came", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    act(() => {
      backend.emit("mcp-confirm", request({ id: "a", target: "Deployment team-a/first" }));
      backend.emit("mcp-confirm", request({ id: "b", tool: "exec_command", target: "Pod team-a/second", details: "ls -l" }));
      backend.emit("mcp-confirm", request({ id: "a", target: "Deployment team-a/first" }));
    });
    let dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Deployment team-a/first");
    expect(dialog).toHaveTextContent("1 more request is waiting.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Pod team-a/second");
    expect(dialog).toHaveTextContent("ls -l");
    expect(dialog).not.toHaveTextContent("more request");
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(2));
    expect(calls("mcp_confirm_answer").map((c) => c.args)).toEqual([
      { id: "a", approved: false },
      { id: "b", approved: true },
    ]);
  });

  it("counts down from two minutes and drops a request nobody answered", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    vi.useFakeTimers();
    act(() => backend.emit("mcp-confirm", request()));
    expect(screen.getByRole("timer")).toHaveTextContent("Denied automatically in 2:00");

    act(() => void vi.advanceTimersByTime(65_000));
    expect(screen.getByRole("timer")).toHaveTextContent("Denied automatically in 0:55");

    act(() => void vi.advanceTimersByTime(55_000));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls("mcp_confirm_answer")).toHaveLength(0);
  });

  it("survives an answer that arrives too late", async () => {
    setup(undefined, {
      mcp_confirm_answer: () => {
        throw { code: "notFound", message: "no such request" };
      },
    });
    renderConfirm();
    await listening("mcp-confirm");
    act(() => backend.emit("mcp-confirm", request()));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the extension that asks, with its method, in the same dialog", async () => {
    setup();
    renderConfirm();
    await listening("mcp-confirm");
    act(() =>
      backend.emit(
        "mcp-confirm",
        request({
          id: "e1",
          source: "extension",
          principal: "Extension Widgets",
          client: "demo.widgets",
          tool: "resources.patch",
          target: "Widget team-a/w1",
        }),
      ),
    );
    const dialog = screen.getByRole("alertdialog", { name: "An extension asks to act" });
    expect(within(dialog).getByText("Extension")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Extension Widgets wants to do the following in prod-admin.");
    expect(dialog).toHaveTextContent("Patch a resource");
    expect(dialog).toHaveTextContent("resources.patch");
    expect(dialog).not.toHaveTextContent("Agent");
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(calls("mcp_confirm_answer")).toHaveLength(1));
    expect(calls("mcp_confirm_answer")[0]!.args).toEqual({ id: "e1", approved: true });
  });
});

describe("Agent activity", () => {
  it("sits in the rail footer next to the Settings button, without the confirmation dialog (#47)", async () => {
    setup();
    renderFooter();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Agent activity" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.listenerCount("mcp-confirm")).toBe(0);
  });

  it("has no button in the rail while the server is off", async () => {
    setup({ enabled: false, port: 47391 });
    renderFooter();
    await screen.findByRole("button", { name: "Settings" });
    await waitFor(() => expect(calls("settings_get").length).toBeGreaterThan(0));
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /Agent activity/ })).toBeNull();
  });

  it("has a button in the rail while it is on, with a dot for ten seconds after a call", async () => {
    setup();
    renderFooter();
    const button = await screen.findByRole("button", { name: "Agent activity" });
    expect(button).not.toHaveAttribute("data-active");
    await listening("mcp-audit");

    vi.useFakeTimers();
    act(() => backend.emit("mcp-audit", entry()));
    expect(screen.getByRole("button", { name: "Agent activity (an agent is working now)" })).toHaveAttribute("data-active", "true");

    act(() => void vi.advanceTimersByTime(9_000));
    expect(screen.getByRole("button", { name: /working now/ })).toBeInTheDocument();
    // A new call starts the ten seconds over.
    act(() => backend.emit("mcp-audit", entry({ tool: "get_events" })));
    act(() => void vi.advanceTimersByTime(9_000));
    expect(screen.getByRole("button", { name: /working now/ })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1_001));
    expect(screen.getByRole("button", { name: "Agent activity" })).not.toHaveAttribute("data-active");
  });

  it("lists the calls of agents and adds new ones as they come", async () => {
    setup(undefined, {
      mcp_audit_list: () => [
        entry({ tool: "delete_resource", target: "Deployment team-a/web", decision: "declined", result: "denied" }),
        entry({ tool: "get_resource", decision: "allowed", result: "ok", durationMs: 7 }),
      ],
    });
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Agent activity" }));
    const dialog = await screen.findByRole("dialog", { name: "Agent activity" });
    const table = await within(dialog).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Time", "Client", "Cluster", "Tool", "Target", "Decision", "Result", "Took",
    ]);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(rows[1]!).slice(1)).toEqual([
      "claude-code", "prod-admin", "delete_resource", "Deployment team-a/web", "Declined by you", "denied", "42 ms",
    ]);
    expect(cells(rows[2]!).slice(1)).toEqual([
      "claude-code", "prod-admin", "get_resource", "Pod team-a/web-1", "Allowed", "ok", "7 ms",
    ]);

    await listening("mcp-audit");
    act(() => backend.emit("mcp-audit", entry({ tool: "list_resources", target: "Pod", durationMs: 3 })));
    const after = within(table).getAllByRole("row");
    expect(after).toHaveLength(4);
    expect(cells(after[1]!)[3]).toBe("list_resources");
  });

  it("counts a call that is both in the list and in the event once", async () => {
    const first = entry({ tool: "get_logs" });
    setup(undefined, { mcp_audit_list: () => [first] });
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Agent activity" }));
    await screen.findByRole("table");
    await listening("mcp-audit");
    act(() => backend.emit("mcp-audit", first));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  });

  it("filters by cluster and shows calls of other clusters again when the filter is cleared", async () => {
    const all = [entry({ clusterId: "prod", tool: "get_logs" }), entry({ clusterId: "staging", clusterName: "staging", tool: "get_events" })];
    setup(undefined, {
      mcp_audit_list: (args) => (args.clusterId ? all.filter((e) => e.clusterId === args.clusterId) : all),
    });
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Agent activity" }));
    await screen.findByRole("table");
    const filter = screen.getByRole("combobox", { name: "Cluster" });
    await waitFor(() => expect(within(filter).getAllByRole("option")).toHaveLength(3));

    fireEvent.change(filter, { target: { value: "staging" } });
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    expect(calls("mcp_audit_list").at(-1)!.args).toEqual({ clusterId: "staging" });
    expect(screen.getByRole("table")).toHaveTextContent("get_events");
    expect(screen.getByRole("table")).not.toHaveTextContent("get_logs");

    // An event about another cluster does not join a filtered list.
    act(() => backend.emit("mcp-audit", entry({ clusterId: "prod", tool: "list_kinds" })));
    expect(screen.getByRole("table")).not.toHaveTextContent("list_kinds");

    fireEvent.change(filter, { target: { value: "" } });
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3));
    expect(calls("mcp_audit_list").at(-1)!.args).toEqual({ clusterId: null });
  });

  it("clears the log after a confirmation", async () => {
    setup(undefined, { mcp_audit_list: () => [entry()] });
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Agent activity" }));
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear the activity log?" })).getByRole("button", { name: "Cancel" }));
    expect(calls("mcp_audit_clear")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Clear the activity log?" })).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls("mcp_audit_clear")).toHaveLength(1));
    expect(await screen.findByText("No calls yet.")).toBeInTheDocument();
  });

  it("shows why the log could not be read", async () => {
    setup(undefined, {
      mcp_audit_list: () => {
        throw { code: "other", message: "journal is locked" };
      },
    });
    renderFooter();
    fireEvent.click(await screen.findByRole("button", { name: "Agent activity" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The log could not be read");
    expect(alert).toHaveTextContent("journal is locked");
  });
});
