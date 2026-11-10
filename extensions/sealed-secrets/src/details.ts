// The details section `sealed-secret` (the manifest's `contributes.detailsSections`), untitled at the built-in view's
// place (order 20, before the conditions), as the built-in view drew it (ADR-0109):
//   - the fields: the Synced condition (the controller's message on hover), since when and when last checked, the
//     generation the controller observed, the scope in words, the target Secret (a link) and how it stands to the
//     SealedSecret — read by name, metadata only, while the section shows —, the template's type, immutability and
//     owner reference;
//   - the controller's error with what it means ("Last error"), or a note when there is no status yet, the status is
//     of an older generation, or the deprecated `spec.data` is used;
//   - "Keys": the sealed keys by name and sealed size, and the template's keys by name — never a value;
//   - "Controller": the Deployments found by kubeseal's default name in kube-system and by the Helm chart's label, with
//     "Sealing keys" inside: the key Secrets of the controllers' namespaces (at most 5), metadata only. The certificate
//     is never read: it lives in the same Secret as the private key.
// The blocks open and close as the built-in ones did, kept in Sextant's own memory of details sections
// (`context.blocks`, `ui.setBlockOpen`) with the panel's "Expand all" and "Collapse all"; a closed block draws and
// watches nothing. The frame reads the shown SealedSecret again whenever its resourceVersion changes. Read-only.
import { trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { block, BlockMemory, dateTime, errorText, formatBytes, message, mutedWord, note, redraw, remark } from "./dom";
import { t } from "./i18n";
import {
  CONTROLLER_LABEL,
  CONTROLLER_NAME,
  CONTROLLER_NAMESPACE,
  controllerSummary,
  DEPLOYMENT,
  failureHint,
  isSealedSecret,
  KEY_LABEL,
  keyState,
  RELATION_TONE,
  scopeOf,
  SECRET,
  sealedKeys,
  SYNC_TONE,
  syncOf,
  targetName,
  targetRelation,
  templateOf,
  usesLegacyData,
} from "./model";

/** At most this many controllers' namespaces are looked at for sealing keys. */
export const MAX_KEY_NAMESPACES = 5;
/** The blocks' ids in Sextant's memory of details sections. */
export const LAST_ERROR_BLOCK = "lastError";
export const KEYS_BLOCK = "keys";
export const CONTROLLER_BLOCK = "controller";
export const SEALING_KEYS_BLOCK = "sealingKeys";

/** A list watched while the section shows: its objects, whether the first answer came, and how it failed. */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  /** The watch ended in an error. */
  error: boolean;
  /** Some of its namespaces may not be read. */
  forbidden: boolean;
}

/** Could not be read (an error, or a namespace refused), as the built-in `failed`. */
const failed = (live: Live | undefined) => live?.error === true || live?.forbidden === true;

// ---------- pieces ----------

/** A link to an object's details in Sextant's panel, named as Sextant's own links are. */
function link(sextant: Sextant, kind: ObjectRef["kind"], name: string | undefined, namespace: string | null): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

/** `ui.fields` labelled from `fields.<key>`; nothing when every row is empty, as the built-in `Fields`. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== false && value !== "");
  return shown.length > 0 ? ui.fields(shown.map(([key, value]) => [t(`fields.${key}`), value] as const)) : null;
}

/**
 * A table, or nothing without rows, as the built-in details' tables: its columns resize and Sextant keeps their widths
 * under `id` (the built-in `details:<id>`'s, by position); the columns marked in `nowrap` keep to one line.
 */
function tableOf(sextant: Sextant, id: string, headers: string[], rows: UiContent[][], label: string, nowrap: readonly boolean[]): HTMLElement | null {
  return rows.length > 0 ? ui.table(headers, rows, { label, id, sextant, nowrap }) : null;
}

/** The Synced state in words, coloured; the controller's message as its tooltip. */
export function syncCell(obj: KubeObject): HTMLElement {
  const s = syncOf(obj);
  const span = document.createElement("span");
  if (s.message) span.title = s.message;
  span.append(ui.status(t(`state.${s.state}`), SYNC_TONE[s.state]));
  return span;
}

// ---------- the target Secret ----------

