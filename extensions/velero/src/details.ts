// The details section `velero` (the manifest's `contributes.detailsSections`) on the five Velero kinds, as Sextant's
// former built-in "Velero" section drew it (ADR-0086, `src/features/storage/details.tsx`): the state in plain words —
// why it was refused or failed, how many errors and warnings it had, how far it got, whether a location is
// unreachable — and the fields that matter, with links to the backup, schedule or storage location:
//   Backup     — phase, namespaces, TTL, storage location, started, completed, expires;
//   Restore    — phase, backup, schedule, started, completed;
//   Schedule   — phase, cron, namespaces, TTL, last backup (an age);
//   locations  — phase, provider, bucket, prefix, access mode (BackupStorageLocations), last validated.
// It is one block titled "Velero", open by default and closable with its title, as the built-in section's was, kept in
// Sextant's own memory of details sections (`context.blocks`, `ui.setBlockOpen`) with the panel's "Expand all" and
// "Collapse all"; the manifest's section has no heading of its own (`heading: false`). The frame reads the shown object
// again whenever its resourceVersion changes, and draws a Schedule's age again every 30 s.
// Conditions, events and YAML are Sextant's own sections. Read-only.
import { ui, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { age, dateTime, element, errorText, formatList } from "./dom";
import { t } from "./i18n";
import {
  BACKUP,
  BACKUP_STORAGE_LOCATION,
  explainVelero,
  get,
  includedNamespaces,
  isKind,
  phaseOf,
  phaseTone,
  RESTORE,
  SCHEDULE,
  str,
  VELERO_KINDS,
  type KindOf,
  type Phrase,
} from "./model";

/** How often ages are drawn again while the section shows. */
export const TICK_MS = 30_000;

/** A phrase as a paragraph in its tone, its lists joined in the UI language. */
export function explanation(phrase: Phrase): HTMLElement {
  const lists = Object.fromEntries(Object.entries(phrase.lists ?? {}).map(([k, v]) => [k, formatList(v)]));
  return element("p", { className: `st-explain st-explain--${phrase.tone ?? "neutral"}`, textContent: t(phrase.key, { ...phrase.params, ...lists }) });
}

/** A link to a Velero object's details in Sextant's panel; nothing without a name. */
function link(sextant: Sextant, kind: KindOf, name: string | undefined, namespace: string | null): HTMLElement | null {
  if (!name) return null;
  return ui.objectLink(sextant, { kind, namespace, name });
}

const time = (obj: KubeObject, ...path: string[]) => dateTime(str(get(obj, ...path)));

/** The id of the section's one block in Sextant's memory of details sections. */
export const BLOCK = "velero";

/**
 * Whether the block is open, and where a toggle goes: Sextant's own memory of details sections (`context.blocks`,
 * written by `ui.setBlockOpen`), where the built-in section's block was kept.
 */
export interface BlockMemory {
  isOpen(block: string): boolean;
  setOpen(block: string, open: boolean): void;
}

/** A block that is open and remembers nothing. */
export const OPEN_BLOCKS: BlockMemory = { isOpen: () => true, setOpen: () => undefined };

/** The section's content for `obj` of `kind`: its block titled "Velero", as the built-in section's. */
export function veleroView(sextant: Sextant, kind: KindOf, obj: KubeObject, now = Date.now(), memory: BlockMemory = OPEN_BLOCKS): Node[] {
  return [
    ui.block(t("velero.section"), veleroContent(sextant, kind, obj, now), {
      collapsible: true,
      collapsed: !memory.isOpen(BLOCK),
      onToggle: (open) => memory.setOpen(BLOCK, open),
    }),
  ];
}

/** The block's content: the state in plain words, then the fields. */
export function veleroContent(sextant: Sextant, kind: KindOf, obj: KubeObject, now = Date.now()): Node[] {
  const phase = phaseOf(obj);
  const ns = obj.metadata?.namespace ?? null;
  const namespaces = includedNamespaces(obj);
  const everyNamespace = () => (namespaces.length > 0 ? formatList(namespaces) : t("velero.everyNamespace"));
  const rows: [string, UiContent][] = [["phase", phase ? ui.status(phase, phaseTone(phase)) : null]];
  if (isKind(kind, BACKUP)) {
    rows.push(
      ["namespaces", everyNamespace()],
      ["ttl", str(get(obj, "spec", "ttl"))],
      ["location", link(sextant, BACKUP_STORAGE_LOCATION, str(get(obj, "spec", "storageLocation")), ns)],
      ["started", time(obj, "status", "startTimestamp")],
      ["completed", time(obj, "status", "completionTimestamp")],
      ["expires", time(obj, "status", "expiration")],
    );
  } else if (isKind(kind, RESTORE)) {
    rows.push(
      ["backup", link(sextant, BACKUP, str(get(obj, "spec", "backupName")), ns)],
      ["schedule", link(sextant, SCHEDULE, str(get(obj, "spec", "scheduleName")), ns)],
      ["started", time(obj, "status", "startTimestamp")],
      ["completed", time(obj, "status", "completionTimestamp")],
    );
  } else if (isKind(kind, SCHEDULE)) {
    rows.push(
      ["cron", str(get(obj, "spec", "schedule"))],
      ["namespaces", everyNamespace()],
      ["ttl", str(get(obj, "spec", "template", "ttl"))],
      ["lastBackup", age(str(get(obj, "status", "lastBackup")), now)],
    );
  } else {
    rows.push(
      ["provider", str(get(obj, "spec", "provider"))],
      ["bucket", str(get(obj, "spec", "objectStorage", "bucket"))],
      ["prefix", str(get(obj, "spec", "objectStorage", "prefix"))],
      ["accessMode", isKind(kind, BACKUP_STORAGE_LOCATION) ? str(get(obj, "spec", "accessMode")) : undefined],
      ["lastValidated", time(obj, "status", "lastValidationTime")],
    );
  }
  return [...explainVelero(kind, obj).map(explanation), ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const))];
}

/**
 * Starts the details section on the object in the context: read again whenever its resourceVersion changes, drawn
 * again every `TICK_MS` for a Schedule's age, and when Sextant's memory of its block changes ("Expand all", another
 * panel of the kind) unless the block already shows it (the user's own toggle).
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  /** How the block shows now, each toggle included. */
  let shownOpen: boolean | undefined;
  const memory: BlockMemory = {
    isOpen: (id) => (shownOpen = ui.blockOpen(sextant.context.blocks, id, true)),
    setOpen: (id, open) => {
      shownOpen = open;
      void sextant.ui.setBlockOpen(id, open).catch(() => undefined);
    },
  };
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;

  const render = () => {
    if (!object) return;
    const { ref, obj } = object;
    if (contribution !== "velero" || !VELERO_KINDS.some((kind) => isKind(ref.kind, kind))) {
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    root.replaceChildren(...veleroView(sextant, ref.kind, obj, Date.now(), memory));
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = { ref, obj: fresh };
      render();
    } catch (err) {
      if (attempt === reading) root.replaceChildren(ui.errorState(errorText(err)));
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(ui.empty(t("common.nothingSelected")));
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      root.replaceChildren(ui.loading(t("loading")));
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) {
      if (object && shownOpen !== undefined && ui.blockOpen(sextant.context.blocks, BLOCK, true) !== shownOpen) render();
      return;
    }
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  // Only a Schedule shows an age (its last backup).
  const timer = setInterval(() => object && isKind(object.ref.kind, SCHEDULE) && render(), TICK_MS);
  return () => {
    clearInterval(timer);
    stopFollow();
  };
}
