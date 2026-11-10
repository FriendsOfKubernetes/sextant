// The details section `cnpg` of CloudNativePG objects, as Sextant's former built-in section drew it:
//   Cluster         — its state in words, ready instances, the current primary and a primary change in progress
//                     (switchover or failover), the instances with their roles and health from the status, backups
//                     (last successful and failed, the recoverability point) and continuous archiving;
//   Backup          — phase, Cluster, method, times and the error;
//   ScheduledBackup — schedule, Cluster, whether suspended, last and next run;
//   Pooler          — Cluster, type, instances and pool mode.
// Conditions and YAML are Sextant's own sections. Read-only. The frame reads the shown object again whenever its
// resourceVersion changes. Its blocks open and close as the built-in section's did, kept in Sextant's own memory of
// details sections (`context.blocks`, `ui.setBlockOpen`) with the panel's "Expand all" and "Collapse all".
import { ui, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { dateTime, element, errorText } from "./dom";
import { t } from "./i18n";
import {
  archivingOf,
  BACKUP_TONE,
  backupMethodOf,
  backupState,
  CLUSTER_TONE,
  clusterInfo,
  clusterNameOf,
  CNPG_GROUP,
  CNPG_KINDS,
  CNPG_VERSION,
  get,
  lastBackupOf,
  num,
  str,
  type CnpgKind,
  type Condition,
} from "./model";

const POD = { group: "", version: "v1", kind: "Pod" };
const CLUSTER = { group: CNPG_GROUP, version: CNPG_VERSION, kind: "Cluster" };

/** A link to an object's details in Sextant's panel; nothing without a name. */
function link(sextant: Sextant, kind: ObjectRef["kind"], name: string | undefined, namespace: string | null): HTMLElement | null {
  return name ? ui.objectLink(sextant, { kind, namespace, name }) : null;
}

/** A note on a primary change, an unhealthy cluster or a failing backup. */
const note = (text: string, tone: "warning" | "danger") => element("p", { className: `cnpg-note cnpg-note--${tone}`, textContent: text });
const muted = (text: string) => element("p", { className: "cnpg-muted", textContent: text });

/** `ui.fields`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows);
  return list.childElementCount > 0 ? list : null;
}

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => !!n);

/**
 * Which blocks are open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`, written
 * by `ui.setBlockOpen`), kept per kind as Settings → Appearance says, with the panel's "Expand all" and "Collapse
 * all" — where the built-in section's blocks were kept.
 */
export interface BlockMemory {
  isOpen(block: string): boolean;
  setOpen(block: string, open: boolean): void;
}

/** Blocks that are all open and remember nothing. */
export const OPEN_BLOCKS: BlockMemory = { isOpen: () => true, setOpen: () => undefined };

/** The blocks' memory of the frame's context; every block open by default, as the built-in's were. */
export function sextantBlocks(sextant: Sextant): BlockMemory {
  return {
    isOpen: (block) => ui.blockOpen(sextant.context.blocks, block, true),
    setOpen: (block, open) => void sextant.ui.setBlockOpen(block, open).catch(() => undefined),
  };
}

/** A block that opens and closes with its title, as Sextant's memory says. */
function block(memory: BlockMemory, id: string, title: string, content: UiContent): HTMLElement {
  return ui.block(title, content, {
    collapsible: true,
    collapsed: !memory.isOpen(id),
    onToggle: (open) => memory.setOpen(id, open),
  });
}

/** A condition as working (True), failing (False) or unknown, in the given words. */
function conditionText(c: Condition | undefined, ok: string, bad: string, unknown: string): HTMLElement | null {
  if (!c) return null;
  if (c.status === "True") return ui.status(ok, "success");
  if (c.status === "False") return ui.status(bad, "danger");
  return ui.status(unknown, "warning");
}

/** A Cluster's state in words, the operator's phase and its reason on hover. */
export function clusterStateText(obj: KubeObject): HTMLElement {
  const info = clusterInfo(obj);
  const word = ui.status(t(`state.${info.state}`), CLUSTER_TONE[info.state]);
  const title = [info.phase, info.phaseReason].filter(Boolean).join(": ");
  if (title) word.title = title;
  return word;
}

/** A Backup's state in words, its error on hover. */
export function backupStateText(obj: KubeObject): HTMLElement {
  const state = backupState(obj);
  const word = ui.status(t(`backupState.${state}`), BACKUP_TONE[state]);
  const error = str(get(obj, "status", "error"));
  if (error) word.title = error;
  return word;
}

export function clusterView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const info = clusterInfo(obj);
  const archiving = archivingOf(obj);
  const lastBackup = lastBackupOf(obj);
  let change: string | undefined;
  if (info.state === "failover") change = t("failover", { primary: info.currentPrimary ?? "" });
  else if (info.changingPrimary) change = t("switchover", { from: info.currentPrimary ?? "", to: info.targetPrimary ?? "" });
  const members = info.members.map((m) => [
    link(sextant, POD, m.name, ns),
    t(`role.${m.role}`),
    m.health ? ui.status(m.health, m.health === "healthy" ? "success" : m.health === "failed" ? "danger" : "warning") : "",
    m.timeline === undefined ? "" : String(m.timeline),
  ]);
  const failing = [archiving, lastBackup].filter((c) => c?.status === "False" && c.message).map((c) => c!.message!);
  const backups = present([
    fieldsOf([
      [t("fields.archiving"), conditionText(archiving, t("archivingOk"), t("archivingFailing"), t("unknown"))],
      [t("fields.lastBackup"), conditionText(lastBackup, t("backupOk"), t("backupFailing"), t("unknown"))],
      [t("fields.lastSuccessfulBackup"), dateTime(info.lastSuccessfulBackup)],
      [t("fields.lastFailedBackup"), dateTime(info.lastFailedBackup)],
      [t("fields.firstRecoverabilityPoint"), dateTime(info.firstRecoverabilityPoint)],
    ]),
    !archiving && !lastBackup && !info.lastSuccessfulBackup && muted(t("noBackups")),
    ...failing.map((m) => note(m, "danger")),
  ]);
  return present([
    change ? note(change, info.state === "failover" ? "danger" : "warning") : null,
    info.state === "unhealthy" && info.phaseReason ? note(info.phaseReason, "danger") : null,
    (info.state === "hibernated" || info.state === "hibernating") && muted(t(`hibernation.${info.state}`)),
    info.replicaCluster && muted(t("replicaCluster")),
    fieldsOf([
      [t("fields.status"), clusterStateText(obj)],
      [t("fields.phase"), info.phase],
      [t("fields.instances"), t("instancesReady", { ready: info.ready, total: info.instances })],
      [t("fields.primary"), link(sextant, POD, info.currentPrimary, ns)],
      [
        t("fields.targetPrimary"),
        info.changingPrimary && info.targetPrimary !== "pending" ? link(sextant, POD, info.targetPrimary, ns) : null,
      ],
      [t("fields.image"), info.image],
      [t("fields.storage"), info.storageSize],
    ]),
    members.length > 0 &&
      block(memory, "members", t("members.title"), ui.table([t("members.instance"), t("members.role"), t("members.health"), t("members.timeline")], members, { label: t("members.title"), id: "instances", sextant, nowrap: [true, true, true, true] })),
    block(memory, "backups", t("backups"), backups),
  ]);
}

