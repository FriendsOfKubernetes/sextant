// The action windows: Sync (revision, prune, dry run; sets `operation`), Refresh / Hard refresh (the refresh
// annotation), Terminate (sets the running operation's phase to Terminating) and "Open Argo CD UI" (a port forward to
// argocd-server, then the browser after the user agrees). Every change is a merge patch of the Application that
// Sextant checks and confirms (the manifest's Modify rule asks every time); the window shows the outcome.
import type { ClusterId, ForwardInfo, ObjectRef, Sextant } from "@sextant/extension-sdk";
import { defaultRevision, isApplication, isMultiSource, patchCall, refreshPatch, syncPatch, terminatePatch, type RefreshKind } from "./argo";
import { button, element, errorBox } from "./dom";
import { t } from "./i18n";
import { describeServer, findInstallation, uiPort } from "./server";
import { installationPicker } from "./picker";
import { startDiff } from "./diff";

function buttons(...nodes: HTMLElement[]): HTMLElement {
  return element("div", { className: "buttons" }, ...nodes);
}

function status(): HTMLElement {
  const node = element("p", { className: "status" });
  node.setAttribute("role", "status");
  return node;
}

/** Runs `send` from `confirm`: disabled while it runs (Sextant may be asking the user), the error under it. */
function runFrom(confirm: HTMLButtonElement, slot: HTMLElement, send: () => Promise<void>): void {
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    slot.replaceChildren();
    try {
      await send();
    } catch (err) {
      slot.replaceChildren(errorBox(err));
    } finally {
      confirm.disabled = false;
    }
  });
}

const cancel = (sextant: Sextant) => button(t("common.cancel"), () => void sextant.ui.close());

async function startSync(sextant: Sextant, root: HTMLElement, ref: ObjectRef): Promise<void> {
  const app = await sextant.resources.get({ ref });
  const multiSource = isMultiSource(app);
  const revision = element("input", { type: "text", value: defaultRevision(app), spellcheck: false, id: "revision" });
  const prune = element("input", { type: "checkbox", id: "prune" });
  const dryRun = element("input", { type: "checkbox", id: "dry-run" });
  const confirm = element("button", { type: "button", className: "primary", textContent: t("sync.confirm") });
  const slot = element("div");
  const valid = () => multiSource || revision.value.trim() !== "";
  revision.addEventListener("input", () => (confirm.disabled = !valid()));
  runFrom(confirm, slot, async () => {
    const patch = syncPatch(app, { revision: multiSource ? null : revision.value.trim(), prune: prune.checked, dryRun: dryRun.checked });
    await sextant.resources.patch(patchCall(ref, patch));
    await sextant.ui.notify(t(dryRun.checked ? "sync.dryRunStarted" : "sync.started", { name: ref.name }));
    await sextant.ui.close();
  });
  root.replaceChildren(
    element("h3", { textContent: t("sync.title", { name: ref.name }) }),
    multiSource
      ? element("p", { className: "muted", textContent: t("sync.multiSource") })
      : element(
          "div",
          { className: "field" },
          element("label", { htmlFor: "revision", textContent: t("sync.revision") }),
          revision,
          element("p", { className: "muted hint", textContent: t("sync.revisionHint") }),
        ),
    element("label", { className: "check" }, prune, ` ${t("sync.prune")}`),
    element("label", { className: "check" }, dryRun, ` ${t("sync.dryRun")}`),
    slot,
    buttons(confirm, cancel(sextant)),
  );
  if (!multiSource) revision.focus();
}

/** Refresh or Hard refresh of every selected Application, one after another; the window closes after the last. */
export async function refreshAll(sextant: Sextant, refs: readonly ObjectRef[], kind: RefreshKind): Promise<void> {
  for (const ref of refs) if (isApplication(ref.kind)) await sextant.resources.patch(patchCall(ref, refreshPatch(kind)));
}

async function startRefresh(sextant: Sextant, root: HTMLElement, refs: readonly ObjectRef[], kind: RefreshKind): Promise<void> {
  const note = status();
  note.textContent = t("refresh.running");
  root.replaceChildren(note);
  try {
    await refreshAll(sextant, refs, kind);
    await sextant.ui.close();
  } catch (err) {
    root.replaceChildren(errorBox(err), buttons(button(t("common.close"), () => void sextant.ui.close())));
  }
}

