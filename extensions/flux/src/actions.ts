// The one action of the extension whose frame Sextant opens (the manifest's `contributes.actions`): Reconcile with
// source. It reads the object to find its source, so it cannot be a patch fixed in the manifest as Reconcile now,
// Suspend and Resume are (Sextant sends those itself). It is `headless` (ADR-0164): Sextant runs its frame out of
// sight, so like the built-in view's action it is one click with nothing drawn. The frame reads the object, sends
// `metadata.annotations["reconcile.fluxcd.io/requestedAt"]` = now to the source of a Kustomization or HelmRelease (and a
// HelmRelease's HelmChart), then to the object, all in one `resources.patchMany` call, and ends the run with
// `ui.close`. A failure stops before the next object and is told with `ui.notify`, naming the object that failed; the
// user's own refusal of Sextant's question ends it silently.
import { isDeclined, isSextantError, type ObjectRef, type Sextant, SextantError, ui } from "@sextant/extension-sdk";
import { errorText } from "./dom";
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

/**
 * The user answered "no" to Sextant's question (or did not answer): nothing to tell them. Sextant answers both its own
 * refusal and the user's with `denied`; only its text says which (`The user declined …`, `No answer from the user …`).
 */
export function declinedByUser(err: unknown): boolean {
  // Sextant says so by the error's reason since 0.30 (#389), not by its words.
  return isDeclined(err);
}

/** What a failed step says: a conflict, or the cluster's message, with the object. */
function stepError(step: Step, err: unknown): string {
  const message = isSextantError(err, "conflict") ? t("change.conflict") : errorText(err);
  return t("reconcileWithSource.failedAt", { kind: step.ref.kind, name: step.ref.name, message });
}

/** Thrown with what to tell the user; `undefined` when nothing is to be told (the user declined). */
class Told extends Error {
  constructor(readonly notice: string | undefined) {
    super(notice ?? "declined");
  }
}

/**
 * Sends the steps in order, each once, under one decision. Sextant's or the user's refusal sends nothing; the first
 * failed object stops the rest.
 */
export async function sendSteps(sextant: Sextant, steps: readonly Step[]): Promise<void> {
  let answer;
  try {
    answer = await sextant.resources.patchMany({
      items: steps.map((step) => ({ ref: refInput(step.ref), patch: step.patch() as never, patchType: "merge" as const })),
    });
  } catch (err) {
    throw new Told(declinedByUser(err) ? undefined : t("reconcileWithSource.failed", { message: errorText(err) }));
  }
  const failed = answer.items.findIndex((item) => "error" in item);
  const item = answer.items[failed];
  if (item && "error" in item) {
    throw new Told(stepError(steps[failed]!, new SextantError(item.error.code as SextantError["code"], item.error.message)));
  }
}

/** Reconcile with source on `selection`: read, send, and say only what went wrong. */
async function reconcileWithSource(sextant: Sextant, selection: ObjectRef): Promise<void> {
  const self = fluxRefOf(selection);
  let obj;
  try {
    obj = await sextant.resources.get({ ref: selection });
  } catch (err) {
    throw new Told(t("reconcileWithSource.failedAt", { kind: self.kind, name: self.name, message: errorText(err) }));
  }
  const order = withSourceOrder(obj, self);
  if (order.length < 2) throw new Told(t("reconcileWithSource.noSource", { kind: self.kind, name: self.name }));
  await sendSteps(
    sextant,
    order.map((ref) => ({ ref, patch: () => reconcilePatch(new Date()) })),
  );
}

/** The actions whose frame runs out of sight (`headless` in the manifest), each on the first selected object. */
const HEADLESS: Record<string, (sextant: Sextant, selection: ObjectRef) => Promise<void>> = {
  "reconcile-with-source": reconcileWithSource,
};

/** Runs a headless action: nothing drawn; a notice for what went wrong, then the run is ended. */
async function runHeadless(sextant: Sextant, run: (sextant: Sextant, selection: ObjectRef) => Promise<void>): Promise<void> {
  try {
    const first = sextant.context.selection[0];
    if (first) await run(sextant, first);
  } catch (err) {
    const notice = err instanceof Told ? err.notice : errorText(err);
    if (notice !== undefined) await sextant.ui.notify(notice).catch(() => undefined);
  } finally {
    await sextant.ui.close().catch(() => undefined);
  }
}

/** Starts the action `contribution` on the objects in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const headless = HEADLESS[contribution];
  if (headless) {
    void runHeadless(sextant, headless);
    return () => undefined;
  }
  root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
  return () => undefined;
}
