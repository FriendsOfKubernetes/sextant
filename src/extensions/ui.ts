// What the window does for a frame's `ui.*` calls (src/extensions/protocol.ts). A malformed call is refused with
// `invalid`, a page that does not exist with `notFound`.
import { ApiError, type ObjectRef } from "../api";
import { useAppStore } from "../app/store";
import { getPage } from "../layout/pages";
import { findResourceDef, parseViewId } from "../resources/registry";
import type { BridgeUi } from "./bridge";
import { pushNotice } from "./notices";
import { contributionKey } from "./protocol";

export interface HostUiOptions {
  extensionId: string;
  /** The extension's name, shown with its notices. */
  extensionName: string;
  /** `ui.close`: closes the frame's window or dock tab; nothing for frames that cannot be closed. */
  close?: () => void;
}

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
      pushNotice(options.extensionName, text);
    },
    close() {
      options.close?.();
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
