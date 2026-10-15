import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  RELEASES_URL,
  UPDATER_COMMANDS,
  updaterConfiguredIn,
  type MockBackend,
  type MockBackendOptions,
  type MockHandler,
  type UpdateInfo,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { SettingsButton, SettingsContent, selectSettingsTab } from "../settings";
import { resetUpdatesState } from "./index";

const NEWER: UpdateInfo = {
  version: "0.3.0",
  currentVersion: "0.2.0",
  date: "2026-11-01T10:00:00Z",
  notes: "## What's Changed\n- Faster tables (#24)",
};

let backend: MockBackend;

function setup(handlers: Record<string, MockHandler> = {}, options: MockBackendOptions = {}) {
  backend = mockBackend(
    {
      clusters_list: () => [],
      kubeconfig_sources: () => [],
      helm_status: () => ({ available: false, version: null, path: null }),
      settings_status: () => ({ writable: true, backupPath: null, error: null }),
      [UPDATER_COMMANDS.check]: () => NEWER,
      ...handlers,
    },
    options,
  );
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
const updatesSection = () => screen.getByRole("region", { name: "Updates" });

beforeEach(() => {
  resetAppStore();
  resetUpdatesState();
  selectSettingsTab("about");
});
afterEach(() => backend.restore());

describe("check at start", () => {
  it("checks once when the setting is on and offers the update with its version and notes", async () => {
    setup({}, { app: { version: "0.2.0", bundleKind: "appimage" } });
    render(<SettingsButton />);
    const dialog = await screen.findByRole("dialog", { name: "Update available" });
    expect(dialog).toHaveTextContent("Sextant 0.3.0 is available (you have 0.2.0).");
    expect(dialog).toHaveTextContent("Faster tables (#24)");
    expect(within(dialog).getByRole("button", { name: "Install and restart" })).toBeEnabled();
    expect(calls(UPDATER_COMMANDS.check)).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not check when the setting is off", async () => {
    setup({}, { settings: { checkForUpdates: false }, app: { bundleKind: "appimage" } });
    render(<SettingsButton />);
    await waitFor(() => expect(calls("settings_get")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls(UPDATER_COMMANDS.check)).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not check in a Vite dev build, even when it reports a bundle kind", async () => {
    setup({}, { app: { bundleKind: "app", devBuild: true } });
    render(<SettingsButton />);
    await waitFor(() => expect(calls("settings_get")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls(UPDATER_COMMANDS.check)).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays quiet when the check fails at start", async () => {
    setup(
      {
        [UPDATER_COMMANDS.check]: () => {
          throw "error sending request for url (https://github.com/FriendsOfKubernetes/sextant/releases/latest/download/latest.json)";
        },
      },
      { app: { bundleKind: "msi" } },
    );
    render(<SettingsButton />);
    await waitFor(() => expect(calls(UPDATER_COMMANDS.check)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Settings: version and updates", () => {
  it("shows the app version, checks on the button and installs, then restarts", async () => {
    setup({ [UPDATER_COMMANDS.install]: () => undefined }, { app: { version: "0.2.0", bundleKind: "app" } });
    render(<SettingsContent />);
    const section = updatesSection();
    await waitFor(() => expect(section).toHaveTextContent("Sextant 0.2.0"));
    expect(calls(UPDATER_COMMANDS.check)).toHaveLength(0);

    fireEvent.click(within(section).getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(section).toHaveTextContent("Sextant 0.3.0 is available (you have 0.2.0)."));
    expect(section).toHaveTextContent("Faster tables (#24)");

    fireEvent.click(within(section).getByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(calls(UPDATER_COMMANDS.relaunch)).toHaveLength(1));
    const order = backend.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith("plugin:"));
    expect(order).toEqual([UPDATER_COMMANDS.check, UPDATER_COMMANDS.install, UPDATER_COMMANDS.relaunch]);
    expect(calls(UPDATER_COMMANDS.install)[0]?.args).toEqual({ version: "0.3.0" });
  });

  it("says when this version is the latest", async () => {
    setup({ [UPDATER_COMMANDS.check]: () => null });
    render(<SettingsContent />);
    const section = updatesSection();
    fireEvent.click(within(section).getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(section).toHaveTextContent("You have the latest version."));
  });

  it("explains a network error", async () => {
    setup({
      [UPDATER_COMMANDS.check]: () => {
        throw "error sending request for url (https://github.com/FriendsOfKubernetes/sextant/releases/latest/download/latest.json)";
      },
    });
    render(<SettingsContent />);
    const section = updatesSection();
    fireEvent.click(within(section).getByRole("button", { name: "Check for updates" }));
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("Could not reach GitHub to check for updates. Check your internet connection");
    expect(within(section).getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("reports a failed installation and does not restart", async () => {
    setup(
      {
        [UPDATER_COMMANDS.install]: () => {
          throw "signature verification failed";
        },
      },
      { app: { bundleKind: "nsis" } },
    );
    render(<SettingsContent />);
    const section = updatesSection();
    fireEvent.click(within(section).getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await within(section).findByRole("button", { name: "Install and restart" }));
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent("not signed with the Sextant release key");
    expect(calls(UPDATER_COMMANDS.relaunch)).toHaveLength(0);
  });

  it("tells a .deb install to update with the package manager instead of installing", async () => {
    setup({}, { app: { bundleKind: "deb" } });
    render(<SettingsContent />);
    const section = updatesSection();
    fireEvent.click(within(section).getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(section).toHaveTextContent("Sextant 0.3.0 is available"));
    expect(section).toHaveTextContent("installed from a .deb package");
    expect(within(section).queryByRole("button", { name: "Install and restart" })).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Open the release page" }));
    await waitFor(() => expect(backend.openedUrls).toEqual([RELEASES_URL]));
  });

  it("turns the check at start off and on", async () => {
    setup();
    render(<SettingsContent />);
    const box = within(updatesSection()).getByRole("checkbox", { name: "Check for updates when Sextant starts" });
    await waitFor(() => expect(box).toBeChecked());
    fireEvent.click(box);
    await waitFor(() => expect(backend.settings.checkForUpdates).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(backend.settings.checkForUpdates).toBe(true));
  });
});

describe("without an update signing key", () => {
  it("turns checking off and says why", async () => {
    setup({}, { updaterConfigured: false, app: { version: "0.2.0", bundleKind: "appimage" } });
    render(
      <>
        <SettingsButton />
        <SettingsContent />
      </>,
    );
    const section = updatesSection();
    await waitFor(() => expect(section).toHaveTextContent("Sextant 0.2.0"));
    expect(section).toHaveTextContent("Updates are turned off in this build: it has no update signing key");
    expect(within(section).getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(within(section).getByRole("checkbox", { name: "Check for updates when Sextant starts" })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls(UPDATER_COMMANDS.check)).toHaveLength(0);
  });

  it("is told by the configuration the app is built with", () => {
    const shipped = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(updaterConfiguredIn(shipped)).toBe(true);
    const endpoints = ["https://example.invalid/latest.json"];
    expect(updaterConfiguredIn({ plugins: { updater: { pubkey: "", endpoints } } })).toBe(false);
    expect(updaterConfiguredIn({ plugins: { updater: { endpoints } } })).toBe(false);
    expect(updaterConfiguredIn({ plugins: {} })).toBe(false);
    expect(updaterConfiguredIn({ plugins: { updater: { pubkey: "key", endpoints: [] } } })).toBe(false);
  });
});