/** The watch of the target Secret: by its name, in the SealedSecret's namespace, metadata only. */
export function targetWatch(obj: KubeObject): Omit<WatchParams, "clusterId"> | null {
  const namespace = obj.metadata.namespace;
  const name = targetName(obj);
  return namespace && name ? { kind: SECRET, namespaces: [namespace], fieldSelector: `metadata.name=${name}`, metadataOnly: true } : null;
}

/** How the target Secret stands: missing, owned by this SealedSecret, taken over, or in the controller's way. */
function targetState(sealed: KubeObject, live: Live | undefined): HTMLElement {
  if (failed(live)) return mutedWord(t("target.unknown"));
  if (!live?.ready) return mutedWord(t("loading"));
  const secret = live.items[0];
  if (!secret) return ui.status(t("target.missing"), "danger");
  const relation = targetRelation(sealed, secret);
  return ui.status(t(`target.${relation}`), RELATION_TONE[relation]);
}

// ---------- the error ----------

/** The controller's error and what it means; else a note on why there is no current status. */
function failure(memory: BlockMemory, obj: KubeObject): HTMLElement | null {
  const sync = syncOf(obj);
  if (sync.state !== "failed" || !sync.message) {
    if (sync.noStatus) return note(t("noStatus"));
    if (sync.stale) return note(t("stale"));
    return usesLegacyData(obj) ? note(t("hint.legacyData")) : null;
  }
  const text = sync.message;
  const hint = failureHint(text);
  return block(memory, LAST_ERROR_BLOCK, t("lastError"), () => [message(text), hint && note(t(`hint.${hint}`))]);
}

// ---------- the keys ----------

function keys(sextant: Sextant, memory: BlockMemory, obj: KubeObject): HTMLElement | null {
  const sealed = sealedKeys(obj);
  const templated = templateOf(obj).dataKeys.map((k) => (k.omitted ? t("keys.omitted", { name: k.name }) : k.name));
  if (sealed.length === 0 && templated.length === 0) return null;
  return block(memory, KEYS_BLOCK, t("keys.title"), () => [
    remark(t("keys.namesOnly")),
    tableOf(
      sextant,
      "keys",
      [t("keys.name"), t("keys.size")],
      sealed.map((k) => [k.name, formatBytes(k.sealedBytes)]),
      t("keys.title"),
      [true, true],
    ),
    fieldsOf([["templated", ui.chips(templated)]]),
  ]);
}

// ---------- the controller ----------

/** The controllers' watches: kubeseal's default name in kube-system, and the Helm chart's label anywhere. */
export const CONTROLLER_WATCHES: { byName: Omit<WatchParams, "clusterId">; byLabel: Omit<WatchParams, "clusterId"> } = {
  byName: { kind: DEPLOYMENT, namespaces: [CONTROLLER_NAMESPACE], fieldSelector: `metadata.name=${CONTROLLER_NAME}` },
  byLabel: { kind: DEPLOYMENT, labelSelector: CONTROLLER_LABEL },
};

export interface Controllers {
  /** The Deployments found by name or label, by namespace and name; `undefined` while loading. */
  deployments: KubeObject[] | undefined;
  /** One of the lists could not be read: "none found" is not known. */
  error: boolean;
}

/** The controllers found, as the built-in `useControllers` merged them. */
export function controllersOf(lists: readonly (Live | undefined)[]): Controllers {
  const error = lists.some(failed);
  const readable = lists.filter((l) => !failed(l));
  if (readable.some((l) => !l?.ready)) return { deployments: undefined, error };
  const byUid = new Map<string, KubeObject>();
  for (const l of readable) for (const d of l?.items ?? []) byUid.set(d.metadata.uid ?? `${d.metadata.namespace}/${d.metadata.name}`, d);
  const deployments = [...byUid.values()].sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
  return { deployments, error };
}

/** The namespaces of the controllers whose sealing keys are read, at most `MAX_KEY_NAMESPACES`. */
export function keyNamespaces(deployments: readonly KubeObject[]): string[] {
  return [...new Set(deployments.map((d) => d.metadata.namespace ?? "").filter(Boolean))].slice(0, MAX_KEY_NAMESPACES);
}

