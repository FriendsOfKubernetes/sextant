import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type AuditEntry,
  type ExtensionInfo,
  type ExtensionManifest,
  type MockBackend,
  type OpenFileOptions,
  type PendingInstall,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { ExtensionsHost, resetExtensionsStore, resetNotices } from "../../extensions";
import { AppShell } from "../../layout/AppShell";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { resetSettingsUi, SettingsContent } from "../settings";
import { ConsentNotice } from "./ConsentNotice";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { isReleaseUrl } from "./install";
import "./index";

const RELEASE = "https://github.com/acme/widgets/releases/download/v1.2.0/widgets.sextant-ext";

const manifest: ExtensionManifest = {
  id: "acme.widgets",
  name: "Widgets",
  version: "1.0.0",
  description: "Shows the widgets of a cluster",
  author: "Acme Inc",
  sextantApi: 1,
  entry: "index.html",
  icon: "scale",
  permissions: {
    clusters: { type: "all" },
    rules: [
      {
        namespaces: { type: "all" },
        kinds: { type: "only", kinds: [{ group: "", kind: "Pod" }, { group: "apps", kind: "Deployment" }] },
        actions: ["read"],
        confirm: false,
      },
      {
        namespaces: { type: "only", namespaces: ["team-a"] },
        kinds: { type: "only", kinds: [{ group: "", kind: "ConfigMap" }] },
        actions: ["modify"],
        confirm: true,
      },
    ],
  },
  contributes: {
    pages: [{ id: "board", title: "Widget board", section: "widgets" }],
    detailsSections: [],
    actions: [{ id: "scale", title: "Scale widget", kinds: [{ group: "demo.dev", kind: "Widget" }], danger: false, multiple: false }],
    columns: [{ kind: { group: "demo.dev", kind: "Widget" }, id: "size", title: "Size", jsonPath: ".spec.size" }],
    dockActions: [],
    settings: { title: "Widget settings" },
  },
};
const withSecrets: ExtensionManifest = {
  ...manifest,
  permissions: {
    clusters: { type: "only", names: ["prod-admin", "staging"] },
    rules: [
      { namespaces: { type: "all" }, kinds: { type: "only", kinds: [{ group: "", kind: "Secret" }] }, actions: ["secretValues"], confirm: false },
    ],
  },
};

const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id: "acme.widgets",
  name: "Widgets",
  version: "1.0.0",
  source: { type: "file", name: "widgets.sextant-ext" },
  dev: false,
  enabled: true,
  state: "active",
  needsConsent: false,
  error: null,
  manifest,
  granted: manifest.permissions,
  installedAt: 0,
  baseUrl: "sextant-ext://acme.widgets/",
  entryUrl: "sextant-ext://acme.widgets/index.html",
  ...over,
});

const pendingOf = (over: Partial<PendingInstall> = {}): PendingInstall => ({
  token: "tok-1",
  manifest,
  source: { type: "file", name: "widgets.sextant-ext" },
  replaces: null,
  newPermissions: true,
  listedInCatalog: null,
  ...over,
});

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  at: Date.UTC(2026, 9, 13, 10, 30, 0),
  source: "extension",
  principal: "Extension Widgets",
  client: "acme.widgets",
  clusterId: "prod",
  clusterName: "prod-admin",
  tool: "resources.get",
  target: "Pod team-a/web-1",
  decision: "allowed",
  result: "ok",
  durationMs: 12,
  ...over,
});

let backend: MockBackend;
let list: ExtensionInfo[];
let pending: PendingInstall;
let opened: OpenFileOptions[];
let picked: string | null;
let audit: AuditEntry[];

