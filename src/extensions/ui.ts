// What the window does for a frame's `ui.*` calls (src/extensions/protocol.ts). A malformed call is refused with
// `invalid`, a page that does not exist with `notFound`.
import { api, ApiError, type ClusterId, type ObjectRef, type ServiceContribution } from "../api";
import { useAppStore } from "../app/store";
import { openLogsTab, POD_KIND } from "../features/logs/openLogsTab";
import { openSelectorLogsTab } from "../features/logs/multi/open";
import { askOpenUrl } from "./openUrl";
import { askSignIn } from "./signIn";
import { getPage } from "../layout/pages";
import { findResourceDef, parseViewId } from "../resources/registry";
import type { BridgeUi } from "./bridge";
import { pushNotice } from "./notices";
import { contributionKey } from "./protocol";

export interface HostUiOptions {
  extensionId: string;
  /** The extension's name as it is now (a dev extension can be renamed while its frame runs), shown with its notices. */
  extensionName: () => string;
  /** `ui.close`: closes the frame's window or dock tab; nothing for frames that cannot be closed. */
  close?: () => void;
  /** The cluster of the frame's context; the active cluster when it has none. */
  clusterId?: () => ClusterId | null;
  /** The services the extension's manifest declares (localized), for `ui.signIn`. */
  services?: () => readonly ServiceContribution[];
  /** `ui.setHidden`: hides or shows the frame's details section. */
  setHidden?: (hidden: boolean) => void;
}

/** Longest label selector `ui.openLogs` takes (as a problem rule's source). */
const MAX_SELECTOR_CHARS = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `ui.*` of one frame. */
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
      useAppStore.getState().setView(clusterId, view);
    },
    notify(params) {
      const text = typeof params === "string" ? params : isRecord(params) ? params.text : undefined;
      if (typeof text !== "string" || text.trim() === "") throw new ApiError("invalid", "ui.notify needs {text}");
      pushNotice(options.extensionName(), text);
    },
    close() {
      options.close?.();
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
      const { namespace, pod, container, labelSelector } = params;
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
        openSelectorLogsTab(clusterId, namespace, selector, selector);
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