/** The sealing keys' watch: the labelled Secrets of the controllers' namespaces, metadata only. */
export function sealingKeysWatch(namespaces: readonly string[]): Omit<WatchParams, "clusterId"> | null {
  return namespaces.length > 0 ? { kind: SECRET, namespaces: [...namespaces], labelSelector: KEY_LABEL, metadataOnly: true } : null;
}

const created = (o: KubeObject) => (typeof o.metadata.creationTimestamp === "string" ? o.metadata.creationTimestamp : "");

function sealingKeys(sextant: Sextant, live: Live | undefined): UiContent {
  // As the built-in `useSealingKeys`: an error reads as none found; newest first.
  const value = live?.error ? [] : live?.ready ? [...live.items].sort((a, b) => created(b).localeCompare(created(a))) : undefined;
  const rows = (value ?? []).map((s) => [link(sextant, SECRET, s.metadata.name, s.metadata.namespace ?? null), keyState(s) ?? "", dateTime(created(s) || undefined)]);
  return [
    value === undefined
      ? remark(t("loading"))
      : tableOf(sextant, "sealingKeys", [t("sealingKeys.name"), t("sealingKeys.state"), t("sealingKeys.created")], rows, t("sealingKeys.title"), [true, true, true]),
    value !== undefined && rows.length === 0 && remark(t("sealingKeys.none")),
    remark(t("sealingKeys.certificateNotShown")),
  ];
}

function controllerBody(sextant: Sextant, memory: BlockMemory, found: Controllers, keysLive: () => Live | undefined): UiContent {
  const { deployments, error } = found;
  if (deployments === undefined) return remark(t("loading"));
  if (deployments.length === 0) return note(t(error ? "controller.cannotRead" : "controller.notFound"));
  const rows = deployments.map((d) => {
    const s = controllerSummary(d);
    const tone = s.ready >= s.desired && s.desired > 0 ? "success" : "danger";
    return [link(sextant, DEPLOYMENT, d.metadata.name, d.metadata.namespace ?? null), ui.status(t("controller.ready", { ready: s.ready, desired: s.desired }), tone), ui.chips(s.images)];
  });
  return [
    tableOf(sextant, "controller", [t("controller.deployment"), t("controller.replicas"), t("controller.image")], rows, t("controller.title"), [true, true, false]),
    block(memory, SEALING_KEYS_BLOCK, t("sealingKeys.title"), () => sealingKeys(sextant, keysLive())),
  ];
}

// ---------- the section ----------

export interface Lists {
  target?: Live;
  byName?: Live;
  byLabel?: Live;
  sealingKeys?: Live;
}

/** The section of `obj` as it is drawn now, with the lists its open blocks watch. */
export function sealedSecretView(sextant: Sextant, obj: KubeObject, memory: BlockMemory, lists: Lists, controllers: Controllers): Node[] {
  const ns = obj.metadata.namespace ?? null;
  const sync = syncOf(obj);
  const scope = scopeOf(obj);
  const template = templateOf(obj);
  const yesNo = (v: boolean | undefined) => (v === undefined ? null : t(v ? "yes" : "no"));
  const nodes: (Node | null)[] = [
    fieldsOf([
      ["status", syncCell(obj)],
      ["since", dateTime(sync.since)],
      ["checked", dateTime(sync.checked)],
      ["generation", sync.observedGeneration !== undefined && sync.generation !== undefined ? t("generation", { observed: sync.observedGeneration, generation: sync.generation }) : null],
      ["scope", t(`scopeHint.${scope}`, { scope: t(`scope.${scope}`) })],
      ["target", link(sextant, SECRET, targetName(obj), ns)],
      ["targetState", targetState(obj, lists.target)],
      ["type", template.type],
      ["immutable", yesNo(template.immutable)],
      ["ownerReference", t(template.skipOwnerReferences ? "ownerReference.skipped" : "ownerReference.set")],
    ]),
    failure(memory, obj),
    keys(sextant, memory, obj),
    block(memory, CONTROLLER_BLOCK, t("controller.title"), () => controllerBody(sextant, memory, controllers, () => lists.sealingKeys)),
  ];
  return nodes.filter((n): n is Node => n !== null);
}

// ---------- watches ----------

/**
 * The watches a section holds, by what they watch: each drawing asks for the lists it needs between `begin` and
 * `end` (a list is started when first asked for), and `end` stops every list it did not ask for.
 */
