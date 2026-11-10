// What the window does for a frame's `ui.*` calls (src/extensions/protocol.ts). A malformed call is refused with
// `invalid`, a page that does not exist with `notFound`.
import { api, ApiError, type ClusterId, type ObjectRef, type ServiceContribution } from "../api";
import { useAppStore } from "../app/store";
import { openLogsTab, POD_KIND } from "../features/logs/openLogsTab";
import { openSelectorLogsTab } from "../features/logs/multi/open";
import { askOpenCluster } from "./openCluster";
import { askOpenUrl } from "./openUrl";
import { askSignIn } from "./signIn";
import { COLUMN_WIDTH_ID, saveExtensionColumnWidth } from "./columnWidths";
import { getPage } from "../layout/pages";
import { findResourceDef, parseViewId } from "../resources/registry";
import type { BridgeUi } from "./bridge";
import { pushNotice } from "./notices";
import { contributionKey } from "./protocol";

export interface HostUiOptions {
  extensionId: string;
  /** The extension's name as it is now (a dev extension can be renamed while its frame runs), shown with its notices. */
  extensionName: () => string;
  /**
   * `ui.close`: closes the frame's window or dock tab; nothing for frames that cannot be closed. `failed`: the action
   * failed, and Sextant shows its own failure dialog with this text (#400).
   */
  close?: (failed?: string) => void;
  /** The cluster of the frame's context; the active cluster when it has none. */
  clusterId?: () => ClusterId | null;
  /** The services the extension's manifest declares (localized), for `ui.signIn`. */
  services?: () => readonly ServiceContribution[];
  /** `ui.setHidden`: hides or shows the frame's details section. */
  setHidden?: (hidden: boolean) => void;
  /** `ui.setBlockOpen`: keeps a block's choice in Sextant's memory of details sections (#416); details frames only. */
  setBlockOpen?: (block: string, open: boolean) => void;
  /** The frame's element while it shows a details section (`ui.revealSection`); `null` in any other view. */
  detailsFrame?: () => HTMLElement | null;
}

/** Longest label selector `ui.openLogs` takes (as a problem rule's source). */
const MAX_SELECTOR_CHARS = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `ui.*` of one frame. */
/** A failure an action's frame tells with `ui.close({failed})` keeps at most this many characters. */
export const MAX_FAILED_CHARS = 1000;