function setup(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  backend = mockBackend(
    {
      extensions_list: () => list,
      extension_inspect_file: () => pending,
      extension_inspect_url: () => pending,
      extension_inspect_folder: () => pending,
      extension_install: () => {
        list = [info({ version: pending.manifest.version, manifest: pending.manifest })];
        backend.emit("extensions-changed", null);
        return list[0];
      },
      extension_set_enabled: (args) => {
        list = list.map((e) => (e.id === args.id ? { ...e, enabled: args.enabled as boolean, state: args.enabled ? "active" : "disabled" } : e));
        return list[0];
      },
      extension_remove: (args) => {
        list = list.filter((e) => e.id !== args.id);
        backend.emit("extensions-changed", null);
      },
      extension_reload: () => list[0],
      extension_audit_list: (args) => audit.filter((e) => !args.extensionId || e.client === args.extensionId),
      extension_audit_clear: () => {
        audit = [];
      },
      clusters_list: () => [],
      kubeconfig_sources: () => [],
      helm_status: () => ({ available: false, version: null, path: null }),
      mcp_status: () => ({ state: "off", url: null, error: null }),
      ...handlers,
    },
    {
      openFile: (o) => {
        opened.push(o);
        return picked;
      },
    },
  );
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
const row = (name: string) => screen.getByRole("listitem", { name });
const dialog = () => screen.getByRole("dialog");
/** The window of consent once the package is read (a dialog with the same title shows while it is being read). */
const loadedConsent = (name: string) =>
  waitFor(() => {
    const found = screen.getByRole("dialog", { name });
    within(found).getByRole("button", { name: /^(Install|Update)$/ });
    return found;
  });

beforeEach(() => {
  resetAppStore();
  resetSettingsUi();
  resetClustersStore();
  resetHelmStatus();
  resetNotices();
  list = [];
  pending = pendingOf();
  opened = [];
  picked = "/home/me/widgets.sextant-ext";
  audit = [];
});
afterEach(() => {
  resetExtensionsStore();
  backend.restore();
});

describe("the list", () => {
  it("shows icon, name, version, source, Development and the state of each extension", async () => {
    list = [
      info(),
      info({
        id: "dev.tool",
        name: "Dev tool",
        version: "0.3.0",
        dev: true,
        enabled: false,
        state: "disabled",
        source: { type: "folder", path: "/src/dev-tool" },
      }),
      info({ id: "broken.one", name: "Broken", state: "failed", error: "sextant-extension.json: entry: no such file", manifest: null }),
    ];
    setup();
    render(<ExtensionsPanel />);
    const widgets = await screen.findByRole("listitem", { name: "Widgets" });
    expect(within(widgets).getByText("Version 1.0.0")).toBeInTheDocument();
    expect(within(widgets).getByText("File widgets.sextant-ext")).toBeInTheDocument();
    expect(within(widgets).getByText("Active")).toBeInTheDocument();
    expect(within(widgets).queryByText("Development")).toBeNull();
    // The manifest's icon is a name of the set: an SVG, not the name as text.
    expect(widgets.querySelector(".ext-icon svg")).not.toBeNull();

    const dev = row("Dev tool");
    expect(within(dev).getByText("Development")).toBeInTheDocument();
    expect(within(dev).getByText("Folder /src/dev-tool")).toBeInTheDocument();
    expect(within(dev).getByText("Disabled")).toBeInTheDocument();
    expect(within(dev).getByRole("button", { name: "Enable Dev tool" })).toBeInTheDocument();

    const broken = row("Broken");
    expect(within(broken).getByText("Failed")).toBeInTheDocument();
    expect(within(broken).getByRole("alert")).toHaveTextContent("sextant-extension.json: entry: no such file");
  });

  it("says so when nothing is installed", async () => {
    setup();
    render(<ExtensionsPanel />);
    expect(await screen.findByText("No extensions are installed.")).toBeInTheDocument();
  });

  it("is a section of the Settings content, with the extension's own settings frame", async () => {
    list = [info()];
    setup();
    render(<SettingsContent />);
    // Under the Extensions tab of Settings, with the extension's own section inside.
    fireEvent.click(screen.getByRole("tab", { name: "Extensions" }));
    const section = await within(screen.getByRole("tabpanel", { name: "Extensions" })).findByRole("region", { name: "Extensions" });
    const widgets = await within(section).findByRole("listitem", { name: "Widgets" });
    expect(within(widgets).getByRole("region", { name: "Settings of Widgets" })).toBeInTheDocument();
    expect(widgets.querySelector("iframe")).not.toBeNull();
    // The whole Settings content renders here; on a slow runner (windows-latest) that took 7.6 s.
  }, 20_000);

  it("shows the settings frame only for an active extension that contributes settings", async () => {
    list = [info({ enabled: false, state: "disabled" })];
    setup();
    render(<ExtensionsPanel />);
    const widgets = await screen.findByRole("listitem", { name: "Widgets" });
    expect(widgets.querySelector("iframe")).toBeNull();
  });
});

describe("installing", () => {
  it("from a file: asks the backend to check the chosen file and installs only after Install", async () => {
    setup();
    render(
      <>
        <ExtensionsPanel />
        <ExtensionsHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));

    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    expect(opened[0]?.directory).toBeUndefined();
    expect(opened[0]?.filters?.[0]?.extensions).toEqual(["sextant-ext", "zip"]);
    expect(calls("extension_inspect_file")[0]?.args).toEqual({ path: "/home/me/widgets.sextant-ext" });
    expect(calls("extension_install")).toHaveLength(0);

    // Who, what it adds, what it may do.
    expect(within(consent).getByText("Acme Inc")).toBeInTheDocument();
    expect(within(consent).getByText("1.0.0")).toBeInTheDocument();
    expect(within(consent).getByText("File widgets.sextant-ext")).toBeInTheDocument();
    expect(within(consent).getByText("Widget board")).toBeInTheDocument();
    expect(within(consent).getByText("Scale widget")).toBeInTheDocument();
    expect(within(consent).getByText("Size")).toBeInTheDocument();
    expect(within(consent).getByText("Widget settings")).toBeInTheDocument();
    expect(within(consent).getByText("All clusters")).toBeInTheDocument();
    expect(within(consent).getByText("Pod, Deployment (apps) in all namespaces: read")).toBeInTheDocument();
    expect(within(consent).getByText("ConfigMap in the namespace team-a: modify")).toBeInTheDocument();
    expect(within(consent).getByText("Asks before running")).toBeInTheDocument();
    // Nothing is said about Secrets when the extension cannot read their values.
    expect(within(consent).queryByRole("alert")).toBeNull();

    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("extension_install")).toHaveLength(1));
    expect(calls("extension_install")[0]?.args).toEqual({ token: "tok-1" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("listitem", { name: "Widgets" })).toBeInTheDocument();
    expect(await screen.findByText("Widgets: Installed version 1.0.0.")).toBeInTheDocument();
  }, 15_000);

  it("Cancel installs nothing and drops the checked package at once", async () => {
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog");
    fireEvent.click(within(consent).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("extension_install")).toHaveLength(0);
    expect(calls("extension_install_cancel").map((c) => c.args)).toEqual([{ token: "tok-1" }]);

    // Closing the window any other way declines too.
    pending = pendingOf({ token: "tok-2" });
    fireEvent.click(screen.getByRole("button", { name: "Install from file…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(calls("extension_install_cancel").map((c) => c.args)).toEqual([{ token: "tok-1" }, { token: "tok-2" }]);
  });

  it("a successful install does not cancel what it installed", async () => {
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("extension_install_cancel")).toHaveLength(0);
  });

  it("a failed install can be tried again from the same window", async () => {
    let attempts = 0;
    setup({
      extension_install: () => {
        attempts += 1;
        if (attempts === 1) throw { code: "other", message: "cannot create /data/extensions/acme.widgets: No space left on device" };
        list = [info()];
        backend.emit("extensions-changed", null);
        return list[0];
      },
    });
    render(
      <>
        <ExtensionsPanel />
        <ExtensionsHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    const alert = await within(consent).findByRole("alert");
    expect(alert).toHaveTextContent("No space left on device");
    const again = within(consent).getByRole("button", { name: "Install" });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("extension_install").map((c) => c.args)).toEqual([{ token: "tok-1" }, { token: "tok-1" }]);
    expect(calls("extension_install_cancel")).toHaveLength(0);
    expect(await screen.findByText("Widgets: Installed version 1.0.0.")).toBeInTheDocument();
  }, 15_000);

  it("an install that is gone (expired, used, changed) cannot be pressed again", async () => {
    setup({
      extension_install: () => {
        throw { code: "notFound", message: "The package changed after it was checked; choose it again to see what it asks for now" };
      },
    });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    const alert = await within(consent).findByRole("alert");
    expect(alert).toHaveTextContent("This install is no longer available");
    expect(alert).toHaveTextContent("The package changed after it was checked");
    expect(within(consent).getByRole("button", { name: "Install" })).toBeDisabled();
  });

  it("does nothing when the file dialog is dismissed", async () => {
    picked = null;
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls("extension_inspect_file")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("from a folder: picks a directory, marks it Development and installs it", async () => {
    picked = "/src/widgets";
    pending = pendingOf({ source: { type: "folder", path: "/src/widgets" } });
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Load unpacked folder…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    expect(opened[0]?.directory).toBe(true);
    expect(calls("extension_inspect_folder")[0]?.args).toEqual({ path: "/src/widgets" });
    expect(within(consent).getByText("Development")).toBeInTheDocument();
    expect(within(consent).getByText("Folder /src/widgets")).toBeInTheDocument();
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("extension_install")).toHaveLength(1));
  });

  it("from a URL: refuses links that are not GitHub release files before any request", async () => {
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from URL…" }));
    const ask = dialog();
    const field = within(ask).getByLabelText("Link to a file in a GitHub release");
    const check = within(ask).getByRole("button", { name: "Download and check" });
    expect(check).toBeDisabled();

    fireEvent.change(field, { target: { value: "https://example.com/widgets.sextant-ext" } });
    fireEvent.blur(field);
    expect(await within(ask).findByText("This is not a link to a file in a GitHub release.")).toBeInTheDocument();
    expect(check).toBeDisabled();
    fireEvent.submit(field.closest("form")!);
    expect(calls("extension_inspect_url")).toHaveLength(0);

    fireEvent.change(field, { target: { value: ` ${RELEASE} ` } });
    expect(check).toBeEnabled();
    fireEvent.click(check);
    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    expect(calls("extension_inspect_url")[0]?.args).toEqual({ url: RELEASE });
    expect(within(consent).queryByLabelText("Link to a file in a GitHub release")).toBeNull();
  });

  it("from a URL: a failed download is a readable message in the same window", async () => {
    setup({
      extension_inspect_url: () => {
        throw { code: "timeout", message: "The download took longer than 60 s" };
      },
    });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from URL…" }));
    fireEvent.change(within(dialog()).getByLabelText("Link to a file in a GitHub release"), { target: { value: RELEASE } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Download and check" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent("The download took too long");
    expect(alert).toHaveTextContent("The download took longer than 60 s");
  });

  it("shows a broken manifest with its path and message", async () => {
    setup({
      extension_inspect_file: () => {
        throw { code: "invalid", message: "sextant-extension.json: contributes.pages[0].id: must match [a-z0-9-]{1,40}" };
      },
    });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This package cannot be installed");
    expect(alert).toHaveTextContent("contributes.pages[0].id: must match [a-z0-9-]{1,40}");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a duplicate id from another source; Install stays for after the other one is removed", async () => {
    setup({
      extension_install: () => {
        throw {
          code: "conflict",
          message: "An extension with the id `acme.widgets` is already installed from the folder /src/widgets; remove it before installing this one",
        };
      },
    });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog", { name: "Install Widgets?" });
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    const alert = await within(consent).findByRole("alert");
    expect(alert).toHaveTextContent("Another extension with this id is already installed");
    expect(alert).toHaveTextContent("remove it before installing this one");
    // The checked package still waits: removing the other extension and pressing Install again works.
    await waitFor(() => expect(within(consent).getByRole("button", { name: "Install" })).toBeEnabled());
  });
});

describe("the window of consent", () => {
  it("warns about Secret values and names the clusters", async () => {
    pending = pendingOf({ manifest: withSecrets });
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    const consent = await screen.findByRole("dialog");
    const warning = within(consent).getByRole("alert");
    expect(warning).toHaveTextContent("Reads the values of Secrets");
    expect(within(consent).getByText("Only the clusters named prod-admin, staging")).toBeInTheDocument();
    expect(within(consent).getByText(/covers every cluster context with that name, from every kubeconfig source/)).toBeInTheDocument();
    expect(consent.querySelector('[data-secret]')).not.toBeNull();
  });

  it("an update says whether the permissions widened", async () => {
    list = [info()];
    pending = pendingOf({ replaces: "1.0.0", newPermissions: true, manifest: { ...withSecrets, version: "1.1.0" } });
    setup();
    const view = render(
      <>
        <ExtensionsPanel />
        <ExtensionsHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Install from file…" }));
    let consent = await screen.findByRole("dialog", { name: "Update Widgets?" });
    expect(within(consent).getByText("Replaces the installed version 1.0.0.")).toBeInTheDocument();
    expect(within(consent).getByText("New permissions")).toBeInTheDocument();
    expect(within(consent).queryByText("Same permissions")).toBeNull();
    fireEvent.click(within(consent).getByRole("button", { name: "Cancel" }));

    pending = pendingOf({ replaces: "1.0.0", newPermissions: false, manifest: { ...manifest, version: "1.0.1" } });
    fireEvent.click(view.getByRole("button", { name: "Install from file…" }));
    consent = await screen.findByRole("dialog", { name: "Update Widgets?" });
    expect(within(consent).getByText("Same permissions")).toBeInTheDocument();
    expect(within(consent).queryByText("New permissions")).toBeNull();
    fireEvent.click(within(consent).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(calls("extension_install")).toHaveLength(1));
    expect(await screen.findByText("Widgets: Updated to version 1.0.1.")).toBeInTheDocument();
  }, 15_000);
});

describe("managing", () => {
  it("Disable and Enable go to the backend", async () => {
    list = [info()];
    setup();
    render(<ExtensionsPanel />);
    const widgets = await screen.findByRole("listitem", { name: "Widgets" });
    fireEvent.click(within(widgets).getByRole("button", { name: "Disable Widgets" }));
    await waitFor(() => expect(calls("extension_set_enabled")[0]?.args).toEqual({ id: "acme.widgets", enabled: false }));
    fireEvent.click(await within(row("Widgets")).findByRole("button", { name: "Enable Widgets" }));
    await waitFor(() => expect(calls("extension_set_enabled")[1]?.args).toEqual({ id: "acme.widgets", enabled: true }));
  });

  it("Reload asks the backend to reload the extension", async () => {
    list = [info()];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Reload Widgets" }));
    await waitFor(() => expect(calls("extension_reload")[0]?.args).toEqual({ id: "acme.widgets" }));
  });

  it("Permissions shows what you allowed", async () => {
    list = [info()];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Permissions of Widgets" }));
    const permissions = dialog();
    expect(within(permissions).getByText("Permissions of Widgets")).toBeInTheDocument();
    expect(within(permissions).getByText("Pod, Deployment (apps) in all namespaces: read")).toBeInTheDocument();
    expect(within(permissions).queryByText("It asks for now")).toBeNull();
    fireEvent.click(within(permissions).getAllByRole("button", { name: "Close" })[1]!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Remove asks first, and removes only after the confirmation", async () => {
    list = [info()];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Widgets" }));
    let confirm = await screen.findByRole("dialog", { name: "Remove Widgets?" });
    expect(confirm).toHaveTextContent("its files and the data it stored are deleted");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls("extension_remove")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Remove Widgets" }));
    confirm = await screen.findByRole("dialog", { name: "Remove Widgets?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("extension_remove")[0]?.args).toEqual({ id: "acme.widgets" }));
    expect(await screen.findByText("No extensions are installed.")).toBeInTheDocument();
  });

  it("shows a failed change in the row", async () => {
    list = [info()];
    setup({
      extension_set_enabled: () => {
        throw { code: "other", message: "disk is full" };
      },
    });
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable Widgets" }));
    const alert = await within(row("Widgets")).findByRole("alert");
    expect(alert).toHaveTextContent("The change could not be made");
    expect(alert).toHaveTextContent("disk is full");
  });
});

describe("an extension paused for new permissions", () => {
  const folder = "/src/widgets";
  const paused = () =>
    info({
      dev: true,
      state: "needsConsent",
      needsConsent: true,
      source: { type: "folder", path: folder },
      manifest: withSecrets,
    });

  it("Review permissions reads the folder again, shows the consent window and installs", async () => {
    list = [paused()];
    pending = pendingOf({ manifest: withSecrets, source: { type: "folder", path: folder }, replaces: "1.0.0" });
    setup();
    render(<ExtensionsPanel />);
    const widgets = await screen.findByRole("listitem", { name: "Widgets" });
    expect(within(widgets).getByText("Needs your approval")).toBeInTheDocument();
    fireEvent.click(within(widgets).getByRole("button", { name: "Review permissions" }));
    const consent = await loadedConsent("Review the permissions of Widgets");
    expect(calls("extension_inspect_folder")[0]?.args).toEqual({ path: folder });
    expect(within(consent).getByRole("alert")).toHaveTextContent("Reads the values of Secrets");
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("extension_install")[0]?.args).toEqual({ token: "tok-1" }));
  });

  it("Permissions shows what was allowed and what is asked now", async () => {
    list = [paused()];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Permissions of Widgets" }));
    const permissions = dialog();
    expect(within(permissions).getByText("You allowed")).toBeInTheDocument();
    expect(within(permissions).getByText("It asks for now")).toBeInTheDocument();
    expect(within(permissions).getByText("Only the clusters named prod-admin, staging")).toBeInTheDocument();
  });

  it("a notice over the window offers the review wherever you are", async () => {
    list = [paused()];
    pending = pendingOf({ manifest: withSecrets, source: { type: "folder", path: folder }, replaces: "1.0.0" });
    setup();
    render(<AppShell />);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Widgets asks for more permissions than you allowed and is paused.");
    fireEvent.click(within(notice).getByRole("button", { name: "Review permissions" }));
    const consent = await loadedConsent("Review the permissions of Widgets");
    fireEvent.click(within(consent).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("extension_install")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("is drawn once by the window, so folding the rail or narrowing the window keeps its window and its dismissal", async () => {
    let width = 1280;
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    // jsdom has no layout: answer max-width queries from `width`.
    window.matchMedia = ((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        get matches() {
          return max ? width <= Number(max[1]) : false;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      };
    }) as unknown as typeof window.matchMedia;
    const resizeTo = (next: number) => {
      width = next;
      act(() => listeners.forEach((fn) => fn()));
    };
    try {
      list = [paused()];
      pending = pendingOf({ manifest: withSecrets, source: { type: "folder", path: folder }, replaces: "1.0.0" });
      setup();
      render(<AppShell />);
      const rail = screen.getByRole("navigation", { name: "Clusters" });
      const notice = await screen.findByRole("alert");
      expect(rail).not.toContainElement(notice);

      fireEvent.click(within(notice).getByRole("button", { name: "Review permissions" }));
      await loadedConsent("Review the permissions of Widgets");
      fireEvent.click(screen.getByRole("button", { name: "Expand cluster list" }));
      resizeTo(400);
      expect(screen.getByRole("dialog", { name: "Review the permissions of Widgets" })).toBeInTheDocument();
      expect(calls("extension_inspect_folder")).toHaveLength(1);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).toBeNull();
      resizeTo(1280);
      fireEvent.click(screen.getByRole("button", { name: "Collapse cluster list" }));
      await act(async () => undefined);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  describe("installed from a package", () => {
    const fromFile = () => info({ state: "needsConsent", needsConsent: true, manifest: withSecrets });
    const fromUrl = () =>
      info({ id: "acme.gadgets", name: "Gadgets", state: "needsConsent", needsConsent: true, source: { type: "url", url: RELEASE } });

    it("the row says to install it again from its source instead of offering a review that cannot work", async () => {
      list = [fromFile(), fromUrl()];
      setup();
      render(<ExtensionsPanel />);
      const widgets = await screen.findByRole("listitem", { name: "Widgets" });
      expect(within(widgets).getByText("Needs your approval")).toBeInTheDocument();
      expect(within(widgets).queryByRole("button", { name: "Review permissions" })).toBeNull();
      expect(within(widgets).getByRole("alert")).toHaveTextContent(
        "To review its permissions, install it again from the file widgets.sextant-ext (Install from file…).",
      );
      const gadgets = screen.getByRole("listitem", { name: "Gadgets" });
      expect(within(gadgets).queryByRole("button", { name: "Review permissions" })).toBeNull();
      expect(within(gadgets).getByRole("alert")).toHaveTextContent(`To review its permissions, install it again from ${RELEASE}`);
      expect(calls("extension_inspect_folder")).toHaveLength(0);
    });

    it("the notice names the source to install again from and offers no review", async () => {
      list = [fromFile(), fromUrl()];
      setup();
      render(<ConsentNotice />);
      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent("Widgets, Gadgets ask for more permissions than you allowed and are paused.");
      expect(notice).toHaveTextContent("Widgets: To review its permissions, install it again from the file widgets.sextant-ext");
      expect(notice).toHaveTextContent(`Gadgets: To review its permissions, install it again from ${RELEASE}`);
      expect(within(notice).queryByRole("button", { name: "Review permissions" })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("next to a folder one, the notice's review opens the folder one", async () => {
      list = [fromFile(), paused()];
      list[1] = { ...list[1]!, id: "dev.widgets", name: "Dev widgets" };
      pending = pendingOf({ manifest: withSecrets, source: { type: "folder", path: folder }, replaces: "1.0.0" });
      setup();
      render(<ConsentNotice />);
      const notice = await screen.findByRole("alert");
      fireEvent.click(within(notice).getByRole("button", { name: "Review permissions" }));
      await loadedConsent("Review the permissions of Widgets");
      expect(calls("extension_inspect_folder")[0]?.args).toEqual({ path: folder });
    });
  });

  it("no notice while every extension is within its permissions, and it can be dismissed", async () => {
    list = [info()];
    setup();
    const view = render(<ConsentNotice />);
    await waitFor(() => expect(calls("extensions_list").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();

    list = [paused()];
    render(<ConsentNotice />);
    const notice = await screen.findByRole("alert");
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("activity", () => {
  it("lists the calls of one extension, follows new ones live and clears after confirmation", async () => {
    list = [info(), info({ id: "other.tool", name: "Other tool" })];
    audit = [entry(), entry({ client: "other.tool", principal: "Extension Other tool", target: "Node n1" })];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Activity of Widgets" }));
    const log = await screen.findByRole("dialog", { name: "Extension activity" });
    expect(await within(log).findByText("Pod team-a/web-1")).toBeInTheDocument();
    expect(calls("extension_audit_list").at(-1)?.args).toEqual({ extensionId: "acme.widgets" });
    expect(within(log).queryByText("Node n1")).toBeNull();
    expect(within(log).getByText("Allowed")).toBeInTheDocument();

    // A new call arrives while the log is open; one of another extension is not shown in this filter.
    await waitFor(() => expect(backend.listenerCount("ext-audit")).toBeGreaterThan(0));
    act(() => backend.emit("ext-audit", entry({ at: Date.UTC(2026, 9, 13, 10, 31, 0), target: "Pod team-a/web-2", decision: "denied", result: "denied" })));
    expect(await within(log).findByText("Pod team-a/web-2")).toBeInTheDocument();
    expect(within(log).getByText("Denied")).toBeInTheDocument();
    act(() => backend.emit("ext-audit", entry({ client: "other.tool", target: "Node n2" })));
    expect(within(log).queryByText("Node n2")).toBeNull();

    // The filter shows all extensions.
    fireEvent.change(within(log).getByLabelText("Extension"), { target: { value: "" } });
    expect(await within(log).findByText("Node n1")).toBeInTheDocument();
    expect(calls("extension_audit_list").at(-1)?.args).toEqual({ extensionId: null });

    fireEvent.click(within(log).getByRole("button", { name: "Clear" }));
    const sure = await screen.findByRole("dialog", { name: "Clear the activity log?" });
    expect(calls("extension_audit_clear")).toHaveLength(0);
    fireEvent.click(within(sure).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls("extension_audit_clear")).toHaveLength(1));
    expect(await within(log).findByText("No calls yet.")).toBeInTheDocument();
  }, 15_000);

  it("opens from the toolbar for all extensions", async () => {
    list = [info()];
    audit = [entry()];
    setup();
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Extension activity" }));
    expect(await screen.findByText("Pod team-a/web-1")).toBeInTheDocument();
    expect(calls("extension_audit_list").at(-1)?.args).toEqual({ extensionId: null });
  });
});

describe("isReleaseUrl", () => {
  it.each([
    [RELEASE, true],
    ["https://github.com/a/b/releases/download/v1/x.zip", true],
    ["http://github.com/a/b/releases/download/v1/x.zip", false],
    ["https://github.com/a/b/releases/latest/download/x.zip", false],
    ["https://github.com/a/b/releases/download/v1", false],
    ["https://github.com/a/b/releases/download/v1/x.zip?token=1", false],
    ["https://github.com:8443/a/b/releases/download/v1/x.zip", false],
    ["https://me@github.com/a/b/releases/download/v1/x.zip", false],
    ["https://github.com.evil.example/a/b/releases/download/v1/x.zip", false],
    ["https://github.com/a/b/releases/download/../x.zip", false],
    ["not a link", false],
    ["", false],
  ])("%s → %s", (url, expected) => {
    expect(isReleaseUrl(url)).toBe(expected);
  });
});