class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  private wanted = new Set<string>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  begin(): void {
    this.wanted = new Set();
  }

  /** The list of `spec`, watched from now on; nothing for no spec. */
  get(spec: Omit<WatchParams, "clusterId"> | null): Live | undefined {
    if (!spec) return undefined;
    const key = JSON.stringify(spec);
    this.wanted.add(key);
    return (this.open.get(key) ?? this.start(key, spec)).live;
  }

  end(): void {
    for (const [key, entry] of this.open) {
      if (this.wanted.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, error: false, forbidden: false };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = items;
          live.ready = true;
          live.error = false;
          this.changed();
        },
        (other) => {
          if (other.type === "error") {
            live.ready = true;
            live.error = true;
          } else if (other.type === "forbidden") live.forbidden = other.namespaces.length > 0;
          else return;
          this.changed();
        },
      ),
      onError: () => {
        live.ready = true;
        live.error = true;
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.begin();
    this.end();
  }
}

/** Calls `run` once in the next microtask, however often it is asked. */
function batched(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  };
}

/**
 * Follows the shown object: `onObject` with it, now and whenever its resourceVersion changes; `onError` when it cannot
 * be read. Returns the function that stops following it.
 */
function followShown(sextant: Sextant, onObject: (ref: ObjectRef, obj: KubeObject) => void, onError: (err: unknown) => void, onNone: () => void): () => void {
  let shown: string | null = null;
  let version: string | null | undefined;
  let reading = 0;
  let stopped = false;
  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && attempt === reading) onObject(ref, obj);
    } catch (err) {
      if (!stopped && attempt === reading) onError(err);
    }
  };
  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      shown = null;
      onNone();
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shown) {
      shown = key;
      version = undefined;
    }
    if (sextant.context.resourceVersion === version) return;
    version = sextant.context.resourceVersion;
    void read(ref);
  };
  follow();
  const off = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    off();
  };
}

function startSection(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let stopped = false;
  const render = () => {
    if (stopped || !object) return;
    const { ref, obj } = object;
    if (!isSealedSecret(ref.kind)) {
      watches.stop();
      root.replaceChildren(ui.empty(t("common.nothingToShow", { view: contribution })));
      return;
    }
    // A closed block watches nothing: the controllers only while "Controller" is open, their keys only while
    // "Sealing keys" is open too.
    const controllerOpen = memory.peek(CONTROLLER_BLOCK);
    watches.begin();
    const lists: Lists = { target: watches.get(targetWatch(obj)) };
    let controllers: Controllers = { deployments: undefined, error: false };
    if (controllerOpen) {
      lists.byName = watches.get(CONTROLLER_WATCHES.byName);
      lists.byLabel = watches.get(CONTROLLER_WATCHES.byLabel);
      controllers = controllersOf([lists.byName, lists.byLabel]);
      const namespaces = controllers.deployments?.length ? keyNamespaces(controllers.deployments) : [];
      if (namespaces.length > 0 && memory.peek(SEALING_KEYS_BLOCK)) lists.sealingKeys = watches.get(sealingKeysWatch(namespaces));
    }
    watches.end();
    redraw(root, sealedSecretView(sextant, obj, memory, lists, controllers));
  };
  const schedule = batched(render);
  const watches = new Watches(sextant, schedule);
  const memory = new BlockMemory(sextant, schedule);
  // Nothing until the object is read, as the built-in section drew nothing without it.
  root.replaceChildren();
  const stopFollow = followShown(
    sextant,
    (ref, obj) => {
      if (object && JSON.stringify(object.ref) !== JSON.stringify(ref)) {
        watches.stop();
        memory.reset();
      }
      object = { ref, obj };
      render();
    },
    (err) => root.replaceChildren(ui.errorState(errorText(err))),
    () => root.replaceChildren(ui.empty(t("common.nothingSelected"))),
  );
  const stopBlocks = sextant.onContextChange(() => {
    if (memory.follow()) schedule();
  });
  return () => {
    stopped = true;
    stopFollow();
    stopBlocks();
    watches.stop();
  };
}

/** Starts the details section `contribution` on the object in the context. */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  return startSection(sextant, root, contribution);
}
