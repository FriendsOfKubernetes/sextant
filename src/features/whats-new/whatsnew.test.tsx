// "What's new" (ADR-0166): once after an update, never on a fresh install, again from About; the extensions that left
// the core offered for install.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ExtensionInfo, type MockBackend } from "../../api";
import { resetExtensionsStore } from "../../extensions/store";
import { axeViolations } from "../../test/axe";
import { useInstallRequest } from "../extensions/installRequest";
import { resetUpdatesState } from "../updates";
import { compareVersions, notesSince, seenAfter } from "./notes";
import { closeWhatsNew, openWhatsNew } from "./store";
import { WhatsNewHost } from "./WhatsNewHost";

describe("the notes", () => {
  it("compare versions and pick the ones not seen", () => {
    expect(compareVersions("0.30.0", "0.29.2")).toBeGreaterThan(0);
    expect(compareVersions("0.30.0", "0.30.0-beta.1")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.9")).toBeGreaterThan(0);
    expect(notesSince("0.29.0").map((n) => n.version)).toEqual(["0.30.3", "0.30.2", "0.30.1", "0.30.0"]);
    expect(notesSince("0.30.0").map((n) => n.version)).toEqual(["0.30.3", "0.30.2", "0.30.1"]);
    expect(notesSince("0.30.3")).toEqual([]);
    expect(seenAfter("0.29.2")).toBe("0.30.3");
    expect(seenAfter("0.31.4")).toBe("0.31.4");
    expect(seenAfter(null)).toBe("0.30.3");
  });
});

describe("the window", () => {
  let backend: MockBackend;
  let installed: ExtensionInfo[];

  const start = (seenVersion: string | undefined) => {
    backend = mockBackend(
      { extensions_list: () => installed },
      { settings: { whatsNew: seenVersion === undefined ? {} : { seenVersion } }, app: { version: "0.30.3" } },
    );
  };

  beforeEach(() => {
    installed = [];
    resetExtensionsStore();
    resetUpdatesState();
    closeWhatsNew();
  });
  afterEach(() => {
    backend.restore();
    useInstallRequest.setState({ id: null });
  });

  it("opens after an update with the moved extensions, and remembers it was seen", async () => {
    installed = [{ id: "sextant.flux" } as ExtensionInfo];
    start("0.29.0");
    const { container } = render(<WhatsNewHost />);
    const dialog = await screen.findByRole("dialog", { name: "What's new in Sextant 0.30.3" });
    expect(within(dialog).getByText("Workspaces of kubeconfig folders")).toBeInTheDocument();
    expect(within(dialog).getByText("Extension blocks on Linux")).toBeInTheDocument();
    expect(within(dialog).getByText("Extension API 5")).toBeInTheDocument();
    expect(within(dialog).getByText("Views of cluster tools are now extensions")).toBeInTheDocument();
    const list = within(dialog).getByRole("list", { name: "Install the extensions that moved" });
    await waitFor(() => expect(within(list).getByText("Installed")).toBeInTheDocument());
    expect(within(list).queryByRole("button", { name: "Install Flux" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    // "Install" asks the catalog's own install and closes the window.
    fireEvent.click(within(list).getByRole("button", { name: "Install Argo Workflows" }));
    expect(useInstallRequest.getState().id).toBe("sextant.argo-workflows");
    expect(screen.queryByRole("dialog", { name: "What's new in Sextant 0.30.3" })).toBeNull();
    await waitFor(() => expect(backend.settings.whatsNew.seenVersion).toBe("0.30.3"));
  });

  it("does not open on a fresh install, which remembers the version at once", async () => {
    start(undefined);
    render(<WhatsNewHost />);
    await waitFor(() => expect(backend.settings.whatsNew.seenVersion).toBe("0.30.3"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open once seen, but opens again from About", async () => {
    start("0.30.3");
    render(<WhatsNewHost />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "settings_get")).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    openWhatsNew();
    const dialog = await screen.findByRole("dialog", { name: "What's new in Sextant 0.30.3" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
