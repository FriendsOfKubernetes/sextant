// Contributions of extensions, registered in Sextant's registries from their manifests — no extension code runs for
// this. Every registry id is `ext:<extensionId>:<id>`; each one shows the extension's frame (`ExtensionFrame`) with its
// view: pages and sidebar sections (`page`), details sections and tabs (`details`), actions opening a window
// (`action`; an action that is a fixed patch is sent by Sextant itself, `patchAction.tsx`), dock buttons opening a dock tab (`dock`); table columns are JSONPath, shown without any frame. The
// settings section is drawn by Settings → Extensions (`ExtensionSettingsFrame`).
//
// Only active extensions contribute (enabled, consented, manifest read). `syncExtensions(list)` follows the installed
// list: what is new is registered, what changed is registered again, what is gone (disabled, removed, waiting for
// consent) is removed with everything it showed — an open page of it falls back to the cluster overview, its dock tabs
// and action windows close.
import { useState, type ComponentType } from "react";
import type { ActionContribution, ExtensionInfo, KindContribution, KindPattern, KindRef, KubeObject, ProblemContribution } from "../api";
import { useAppStore } from "../app/store";
import { Dialog, isIconName, type IconName } from "../components";
import { openActionDialog, registerAction, reportActionFailure, type ActionContext } from "../features/actions/registry";
import { registerClusterMenuItem } from "../features/clusters/menuItems";
import { categoryOfExtension, detectExtension, registerExtensionProblems } from "../features/problems/extensionCategories";
import { NamespaceFilter } from "../features/namespaces";
import { useExtensionSectionCount } from "../features/problems/hooks";
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
import { getSectionBadge, registerSectionBadge } from "../layout/sectionBadges";
import { evalJsonPath, formatJsonPathValues } from "../resources/jsonpath";
import { DEFAULT_ENTRY_ICON, extendActions, extendColumns, placeKind, placeSection, SIDEBAR_SECTIONS } from "../resources/registry";
import { computedColumn, placement } from "./columns";
import {
  registerClusterSettingsSection,
  registerClusterSettingsTab,
  unregisterClusterSettingsSection,
  unregisterClusterSettingsTab,
} from "../features/clusters/settingsRegistry";
import { ExtensionClusterSettingsFrame, ExtensionFrame } from "./ExtensionFrame";
import { evaluate, kindKeyOf } from "./problemRules";
import { endHeadlessActionsOf, startHeadlessAction } from "./headless";
import { runPatchAction } from "./patchAction";
import { matchesSelector } from "./selector";
import { contributionKey, VIEW } from "./protocol";

