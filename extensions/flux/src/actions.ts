// The one action of the extension that has a window (the manifest's `contributes.actions`): Reconcile with source. It
// reads the object to find its source, so it cannot be a patch fixed in the manifest as Reconcile now, Suspend and
// Resume are (Sextant sends those itself). Like the built-in view's action it is one click: the window sends at once,
// `metadata.annotations["reconcile.fluxcd.io/requestedAt"]` = now on the source of a Kustomization or HelmRelease (and a
// HelmRelease's HelmChart), then on the object, every object in one `resources.patchMany` call, shows that it is
// waiting, and closes itself once they are sent. A failure stops before the next object, says which object failed and
// offers to send again.
import { isSextantError, SextantError, ui, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { element, errorBox, errorText } from "./dom";
import { reconcilePatch, refInput, withSourceOrder, type FluxRef } from "./flux";
import { t } from "./i18n";

const fluxRefOf = (ref: ObjectRef): FluxRef => ({
  group: ref.kind.group,
  ...(ref.kind.version ? { version: ref.kind.version } : {}),
  kind: ref.kind.kind,
  namespace: ref.namespace,
  name: ref.name,
});

/** A step of an action: one object and the patch it gets (built when it is sent, so a time is the time of sending). */
export interface Step {
  ref: FluxRef;
  patch: () => Record<string, unknown>;
}

/** Items one `resources.patchMany` takes at most; more steps go in further calls. */
export const MAX_BATCH = 50;

/** What a failed step says: a conflict, or the cluster's message, with the object. */
function stepError(step: Step, err: unknown): string {
  const message = isSextantError(err, "conflict") ? t("change.conflict") : errorText(err);
  return t("window.failedAt", { kind: step.ref.kind, name: step.ref.name, message });
}

/**
 * Sends the steps in order, each once, under one decision per call of up to `MAX_BATCH`. Sextant's or the user's
 * refusal sends nothing; the first failed object stops the rest.
 */
export async function sendSteps(sextant: Sextant, steps: readonly Step[]): Promise<void> {
  for (let start = 0; start < steps.length; start += MAX_BATCH) {
    const batch = steps.slice(start, start + MAX_BATCH);
    let answer;
    try {
      answer = await sextant.resources.patchMany({
        items: batch.map((step) => ({ ref: refInput(step.ref), patch: step.patch() as never, patchType: "merge" as const })),
      });
    } catch (err) {
      throw new Error(errorText(err), { cause: err });
    }
    const failed = answer.items.findIndex((item) => "error" in item);
    const item = answer.items[failed];
    if (item && "error" in item) {
      const err = new SextantError(item.error.code as SextantError["code"], item.error.message);
      throw new Error(stepError(batch[failed]!, err), { cause: err });
    }
  }
}

/**
 * The window: the intro and the objects, sent at once; it closes itself once they are sent, and on a failure says why
 * and offers to send again.
 */
export function sendingWindow(sextant: Sextant, root: HTMLElement, parts: { intro: Node[]; steps: Step[] }): void {
  const status = element("span", { className: "change-status" });
  status.setAttribute("role", "status");
  const show = (text: string, tone: "muted" | "danger") => {
    status.className = `change-status sx-status sx-status--${tone}`;
    status.textContent = text;
  };
  const retry = ui.button(t("related.retry"), () => void send(), { variant: "primary" });
  retry.hidden = true;
  const send = async () => {
    retry.hidden = true;
    show(t("change.waiting"), "muted");
    try {
      await sendSteps(sextant, parts.steps);
      await sextant.ui.close().catch(() => undefined);
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "danger");
      retry.hidden = false;
    }
  };
  const refs = parts.steps.map((s) => s.ref);
  const objects = ui.table(
    [t("related.kind"), t("related.name"), t("related.namespace")],
    refs.map((r) => [r.kind, r.name, r.namespace ?? ""]),
  );
  root.replaceChildren(...parts.intro, objects, element("div", { className: "actions" }, status, retry));
  void send();
}

type Opener = (sextant: Sextant, root: HTMLElement, refs: FluxRef[], selection: ObjectRef[]) => void | Promise<void>;

export const ACTIONS: Record<string, Opener> = {
  async "reconcile-with-source"(sextant, root, refs, selection) {
    const self = refs[0]!;
    const obj = await sextant.resources.get({ ref: selection[0]! });
    const order = withSourceOrder(obj, self);
    if (order.length < 2) {
      root.replaceChildren(ui.empty(t("reconcileWithSource.noSource", { kind: self.kind, name: self.name })));
      return;
    }
    sendingWindow(sextant, root, {
      intro: [element("p", { textContent: t("reconcileWithSource.intro", { kind: self.kind, name: self.name }) })],
      steps: order.map((ref) => ({ ref, patch: () => reconcilePatch(new Date()) })),
    });
  },
};

/** The actions that run on one object only (the manifest does not mark them `multiple`). */
const SINGLE = new Set(["reconcile-with-source"]);

/** Starts the window of the action `contribution` on the objects in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const open = ACTIONS[contribution];
  const all = sextant.context.selection;
  const selection = SINGLE.has(contribution) ? all.slice(0, 1) : all;
  if (!open) {
    root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
    return () => undefined;
  }
  if (selection.length === 0) {
    root.replaceChildren(ui.empty(t("common.nothingSelected")));
    return () => undefined;
  }
  root.replaceChildren(ui.loading(t("common.loading")));
  void Promise.resolve(open(sextant, root, selection.map(fluxRefOf), selection)).catch((err: unknown) => root.replaceChildren(errorBox(err)));
  return () => undefined;
}
