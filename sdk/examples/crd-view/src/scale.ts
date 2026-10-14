// The "Scale widget" action: a merge patch of `spec.replicas`. Sextant asks the user to allow it (the manifest's rule
// for Modify has `confirm: true`); a refusal is shown and the window stays open.
import type { Sextant } from "@sextant/extension-sdk";
import { element, parseCount, readSettings, selectedWidget, type Widget } from "./widget";

export function startScale(sextant: Sextant, root: HTMLElement): () => void {
  const ref = selectedWidget(sextant);
  if (!ref) {
    root.replaceChildren(element("p", { className: "error", textContent: "No widget is selected." }));
    return () => undefined;
  }
  let settings = { step: 1, maxReplicas: 10 };
  const replicas = element("input", { type: "text", inputMode: "numeric", value: "" });
  replicas.setAttribute("aria-label", "Replicas");
  const minus = element("button", { type: "button", textContent: "−" });
  const plus = element("button", { type: "button", textContent: "+" });
  const hint = element("span", { className: "muted" });
  const error = element("p", { className: "error", hidden: true });
  const cancel = element("button", { type: "button", textContent: "Cancel" });
  const scale = element("button", { type: "button", className: "primary", textContent: "Scale", disabled: true });
  root.replaceChildren(
    element("h2", { textContent: `Scale ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}` }),
    element("div", { className: "row" }, minus, replicas, plus, hint),
    error,
    element("div", { className: "actions" }, cancel, scale),
  );

  const fail = (message: string | null) => {
    error.hidden = message === null;
    error.textContent = message ?? "";
  };
  const stepBy = (delta: number) => {
    const now = Number.parseInt(replicas.value, 10) || 0;
    replicas.value = String(Math.min(settings.maxReplicas, Math.max(0, now + delta)));
    fail(null);
  };
  minus.addEventListener("click", () => stepBy(-settings.step));
  plus.addEventListener("click", () => stepBy(settings.step));
  replicas.addEventListener("input", () => fail(null));
  cancel.addEventListener("click", () => void sextant.ui.close());

  scale.addEventListener("click", async () => {
    const count = parseCount(replicas.value, 0, settings.maxReplicas);
    if (count === null) {
      fail(`Enter a whole number from 0 to ${settings.maxReplicas}.`);
      return;
    }
    scale.disabled = true;
    fail(null);
    try {
      await sextant.resources.patch({ ref, patch: { spec: { replicas: count } }, patchType: "merge" });
      await sextant.ui.notify(`Scaled ${ref.name} to ${count} ${count === 1 ? "replica" : "replicas"}`);
      await sextant.ui.close();
    } catch (err) {
      fail((err as Error).message);
      scale.disabled = false;
    }
  });

  void (async () => {
    settings = await readSettings(sextant);
    hint.textContent = `step ${settings.step}, at most ${settings.maxReplicas}`;
    try {
      const widget = await sextant.resources.get<Widget>({ ref });
      replicas.value = String(widget.spec?.replicas ?? 0);
      scale.disabled = false;
      replicas.focus();
    } catch (err) {
      fail((err as Error).message);
    }
  })();
  return () => undefined;
}
