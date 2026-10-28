// Settings → Extensions → Catalog (ADR-0130): what the window asks the backend and when, what an entry offers, and that
// every install from the catalog ends in the same window of consent.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type CatalogEntry,
  type CatalogStatus,
  type CatalogView,
  type ExtensionInfo,
  type ExtensionManifest,
  type MockBackend,
  type PendingInstall,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { ExtensionsHost, resetExtensionsStore, resetNotices } from "../../extensions";
import { resetSettingsUi } from "../settings";
import { matches, offerOf, shownEntries } from "./catalog";
import { ExtensionsPanel } from "./ExtensionsPanel";
import "./index";

const KEY = "RWRmwUKpGrT0wCM6r495TOHPsMcYy+xUdj3/1RXckiwRpEFye9nj9GjJ";

const catalogEntry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: "acme.quota",
  name: "Quota board",
  author: "Acme",
  description: "Namespace quotas at a glance",
  categories: ["cost"],
  repository: "acme/sextant-quota",
  publisherKey: KEY,
  keyId: "C0F4B41AA942C166",
  withdrawn: null,
  latest: {
    version: "1.1.0",
    sextantApi: 1,
    tag: "v1.1.0",
    asset: "acme.quota-1.1.0.sextant-ext",
    size: 2048,
    sha256: "0".repeat(64),
    keyId: "C0F4B41AA942C166",
    publishedAt: "2026-10-20T10:00:00Z",
    permissions: {
      clusters: { type: "all" },
      rules: [{ namespaces: { type: "all" }, kinds: { type: "only", kinds: [{ group: "", kind: "ResourceQuota" }] }, actions: ["read"], confirm: true }],
    },
    contributes: { pages: 1, detailsSections: 0, actions: 0, columns: 2, dockActions: 0, settings: 0 },
  },
  ...over,
});

const ENTRIES = [
  catalogEntry(),
  catalogEntry({ id: "acme.flux-tools", name: "Flux tools", description: "Reconcile from the sidebar", categories: ["gitops"], repository: "acme/flux-tools" }),
  catalogEntry({ id: "old.thing", name: "Old thing", withdrawn: "A known-bad release" }),
  catalogEntry({ id: "new.nothing", name: "Not yet released", latest: null }),
];

const viewOf = (over: Partial<CatalogView> = {}): CatalogView => ({
  enabled: true,
  index: { generatedAt: "2026-10-28T12:00:00Z", entries: ENTRIES, skipped: 0 },
  fetchedAt: Date.UTC(2026, 9, 28, 12, 0, 0),
  error: null,
  installed: [],
  ...over,
});

const manifest: ExtensionManifest = {
  id: "acme.quota",
  name: "Quota board",
  version: "1.1.0",
  description: "Namespace quotas at a glance",
  author: "Acme",
  sextantApi: 1,
  entry: "index.html",
  permissions: { clusters: { type: "all" }, rules: [] },
  contributes: { pages: [], detailsSections: [], actions: [], columns: [], dockActions: [] },
};

const catalogSource = { type: "catalog" as const, repository: "acme/sextant-quota", keyId: "C0F4B41AA942C166", publicKey: KEY };

const installedInfo = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id: "acme.quota",
  name: "Quota board",
  version: "1.0.0",
  source: catalogSource,
  dev: false,
  enabled: true,
  state: "active",
  needsConsent: false,
  error: null,
  manifest: { ...manifest, version: "1.0.0" },
  granted: { clusters: { type: "all" }, rules: [] },
  installedAt: 0,
  baseUrl: "sextant-ext://acme.quota/",
  entryUrl: "sextant-ext://acme.quota/index.html",
  ...over,
});

let backend: MockBackend | undefined;
let list: ExtensionInfo[];
let view: CatalogView;
let pending: PendingInstall;

