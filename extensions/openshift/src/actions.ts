// The windows of "Rollout latest" (`rollout-latest`, on a DeploymentConfig) and "Start build" (`start-build`, on a
// BuildConfig), as Sextant's former built-in dialogs (`src/features/openshift/actions.tsx`, ADR-0120): the question,
// what the action does, the one request it sends (requests.ts, the text the core sends), then Sextant's
// `resources.instantiate` once, which builds that request itself from the name, and what it made. "Rollout latest"
// reads the latest version's ReplicationController first, as `oc rollout latest` does: while it has not ended, or for a
// paused DeploymentConfig, the window says why and "Roll out" stays off — and the core checks the same again right
// before sending. The window is the only question: the manifest's Modify rule on the two kinds has `confirm: false`,
// so Sextant does not ask again, as the built-in dialogs did not. A failure stays in the window and nothing is repeated.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type Watch } from "@sextant/extension-sdk";
import { code, element, errorText, note, remark } from "./dom";
import { t } from "./i18n";
import { rcNameOf, REPLICATION_CONTROLLER, rolloutBlock } from "./model";
import { requestText, rolloutLatestRequest, startBuildRequest } from "./requests";

/** The actions' ids in the manifest. */
export const ROLLOUT_LATEST = "rollout-latest";
export const START_BUILD = "start-build";

const close = (sextant: Sextant) => void sextant.ui.close().catch(() => undefined);

interface ConfirmWindow {
  title: string;
  confirmLabel: string;
  body: () => Node[];
  /** Whether the confirm button may be pressed now. */
  canConfirm: () => boolean;
  /** Sends the change once; the text that says what it made. */
  confirm: () => Promise<string>;
}

/**
 * Draws a confirmation as the built-in `ConfirmAction`: the question and its body with "Cancel" and the confirm button
 * ("Working…" while it is sent), an error under it, then the result with "Close". Returns `refresh`, called whenever
 * the body or whether it may be confirmed changed.
 */
function confirmWindow(sextant: Sextant, root: HTMLElement, win: ConfirmWindow): () => void {
  let busy = false;
  let error: string | null = null;
  let result: string | null = null;
  const draw = () => {
    const question = element("p", { className: "question", textContent: win.title });
    if (result !== null) {
      const done = element("p", { className: "action-dialog__result", textContent: result });
      done.setAttribute("role", "status");
      root.replaceChildren(question, done, element("div", { className: "actions" }, ui.button(t("dialog.close"), () => close(sextant), { variant: "primary" })));
      return;
    }
    const confirm = ui.button(busy ? t("dialog.working") : win.confirmLabel, () => void send(), { variant: "primary", disabled: busy || !win.canConfirm() });
    root.replaceChildren(
      question,
      ...win.body(),
      ...(error === null ? [] : [ui.errorState(error)]),
      element("div", { className: "actions" }, ui.button(t("dialog.cancel"), () => close(sextant)), confirm),
    );
  };
  async function send(): Promise<void> {
    if (busy || !win.canConfirm()) return;
    busy = true;
    error = null;
    draw();
    try {
      result = await win.confirm();
    } catch (err) {
      error = errorText(err);
    }
    busy = false;
    draw();
  }
  draw();
  return draw;
}

/** The window of "Rollout latest" on the DeploymentConfig `dc`; returns its stop. */
export function rolloutLatestWindow(sextant: Sextant, root: HTMLElement, dc: KubeObject, ref: ObjectRef): () => void {
  const namespace = dc.metadata.namespace;
  // The latest version's ReplicationController, as `oc` reads it before sending.
  let rcs: KubeObject[] = [];
  let checked = namespace === undefined;
  let watch: Watch | null = null;
  const block = () => rolloutBlock(dc, rcs);
  const refresh = confirmWindow(sextant, root, {
    title: t("rolloutLatest.title", { name: ref.name }),
    confirmLabel: t("rolloutLatest.confirm"),
    canConfirm: () => checked && block() === undefined,
    body: () => {
      const blocked = block();
      return [
        element("p", { textContent: t("rolloutLatest.text") }),
        ...(blocked ? [note(t(`rolloutLatest.${blocked}`, { name: rcNameOf(dc) }), "warning")] : []),
        remark(t("request")),
        ...[code(requestText(rolloutLatestRequest(dc)))].filter((n): n is HTMLElement => n !== null),
      ];
    },
    confirm: async () => {
      const made = await sextant.resources.instantiate({ ref });
      return t("rolloutLatest.done", { name: made.name });
    },
  });
  if (namespace !== undefined) {
    const settle = () => {
      checked = true;
      refresh();
    };
    watch = sextant.resources.watch(
      { kind: { group: REPLICATION_CONTROLLER.group, version: REPLICATION_CONTROLLER.version, kind: REPLICATION_CONTROLLER.kind }, namespaces: [namespace], fieldSelector: `metadata.name=${rcNameOf(dc)}` },
      {
        onUpdate: trackObjects(
          (items) => {
            rcs = [...items];
            settle();
          },
          (other) => {
            // A list it cannot read blocks nothing here: the core checks again before sending, as the built-in did.
            if (other.type === "error" || other.type === "forbidden") settle();
          },
        ),
        onError: settle,
      },
    );
    watch.started.catch(() => undefined);
  }
  return () => void watch?.unwatch().catch(() => undefined);
}

/** The window of "Start build" on the BuildConfig `bc`. */
export function startBuildWindow(sextant: Sextant, root: HTMLElement, bc: KubeObject, ref: ObjectRef): void {
  confirmWindow(sextant, root, {
    title: t("startBuild.title", { name: ref.name }),
    confirmLabel: t("startBuild.confirm"),
    canConfirm: () => true,
    body: () => [
      element("p", { textContent: t("startBuild.text") }),
      remark(t("request")),
      ...[code(requestText(startBuildRequest(bc)))].filter((n): n is HTMLElement => n !== null),
    ],
    confirm: async () => {
      const made = await sextant.resources.instantiate({ ref });
      return t("startBuild.done", { name: made.name });
    },
  });
}

/** Starts the action window `contribution` on the object Sextant selected; returns its stop. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const ref: ObjectRef | undefined = sextant.context.selection[0];
  if (!ref || (contribution !== ROLLOUT_LATEST && contribution !== START_BUILD)) {
    root.replaceChildren(ui.empty(t("common.nothingSelected")));
    return () => undefined;
  }
  let stopped = false;
  let stop: () => void = () => undefined;
  root.replaceChildren(ui.loading(t("loading")));
  void sextant.resources
    .get({ ref })
    .then((obj) => {
      if (stopped) return;
      if (contribution === ROLLOUT_LATEST) stop = rolloutLatestWindow(sextant, root, obj, ref);
      else startBuildWindow(sextant, root, obj, ref);
    })
    .catch((err: unknown) => {
      if (!stopped) root.replaceChildren(ui.errorState(errorText(err)));
    });
  return () => {
    stopped = true;
    stop();
  };
}
