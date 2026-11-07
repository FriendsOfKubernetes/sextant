// The windows of the Workflow actions Suspend, Resume, Stop and Terminate (ADR-0097, amended for #238). Each reads the
// Workflow and lists exactly the merge patch it will send (./patches.ts, as util.go builds it), with the
// resourceVersion read and the time of reading where the patch carries them. On confirm the Workflow is read once
// more: if the patch would differ from the one shown, nothing is sent and the window shows the new one to confirm.
// Then the patch goes once (ADR-0055), with the resourceVersion of that last read where it is versioned, so the API
// server refuses it (a conflict) when the Workflow changed in between. Retry is not offered. The window is the only
// question: the manifest's Modify rule has `confirm: false`, so Sextant does not ask again, as the built-in view did
// not.
import { ui, type JsonValue, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { element, errorText } from "./dom";
import { t } from "./i18n";
import { actionOf, nowStamp, patchToSend, planFor, type WorkflowAction, type WorkflowPlan } from "./patches";

const json = (value: unknown) => JSON.stringify(value);
const resourceVersionOf = (wf: KubeObject) => (typeof wf.metadata.resourceVersion === "string" ? wf.metadata.resourceVersion : undefined);

/** What the window shows: the plan, and its patch as it would be sent now (the resourceVersion read, the time). */
export interface Shown {
  plan: WorkflowPlan;
  patch: Record<string, unknown> | undefined;
}

export const shownFor = (action: WorkflowAction, wf: KubeObject, stamp = nowStamp()): Shown => {
  const plan = planFor(action, wf);
  return { plan, patch: patchToSend(plan, resourceVersionOf(wf), stamp) };
};

/** What the window shows of a plan: the patch with its notes, or why there is none. */
export function planView(action: WorkflowAction, ref: ObjectRef, shown: Shown): Node[] {
  const { plan, patch } = shown;
  if (plan.refusal) {
    const alert = element("p", {
      className: "explain error",
      textContent: t(`dialog.refusal.${plan.refusal.reason}`, { name: ref.name, namespace: ref.namespace ?? "", ...plan.refusal }),
    });
    alert.setAttribute("role", "alert");
    return [alert];
  }
  if (!patch) return [element("p", { className: "explain", textContent: t(`dialog.nothing.${action}`) })];
  const text = ui.pre(json(patch));
  text.classList.add("patch");
  return [
    element("p", { textContent: t("dialog.patch") }),
    text,
    plan.versioned ? element("p", { className: "sx-muted", textContent: t("dialog.versioned") }) : null,
    plan.stamped.length > 0 ? element("p", { className: "sx-muted", textContent: t("dialog.stamped") }) : null,
  ].filter((n): n is HTMLElement => n !== null);
}

/** Whether the window may send what it shows. */
const sendable = (shown: Shown) => !shown.plan.refusal && shown.patch !== undefined;

/** Starts the window of the action `contribution` on the Workflow in the context. */
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
    .then((wf) => actionWindow(sextant, root, ref, action, wf))
    .catch((err: unknown) => root.replaceChildren(ui.errorState(errorText(err))));
  return () => undefined;
}

function actionWindow(sextant: Sextant, root: HTMLElement, ref: ObjectRef, action: WorkflowAction, first: KubeObject): void {
  let shown = shownFor(action, first);
  const planSlot = element("div", { className: "plan" }, ...planView(action, ref, shown));
  const status = element("p", { className: "change-status" });
  status.setAttribute("role", "status");
  const confirm = ui.button(t(`actions.${action}`), () => void send(), {
    variant: action === "stop" || action === "terminate" ? "danger" : "primary",
    disabled: !sendable(shown),
  });
  const cancel = ui.button(t("change.cancel"), () => void sextant.ui.close().catch(() => undefined));
  async function send(): Promise<void> {
    confirm.disabled = true;
    status.className = "change-status sx-muted";
    status.textContent = t("change.waiting");
    try {
      const wf = await sextant.resources.get({ ref });
      const fresh = planFor(action, wf);
      if (json(fresh) !== json(shown.plan)) {
        // Nothing is sent: the window shows the Workflow as it is now.
        shown = shownFor(action, wf);
        planSlot.replaceChildren(...planView(action, ref, shown));
        status.className = "change-status sx-status--danger";
        status.textContent = t("dialog.changed");
        confirm.disabled = !sendable(shown);
        return;
      }
      const patch = patchToSend(fresh, resourceVersionOf(wf), nowStamp());
      if (patch) await sextant.resources.patch({ ref, patch: patch as JsonValue, patchType: "merge" });
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
