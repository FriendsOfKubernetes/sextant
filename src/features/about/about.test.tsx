import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, UPDATER_COMMANDS, type MockBackend, type MockBackendOptions, type MockHandler } from "../../api";
import { resetAppStore } from "../../app/store";
import { AppShell } from "../../layout/AppShell";
import { SettingsContent, selectSettingsTab } from "../settings";
import { resetUpdatesState } from "../updates";
import { AboutHost } from "./AboutHost";
import { resetAbout } from "./store";

let backend: MockBackend;
let clipboard: string[];

function setup(handlers: Record<string, MockHandler> = {}, options: MockBackendOptions = {}) {
  backend = mockBackend(
    {
      clusters_list: () => [],
      kubeconfig_sources: () => [],
      helm_status: () => ({ available: false, version: null, path: null }),
      settings_status: () => ({ writable: true, backupPath: null, error: null }),
      ...handlers,
    },
    options,
  );
}

const aboutDialog = () => screen.findByRole("dialog", { name: "About Sextant" });
const openFromTray = async () => {
  await waitFor(() => expect(backend.listenerCount("open-about")).toBe(1));
  act(() => backend.emit("open-about", null));
  return aboutDialog();
};

beforeEach(() => {
  resetAppStore();
  resetAbout();
  resetUpdatesState();
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => void clipboard.push(text)) },
  });
});
afterEach(() => backend.restore());

describe("opening", () => {
  it("opens from the tray event, in the shell, once", async () => {
    setup();
    render(<AppShell />);
    expect(screen.queryByRole("dialog", { name: "About Sextant" })).not.toBeInTheDocument();
    const dialog = await openFromTray();
    expect(dialog).toBeInTheDocument();
    expect(screen.getAllByRole("dialog", { name: "About Sextant" })).toHaveLength(1);
    expect(backend.listenerCount("open-about")).toBe(1);
  });

  it("opens from the button in Settings shown as a page", async () => {
    setup();
    selectSettingsTab("about");
    render(
      <>
        <SettingsContent />
        <AboutHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "About Sextant" }));
    expect(await aboutDialog()).toBeInTheDocument();
  });

  it("opens from Settings shown as a dialog (no cluster), on top of it", async () => {
    setup();
    selectSettingsTab("about");
    render(<AppShell />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("button", { name: "About Sextant" }));
    expect(await aboutDialog()).toBeInTheDocument();
    // Escape closes the About dialog first and leaves Settings open.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "About Sextant" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("what it shows", () => {
  it("names the version, the licence and the copyright of the build", async () => {
    setup({}, { app: { version: "0.6.1", bundleKind: "appimage" } });
    render(<AboutHost />);
    const dialog = await openFromTray();
    expect(await within(dialog).findByText("0.6.1", { exact: false })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("AppImage");
    expect(dialog).toHaveTextContent("MIT OR Apache-2.0");
    expect(dialog).toHaveTextContent("Sextant contributors");
    // The licence is said once, on its own line; the copyright line does not repeat it.
    expect(dialog.textContent?.match(/MIT OR Apache-2\.0/g)).toHaveLength(1);
    expect(within(dialog).getByText(/Sextant contributors/).textContent).not.toContain("Apache");
  });

  it.each([
    [{ bundleKind: null, devBuild: true }, "development build"],
    [{ bundleKind: null, devBuild: false }, "not installed from a release package"],
    [{ bundleKind: "deb" as const, devBuild: false }, ".deb package"],
  ])("tells how it was installed: %j", async (app, text) => {
    setup({}, { app });
    render(<AboutHost />);
    const dialog = await openFromTray();
    await waitFor(() => expect(dialog).toHaveTextContent(text));
  });

  it("opens each of the five links in the system browser", async () => {
    setup();
    render(<AboutHost />);
    const dialog = await openFromTray();
    for (const name of ["Repository", "Wiki", "Releases", "Discussions", "Report an issue"]) {
      fireEvent.click(within(dialog).getByRole("button", { name }));
    }
    await waitFor(() => expect(backend.openedUrls).toHaveLength(5));
    expect(backend.openedUrls).toEqual([
      "https://github.com/FriendsOfKubernetes/sextant",
      "https://github.com/FriendsOfKubernetes/sextant/wiki",
      "https://github.com/FriendsOfKubernetes/sextant/releases",
      "https://github.com/FriendsOfKubernetes/sextant/discussions",
      "https://github.com/FriendsOfKubernetes/sextant/issues/new/choose",
    ]);
  });
});

describe("check for updates", () => {
  const NEWER = { version: "0.7.0", currentVersion: "0.6.1", date: null, notes: "Tray and About" };

  it("uses the same check as Settings and shows the update with an install button when the build can install", async () => {
    setup({ [UPDATER_COMMANDS.check]: () => NEWER }, { app: { bundleKind: "appimage" } });
    render(<AboutHost />);
    const dialog = await openFromTray();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Check for updates" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Check for updates" }));
    expect(await within(dialog).findByText("Sextant 0.7.0 is available (you have 0.6.1).")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Install and restart" })).toBeEnabled();
    expect(backend.calls.filter((c) => c.cmd === UPDATER_COMMANDS.check)).toHaveLength(1);
  });

  it("says when there is nothing newer", async () => {
    setup({ [UPDATER_COMMANDS.check]: () => null }, { app: { bundleKind: "appimage" } });
    render(<AboutHost />);
    const dialog = await openFromTray();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Check for updates" }));
    expect(await within(dialog).findByText("You have the latest version.")).toBeInTheDocument();
  });

  it("is off, with the reason, in a build without an update key", async () => {
    setup({}, { updaterConfigured: false });
    render(<AboutHost />);
    const dialog = await openFromTray();
    expect(within(dialog).getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(dialog).toHaveTextContent("Updates are turned off in this build");
  });
});

describe("Copy version info", () => {
  it("puts the version, the OS, the WebView and Tauri on the clipboard, nothing else", async () => {
    setup({}, { app: { version: "0.6.1", bundleKind: "appimage" } });
    render(<AboutHost />);
    const dialog = await openFromTray();
    await waitFor(() => expect(dialog).toHaveTextContent("AppImage"));
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "about_info")).toBe(true));
    const button = within(dialog).getByRole("button", { name: "Copy version info" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toBe(
      [
        "Sextant 0.6.1 (AppImage)",
        "OS: Linux Ubuntu 24.04.1 LTS x86_64",
        "WebView: 2.44.1",
        "Tauri: 2.12.3",
      ].join("\n"),
    );
    expect(await within(dialog).findByText("Copied")).toBeInTheDocument();
  });

  it("leaves out what the machine could not tell", async () => {
    setup(
      { about_info: () => ({ os: "macOS", arch: "aarch64", osVersion: null, webviewVersion: null, tauriVersion: "2.12.3" }) },
      { app: { version: "0.6.1", bundleKind: null, devBuild: true } },
    );
    render(<AboutHost />);
    const dialog = await openFromTray();
    const button = within(dialog).getByRole("button", { name: "Copy version info" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toBe(
      ["Sextant 0.6.1 (development build)", "OS: macOS aarch64", "WebView: unknown", "Tauri: 2.12.3"].join("\n"),
    );
  });

  it("still copies the version when the machine cannot be asked", async () => {
    setup({ about_info: () => Promise.reject({ code: "other", message: "boom" }) }, { app: { version: "0.6.1" } });
    render(<AboutHost />);
    const dialog = await openFromTray();
    const button = within(dialog).getByRole("button", { name: "Copy version info" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toBe(["Sextant 0.6.1 (not installed from a release package)", "OS: unknown"].join("\n"));
  });
});
