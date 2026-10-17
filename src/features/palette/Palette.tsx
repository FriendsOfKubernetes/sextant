// The command palette (Ctrl+K / Cmd+K, see shortcut.ts): one search field over the places to go (sections and pages of
// the active cluster, other clusters, Settings' tabs) and the objects of the active cluster, found by name across the
// kinds it serves (objectIndex.ts). Enter opens what is highlighted (an object: its details); Tab on an object lists
// the actions its kind offers in the action registry — the same actions, dialogs and confirmations as the details
// panel's buttons. Keyboard only: arrows, Home/End, Enter, Tab, Shift+Tab or Backspace back to the results, Escape.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, useSettings, type ApiError, type KubeObject } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { Icon } from "../../components";
import { usePagesVersion } from "../../layout/pages";
import { findKind, getResourceDef, parseViewId, useClusterKinds, useRegistryVersion } from "../../resources";
import { actionLabel, getActionsFor, runAction, useActionsVersion } from "../actions/registry";
import { useClustersStore } from "../clusters/clustersStore";
import {
  filterGroups,
  kindTitle,
  navigationGroups,
  objectGroups,
  objectItem,
  objectKey,
  statusOf,
  TERMINATING,
  type ObjectTarget,
  type PaletteGroup,
  type PaletteItem,
} from "./items";
import { queryWords } from "./fuzzy";
import {
  defaultSearchKinds,
  MAX_SEARCH_KINDS,
  parseKindQuery,
  searchKinds,
  useObjectIndex,
  type KindQuery,
} from "./objectIndex";
import { rememberRecent, usePalette } from "./store";
import "./palette.css";

/** How long typing has to pause before the objects are searched again. */
export const SEARCH_DEBOUNCE_MS = 120;
/** Objects whose status is read (one `resource_get` each), from the top of the results. */
export const STATUS_LIMIT = 10;
const STATUS_CONCURRENCY = 3;
const AUTOCOMPLETE = "list";
const ACTIONS_GROUP = "actions";

interface ActionsStep {
  target: ObjectTarget;
  obj: KubeObject | null;
  error: ApiError | null;
}

