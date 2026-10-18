// A copied directory `src/locales/xx/` is a new language: it shows up in Settings with no code change. The list
// comes from `availableLanguages` (directory names found by import.meta.glob), replaced here as if `xx` existed.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { getPage } from "../../layout/pages";
import { SETTINGS_PAGE_ID } from "./index";

vi.mock("../../i18n", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../i18n")>();
  return { ...original, availableLanguages: ["en", "xx"] };
});

let backend: MockBackend;
afterEach(() => backend.restore());

describe("language list", () => {
  it("shows every directory of src/locales and saves the choice", async () => {
    backend = mockBackend({ kubeconfig_sources: () => [], clusters_list: () => [], helm_status: () => ({ available: false, version: null, path: null }) });
    const page = getPage(SETTINGS_PAGE_ID);
    if (!page) throw new Error("the settings page is not registered");
    render(<page.Component clusterId="c1" />);
    const language = screen.getByRole("combobox", { name: "Language" });
    expect(within(language).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["system", "en", "xx"]);
    fireEvent.change(language, { target: { value: "xx" } });
    await waitFor(() => expect(backend.settings.language).toBe("xx"));
  });
});
