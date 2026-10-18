// The native tray menu follows the UI language: the window sends its texts whenever the language changes.
import { afterEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { i18n } from "../../i18n";
import { followLanguageInTray, trayTexts } from "./trayTexts";

let backend: MockBackend | undefined;
afterEach(async () => {
  backend?.restore();
  await i18n.changeLanguage("en");
  i18n.removeResourceBundle("xx", "tray");
});

describe("tray texts", () => {
  it("are the tray namespace in the current language", () => {
    expect(trayTexts()).toEqual({
      show: "Show Sextant",
      hide: "Hide Sextant",
      about: "About Sextant…",
      quit: "Quit Sextant",
      tooltip: "Sextant",
    });
  });

  it("go to the backend when the language changes, English for what the language lacks", async () => {
    backend = mockBackend();
    followLanguageInTray();
    followLanguageInTray();
    i18n.addResourceBundle("xx", "tray", { show: "Sextant anzeigen", quit: "Sextant beenden" });
    await i18n.changeLanguage("xx");
    const sent = backend.calls.filter((c) => c.cmd === "tray_set_texts");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toEqual({
      texts: { show: "Sextant anzeigen", hide: "Hide Sextant", about: "About Sextant…", quit: "Sextant beenden", tooltip: "Sextant" },
    });
  });
});
