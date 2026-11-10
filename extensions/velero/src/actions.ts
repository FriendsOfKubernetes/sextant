// The windows of "Back up namespace…" (`back-up-namespace`, on a Namespace) and "Restore from this backup…"
// (`restore-backup`, on a Backup), as Sextant's former built-in dialogs (ADR-0086, `VeleroDialogs.tsx` through
// `CreateDialog.tsx`): the form, then a confirmation that lists the one object to be created — kind, namespace, name,
// what Velero does with it and its YAML — then exactly that object created once with `resources.create` (#412). A
// name already taken is answered `conflict` by the API server and the object there is left as it was; nothing reaches
// the cluster before "Create" is pressed, a failure stays in the window and nothing is repeated. Velero does the work;
// the extension only creates the request. The window is the only question: the manifest's Modify rule on Backups and
// Restores has `confirm: false`, so Sextant does not ask again, as the built-in dialogs did not.
//
// A Backup goes into Velero's namespace, told by its BackupStorageLocations (watched while the window is open, kept in
// the order the watch delivered them, as the built-in dialog's `useWatch` kept them); a Restore goes where its Backup
// is. "Back up namespace…" is offered only where the cluster serves Backups (the manifest's `requiresKinds`). A restore skips most objects that already exist (some kinds, such as
// ServiceAccounts, are merged), and the confirmation says so.
import { isSextantError, objectKey, ui, type KubeObject, type ObjectRef, type Sextant, type WatchUpdate } from "@sextant/extension-sdk";
import { element, errorText } from "./dom";
import {
  DEFAULT_TTL,
  describeObject,
  stamp,
  suffixed,
  validNamespace,
  validTtl,
  validVeleroName,
  veleroBackupOf,
  veleroRestoreOf,
} from "./forms";
import { t } from "./i18n";
import { BACKUP_STORAGE_LOCATION, get, includedNamespaces, veleroNamespaceOf } from "./model";
import { toYaml } from "./yaml";

/** The actions' ids in the manifest. */
export const BACKUP_ACTION = "back-up-namespace";
export const RESTORE_ACTION = "restore-backup";

let fieldCounter = 0;

/** A labelled field with a hint below it, as the built-in dialogs' `Field`. */
interface Field {
  node: HTMLElement;
  setHint(text: string | undefined): void;
}

function field(label: string, control: HTMLInputElement | HTMLSelectElement): Field {
  const id = `velero-field-${++fieldCounter}`;
  control.id = id;
  const hint = element("span", { className: "action-dialog__hint" });
  hint.hidden = true;
  const node = element("div", { className: "action-dialog__field" }, element("label", { htmlFor: id, textContent: label }), control, hint);
  return {
    node,
    setHint(text) {
      hint.textContent = text ?? "";
      hint.hidden = text === undefined;
    },
  };
}

function input(value: string, onInput: (value: string) => void, options: { readOnly?: boolean; placeholder?: string } = {}): HTMLInputElement {
  const node = element("input", { className: "st-input", value, readOnly: options.readOnly === true });
  if (options.placeholder !== undefined) node.placeholder = options.placeholder;
  node.addEventListener("input", () => onInput(node.value.trim()));
  return node;
}

/**
 * Returns an update handler for `resources.watch` that keeps the current objects in the order the watch delivered
 * them — a snapshot's order, an object that changes keeping its place and a new one coming last — as Sextant's own
 * watch state keeps them (`applyWatchUpdate`, which the built-in dialog read), and calls `onChange` after each change.
 */
export function inDeliveryOrder(onChange: (objects: KubeObject[]) => void): (update: WatchUpdate) => void {
  let objects = new Map<string, KubeObject>();
  return (update) => {
    if (update.type === "snapshot") {
      objects = new Map((update.items as unknown as KubeObject[]).map((o) => [objectKey(o), o]));
    } else if (update.type === "delta") {
      for (const o of update.upserted as unknown as KubeObject[]) objects.set(objectKey(o), o);
      for (const uid of update.deleted) objects.delete(uid);
    } else {
      return;
    }
    onChange([...objects.values()]);
  };
}

/** What a create window needs: its title, the form, and the object the form builds (`null` while not valid). */
interface CreateWindow {
  title: string;
  form: Node[];
  /** The field that takes the focus whenever the form shows, as the built-in dialogs' `autoFocus`. */
  focus?: HTMLElement;
  object(): KubeObject | null;
  /** What the confirmation says the change does beyond the object. */
  note(): string;
}

