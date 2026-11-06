// The windows of the extension's actions (the manifest's `contributes.actions`). Each shows the objects it runs on and
// the merge patch it sends, and sends it once the user presses its button — one object at a time, in order, each
// once; Sextant asks for its own confirmation of each change in between. Nothing is sent from opening a window. A
// failure stops before the next object and says which object failed.
//
// - `reconcile`: `metadata.annotations["reconcile.fluxcd.io/requestedAt"]` = now, on every selected object;
// - `reconcile-with-source`: the same on the source of a Kustomization or HelmRelease (and a HelmRelease's HelmChart),
//   then on the object;
// - `suspend`: `spec.suspend: true`, after the built-in view's question;
// - `resume`: `spec.suspend: false` on every selected object.
import { isSextantError, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { element, errorBox, errorText, muted } from "./dom";
import { reconcilePatch, refInput, REQUESTED_AT_ANNOTATION, suspendPatch, withSourceOrder, type FluxRef } from "./flux";
import { i18n, t } from "./i18n";

const fluxRefOf = (ref: ObjectRef): FluxRef => ({ group: ref.kind.group, kind: ref.kind.kind, namespace: ref.namespace, name: ref.name });

/** A step of an action: one object and the patch it gets (built when it is sent, so a time is the time of sending). */
export interface Step {
  ref: FluxRef;
  patch: () => Record<string, unknown>;
}

/** What a failed step says: Sextant's or the user's refusal, a conflict, or the cluster's message, with the object. */
function stepError(step: Step, err: unknown): string {
  const message = isSextantError(err, "conflict") ? t("change.conflict") : errorText(err);
  return t("window.failedAt", { kind: step.ref.kind, name: step.ref.name, message });
}

/** Sends the steps in order, each once; the first failure stops the rest. */
export async function sendSteps(sextant: Sextant, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    try {
      await sextant.resources.patch({ ref: refInput(step.ref), patch: step.patch() as never, patchType: "merge" });
    } catch (err) {
      throw new Error(stepError(step, err), { cause: err });
    }
  }
}

const objectList = (refs: readonly FluxRef[]) =>
  element(
    "ol",
    { className: "objects" },
    ...refs.map((r) => element("li", {}, element("span", { className: "muted", textContent: `${r.kind} ` }), r.namespace ? `${r.namespace}/${r.name}` : r.name)),
  );

/** The window: the intro, the objects, the patch folded, and Cancel / the action's button. */
export function actionWindow(
  sextant: Sextant,
  root: HTMLElement,
  parts: { intro: Node[]; steps: Step[]; label: string; notice: string },
): void {
  const status = element("span", { className: "change-status" });
  status.setAttribute("role", "status");
  const send = element("button", { type: "button", className: "primary", textContent: parts.label });
  const cancel = element("button", { type: "button", textContent: t("change.cancel") });
  cancel.addEventListener("click", () => void sextant.ui.close().catch(() => undefined));
  send.addEventListener("click", async () => {
    send.disabled = true;
    status.className = "change-status muted";
    status.textContent = t("change.waiting");
    try {
      await sendSteps(sextant, parts.steps);
      status.className = "change-status ok";
      status.textContent = t("change.done");
      await sextant.ui.notify(parts.notice).catch(() => undefined);
      await sextant.ui.close().catch(() => undefined);
    } catch (err) {
      status.className = "change-status error";
      status.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      send.disabled = false;
    }
  });
  const example = parts.steps[0]?.patch();
  const preview = element(
    "details",
    { className: "preview" },
    element("summary", { textContent: t("change.preview") }),
    element("pre", { textContent: JSON.stringify(example ?? null, null, 2) }),
  );
  root.replaceChildren(...parts.intro, objectList(parts.steps.map((s) => s.ref)), preview, element("div", { className: "actions" }, status, cancel, send));
}

const names = (refs: readonly FluxRef[]) => i18n().formatList(refs.map((r) => `${r.kind} ${r.name}`));

type Opener = (sextant: Sextant, root: HTMLElement, refs: FluxRef[], selection: ObjectRef[]) => void | Promise<void>;

export const ACTIONS: Record<string, Opener> = {
  reconcile(sextant, root, refs) {
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("reconcile.intro", { annotation: REQUESTED_AT_ANNOTATION }) })],
      steps: refs.map((ref) => ({ ref, patch: () => reconcilePatch(new Date()) })),
      label: t("actions.reconcile"),
      notice: t("notice.reconcile", { names: names(refs) }),
    });
  },

  async "reconcile-with-source"(sextant, root, refs, selection) {
    const self = refs[0]!;
    const obj = await sextant.resources.get({ ref: selection[0]! });
    const order = withSourceOrder(obj, self);
    if (order.length < 2) {
      root.replaceChildren(muted(t("reconcileWithSource.noSource", { kind: self.kind, name: self.name })));
      return;
    }
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("reconcileWithSource.intro", { kind: self.kind, name: self.name }) })],
      steps: order.map((ref) => ({ ref, patch: () => reconcilePatch(new Date()) })),
      label: t("actions.reconcileWithSource"),
      notice: t("notice.reconcile", { names: names(order) }),
    });
  },

  suspend(sextant, root, refs) {
    const ref = refs[0]!;
    const what = { kind: ref.kind, name: ref.name };
    actionWindow(sextant, root, {
      intro: [element("h2", { textContent: t("suspend.title", what) }), element("p", { textContent: t("suspend.text", what) })],
      steps: [{ ref, patch: () => suspendPatch(true) }],
      label: t("suspend.confirm"),
      notice: t("notice.suspend", what),
    });
  },

  resume(sextant, root, refs) {
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("resume.intro") })],
      steps: refs.map((ref) => ({ ref, patch: () => suspendPatch(false) })),
      label: t("actions.resume"),
      notice: t("notice.resume", { names: names(refs) }),
    });
  },
};

/** The actions that run on one object only (the manifest does not mark them `multiple`). */
const SINGLE = new Set(["reconcile-with-source", "suspend"]);

/** Starts the window of the action `contribution` on the objects in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const open = ACTIONS[contribution];
  const all = sextant.context.selection;
  const selection = SINGLE.has(contribution) ? all.slice(0, 1) : all;
  if (!open) {
    root.replaceChildren(muted(t("common.nothingToShow", { view: contribution })));
    return () => undefined;
  }
  if (selection.length === 0) {
    root.replaceChildren(muted(t("common.nothingSelected")));
    return () => undefined;
  }
  root.replaceChildren(muted(t("common.loading")));
  void Promise.resolve(open(sextant, root, selection.map(fluxRefOf), selection)).catch((err: unknown) => root.replaceChildren(errorBox(err)));
  return () => undefined;
}