export function hostUi(options: HostUiOptions): BridgeUi {
  return {
    openDetails(params) {
      const ref = objectRef(params);
      if (!useAppStore.getState().activeClusterId) throw new ApiError("invalid", "no cluster is open");
      useAppStore.getState().openDetails(ref);
    },
    navigate(params) {
      const page = typeof params === "string" ? params : isRecord(params) ? params.page : undefined;
      if (typeof page !== "string" || page === "") throw new ApiError("invalid", "ui.navigate needs {page}");
      const clusterId = useAppStore.getState().activeClusterId;
      if (!clusterId) throw new ApiError("invalid", "no cluster is open");
      // The extension's own page first, then a page or a table view of Sextant — never another extension's page.
      const own = contributionKey(options.extensionId, page);
      const sextantPage = !page.startsWith("ext:") && (getPage(page) !== undefined || parseViewId(page) !== null);
      const view = getPage(own) ? own : sextantPage ? page : null;
      if (!view) throw new ApiError("notFound", `no page ${page}`);
      // `closeDetails: true` (since Sextant 0.30): the page takes the place of the details panel, as Sextant's own
      // "Check a request…" does.
      if (isRecord(params) && params.closeDetails === true) useAppStore.getState().closeDetails();
      useAppStore.getState().setView(clusterId, view);
    },
    notify(params) {
      const text = typeof params === "string" ? params : isRecord(params) ? params.text : undefined;
      if (typeof text !== "string" || text.trim() === "") throw new ApiError("invalid", "ui.notify needs {text}");
      pushNotice(options.extensionName(), text);
    },
    close(params) {
      const failed = isRecord(params) && typeof params.failed === "string" ? params.failed.trim() : "";
      // Text of the extension's: clipped, shown as plain text in Sextant's failure dialog.
      options.close?.(failed === "" ? undefined : Array.from(failed).slice(0, MAX_FAILED_CHARS).join(""));
    },
    setHidden(params) {
      const hidden = typeof params === "boolean" ? params : isRecord(params) ? params.hidden : undefined;
      if (typeof hidden !== "boolean") throw new ApiError("invalid", "ui.setHidden needs {hidden: true|false}");
      options.setHidden?.(hidden);
    },
    async openLogs(params) {
      const bad = () =>
        new ApiError("invalid", "ui.openLogs needs {namespace, pod, container?} or {namespace, labelSelector}");
      if (!isRecord(params)) throw bad();
      const { namespace, pod, container, labelSelector, title } = params;
      // A merged tab's title (#407): `raycluster/<name>` instead of the selector; shown as written, clipped.
      if (title !== undefined && (typeof title !== "string" || title.trim() === "" || Array.from(title).some((c) => c < " " || c === "\u007f"))) {
        throw bad();
      }
      const tabTitle = typeof title === "string" ? Array.from(title.trim()).slice(0, 80).join("") : undefined;
      if (typeof namespace !== "string" || namespace === "") throw bad();
      const named = typeof pod === "string" && pod !== "";
      const selected = typeof labelSelector === "string" && labelSelector.trim() !== "";
      if (named === selected) throw bad();
      if (selected && (labelSelector as string).length > MAX_SELECTOR_CHARS) throw bad();
      if (container !== undefined && (typeof container !== "string" || container === "")) throw bad();
      const clusterId = options.clusterId?.() ?? useAppStore.getState().activeClusterId;
      if (!clusterId) throw new ApiError("invalid", "no cluster is open");
      // Rust decides and journals it as the extension's; the tab then reads as the user's own does.
      await api.extensions.call(options.extensionId, "logs.open", {
        clusterId,
        namespace,
        ...(named ? { pod } : { labelSelector: (labelSelector as string).trim() }),
        ...(typeof container === "string" ? { container } : {}),
      });
      if (selected) {
        const selector = (labelSelector as string).trim();
        openSelectorLogsTab(clusterId, namespace, selector, tabTitle ?? selector);
        return;
      }
      const object = await api.resources.get(clusterId, { kind: POD_KIND, namespace, name: pod as string });
      openLogsTab(clusterId, object, typeof container === "string" ? container : undefined);
    },
    async signIn(params) {
      const bad = () => new ApiError("invalid", "ui.signIn needs {namespace, service, clusterId?}");
      if (!isRecord(params)) throw bad();
      const { namespace, service } = params;
      if (typeof namespace !== "string" || namespace === "" || typeof service !== "string") throw bad();
      const clusterId =
        (typeof params.clusterId === "string" && params.clusterId) || options.clusterId?.() || useAppStore.getState().activeClusterId;
      if (!clusterId) throw new ApiError("invalid", "no cluster is open");
      const declared = options.services?.().find((s) => s.id === service);
      if (!declared) throw new ApiError("notFound", `no service ${service} the user agreed to`);
      const signedIn = await askSignIn({
        extensionId: options.extensionId,
        extensionName: options.extensionName(),
        clusterId,
        namespace,
        service: declared,
      });
      return { signedIn };
    },
    async openUrl(params) {
      const url = typeof params === "string" ? params : isRecord(params) ? params.url : undefined;
      return { opened: await askOpenUrl(options.extensionId, options.extensionName(), url) };
    },
    openCluster(params) {
      return askOpenCluster(options.extensionId, options.extensionName(), params);
    },
    revealSection(params) {
      // A section of the same details panel (since Sextant 0.30): one of Sextant's by its id, or the extension's own by
      // its manifest id; opened if collapsed, scrolled to and focused, as Sextant's own "Show request metrics".
      const id = isRecord(params) ? params.id : undefined;
      if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
        throw new ApiError("invalid", "ui.revealSection needs {id}: a details section id of letters, digits, `-`, `_` and `.`");
      }
      const frame = options.detailsFrame?.() ?? null;
      if (!frame) throw new ApiError("invalid", "ui.revealSection is for a details section's frame");
      const panel = frame.closest(".details");
      const own = contributionKey(options.extensionId, id);
      const find = (key: string) => panel?.querySelector<HTMLElement>(`[data-section="${CSS.escape(key)}"]`) ?? null;
      const section = find(own) ?? find(id);
      if (!section) throw new ApiError("notFound", `no details section ${id} is shown`);
      // The heading's button first (a selector list would give the `h3` around it, which is first in the document).
      const heading = section.querySelector<HTMLElement>("h3 button") ?? section.querySelector<HTMLElement>("h3");
      if (heading?.getAttribute("aria-expanded") === "false") heading.click();
      section.scrollIntoView?.({ block: "start", behavior: "smooth" });
      heading?.focus();
    },
    setColumnWidth(params) {
      const bad = () =>
        new ApiError("invalid", "ui.setColumnWidth needs {table, column, width}: ids of letters, digits, `-`, `_` and `.`, and a width in pixels or null");
      if (!isRecord(params) || typeof params.table !== "string" || typeof params.column !== "string") throw bad();
      if (!COLUMN_WIDTH_ID.test(params.table) || !COLUMN_WIDTH_ID.test(params.column)) throw bad();
      const width = params.width;
      if (width !== null && (typeof width !== "number" || !Number.isFinite(width))) throw bad();
      saveExtensionColumnWidth(options.extensionId, params.table, params.column, width);
    },
    setBlockOpen(params) {
      const bad = () => new ApiError("invalid", "ui.setBlockOpen needs {id, open}: a block id of letters, digits, `-`, `_` and `.`");
      if (!isRecord(params) || typeof params.open !== "boolean" || typeof params.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(params.id)) throw bad();
      if (!options.setBlockOpen) throw new ApiError("invalid", "ui.setBlockOpen is for a details section's frame");
      options.setBlockOpen(params.id, params.open);
    },
  };
}

/** A checked `ObjectRef`; a missing version is taken from Sextant's description of the kind. */
function objectRef(value: unknown): ObjectRef {
  const bad = () => new ApiError("invalid", "ui.openDetails needs {kind: {group, version, kind}, namespace, name}");
  if (!isRecord(value) || !isRecord(value.kind)) throw bad();
  const { group = "", version, kind } = value.kind;
  const { namespace = null, name } = value;
  if (typeof group !== "string" || typeof kind !== "string" || kind === "") throw bad();
  if (typeof name !== "string" || name === "") throw bad();
  if (namespace !== null && typeof namespace !== "string") throw bad();
  const known = typeof version === "string" && version !== "" ? version : findResourceDef({ group, kind })?.kind.version;
  if (!known) throw new ApiError("invalid", `ui.openDetails needs the version of ${kind}`);
  return { kind: { group, version: known, kind }, namespace: namespace || null, name };
}