const close = (sextant: Sextant) => void sextant.ui.close().catch(() => undefined);

/**
 * Draws the window's two steps and the result: the form with "Review" (enabled while the form builds an object), the
 * confirmation with "Back" and "Create", and "Created …" with "Close". Returns `refresh`, called whenever the form
 * changed.
 */
export function createWindow(sextant: Sextant, root: HTMLElement, win: CreateWindow): () => void {
  const title = () => element("p", { className: "question", textContent: win.title });
  const review = ui.button(t("create.review"), () => confirm(), { variant: "primary" });
  const formStep = [
    title(),
    element("div", { className: "st-form" }, ...win.form),
    element("div", { className: "actions" }, ui.button(t("dialog.cancel"), () => close(sextant)), review),
  ];
  const refresh = () => {
    review.disabled = win.object() === null;
  };
  const showForm = () => {
    refresh();
    root.replaceChildren(...formStep);
    win.focus?.focus();
  };

  function confirm(): void {
    const frozen = win.object();
    if (!frozen) return;
    const what = describeObject(frozen);
    const yaml = toYaml(frozen);
    const names = element("ul", { className: "action-dialog__names" }, element("li", { textContent: what }));
    names.setAttribute("aria-label", t("create.objects"));
    const text = element("pre", { className: "st-yaml", textContent: yaml });
    text.setAttribute("aria-label", t("create.yaml"));
    const note = win.note();
    const errorSlot = element("div");
    const back = ui.button(t("create.back"), () => showForm());
    const create = ui.button(t("create.confirm"), () => void send(), { variant: "primary" });
    async function send(): Promise<void> {
      back.disabled = true;
      create.disabled = true;
      create.textContent = t("dialog.working");
      errorSlot.replaceChildren();
      try {
        await sextant.resources.create({ yaml });
      } catch (err) {
        const message = isSextantError(err, "conflict") ? t("create.exists", { object: what }) : errorText(err);
        errorSlot.replaceChildren(ui.errorState(message));
        back.disabled = false;
        create.disabled = false;
        create.textContent = t("create.confirm");
        return;
      }
      const done = element("p", { className: "action-dialog__result", textContent: t("create.done", { object: what }) });
      done.setAttribute("role", "status");
      root.replaceChildren(title(), done, element("div", { className: "actions" }, ui.button(t("dialog.close"), () => close(sextant), { variant: "primary" })));
    }
    const parts: Node[] = [title(), element("p", { textContent: t("create.willCreate") }), names];
    if (note) parts.push(element("p", { className: "st-note", textContent: note }));
    parts.push(text, errorSlot, element("div", { className: "actions" }, back, create));
    root.replaceChildren(...parts);
  }

  showForm();
  return refresh;
}

/** The window of "Back up namespace…" on the Namespace `namespace`; returns its stop. */
export function backupWindow(sextant: Sextant, root: HTMLElement, namespace: string): () => void {
  let locations: KubeObject[] = [];
  let name = suffixed(namespace, stamp(new Date()));
  let ttl = DEFAULT_TTL;
  let storageLocation = "";
  const veleroNamespace = () => veleroNamespaceOf(locations);

  const nameInput = input(name, (v) => ((name = v), update()));
  const nameField = field(t("form.name"), nameInput);
  const veleroInput = input(veleroNamespace(), () => undefined, { readOnly: true });
  const veleroField = field(t("velero.namespace"), veleroInput);
  const ttlField = field(t("velero.ttl"), input(ttl, (v) => ((ttl = v), update())));
  const select = element("select", { className: "st-input" });
  select.addEventListener("change", () => ((storageLocation = select.value), update()));
  const locationField = field(t("velero.location"), select);

  const fillLocations = () => {
    const inVelero = locations.filter((l) => l.metadata?.namespace === veleroNamespace());
    const options = [element("option", { value: "", textContent: t("velero.defaultLocation") })];
    for (const l of inVelero) options.push(element("option", { value: l.metadata?.name ?? "", textContent: l.metadata?.name ?? "" }));
    select.replaceChildren(...options);
    select.value = storageLocation;
    // What is shown is what is created: a location that went away falls back to Velero's default.
    storageLocation = select.value;
  };

  const object = () =>
    validVeleroName(name) && validTtl(ttl) ? veleroBackupOf({ veleroNamespace: veleroNamespace(), name, namespace, ttl, storageLocation }) : null;
  const refresh = createWindow(sextant, root, {
    title: t("velero.backupTitle", { namespace }),
    form: [nameField.node, veleroField.node, ttlField.node, locationField.node],
    focus: nameInput,
    object,
    note: () => t("velero.backupNote", { namespace }),
  });
  function update(): void {
    nameField.setHint(validVeleroName(name) ? undefined : t("velero.invalidName"));
    veleroInput.value = veleroNamespace();
    veleroField.setHint(locations.length === 0 ? t("velero.noLocations") : undefined);
    ttlField.setHint(validTtl(ttl) ? t("velero.ttlHint") : t("velero.invalidTtl"));
    refresh();
  }
  fillLocations();
  update();

  const watch = sextant.resources.watch(
    { kind: BACKUP_STORAGE_LOCATION },
    {
      onUpdate: inDeliveryOrder((items) => {
        locations = items;
        fillLocations();
        update();
      }),
    },
  );
  watch.started.catch(() => undefined);
  return () => void watch.unwatch().catch(() => undefined);
}