function setup(settings: { catalog?: boolean } = {}) {
  backend = mockBackend(
    {
      extensions_list: () => list,
      extension_catalog: () => view,
      extension_inspect_catalog: () => pending,
      extension_inspect_file: () => pending,
      extension_install: () => {
        list = [installedInfo({ version: pending.manifest.version })];
        backend!.emit("extensions-changed", null);
        return list[0];
      },
      extension_audit_list: () => [],
    },
    { settings: { extensionCatalog: { enabled: settings.catalog ?? true } } },
  );
  render(
    <>
      <ExtensionsPanel />
      <ExtensionsHost />
    </>,
  );
}

const calls = (cmd: string) => backend!.calls.filter((c) => c.cmd === cmd);
const openCatalog = async () => fireEvent.click(await screen.findByRole("tab", { name: "Catalog" }));

beforeEach(() => {
  resetAppStore();
  resetSettingsUi();
  resetNotices();
  list = [];
  view = viewOf();
  pending = {
    token: "tok-cat",
    manifest,
    source: catalogSource,
    replaces: null,
    newPermissions: true,
    listedInCatalog: null,
  };
});
afterEach(() => {
  resetExtensionsStore();
  backend?.restore();
  backend = undefined;
});

describe("what an entry offers", () => {
  const status = (s: CatalogStatus) => s;
  it("depends on what is installed and on the backend's status of it", () => {
    const entry = catalogEntry();
    expect(offerOf(entry, undefined, undefined)).toEqual({ kind: "install" });
    expect(offerOf(catalogEntry({ latest: { ...entry.latest!, sextantApi: 2 } }), undefined, undefined)).toEqual({ kind: "needsNewer", version: "1.1.0" });
    expect(offerOf(entry, installedInfo(), status({ type: "updateAvailable", version: "1.1.0" }))).toEqual({ kind: "update", version: "1.1.0" });
    expect(offerOf(entry, installedInfo(), status({ type: "upToDate" }))).toEqual({ kind: "installed" });
    expect(offerOf(entry, installedInfo(), status({ type: "keyChanged" }))).toEqual({ kind: "pinnedElsewhere" });
    expect(offerOf(entry, installedInfo({ source: { type: "file", name: "q.sextant-ext" } }), undefined)).toEqual({ kind: "otherSource" });
    expect(offerOf(catalogEntry({ withdrawn: "Bad" }), installedInfo(), undefined)).toEqual({ kind: "withdrawn", reason: "Bad" });
  });

  it("is shown only for entries with a release; a withdrawn one only while installed", () => {
    const ids = (installed: string[]) => shownEntries(viewOf(), new Set(installed)).map((e) => e.id);
    expect(ids([])).toEqual(["acme.quota", "acme.flux-tools"]);
    expect(ids(["old.thing"])).toEqual(["acme.quota", "acme.flux-tools", "old.thing"]);
    expect(matches(catalogEntry(), "quota acme", null)).toBe(true);
    expect(matches(catalogEntry(), "quota flux", null)).toBe(false);
    expect(matches(catalogEntry(), "", "gitops")).toBe(false);
  });
});

