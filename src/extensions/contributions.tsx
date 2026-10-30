// Contributions of extensions, registered in Sextant's registries from their manifests — no extension code runs for
// this. Every registry id is `ext:<extensionId>:<id>`; each one shows the extension's frame (`ExtensionFrame`) with its
// view: pages and sidebar sections (`page`), details sections and tabs (`details`), actions opening a window
// (`action`), dock buttons opening a dock tab (`dock`); table columns are JSONPath, shown without any frame. The
// settings section is drawn by Settings → Extensions (`ExtensionSettingsFrame`).
//
// Only active extensions contribute (enabled, consented, manifest read). `syncExtensions(list)` follows the installed
// list: what is new is registered, what changed is registered again, what is gone (disabled, removed, waiting for
// consent) is removed with everything it showed — an open page of it falls back to the cluster overview, its dock tabs
// and action windows close.
import type { ComponentType } from "react";
import type { ActionContribution, ExtensionInfo, KindPattern, KindRef, KubeObject } from "../api";
import { useAppStore } from "../app/store";
import { Dialog, isIconName, type IconName } from "../components";
import { registerAction, type ActionContext } from "../features/actions/registry";
import { registerExtensionProblems } from "../features/problems/extensionCategories";
import { registerDetailsSection, unregisterDetailsSection, type DetailsSectionProps } from "../layout/details/registry";
import {
  getDockTabComponent,
  registerDockAction,
  registerDockTab,
  unregisterDockAction,
  unregisterDockTab,
  type DockTabProps,
} from "../layout/dock/registry";
import { getPage, registerPage, unregisterPage, type PageProps } from "../layout/pages";
import { evalJsonPath, formatJsonPathValues } from "../resources/jsonpath";
import { DEFAULT_ENTRY_ICON, extendActions, extendColumns } from "../resources/registry";
import { ExtensionFrame } from "./ExtensionFrame";
import { contributionKey, VIEW } from "./protocol";

/** Default position of an extension's details section: after Sextant's conditions (30), before YAML (90). */
const DETAILS_ORDER = 50;
/** Extension dock buttons come after Sextant's own. */
const DOCK_ORDER = 100;

interface Registration {
  /** What the registration was made from; a different one is registered again. */
  signature: string;
  removers: (() => void)[];
}

const registrations = new Map<string, Registration>();
/** Windows opened by an extension's actions, closed when the extension goes. */
const openWindows = new Map<string, Set<() => void>>();

/** Registers everything an active extension contributes, replacing an earlier registration of it. */
export function registerExtension(info: ExtensionInfo): void {
  removeRegistration(info.id);
  if (!isActive(info)) return;
  registrations.set(info.id, { signature: signatureOf(info), removers: contribute(info) });
}

/** Removes everything the extension contributed and whatever of it is open. */
export function unregisterExtension(extensionId: string): void {
  removeRegistration(extensionId);
  closeOrphans();
}

/** Makes the registries match the installed extensions (only the active ones contribute). */
export function syncExtensions(list: readonly ExtensionInfo[]): void {
  const active = new Map(list.filter(isActive).map((info) => [info.id, info]));
  for (const [id, registration] of [...registrations]) {
    const next = active.get(id);
    if (!next || signatureOf(next) !== registration.signature) removeRegistration(id);
  }
  for (const info of active.values()) {
    if (!registrations.has(info.id)) registrations.set(info.id, { signature: signatureOf(info), removers: contribute(info) });
  }
  closeOrphans();
}

/** Ids of the extensions whose contributions are registered. */
export function registeredExtensions(): string[] {
  return [...registrations.keys()];
}

function isActive(info: ExtensionInfo): info is ExtensionInfo & { entryUrl: string } {
  return info.state === "active" && info.manifest !== null && !!info.entryUrl;
}

function signatureOf(info: ExtensionInfo): string {
  // A new consent (permissions, the kinds its problem rules judge) comes with a new install time: where its rules run
  // is asked again.
  return JSON.stringify([info.name, info.entryUrl, info.manifest?.icon, info.manifest?.contributes, info.granted, info.installedAt]);
}

function removeRegistration(extensionId: string): void {
  const registration = registrations.get(extensionId);
  registrations.delete(extensionId);
  for (const remove of registration?.removers ?? []) remove();
  const windows = openWindows.get(extensionId);
  openWindows.delete(extensionId);
  for (const close of windows ?? []) close();
}

/** An open page, dock tab of a contribution that is gone. */
function closeOrphans(): void {
  const state = useAppStore.getState();
  for (const [clusterId, view] of Object.entries(state.clusterViews)) {
    if (view.view?.startsWith("ext:") && !getPage(view.view)) state.setView(clusterId, null);
  }
  for (const tab of state.dock.tabs) {
    if (tab.type.startsWith("ext:") && !getDockTabComponent(tab.type)) useAppStore.getState().closeDockTab(tab.id);
  }
}

/** An icon of Sextant's set; an unknown name gets the default one. */
function iconOf(name: string | undefined, fallback: IconName = DEFAULT_ENTRY_ICON): IconName {
  return name !== undefined && isIconName(name) ? name : fallback;
}

function matches(kinds: readonly KindPattern[], kind: Pick<KindRef, "group" | "kind">): boolean {
  return kinds.some(
    (k) => k.group.toLowerCase() === kind.group.toLowerCase() && k.kind.toLowerCase() === kind.kind.toLowerCase(),
  );
}