export function backupView(sextant: Sextant, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const error = str(get(obj, "status", "error"));
  return present([
    fieldsOf([
      [t("fields.status"), backupStateText(obj)],
      [t("fields.cluster"), link(sextant, CLUSTER, clusterNameOf(obj), ns)],
      [t("fields.method"), backupMethodOf(obj)],
      [t("fields.target"), str(get(obj, "spec", "target"))],
      [t("fields.startedAt"), dateTime(str(get(obj, "status", "startedAt")))],
      [t("fields.stoppedAt"), dateTime(str(get(obj, "status", "stoppedAt")))],
      [t("fields.backupId"), str(get(obj, "status", "backupId"))],
      [t("fields.destination"), str(get(obj, "status", "destinationPath"))],
    ]),
    error && backupState(obj) === "failed" ? block(memory, "error", t("errorBlock"), note(error, "danger")) : null,
  ]);
}

export function scheduledBackupView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  return present([
    fieldsOf([
      [t("fields.cluster"), link(sextant, CLUSTER, clusterNameOf(obj), ns)],
      [t("fields.schedule"), str(get(obj, "spec", "schedule"))],
      [t("fields.suspended"), get(obj, "spec", "suspend") === true ? t("yes") : t("no")],
      [t("fields.method"), backupMethodOf(obj)],
      [t("fields.lastScheduleTime"), dateTime(str(get(obj, "status", "lastScheduleTime")))],
      [t("fields.nextScheduleTime"), dateTime(str(get(obj, "status", "nextScheduleTime")))],
    ]),
  ]);
}