export function Palette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const listId = useId();
  const optionPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<ActionsStep | null>(null);
  // Objects are searched from the first typed character on (not on open), and all kinds only when asked.
  const [started, setStarted] = useState(false);
  const [allKinds, setAllKinds] = useState(false);

  const clusterId = useAppStore((s) => s.activeClusterId);
  const details = useAppStore((s) => s.details);
  const { view } = useClusterView(clusterId);
  const { kinds } = useClusterKinds(clusterId);
  const clusters = useClustersStore((s) => s.clusters);
  const states = useClustersStore((s) => s.states);
  const { settings } = useSettings();
  const recent = usePalette((s) => s.recent);
  const pagesVersion = usePagesVersion();
  const registryVersion = useRegistryVersion();
  const actionsVersion = useActionsVersion();

  // Focus the field on open; give the focus back on close unless something else (an action's dialog) took it.
  useEffect(() => {
    const before = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const now = document.activeElement;
      const ours = !now || now === document.body || rootRef.current?.contains(now);
      if (ours && before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSearched(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Every kind that could be searched; the open table's kind first (`view` stands for it, a stable string).
  const searchable = useMemo(
    () => (kinds ? searchKinds(kinds, parseViewId(view)) : null),
    // `registryVersion`: a kind registered later changes the order.
    [kinds, view, registryVersion],
  );
  const kindQuery: KindQuery = useMemo(
    () => (searchable ? parseKindQuery(searched, searchable) : { kind: null, words: queryWords(searched) }),
    [searchable, searched],
  );
  const named = kindQuery.kind;
  const defaults = useMemo(
    () => (searchable ? defaultSearchKinds(searchable, parseViewId(view)) : null),
    [searchable, view],
  );
  // What is watched: the common kinds, or all (capped) when asked, plus the kind the query names.
  const toSearch = useMemo(() => {
    if (!started || !searchable || !defaults) return null;
    const base = allKinds ? searchable.slice(0, MAX_SEARCH_KINDS) : defaults;
    return named && !base.includes(named) ? [...base, named] : base;
  }, [started, searchable, defaults, allKinds, named]);
  const index = useObjectIndex(clusterId, toSearch);

  const navigation = useMemo(
    () => navigationGroups({ t, clusterId, kinds, clusters, states, settings }),
    // The versions re-read the registries when pages or kinds are registered or removed.
    [t, clusterId, kinds, clusters, states, settings, pagesVersion, registryVersion],
  );

  const recentKeys = useMemo(() => new Set(recent.map((r) => r.key)), [recent]);

  const groups: PaletteGroup[] = useMemo(() => {
    if (step) return [];
    const q = query.trim();
    if (q === "") {
      const byKey = new Map(navigation.flatMap((g) => g.items).map((i) => [i.key, i]));
      const recentItems: PaletteItem[] = [];
      for (const entry of recent) {
        if (entry.object) {
          if (entry.object.clusterId !== clusterId) continue;
          recentItems.push(objectItem({ ...entry.object, resourceKind: findKind(kinds, entry.object.kind) ?? null }));
        } else {
          const item = byKey.get(entry.key);
          if (item) recentItems.push(item);
        }
      }
      const result: PaletteGroup[] = [];
      if (recentItems.length > 0) result.push({ id: "recent", label: t("palette:groups.recent"), items: recentItems });
      if (details && clusterId) {
        const target: ObjectTarget = {
          clusterId,
          kind: details.kind,
          namespace: details.namespace,
          name: details.name,
          resourceKind: findKind(kinds, details.kind) ?? null,
        };
        result.push({ id: "selected", label: t("palette:groups.selected"), items: [objectItem(target)] });
      }
      return [...result, ...navigation.filter((g) => g.items.length > 0)];
    }
    const places = filterGroups(navigation, q, recentKeys);
    const objects = clusterId ? objectGroups(t, clusterId, index.kinds, kindQuery) : [];
    const sorted = [...places, ...objects].sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
    // More kinds than the common ones, on request.
    if (clusterId && searchable && defaults && !allKinds && !named && searchable.length > defaults.length) {
      const count = Math.min(searchable.length, MAX_SEARCH_KINDS);
      const searchAll: PaletteItem = {
        key: "searchAll",
        label: t("palette:searchAll", { count }),
        icon: "customResources",
        stay: true,
        run: () => setAllKinds(true),
        score: 0,
      };
      sorted.push({ id: "more", label: t("palette:groups.more"), items: [searchAll] });
    }
    return sorted;
  }, [
    step,
    query,
    navigation,
    recent,
    recentKeys,
    details,
    clusterId,
    kinds,
    index,
    kindQuery,
    searchable,
    defaults,
    allKinds,
    named,
    t,
  ]);

  const actionItems: PaletteItem[] = useMemo(() => {
    if (!step) return [];
    const { target, obj } = step;
    const items: PaletteItem[] = [
      { ...objectItem(target), key: "details", label: t("palette:openDetails"), detail: undefined, icon: "eye" },
    ];
    if (obj) {
      const def = getResourceDef(target.kind, target.resourceKind);
      for (const action of getActionsFor([obj], target.kind, def.actions)) {
        items.push({
          key: `action:${action.id}`,
          label: actionLabel(action, t),
          icon: action.icon,
          danger: action.danger,
          run: () => void runAction(action, target.clusterId, target.kind, [obj]),
          recent: objectItem(target).recent,
          score: 0,
        });
      }
    }
    const q = query.trim();
    if (q === "") return items;
    return filterGroups([{ id: ACTIONS_GROUP, label: "", items }], q, new Set())[0]?.items ?? [];
    // `actionsVersion`: actions registered or removed meanwhile.
  }, [step, query, t, actionsVersion]);

  const options: PaletteItem[] = step ? actionItems : groups.flatMap((g) => g.items);
  const current = Math.min(active, Math.max(options.length - 1, 0));
  const statuses = useStatuses(step ? [] : options);

  useEffect(() => {
    document.getElementById(`${optionPrefix}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, optionPrefix]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item?.run) return;
    if (item.stay) {
      item.run();
      return;
    }
    if (item.recent) rememberRecent(item.recent);
    onClose();
    item.run();
  };

  const showActions = (item: PaletteItem | undefined) => {
    const target = item?.object;
    if (!target) return;
    setStep({ target, obj: null, error: null });
    setQuery("");
    setActive(0);
    api.resources
      .get(target.clusterId, { kind: target.kind, namespace: target.namespace, name: target.name })
      .then(
        (obj) => setStep((s) => (s?.target === target ? { ...s, obj } : s)),
        (err: unknown) => setStep((s) => (s?.target === target ? { ...s, error: toApiError(err) } : s)),
      );
  };

  const back = () => {
    setStep(null);
    setQuery("");
    setActive(0);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const move = (to: number) => {
      e.preventDefault();
      if (options.length > 0) setActive(((to % options.length) + options.length) % options.length);
    };
    switch (e.key) {
      case "ArrowDown":
        return move(current + 1);
      case "ArrowUp":
        return move(current - 1);
      case "Home":
        if (e.ctrlKey) return move(0);
        return;
      case "End":
        if (e.ctrlKey) return move(options.length - 1);
        return;
      case "PageDown":
        return move(Math.min(current + 8, options.length - 1));
      case "PageUp":
        return move(Math.max(current - 8, 0));
      case "Enter":
        e.preventDefault();
        return choose(options[current]);
      case "Tab":
        // Focus stays in the field: Tab goes into an object's actions, Shift+Tab back.
        e.preventDefault();
        if (e.shiftKey) {
          if (step) back();
        } else if (!step) {
          showActions(options[current]);
        }
        return;
      case "Backspace":
        if (step && query === "") {
          e.preventDefault();
          back();
        }
        return;
      case "Escape":
        e.preventDefault();
        // The details panel and dialogs listen for Escape on the window: this one is the palette's.
        e.stopPropagation();
        if (step) back();
        else onClose();
        return;
    }
  };

  const optionId = (i: number) => `${optionPrefix}-${i}`;
  let position = 0;
  const renderItem = (item: PaletteItem, groupId: string) => {
    const i = position++;
    const status = item.object ? statuses.get(objectKey(item.object)) : undefined;
    return (
      <div
        key={`${groupId}:${item.key}`}
        id={optionId(i)}
        role="option"
        aria-selected={i === current}
        className={optionClass(i === current, item.danger)}
        onMouseMove={() => i !== current && setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => choose(item)}
      >
        {item.icon && <Icon name={item.icon} className="palette__icon" />}
        <span className="palette__label">{item.label}</span>
        {item.detail && <span className="palette__detail">{item.detail}</span>}
        {status && <span className="palette__status-text">{status}</span>}
        {item.object && !step && i === current && <span className="palette__key">{t("palette:tabForActions")}</span>}
      </div>
    );
  };

  const searching = clusterId && !step && index.pending > 0 && query.trim() !== "";
  const limited = clusterId && !step && allKinds && (searchable?.length ?? 0) > MAX_SEARCH_KINDS;

  let note: string | null = null;
  if (step?.error) note = t("palette:actionsFailed", { message: step.error.message });
  else if (step && !step.obj) note = t("palette:loadingActions");
  else if (step && actionItems.length <= 1 && query.trim() === "") note = t("palette:noActions");
  else if (!clusterId && query.trim() !== "") note = t("palette:noCluster");
  else if (options.length === 0 && query.trim() !== "" && !searching) note = t("palette:empty");

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={rootRef} className="palette" role="dialog" aria-modal aria-label={t("palette:title")}>
        {step && (
          <div className="palette__crumb">
            <Icon name="chevronRight" size={12} />
            <span>
              {t("palette:actionsFor", {
                kind: kindTitle(t, step.target.kind, step.target.resourceKind),
                name: step.target.name,
              })}
            </span>
          </div>
        )}
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          role="combobox"
          aria-label={t("palette:search")}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete={AUTOCOMPLETE}
          aria-activedescendant={options.length > 0 ? optionId(current) : undefined}
          placeholder={step ? t("palette:filterActions") : t("palette:placeholder")}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim() !== "") setStarted(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id={listId} className="palette__list" role="listbox" aria-label={t("palette:results")}>
          {step
            ? actionItems.map((item) => renderItem(item, ACTIONS_GROUP))
            : groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.label} className="palette__group">
                  <div className="palette__group-label" aria-hidden>
                    {group.label}
                  </div>
                  {group.items.map((item) => renderItem(item, group.id))}
                </div>
              ))}
        </div>
        <div className="palette__footer">
          <span role="status" className="palette__note">
            {note ??
              (searching
                ? t("palette:searching", {
                    done: index.kinds.length - index.pending,
                    total: toSearch?.length ?? 0,
                  })
                : limited
                  ? t("palette:limited", { count: MAX_SEARCH_KINDS, total: searchable?.length ?? 0 })
                  : "")}
          </span>
          <span className="palette__hint">{step ? t("palette:hintActions") : t("palette:hint")}</span>
        </div>
      </div>
    </div>
  );
}

function optionClass(active: boolean, danger: boolean | undefined): string {
  let name = "palette__option";
  if (active) name += " palette__option--active";
  if (danger) name += " palette__option--danger";
  return name;
}

/** The cache key of an object's status: it is read again when the object changed. */
function statusKey(o: ObjectTarget): string {
  return `${objectKey(o)}@${o.meta?.metadata?.resourceVersion ?? ""}`;
}

/**
 * The statuses of the first `STATUS_LIMIT` objects among `items`, by `objectKey`. Searched objects carry only their
 * metadata, so each status costs one `resource_get`, at most `STATUS_CONCURRENCY` at once; read again only when the
 * object changed (its resourceVersion). Answers that come after the palette closed are dropped.
 */
function useStatuses(items: PaletteItem[]): Map<string, string> {
  const [cache, setCache] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // Keys asked for already (answered or not), so a re-render does not ask twice.
  const asked = useRef(new Set<string>());
  const wanted = items
    .filter((i) => i.object?.meta)
    .slice(0, STATUS_LIMIT)
    .map((i) => i.object!);
  const signature = wanted.map(statusKey).join("|");

  useEffect(() => {
    let closed = false;
    const queue = wanted.filter((o) => !asked.current.has(statusKey(o)));
    const worker = async () => {
      for (let next = queue.shift(); next && !closed; next = queue.shift()) {
        const target = next;
        const key = statusKey(target);
        asked.current.add(key);
        try {
          const obj = await api.resources.get(target.clusterId, {
            kind: target.kind,
            namespace: target.namespace,
            name: target.name,
          });
          if (closed) {
            asked.current.delete(key);
            return;
          }
          const status = statusOf(obj, target.kind, target.resourceKind) ?? null;
          setCache((prev) => new Map(prev).set(key, status));
        } catch {
          // No status for it; the object stays in the results.
        }
      }
    };
    for (let i = 0; i < STATUS_CONCURRENCY; i++) void worker();
    return () => {
      closed = true;
      // Not answered yet: may be asked again by the next round.
      for (const o of queue) asked.current.delete(statusKey(o));
    };
    // `signature` stands for `wanted`.
  }, [signature]);

  const result = new Map<string, string>();
  for (const o of wanted) {
    const status = o.meta?.metadata?.deletionTimestamp ? TERMINATING : cache.get(statusKey(o));
    if (status) result.set(objectKey(o), status);
  }
  return result;
}
