// The windows of the Rollout actions Promote, Promote fully, Abort, Retry, Pause and Resume (ADR-0097). Each reads the
// Rollout and lists exactly the patches it will send (./patches.ts, as `kubectl argo rollouts` builds them from the
// Rollout as it is now). On confirm the Rollout is read once more: if the action no longer applies, or the patches
// would differ from the ones shown, nothing is sent and the window shows why, or the new patches to confirm. Each
// patch is sent once (ADR-0055), all of them in one `resources.patchMany`. The window is the only question: the
// manifest's Modify rule has `confirm: false`, so Sextant does not ask again, as the built-in view did not.
import { ui, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { element, errorText } from "./dom";
import { t } from "./i18n";
import { actionOf, APPLIES, changesSomething, fallbackOf, planFor, sendPlan, type PatchPlan, type RolloutAction } from "./patches";

const json = (value: unknown) => JSON.stringify(value);

/** What the window says when the Rollout as it is now needs no patch. */
const NOTHING: Record<RolloutAction, string> = {
  promote: "dialog.nothing",
  promoteFull: "dialog.nothing",
  abort: "dialog.nothing",
  retry: "dialog.nothing",
  pause: "dialog.nothingPause",
  resume: "dialog.nothingResume",
};

/** A patch as the window lists it. */
const patchText = (patch: unknown) => {
  const node = ui.pre(json(patch));
  node.classList.add("patch");
  return node;
};

/** What the window shows of a plan: the patches, or why there is none. */
export function planView(action: RolloutAction, ro: KubeObject, plan: PatchPlan): Node[] {
  if (!APPLIES[action](ro)) return [element("p", { className: "explain", textContent: t(`whyNot.${action}`) })];
  if (!changesSomething(plan)) return [element("p", { className: "explain", textContent: t(NOTHING[action]) })];
  const fallback = fallbackOf(plan);
  return [
    ...(plan.status ? [element("p", { textContent: t("dialog.statusPatch") }), patchText(plan.status)] : []),
    ...(plan.spec ? [element("p", { textContent: t("dialog.specPatch") }), patchText(plan.spec)] : []),
    ...(fallback ? [element("p", { className: "sx-muted", textContent: t("dialog.fallbackPatch") }), patchText(fallback)] : []),
  ];
}

/** Whether the window may send `plan` for `ro`. */
const sendable = (action: RolloutAction, ro: KubeObject, plan: PatchPlan) => APPLIES[action](ro) && changesSomething(plan);

/** Starts the window of the action `contribution` on the Rollout in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const ref = sextant.context.selection[0];
  const action = actionOf(contribution);
  if (!ref || !action) {
    root.replaceChildren(ui.empty(t("common.nothingSelected")));
    return () => undefined;
  }
  root.replaceChildren(ui.loading(t("dialog.loading")));
  void sextant.resources
    .get({ ref })
    .then((ro) => actionWindow(sextant, root, ref, action, ro))
    .catch((err: unknown) => root.replaceChildren(ui.errorState(errorText(err))));
  return () => undefined;
}

function actionWindow(sextant: Sextant, root: HTMLElement, ref: ObjectRef, action: RolloutAction, first: KubeObject): void {
  let shown = planFor(action, first);
  const planSlot = element("div", { className: "plan" }, ...planView(action, first, shown));
  const status = element("p", { className: "change-status" });
  status.setAttribute("role", "status");
  const confirm = ui.button(t(`actions.${action}`), () => void send(), {
    variant: action === "abort" ? "danger" : "primary",
    disabled: !sendable(action, first, shown),
  });
  const cancel = ui.button(t("change.cancel"), () => void sextant.ui.close().catch(() => undefined));
  async function send(): Promise<void> {
    confirm.disabled = true;
    status.className = "change-status sx-muted";
    status.textContent = t("change.waiting");
    try {
      const ro = await sextant.resources.get({ ref });
      const fresh = planFor(action, ro);
      if (!sendable(action, ro, fresh) || json(fresh) !== json(shown)) {
        // Nothing is sent: the window shows the Rollout as it is now.
        shown = fresh;
        planSlot.replaceChildren(...planView(action, ro, fresh));
        status.className = "change-status sx-status--danger";
        status.textContent = t("dialog.changed");
        confirm.disabled = !sendable(action, ro, fresh);
        return;
      }
      await sendPlan(sextant, ref, fresh);
      status.className = "change-status sx-status--success";
      status.textContent = t("change.done");
      await sextant.ui.close().catch(() => undefined);
    } catch (err) {
      status.className = "change-status sx-status--danger";
      status.textContent = errorText(err);
      confirm.disabled = false;
    }
  }
  root.replaceChildren(
    element("p", { className: "question", textContent: t(`dialog.${action}Title`, { name: ref.name }) }),
    element("p", { textContent: t(`dialog.${action}Text`) }),
    planSlot,
    element("div", { className: "actions" }, status, cancel, confirm),
  );
}