function contribute(info: ExtensionInfo & { entryUrl: string }): (() => void)[] {
  const extensionId = info.id;
  const contributes = info.manifest!.contributes;
  const removers: (() => void)[] = [];
  const extensionIcon = iconOf(info.manifest!.icon);

  // Problem rules: evaluated by the problems store, never by extension code (ADR-0137); where they run is decided in
  // Rust for the kinds the user agreed to.
  if (contributes.problems.length > 0) {
    removers.push(registerExtensionProblems(extensionId, info.name, contributes.problems));
  }

  for (const page of contributes.pages) {
    const id = contributionKey(extensionId, page.id);
    registerPage({
      id,
      section: page.section,
      sectionTitle: page.sectionTitle,
      order: page.order ?? 0,
      label: page.title,
      icon: iconOf(page.icon, extensionIcon),
      Component: pageComponent(extensionId, page.id, page.title),
    });
    removers.push(() => unregisterPage(id));
  }

  for (const section of contributes.detailsSections) {
    const id = contributionKey(extensionId, section.id);
    registerDetailsSection({
      id,
      order: section.order ?? DETAILS_ORDER,
      placement: section.placement,
      label: section.title,
      appliesTo: (kind) => matches(section.kinds, kind),
      Component: detailsComponent(extensionId, section.id, section.title, section.placement === "tab"),
    });
    removers.push(() => unregisterDetailsSection(id));
  }

  for (const action of contributes.actions) {
    const id = contributionKey(extensionId, action.id);
    removers.push(
      registerAction(id, {
        // Shown as written: never through i18next, so `{{…}}` or `$t(…)` in a title stay text.
        label: action.title,
        icon: iconOf(action.icon, extensionIcon),
        // Always in the details panel's "Actions" dropdown (#275); `registerAction` enforces it too.
        placement: "more",
        danger: action.danger,
        multiple: action.multiple,
        appliesTo: (_obj, kind) => matches(action.kinds, kind),
        run: (ctx) => openActionWindow(extensionId, action, ctx),
      }),
    );
    for (const kind of action.kinds) removers.push(extendActions(kind, [id]));
  }

  for (const column of contributes.columns) {
    const values = (obj: KubeObject) => evalJsonPath(obj, column.jsonPath);
    removers.push(
      extendColumns(column.kind, [
        {
          id: contributionKey(extensionId, column.id),
          title: column.title,
          value: (obj) => {
            const found = values(obj);
            if (found.length === 0) return undefined;
            return found.length === 1 && typeof found[0] === "number" ? found[0] : formatJsonPathValues(found);
          },
          afterTitle: column.after,
          fallback: "end",
        },
      ]),
    );
  }

  contributes.dockActions.forEach((dock, index) => {
    const type = contributionKey(extensionId, dock.id);
    registerDockTab(type, DockTabFrame);
    registerDockAction({
      id: type,
      order: DOCK_ORDER + index,
      label: dock.title,
      // Without an icon the button shows its title.
      icon: dock.icon === undefined ? undefined : iconOf(dock.icon, extensionIcon),
      run: () =>
        useAppStore.getState().openDockTab({
          id: type,
          type,
          title: dock.title,
          payload: { extensionId, contribution: dock.id, title: dock.title } satisfies DockPayload,
        }),
    });
    removers.push(() => {
      unregisterDockAction(type);
      unregisterDockTab(type);
    });
  });

  return removers;
}

function pageComponent(extensionId: string, contribution: string, title: string): ComponentType<PageProps> {
  return function ExtensionPage({ clusterId }: PageProps) {
    return (
      <ExtensionFrame
        extensionId={extensionId}
        view={VIEW.page}
        contribution={contribution}
        title={title}
        clusterId={clusterId}
        className="ext-frame--page"
      />
    );
  };
}

function detailsComponent(
  extensionId: string,
  contribution: string,
  title: string,
  tab: boolean,
): ComponentType<DetailsSectionProps> {
  return function ExtensionDetails({ clusterId, objectRef, obj }: DetailsSectionProps) {
    const frame = (
      <ExtensionFrame
        extensionId={extensionId}
        view={VIEW.details}
        contribution={contribution}
        title={title}
        clusterId={clusterId}
        selection={[objectRef]}
        resourceVersion={typeof obj?.metadata?.resourceVersion === "string" ? obj.metadata.resourceVersion : null}
        autoHeight={!tab}
        className={tab ? "ext-frame--tab" : "ext-frame--section"}
      />
    );
    if (tab) return frame;
    return (
      <div className="ext-section">
        <h3 className="ext-section__title">{title}</h3>
        {frame}
      </div>
    );
  };
}

function openActionWindow(extensionId: string, action: ActionContribution, ctx: ActionContext): void {
  const windows = openWindows.get(extensionId) ?? new Set<() => void>();
  openWindows.set(extensionId, windows);
  let tracked = () => {};
  const close = ctx.openDialog((done) => {
    const finish = () => {
      windows.delete(tracked);
      done();
    };
    return (
      <Dialog open title={action.title} onClose={finish}>
        <ExtensionFrame
          extensionId={extensionId}
          view={VIEW.action}
          contribution={action.id}
          title={action.title}
          clusterId={ctx.clusterId}
          selection={ctx.refs}
          onClose={finish}
          className="ext-frame--action"
        />
      </Dialog>
    );
  });
  tracked = () => {
    windows.delete(tracked);
    close();
  };
  windows.add(tracked);
}

interface DockPayload {
  extensionId: string;
  contribution: string;
  title: string;
}

function DockTabFrame({ tab }: DockTabProps) {
  const clusterId = useAppStore((s) => s.activeClusterId);
  const payload = tab.payload as DockPayload;
  return (
    <ExtensionFrame
      extensionId={payload.extensionId}
      view={VIEW.dock}
      contribution={payload.contribution}
      title={payload.title}
      clusterId={clusterId}
      onClose={() => useAppStore.getState().closeDockTab(tab.id)}
      className="ext-frame--dock"
    />
  );
}