export function poolerView(sextant: Sextant, obj: KubeObject): Node[] {
  const ns = obj.metadata.namespace ?? null;
  return present([
    fieldsOf([
      [t("fields.cluster"), link(sextant, CLUSTER, clusterNameOf(obj), ns)],
      [t("fields.type"), str(get(obj, "spec", "type")) ?? "rw"],
      [t("fields.poolerInstances"), num(get(obj, "spec", "instances"))?.toString()],
      [t("fields.poolMode"), str(get(obj, "spec", "pgbouncer", "poolMode"))],
    ]),
  ]);
}

/** The view of one CloudNativePG object, by its kind; nothing for another kind. */
export function viewOf(sextant: Sextant, kind: string, obj: KubeObject, memory: BlockMemory = OPEN_BLOCKS): Node[] {
  switch (CNPG_KINDS.find((k) => k === kind) as CnpgKind | undefined) {
    case "Cluster":
      return clusterView(sextant, obj, memory);
    case "Backup":
      return backupView(sextant, obj, memory);
    case "ScheduledBackup":
      return scheduledBackupView(sextant, obj);
    case "Pooler":
      return poolerView(sextant, obj);
    default:
      return [];
  }
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes. A
 * section with nothing to show hides itself, title included, until it has something (`ui.setHidden`). The view is
 * drawn again when Sextant's memory of its blocks changes ("Expand all", another panel of the kind), unless the blocks
 * already show it (the user's own toggle).
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const blocks = sextantBlocks(sextant);
  /** The shown object and how its blocks show now (each toggle included). */
  let shownObject: { kind: string; obj: KubeObject } | null = null;
  const shownBlocks = new Map<string, boolean>();
  const memory: BlockMemory = {
    isOpen: (id) => {
      const open = blocks.isOpen(id);
      shownBlocks.set(id, open);
      return open;
    },
    setOpen: (id, open) => {
      shownBlocks.set(id, open);
      blocks.setOpen(id, open);
    },
  };
  const draw = (kind: string, obj: KubeObject) => {
    shownObject = { kind, obj };
    shownBlocks.clear();
    show(viewOf(sextant, kind, obj, memory));
  };
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let hidden = false;

  /** Shows `nodes`, hiding the section while there are none. */
  const show = (nodes: Node[]) => {
    root.replaceChildren(...nodes);
    const empty = nodes.length === 0;
    if (empty === hidden) return;
    hidden = empty;
    void sextant.ui.setHidden(empty).catch(() => undefined);
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      if (contribution === "cnpg") draw(ref.kind.kind, fresh);
      else show([ui.empty(t("common.nothingToShow", { view: contribution }))]);
    } catch (err) {
      if (attempt === reading) show([ui.errorState(errorText(err))]);
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      show([ui.empty(t("common.nothingSelected"))]);
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      shownObject = null;
      show([ui.loading(t("loading"))]);
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) {
      const now = shownObject;
      if (now && [...shownBlocks].some(([id, open]) => blocks.isOpen(id) !== open)) draw(now.kind, now.obj);
      return;
    }
    shownVersion = version;
    void read(ref);
  };
  follow();
  return sextant.onContextChange(follow);
}