function startTerminate(sextant: Sextant, root: HTMLElement, ref: ObjectRef): void {
  const confirm = element("button", { type: "button", className: "danger", textContent: t("terminate.confirm") });
  const slot = element("div");
  runFrom(confirm, slot, async () => {
    await sextant.resources.patch(patchCall(ref, terminatePatch()));
    await sextant.ui.close();
  });
  root.replaceChildren(
    element("h3", { textContent: t("terminate.title", { name: ref.name }) }),
    element("p", { textContent: t("terminate.text", { name: ref.name }) }),
    slot,
    buttons(confirm, cancel(sextant)),
  );
}

/** Where the UI opens: an Application on its own page, other objects on the list of applications. */
export function uiPath(ref: ObjectRef | undefined): string {
  return ref && isApplication(ref.kind) && ref.namespace
    ? `/applications/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`
    : "/applications";
}

/** A forward of the extension's own to the Service and port that is still running. */
export function runningForward(forwards: readonly ForwardInfo[], clusterId: ClusterId, namespace: string, name: string, port: number): ForwardInfo | undefined {
  return forwards.find(
    (f) =>
      f.cluster === clusterId &&
      f.target.type === "service" &&
      f.target.namespace === namespace &&
      f.target.name === name &&
      f.remotePort === port &&
      f.status.state === "active",
  );
}

/**
 * Opens the Argo CD UI at `path`: the installation's argocd-server Service, a local port forwarded to its UI port
 * (one already running is reused), `https://localhost:<port>` (`http` when the server runs without TLS), opened
 * after the user agrees in Sextant's own dialog.
 */
async function startOpenUi(sextant: Sextant, root: HTMLElement, clusterId: ClusterId, ref: ObjectRef | undefined): Promise<void> {
  const note = status();
  note.textContent = t("openUi.opening");
  root.replaceChildren(note);
  const lookup = await findInstallation(sextant, clusterId);
  if (lookup.type === "none") {
    root.replaceChildren(element("p", { className: "error", textContent: t("diff.errors.notFound") }));
    return;
  }
  if (lookup.type === "several") {
    root.replaceChildren(installationPicker(sextant, clusterId, lookup.namespaces, () => void startOpenUi(sextant, root, clusterId, ref)));
    return;
  }
  const server = await describeServer(sextant, clusterId, lookup.namespace, lookup.server);
  const name = lookup.server.metadata.name;
  const port = uiPort(lookup.server);
  const forward =
    runningForward(await sextant.portForward.list({ clusterId }), clusterId, lookup.namespace, name, port) ??
    (await sextant.portForward.start({ clusterId, namespace: lookup.namespace, kind: "Service", name, port }));
  const url = `${server.insecure ? "http" : "https"}://localhost:${forward.localPort}${uiPath(ref)}`;
  if (await sextant.ui.openUrl(url)) {
    await sextant.ui.close();
    return;
  }
  root.replaceChildren(element("p", { textContent: t("openUi.declined", { url }) }), buttons(button(t("common.close"), () => void sextant.ui.close())));
}

/** The window of the action `contribution` on the selected objects. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const refs = sextant.context.selection;
  const ref = refs[0];
  const clusterId = sextant.context.clusterId;
  const fail = (err: unknown) => root.replaceChildren(errorBox(err), buttons(button(t("common.close"), () => void sextant.ui.close())));
  if (contribution === "open-ui") {
    if (clusterId) startOpenUi(sextant, root, clusterId, ref).catch(fail);
    return () => undefined;
  }
  if (!ref) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingToShow") }));
    return () => undefined;
  }
  switch (contribution) {
    case "sync":
      startSync(sextant, root, ref).catch(fail);
      break;
    case "refresh":
      void startRefresh(sextant, root, refs, "normal");
      break;
    case "hard-refresh":
      void startRefresh(sextant, root, refs, "hard");
      break;
    case "terminate":
      startTerminate(sextant, root, ref);
      break;
    case "diff":
      return startDiff(sextant, root, ref);
    default:
      root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingToShow") }));
  }
  return () => undefined;
}