/** The window of "Restore from this backup…" on the Backup `backup`. */
export function restoreWindow(sextant: Sextant, root: HTMLElement, backup: KubeObject): void {
  const backupName = backup.metadata?.name ?? "";
  // A Restore goes where its Backup is: that namespace is Velero's.
  const veleroNamespace = backup.metadata?.namespace ?? "";
  const sources = includedNamespaces(backup).filter((ns) => ns !== "*");
  let name = suffixed(backupName, stamp(new Date()));
  const mapping: Record<string, string> = {};
  const phase = String(get(backup, "status", "phase") ?? "");

  const nameInput = input(name, (v) => ((name = v), update()));
  const nameField = field(t("form.name"), nameInput);
  const mappingFields = sources.map((ns) => {
    const f = field(
      t("velero.mapFrom", { namespace: ns }),
      input("", (v) => ((mapping[ns] = v), update()), { placeholder: ns }),
    );
    return { ns, f };
  });
  const form: Node[] = [];
  if (phase !== "Completed") form.push(element("p", { className: "st-note", textContent: t("velero.restoreNotCompleted", { phase: phase || "—" }) }));
  form.push(nameField.node);
  if (sources.length === 0) {
    form.push(element("p", { className: "action-dialog__hint", textContent: t("velero.allNamespaces") }));
  } else {
    form.push(
      element(
        "fieldset",
        { className: "st-mapping" },
        element("legend", { textContent: t("velero.mapping") }),
        element("p", { className: "action-dialog__hint", textContent: t("velero.mappingHint") }),
        ...mappingFields.map(({ f }) => f.node),
      ),
    );
  }
  const mappingOk = () => Object.values(mapping).every((to) => to === "" || validNamespace(to));
  const object = () => (validVeleroName(name) && mappingOk() ? veleroRestoreOf({ veleroNamespace, name, backup: backupName, mapping }) : null);
  const mapped = () => Object.entries(mapping).filter(([from, to]) => to !== "" && to !== from);
  const refresh = createWindow(sextant, root, {
    title: t("velero.restoreTitle", { name: backupName }),
    form,
    focus: nameInput,
    object,
    note: () => (mapped().length > 0 ? t("velero.restoreNoteMapped") : t("velero.restoreNote")),
  });
  function update(): void {
    nameField.setHint(validVeleroName(name) ? undefined : t("velero.invalidName"));
    for (const { ns, f } of mappingFields) {
      const value = mapping[ns] ?? "";
      f.setHint(value === "" || validNamespace(value) ? undefined : t("velero.invalidNamespace"));
    }
    refresh();
  }
  update();
}

/** Starts the window of the action `contribution` on the object in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const ref: ObjectRef | undefined = sextant.context.selection[0];
  if (!ref || (contribution !== BACKUP_ACTION && contribution !== RESTORE_ACTION)) {
    root.replaceChildren(ui.empty(t("common.nothingSelected")));
    return () => undefined;
  }
  let stopped = false;
  let stop: () => void = () => undefined;
  root.replaceChildren(ui.loading(t("loading")));
  if (contribution === BACKUP_ACTION) {
    stop = backupWindow(sextant, root, ref.name);
  } else {
    void sextant.resources
      .get({ ref })
      .then((backup) => !stopped && restoreWindow(sextant, root, backup))
      .catch((err: unknown) => root.replaceChildren(ui.errorState(errorText(err))));
  }
  return () => {
    stopped = true;
    stop();
  };
}