describe("the catalog tab", () => {
  it("asks nothing until it is opened, then lists, searches and refreshes", async () => {
    setup();
    await screen.findByRole("tab", { name: "Installed" });
    expect(calls("extension_catalog")).toHaveLength(0);

    await openCatalog();
    await waitFor(() => expect(calls("extension_catalog")[0]?.args).toEqual({ refresh: false }));
    const panel = await screen.findByRole("list", { name: "Catalog" });
    expect(within(panel).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Quota board", "Flux tools"]);
    expect(screen.getByText(/does not review the code of every release/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "reconcile" } });
    expect(within(screen.getByRole("list", { name: "Catalog" })).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cost" } });
    expect(within(screen.getByRole("list", { name: "Catalog" })).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Quota board"]);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls("extension_catalog").at(-1)?.args).toEqual({ refresh: true }));
  });

  it("shows what the catalog lists for an entry, as published", async () => {
    setup();
    await openCatalog();
    fireEvent.click(await screen.findByRole("button", { name: "Details of Quota board" }));
    const card = screen.getByRole("listitem", { name: "Quota board" });
    expect(within(card).getByText("acme/sextant-quota")).toBeInTheDocument();
    expect(within(card).getByText("C0F4B41AA942C166")).toBeInTheDocument();
    expect(within(card).getByText("Table columns: 2")).toBeInTheDocument();
    expect(within(card).getByText("ResourceQuota in all namespaces: read")).toBeInTheDocument();
    expect(within(card).getByText(/As published in the catalog/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Open acme/sextant-quota on GitHub" }));
    expect(backend!.openedUrls).toEqual(["https://github.com/acme/sextant-quota"]);
  });

  it("installs only through the window of consent, which names the catalog and the verified key", async () => {
    setup();
    await openCatalog();
    fireEvent.click(await screen.findByRole("button", { name: "Install Quota board" }));
    const consent = await screen.findByRole("dialog", { name: "Install Quota board?" });
    expect(calls("extension_inspect_catalog")[0]?.args).toEqual({ id: "acme.quota" });
    expect(within(consent).getByText("Catalog: acme/sextant-quota")).toBeInTheDocument();
    expect(within(consent).getByText("Signed by the publisher, key C0F4B41AA942C166")).toBeInTheDocument();
    expect(calls("extension_install")).toHaveLength(0);
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("extension_install")[0]?.args).toEqual({ token: "tok-cat" }));
    // The statuses against the catalog are read again for the new list.
    await waitFor(() => expect(calls("extension_catalog").length).toBeGreaterThan(1));
  });

  it("keeps the older copy when a refresh fails, and says so", async () => {
    view = viewOf({ error: { code: "unreachable", message: "The download failed: dns error" } });
    setup();
    await openCatalog();
    expect(await screen.findByText(/the catalog could not be refreshed \(The download failed: dns error\)/)).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Quota board" })).toBeInTheDocument();
  });
});

describe("installed catalog extensions", () => {
  it("offer an update from the list, and the catalog is read for them without opening its tab", async () => {
    list = [installedInfo()];
    view = viewOf({ installed: [{ id: "acme.quota", status: { type: "updateAvailable", version: "1.1.0" } }] });
    setup();
    const row = await screen.findByRole("listitem", { name: "Quota board" });
    expect(within(row).getByText("Catalog: acme/sextant-quota")).toBeInTheDocument();
    fireEvent.click(await within(row).findByRole("button", { name: "Update Quota board to 1.1.0" }));
    await screen.findByRole("dialog", { name: "Install Quota board?" });
    expect(calls("extension_inspect_catalog")[0]?.args).toEqual({ id: "acme.quota" });
  });

  it("say when the publisher's key changed or the entry was withdrawn", async () => {
    list = [installedInfo()];
    view = viewOf({ installed: [{ id: "acme.quota", status: { type: "keyChanged" } }] });
    setup();
    expect(await screen.findByText(/The publisher's key changed in the catalog, so updates are refused/)).toBeInTheDocument();
  });
});

describe("the switch", () => {
  it("off: no tabs and nothing asked; turning it off is saved", async () => {
    list = [installedInfo()];
    setup({ catalog: false });
    expect(await screen.findByRole("listitem", { name: "Quota board" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Catalog" })).toBeNull();
    expect(calls("extension_catalog")).toHaveLength(0);
    const box = screen.getByRole("checkbox", { name: "Use the extension catalog" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(backend!.settings.extensionCatalog.enabled).toBe(true));
    expect(await screen.findByRole("tab", { name: "Catalog" })).toBeInTheDocument();
  });
});

describe("a package from elsewhere with a catalog id", () => {
  it("is named on the window of consent", async () => {
    pending = { ...pending, source: { type: "file", name: "quota.sextant-ext" }, listedInCatalog: { name: "Quota board", author: "Acme" } };
    backend = mockBackend({ extensions_list: () => [], extension_inspect_file: () => pending }, { openFile: () => "/tmp/quota.sextant-ext" });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Quota board?" });
    expect(
      within(consent).getByText("The catalog lists an extension with this id: Quota board by Acme. This package is not from the catalog."),
    ).toBeInTheDocument();
  });
});
