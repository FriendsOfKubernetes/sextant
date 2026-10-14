// The extension's section in Settings → Extensions → Widgets: the step and the maximum of the Scale action, kept in
// the extension's storage.
import type { Sextant } from "@sextant/extension-sdk";
import { DEFAULT_SETTINGS, element, parseCount, readSettings, SETTINGS_KEY, type ScaleSettings } from "./widget";

export function startSettings(sextant: Sextant, root: HTMLElement): () => void {
  const step = element("input", { type: "text", inputMode: "numeric" });
  step.setAttribute("aria-label", "Step");
  const max = element("input", { type: "text", inputMode: "numeric" });
  max.setAttribute("aria-label", "Maximum replicas");
  const message = element("p");
  const save = element("button", { type: "button", className: "primary", textContent: "Save" });
  const reset = element("button", { type: "button", textContent: "Reset" });
  root.replaceChildren(
    element("p", { className: "muted", textContent: "How the Scale widget action changes replicas." }),
    element("label", { textContent: "Step" }),
    step,
    element("label", { textContent: "Maximum replicas" }),
    max,
    message,
    element("div", { className: "actions" }, reset, save),
  );

  const say = (text: string, className: "saved" | "error" | "") => {
    message.textContent = text;
    message.className = className;
  };
  const show = (settings: ScaleSettings) => {
    step.value = String(settings.step);
    max.value = String(settings.maxReplicas);
  };
  for (const field of [step, max]) field.addEventListener("input", () => say("", ""));

  save.addEventListener("click", async () => {
    const settings = { step: parseCount(step.value, 1, 1000), maxReplicas: parseCount(max.value, 1, 1000) };
    if (settings.step === null || settings.maxReplicas === null) {
      say("Step and maximum are whole numbers from 1 to 1000.", "error");
      return;
    }
    try {
      await sextant.storage.set(SETTINGS_KEY, settings);
      say("Saved", "saved");
    } catch (err) {
      say((err as Error).message, "error");
    }
  });
  reset.addEventListener("click", async () => {
    try {
      await sextant.storage.remove(SETTINGS_KEY);
      show(DEFAULT_SETTINGS);
      say("", "");
    } catch (err) {
      say((err as Error).message, "error");
    }
  });

  void readSettings(sextant).then(show);
  return () => undefined;
}
