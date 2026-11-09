// Actions of extensions that run without a window (`contributes.actions[].headless`, #379): Sextant loads the action's
// frame out of sight, with the same context a window's frame gets, and nothing else changes — every call goes through
// the same bridge, Rust's decision and Sextant's confirmations. The frame ends the run with `ui.close`; it tells the
// user with `ui.notify` (the extension's notices); an error it reports, a frame that does not load, or a run past
// `HEADLESS_LIMIT_MS` is told as a notice of the extension's too.
import { create } from "zustand";
import type { ClusterId, ObjectRef } from "../api";
import { i18n } from "../i18n";
import { ExtensionFrame } from "./ExtensionFrame";
import { reportActionFailure } from "../features/actions/registry";
import { pushNotice } from "./notices";
import { VIEW } from "./protocol";
import { useExtensions } from "./store";

/** A hidden action that has not closed by then is ended. */
export const HEADLESS_LIMIT_MS = 120_000;

interface HeadlessRun {
  id: number;
  extensionId: string;
  /** The extension's name, for its notices. */
  extension: string;
  contribution: string;
  title: string;
  clusterId: ClusterId;
  refs: readonly ObjectRef[];
}

interface HeadlessState {
  runs: readonly HeadlessRun[];
}

export const useHeadlessRuns = create<HeadlessState>()(() => ({ runs: [] }));

let counter = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Starts the hidden frame of an action on `refs`. */
export function startHeadlessAction(run: Omit<HeadlessRun, "id">): void {
  const id = ++counter;
  useHeadlessRuns.setState((s) => ({ runs: [...s.runs, { ...run, id }] }));
  timers.set(
    id,
    setTimeout(() => {
      if (!endHeadlessAction(id)) return;
      pushNotice(run.extension, i18n.t("extensions:host.action.timedOut", { action: run.title }));
    }, HEADLESS_LIMIT_MS),
  );
}

/** Ends a run (its frame goes); whether it was still running. */
export function endHeadlessAction(id: number): boolean {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const running = useHeadlessRuns.getState().runs.some((r) => r.id === id);
  if (running) useHeadlessRuns.setState((s) => ({ runs: s.runs.filter((r) => r.id !== id) }));
  return running;
}

/** Ends every run of `extensionId` (it was disabled or removed). */
export function endHeadlessActionsOf(extensionId: string): void {
  for (const run of useHeadlessRuns.getState().runs) if (run.extensionId === extensionId) endHeadlessAction(run.id);
}

/** The hidden frames of the actions running now; mounted once by `ExtensionsHost`. */
export function HeadlessActions() {
  const runs = useHeadlessRuns((s) => s.runs);
  const { extensions } = useExtensions();
  if (runs.length === 0) return null;
  return (
    <div className="ext-headless" aria-hidden="true">
      {runs
        .filter((run) => extensions.some((e) => e.id === run.extensionId && e.state === "active"))
        .map((run) => (
          <ExtensionFrame
            key={run.id}
            extensionId={run.extensionId}
            view={VIEW.action}
            contribution={run.contribution}
            title={run.title}
            clusterId={run.clusterId}
            selection={run.refs}
            onClose={(failed) => {
              if (endHeadlessAction(run.id) && failed !== undefined) reportActionFailure(run.title, failed);
            }}
            onFailed={(message) => {
              if (!endHeadlessAction(run.id)) return;
              pushNotice(
                run.extension,
                message
                  ? i18n.t("extensions:host.action.failed", { action: run.title, message })
                  : i18n.t("extensions:host.action.notLoaded", { action: run.title }),
              );
            }}
            className="ext-frame--headless"
          />
        ))}
    </div>
  );
}
