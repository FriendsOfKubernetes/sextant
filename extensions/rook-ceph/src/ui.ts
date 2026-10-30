// What every change looks like in the extension: the change shown before it is sent (the exact patch or YAML), one
// button that sends it, Sextant's own confirmation in between (the permissions ask first), and the outcome in words.
// A refusal by the user (`denied`) or the cluster, and a conflict (the object changed since it was read), are shown,
// never retried.
import { isSextantError, type Sextant } from "@sextant/extension-sdk";
import { element, errorText } from "./dom";
import { t } from "./i18n";

/** A labelled field: the label is the input's accessible name. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const id = `f-${Math.random().toString(36).slice(2)}`;
  input.id = id;
  return element(
    "div",
    { className: "field" },
    element("label", { htmlFor: id, textContent: label }),
    input,
    hint ? element("p", { className: "muted hint", textContent: hint }) : null,
  );
}

export function numberInput(value: number | undefined, min: number, max: number): HTMLInputElement {
  return element("input", { type: "number", min: String(min), max: String(max), step: "1", value: value === undefined ? "" : String(value) });
}

export function textInput(value: string | undefined, placeholder = ""): HTMLInputElement {
  return element("input", { type: "text", value: value ?? "", placeholder, spellcheck: false });
}

export function checkbox(label: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = element("input", { type: "checkbox", checked });
  return { row: element("label", { className: "check" }, input, ` ${label}`), input };
}

export function select(options: readonly { value: string; label: string }[], value: string): HTMLSelectElement {
  const node = element("select", {}, ...options.map((o) => element("option", { value: o.value, textContent: o.label })));
  node.value = value;
  return node;
}

/** A whole number from `min` to `max` in a field, else `null`. */
export function readCount(input: HTMLInputElement, min: number, max: number): number | null {
  const text = input.value.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

const previewText = (change: unknown) => (typeof change === "string" ? change : JSON.stringify(change, null, 2));

/** The change as it will be sent, folded: what a confirmation is about. */
export function preview(change: unknown): HTMLElement {
  return element("details", { className: "preview" }, element("summary", { textContent: t("change.preview") }), element("pre", { textContent: previewText(change) }));
}

/**
 * Shows `change` in `slot`, or nothing for `null`. A preview already there keeps its element, so one the user opened
 * stays open while the form is edited.
 */
export function showPreview(slot: HTMLElement, change: unknown): void {
  if (change === null) {
    slot.replaceChildren();
    return;
  }
  const pre = slot.querySelector(".preview > pre");
  if (pre) pre.textContent = previewText(change);
  else slot.replaceChildren(preview(change));
}

/** What a failed change says: Sextant's or the user's refusal, a conflict, or the cluster's message. */
export function changeError(err: unknown): string {
  if (isSextantError(err, "conflict")) return t("change.conflict");
  return errorText(err);
}

export interface ChangeButton {
  button: HTMLButtonElement;
  status: HTMLElement;
}

/**
 * A button that runs `send` once per press: disabled while it runs (Sextant may be asking the user), then the
 * outcome in `status`. `done` runs after a success.
 */
export function changeButton(
  label: string,
  send: () => Promise<unknown>,
  options: { danger?: boolean; primary?: boolean; done?: () => void; doneText?: string } = {},
): ChangeButton {
  const status = element("span", { className: "change-status" });
  status.setAttribute("role", "status");
  const button = element("button", {
    type: "button",
    textContent: label,
    className: options.danger ? "danger" : options.primary ? "primary" : "",
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.className = "change-status muted";
    status.textContent = t("change.waiting");
    try {
      await send();
      status.className = "change-status ok-text";
      status.textContent = options.doneText ?? t("change.done");
      options.done?.();
    } catch (err) {
      status.className = "change-status error";
      status.textContent = changeError(err);
    } finally {
      button.disabled = false;
    }
  });
  return { button, status };
}

/**
 * The window of an action: its form, the change it would send (re-built on every input), and Apply / Cancel.
 * `build` returns the change, or a reason it cannot be made yet; `send` sends it. Apply closes the window with a
 * notice after a success.
 */
export function actionWindow(
  sextant: Sextant,
  root: HTMLElement,
  parts: {
    intro?: (Node | null)[];
    form: (Node | null)[];
    build: () => { change: unknown } | { reason: string };
    send: (change: unknown) => Promise<unknown>;
    applyLabel: string;
    /** The notice after a success; a function when it names what was typed. */
    notice: string | (() => string);
    danger?: boolean;
  },
): () => void {
  const previewSlot = element("div", {});
  // Why it cannot be applied yet: a hint, not an error (refusals of the cluster are shown by the button).
  const reason = element("p", { className: "muted" });
  const { button, status } = changeButton(parts.applyLabel, async () => {
    const built = parts.build();
    if ("reason" in built) throw new Error(built.reason);
    await parts.send(built.change);
    await sextant.ui.notify(typeof parts.notice === "string" ? parts.notice : parts.notice()).catch(() => undefined);
    await sextant.ui.close().catch(() => undefined);
  }, { danger: parts.danger, primary: !parts.danger });
  const cancel = element("button", { type: "button", textContent: t("change.cancel") });
  cancel.addEventListener("click", () => void sextant.ui.close().catch(() => undefined));
  const refresh = () => {
    const built = parts.build();
    if ("reason" in built) {
      reason.textContent = built.reason;
      showPreview(previewSlot, null);
      button.disabled = true;
    } else {
      reason.textContent = "";
      showPreview(previewSlot, built.change);
      button.disabled = false;
    }
  };
  const form = element("div", { className: "form" }, ...parts.form);
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  root.replaceChildren(
    ...(parts.intro ?? []).filter((n): n is Node => n !== null),
    form,
    reason,
    previewSlot,
    element("div", { className: "actions" }, status, cancel, button),
  );
  refresh();
  return () => undefined;
}