/** Default position of an extension's details section: after Sextant's conditions (30), before YAML (90). */
const DETAILS_ORDER = 50;
/** Extension tabs in a cluster's settings come after Sextant's own, before "More". */
const CLUSTER_SETTINGS_ORDER = 500;
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
  endHeadlessActionsOf(extensionId);
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

  // Counters on the extension's own sections (ADR-0143): the problems of its own rules, counted by the window. Never on
  // a section of Sextant's, nor on one another extension already counts.
  for (const badge of contributes.sectionBadges) {
    if ((SIDEBAR_SECTIONS as readonly string[]).includes(badge.section) || getSectionBadge(badge.section)) continue;
    const category = categoryOfExtension(extensionId);
    const rules = badge.rules;
    removers.push(
      registerSectionBadge(badge.section, (clusterId) => useExtensionSectionCount(clusterId, category, rules), {
        tone: "danger",
        labelKey: "extensions:host.sectionBadge",
      }),
    );
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

  // Kinds listed in a section of the extension's own (ADR-0152): Sextant's table there, "Only problems" from its rules.
  const listed: readonly KindContribution[] = contributes.kinds;
  for (const entry of listed) {
    removers.push(
      placeKind(entry, {
        owner: extensionId,
        section: entry.section,
        sectionTitle: entry.sectionTitle,
        label: entry.title,
        icon: entry.icon === undefined ? undefined : iconOf(entry.icon, extensionIcon),
        order: entry.order ?? 0,
        // The kind's own "Only problems" (#396), else its rules'.
        problem:
          entry.problemWhen !== undefined
            ? ((when) => (obj: KubeObject) => holdsNow(when, obj))(entry.problemWhen)
            : problemOf(extensionId, entry, contributes.problems),
        aliases: entry.aliases ?? [],
        searchByDefault: entry.searchByDefault,
        printerColumns: entry.printerColumns,
      }),
    );
  }

  // The extension's own sections: header, icon, place (ADR-0160).
  for (const section of contributes.sections) {
    removers.push(
      placeSection(section.section, {
        owner: extensionId,
        title: section.title,
        icon: section.icon === undefined ? undefined : iconOf(section.icon, extensionIcon),
        after: section.after,
      }),
    );
  }

  for (const action of contributes.actions) {
    const id = contributionKey(extensionId, action.id);
    const when = action.when;
    removers.push(
      registerAction(id, {
        // Shown as written: never through i18next, so `{{…}}` or `$t(…)` in a title stay text.
        label: action.title,
        icon: iconOf(action.icon, extensionIcon),
        // In the details panel's "Actions" dropdown (#275), unless it asks for a button on a kind of its own section
        // (ADR-0154): `registerAction` and `placementOf` enforce it.
        placement: "more",
        primaryOn: action.placement === "primary" ? (kind) => matches(listed, kind) : undefined,
        danger: action.danger,
        multiple: action.multiple,
        appliesTo: (obj, kind) => matches(action.kinds, kind) && (when === undefined || holdsNow(when, obj)),
        notApplicableReason:
          when === undefined
            ? undefined
            : (obj, kind) => (matches(action.kinds, kind) && !holdsNow(when, obj) ? action.whyNot : undefined),
        // A fixed patch is sent by Sextant without the extension's window (#367).
        // An action without a window runs its frame out of sight (#379).
        run: (ctx) =>
          action.patch !== undefined
            ? runPatchAction(extensionId, action, ctx)
            : action.headless === true
              ? startHeadlessAction({
                  extensionId,
                  extension: info.name,
                  contribution: action.id,
                  title: action.title,
                  clusterId: ctx.clusterId,
                  refs: ctx.refs,
                })
              : openActionWindow(extensionId, action.id, action.title, ctx),
      }),
    );
    for (const kind of action.kinds) removers.push(extendActions(kind, [id]));
  }

  // A column placed after one of the extension's own columns names it by its manifest id (ADR-0161).
  const ownColumn = (id: string) => (contributes.columns.some((c) => c.id === id) ? contributionKey(extensionId, id) : undefined);
  for (const column of contributes.columns) {
    // Computed from field paths (ADR-0153), or the JSONPath of CRD printer columns.
    if (column.paths !== undefined || column.jsonPath === undefined) {
      removers.push(extendColumns(column.kind, [computedColumn(contributionKey(extensionId, column.id), column, ownColumn)]));
      continue;
    }
    const jsonPath = column.jsonPath;
    const values = (obj: KubeObject) => evalJsonPath(obj, jsonPath);
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
          ...placement(column, ownColumn),
          fallback: "end",
        },
      ]),
    );
  }

  // Items of a cluster's context menu (ADR-0157): the extension's window with that cluster in its context.
  for (const item of contributes.menuItems) {
    removers.push(
      registerClusterMenuItem({
        id: contributionKey(extensionId, item.id),
        label: item.title,
        icon: item.icon === undefined ? undefined : iconOf(item.icon, extensionIcon),
        run: (clusterId) =>
          openActionWindow(extensionId, item.id, item.title, { clusterId, refs: [], openDialog: openActionDialog }),
      }),
    );
  }

  // A tab in a cluster's settings (ADR-0160): the frame with that cluster in its context.
  if (contributes.clusterSettings) {
    const id = contributionKey(extensionId, "cluster-settings");
    registerClusterSettingsTab({ id, order: CLUSTER_SETTINGS_ORDER, labelKey: "", label: contributes.clusterSettings.title });
    registerClusterSettingsSection({
      id,
      order: 0,
      tab: id,
      Component: ({ clusterId }) => <ExtensionClusterSettingsFrame extensionId={extensionId} clusterId={clusterId} />,
    });
    removers.push(() => {
      unregisterClusterSettingsSection(id);
      unregisterClusterSettingsTab(id);
    });
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

/** Whether a condition of an action holds for `obj` now (one that holds from or until a time counts within it). */
function holdsNow(condition: NonNullable<ActionContribution["when"]>, obj: KubeObject): boolean {
  const verdict = evaluate(condition, obj);
  const now = Date.now();
  return (
    verdict.holds && (verdict.activeFrom === undefined || verdict.activeFrom <= now) && (verdict.until === undefined || verdict.until > now)
  );
}

/**
 * A listed kind's "Only problems": an object has a problem of the extension's rules for the kind now (grace not
 * counted), and is one its rules' source picks.
 */
function problemOf(
  extensionId: string,
  kind: Pick<KindRef, "group" | "kind">,
  rules: readonly ProblemContribution[],
): ((obj: KubeObject) => boolean) | undefined {
  const own = rules.filter((rule) => kindKeyOf(rule.kind) === kindKeyOf(kind));
  if (own.length === 0) return undefined;
  const selector = own[0]!.source?.labelSelector;
  const category = categoryOfExtension(extensionId);
  return (obj) => {
    if (selector !== undefined && !matchesSelector(obj.metadata?.labels as Record<string, string> | undefined, selector)) {
      return false;
    }
    const now = Date.now();
    return detectExtension(category, kind, obj).some(
      (d) => (d.activeFrom === undefined || d.activeFrom <= now) && (d.until === undefined || d.until > now),
    );
  };
}

function pageComponent(extensionId: string, contribution: string, title: string): ComponentType<PageProps> {
  // A page is told the namespace filter (`HostContext.namespaces`), so the filter is shown above it: otherwise a choice
  // made in a table would narrow the page with no way to change it there.
  return function ExtensionPage({ clusterId }: PageProps) {
    return (
      <div className="ext-page">
        <div className="ext-page__toolbar">
          <NamespaceFilter clusterId={clusterId} />
        </div>
        <ExtensionFrame
          extensionId={extensionId}
          view={VIEW.page}
          contribution={contribution}
          title={title}
          clusterId={clusterId}
          className="ext-frame--page"
        />
      </div>
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
    // `ui.setHidden` (ADR-0161): a section with nothing to show hides, title included; the frame keeps running.
    const [hidden, setHidden] = useState(false);
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
        onHidden={tab ? undefined : setHidden}
      />
    );
    if (tab) return frame;
    return (
      <div className="ext-section" hidden={hidden}>
        <h3 className="ext-section__title">{title}</h3>
        {frame}
      </div>
    );
  };
}

function openActionWindow(
  extensionId: string,
  contribution: string,
  title: string,
  ctx: Pick<ActionContext, "clusterId" | "refs" | "openDialog">,
): void {
  const windows = openWindows.get(extensionId) ?? new Set<() => void>();
  openWindows.set(extensionId, windows);
  let tracked = () => {};
  const close = ctx.openDialog((done) => {
    const finish = () => {
      windows.delete(tracked);
      done();
    };
    return (
      <Dialog open title={title} onClose={finish}>
        <ExtensionFrame
          extensionId={extensionId}
          view={VIEW.action}
          contribution={contribution}
          title={title}
          clusterId={ctx.clusterId}
          selection={ctx.refs}
          onClose={(failed) => {
            finish();
            if (failed !== undefined) reportActionFailure(title, failed);
          }}
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
