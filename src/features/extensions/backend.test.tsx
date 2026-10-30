// An extension's backend in Settings → Extensions (ADR-0131): the consent screen names what it runs and reaches, the
// credentials form sends a value once and never reads one back, and the log shows what the backend wrote.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type BackendLogLine,
  type CredentialStatus,
  type ExtensionInfo,
  type ExtensionManifest,
  type MockBackend,
  type PendingInstall,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { ExtensionsHost, resetExtensionsStore, resetNotices } from "../../extensions";
import { resetSettingsUi } from "../settings";
import { ExtensionsPanel } from "./ExtensionsPanel";
import "./index";

const manifest: ExtensionManifest = {
  id: "acme.pager",
  name: "Pager",
  version: "1.0.0",
  description: "Pages the on-call engineer",
  author: "Acme",
  sextantApi: 1,
  entry: "index.html",
  permissions: { clusters: { type: "all" }, rules: [] },
  contributes: { pages: [], detailsSections: [], actions: [], columns: [], dockActions: [], problems: [], metricQueries: [] },
  backend: {
    module: "backend.wasm",
    network: { hosts: ["api.pager.example.com"] },
    credentials: [{ id: "token", label: "Pager API token" }],
  },
};

const info: ExtensionInfo = {
  id: "acme.pager",
  name: "Pager",
  version: "1.0.0",
  source: { type: "file", name: "pager.sextant-ext" },
  dev: false,
  enabled: true,
  state: "active",
  needsConsent: false,
  error: null,
  manifest,
  granted: manifest.permissions,
  installedAt: 0,
  baseUrl: "sextant-ext://acme.pager/",
  entryUrl: "sextant-ext://acme.pager/index.html",
};

let backend: MockBackend | undefined;
let list: ExtensionInfo[];
let credentials: CredentialStatus[];
let log: BackendLogLine[];

function setup() {
  backend = mockBackend(
    {
      extensions_list: () => list,
      extension_inspect_file: (): PendingInstall => ({
        token: "tok",
        manifest,
        source: { type: "file", name: "pager.sextant-ext" },
        replaces: null,
        newPermissions: true,
        listedInCatalog: null,
      }),
      extension_credentials: () => credentials,
      extension_credential_set: (args) => {
        credentials = credentials.map((c) => (c.id === args.credential ? { ...c, set: args.value !== null } : c));
      },
      extension_backend_log: () => log,
      extension_audit_list: () => [],
    },
    { openFile: () => "/tmp/pager.sextant-ext" },
  );
  render(
    <>
      <ExtensionsPanel />
      <ExtensionsHost />
    </>,
  );
}

const calls = (cmd: string) => backend!.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  resetAppStore();
  resetSettingsUi();
  resetNotices();
  list = [];
  credentials = [{ id: "token", label: "Pager API token", set: false }];
  log = [];
});
afterEach(() => {
  resetExtensionsStore();
  backend?.restore();
  backend = undefined;
});

describe("the consent screen", () => {
  it("says that the extension runs code outside the window, and where it may connect", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Pager?" });
    expect(within(consent).getByText("Runs its own code outside the window")).toBeInTheDocument();
    expect(within(consent).getByText("api.pager.example.com")).toBeInTheDocument();
    expect(within(consent).getByText("Pager API token")).toBeInTheDocument();
  });
});

describe("an installed backend", () => {
  it("takes credentials in Sextant's own form and never reads one back", async () => {
    list = [info];
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Credentials of Pager" }));
    const dialog = await screen.findByRole("dialog", { name: "Credentials of Pager" });
    const row = await within(dialog).findByRole("listitem", { name: "Pager API token" });
    expect(within(row).getByText("Not entered")).toBeInTheDocument();
    const field = within(row).getByLabelText("Pager API token");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "s3cret" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls("extension_credential_set")[0]?.args).toEqual({ id: "acme.pager", credential: "token", value: "s3cret" }),
    );
    expect(await within(row).findByText("Entered")).toBeInTheDocument();
    expect(field).toHaveValue("");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("extension_credential_set")[1]?.args).toEqual({ id: "acme.pager", credential: "token", value: null }));
  });

  it("shows its log", async () => {
    list = [info];
    log = [
      { at: Date.UTC(2026, 9, 28, 12, 0, 0), level: "info", message: "paged alice" },
      { at: Date.UTC(2026, 9, 28, 12, 0, 1), level: "error", message: "the backend ran out of time" },
    ];
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Backend log of Pager" }));
    const dialog = await screen.findByRole("dialog", { name: "Backend log of Pager" });
    expect(await within(dialog).findByText("paged alice")).toBeInTheDocument();
    expect(within(dialog).getByText("the backend ran out of time")).toBeInTheDocument();
    expect(within(dialog).getByText("Error")).toBeInTheDocument();
  });
});
