// The choice of the Argo CD installation when several namespaces of a cluster have an argocd-server Service: the
// extension picks none by itself. The user's choice is kept for the cluster (`sextant.storage`) and taken only while
// that namespace still has such a Service.
import type { ClusterId, Sextant } from "@sextant/extension-sdk";
import { element, errorBox } from "./dom";
import { t } from "./i18n";
import { rememberInstallation } from "./server";

export function installationPicker(sextant: Sextant, clusterId: ClusterId, namespaces: readonly string[], onChosen: () => void): HTMLElement {
  let chosen: string | null = null;
  const use = element("button", { type: "button", className: "primary", textContent: t("installation.use"), disabled: true });
  const slot = element("div");
  const choices = element("div", { className: "choices" });
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", t("installation.title"));
  for (const namespace of namespaces) {
    const radio = element("input", { type: "radio", name: "installation", value: namespace });
    radio.addEventListener("change", () => {
      chosen = namespace;
      use.disabled = false;
    });
    choices.append(element("label", { className: "check" }, radio, ` ${namespace}`));
  }
  use.addEventListener("click", async () => {
    if (chosen === null) return;
    use.disabled = true;
    use.textContent = t("installation.using");
    slot.replaceChildren();
    try {
      await rememberInstallation(sextant, clusterId, chosen);
      onChosen();
    } catch (err) {
      slot.replaceChildren(errorBox(err));
      use.disabled = false;
      use.textContent = t("installation.use");
    }
  });
  const intro = element("p", { textContent: t("installation.several", { namespaces: namespaces.join(", ") }) });
  intro.setAttribute("role", "alert");
  const form = element(
    "section",
    { className: "installation" },
    element("h3", { textContent: t("installation.title") }),
    intro,
    element("p", { textContent: t("installation.choose") }),
    choices,
    slot,
    element("div", { className: "buttons" }, use),
  );
  form.setAttribute("aria-label", t("installation.title"));
  return form;
}
