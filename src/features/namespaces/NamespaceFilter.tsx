// Namespace filter in the table header: "All namespaces" or a multi-selection, with a filter box; the namespaces
// selected when the list opens are listed first (`order.ts`).
//
// The list is the namespaces the cluster lists ∪ the selected ones ∪ the known ones (`known.ts`, #285) ∪ the ones the
// access check found; a known namespace stays when unticked and can be forgotten here. For a user who may not list
// Namespaces (`accessStore.ts`) each name carries the API server's answer ("accessible" / "no access"), "All
// namespaces" reads "All accessible (N)", and a hint says to type a namespace.
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type WatchSpec } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Button, Checkbox, Icon, usePopup, usePopupPosition } from "../../components";
import { formatList } from "../../i18n/format";
import { candidatesOf, inScope, MAX_SCOPE_NAMESPACES, type FoundBy } from "./access";
import { refreshAccess, useAccess, useRestrictedScope } from "./accessStore";
import { forgetKnownNamespaces, isNamespaceName, useKnownNamespaces } from "./known";
import { selectNamespaces } from "./namespaces";
import { orderNamespaces } from "./order";
import "./namespaces.css";

const NAMESPACES: WatchSpec = {
  kind: { group: "", version: "v1", kind: "Namespace" },
  namespaces: null,
  labelSelector: null,
  fieldSelector: null,
};

export function NamespaceFilter({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const selected = useAppStore((s) => s.clusterViews[clusterId]?.namespaces ?? null);
  const known = useKnownNamespaces(clusterId);
  const access = useAccess(clusterId);
  const scope = useRestrictedScope(clusterId);
  const restricted = access.listNamespaces === false;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  // The selection when the list was opened: those namespaces are listed first until it is opened again (#219).
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const popupId = useId();
  const hintId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // The popup opens under the button's right edge (the filter usually sits at the right of a header); where that
  // would cross the left edge of the main area (a filter at the left of a page, #168), it opens under the left edge;
  // where it would cross the window's right or bottom edge, it flips or shifts to stay inside (#176).
  usePopupPosition(popupRef, ref, {
    open,
    align: "end",
    gap: 4,
    bounds: () => ref.current?.closest("main")?.getBoundingClientRect() ?? null,
  });
  const { items } = useWatch(clusterId, NAMESPACES);

  const all = useMemo(() => {
    const names = new Set<string>();
    for (const ns of items.values()) if (ns.metadata?.name) names.add(ns.metadata.name);
    // Selected and known namespaces stay listed even when the list cannot be read (no permission to list namespaces).
    for (const ns of selected ?? []) names.add(ns);
    for (const ns of known) names.add(ns);
    for (const ns of access.found.keys()) names.add(ns);
    return [...names].sort();
  }, [items, selected, known, access.found]);

  const groups = orderNamespaces(all, pinned, filter);
  const visible = [...groups.selected, ...groups.others];
  // Namespaces "All" would watch if it were not capped.
  const reachable = restricted
    ? candidatesOf(known, access.found).filter((ns) => inScope(access.namespaces.get(ns))).length
    : 0;

  usePopup(ref, () => setOpen(false), open);

  const choose = (value: string[] | null) => {
    void selectNamespaces(clusterId, value).catch(() => {
      // Not fatal: the filter applies for this session and is saved with the next change.
    });
  };
  const toggle = (ns: string) => {
    const current = selected ?? [];
    choose(current.includes(ns) ? current.filter((n) => n !== ns) : [...current, ns]);
  };
  const forget = (ns: string) => {
    if (selected?.includes(ns)) choose(selected.filter((n) => n !== ns));
    void forgetKnownNamespaces(clusterId, [ns]).catch(() => undefined);
  };

  const foundText = (by: readonly FoundBy[]) =>
    t("namespaces:found.title", { sources: formatList(by.map((b) => t(`namespaces:found.${b}`))) });

  // The name alone shows only that namespace and closes the list (as in Lens); the checkbox adds or removes it.
  const only = (ns: string) => {
    choose([ns]);
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>(".ns-filter__button")?.focus();
  };

  const option = (ns: string) => {
    const mark = restricted ? access.namespaces.get(ns) : undefined;
    const by = access.found.get(ns);
    return (
      <div key={ns} className="ns-filter__row">
        <div className="ns-filter__option">
          <Checkbox aria-label={ns} checked={selected?.includes(ns) ?? false} onChange={() => toggle(ns)} />
          <button
            type="button"
            className="ns-filter__name"
            aria-label={t("namespaces:filter.only", { namespace: ns })}
            title={t("namespaces:filter.only", { namespace: ns })}
            onClick={() => only(ns)}
          >
            {ns}
          </button>
          {mark === "accessible" && <Badge tone="success">{t("namespaces:mark.accessible")}</Badge>}
          {mark === "noAccess" && <Badge tone="warning">{t("namespaces:mark.noAccess")}</Badge>}
          {by && !known.includes(ns) && (
            <span className="ns-filter__found" title={foundText(by)}>
              {t("namespaces:mark.found")}
            </span>
          )}
        </div>
        {known.includes(ns) && (
          <button
            type="button"
            className="icon-btn icon-btn--small"
            aria-label={t("namespaces:filter.forget", { namespace: ns })}
            title={t("namespaces:filter.forget", { namespace: ns })}
            onClick={() => forget(ns)}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
    );
  };

  const allLabel =
    restricted && scope ? t("namespaces:filter.allAccessible", { count: scope.length }) : t("resources:namespaces.all");
  const label =
    selected === null
      ? allLabel
      : selected.length <= 2
        ? formatList(selected)
        : t("resources:namespaces.count", { count: selected.length });

  return (
    <div className="ns-filter" ref={ref}>
      <Button
        className="ns-filter__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={t("resources:namespaces.label", { value: label })}
        onClick={() => {
          if (!open) setPinned(selected ?? []);
          setOpen(!open);
        }}
      >
        <span className="ns-filter__label">{label}</span>
        <Icon name="chevronDown" />
      </Button>
      {open && (
        <div
          id={popupId}
          ref={popupRef}
          className="ns-filter__popup"
          role="dialog"
          aria-label={t("resources:namespaces.title")}
        >
          <input
            className="ns-filter__search"
            type="search"
            placeholder={t("resources:namespaces.search")}
            aria-label={t("resources:namespaces.search")}
            aria-describedby={invalid !== null ? hintId : undefined}
            aria-invalid={invalid !== null || undefined}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setInvalid(null);
            }}
            onKeyDown={(e) => {
              // Enter selects the typed namespace, also one that is not listed (no permission to list namespaces).
              const typed = filter.trim();
              if (e.key === "Enter" && typed) {
                e.preventDefault();
                const target = visible.length === 1 ? (visible[0] ?? typed) : typed;
                if (!isNamespaceName(target)) {
                  setInvalid(target);
                  return;
                }
                if (!(selected ?? []).includes(target)) toggle(target);
                setFilter("");
              }
            }}
            autoFocus
          />
          {invalid !== null && (
            <div id={hintId} className="ns-filter__invalid" role="alert">
              {t("namespaces:invalidName", { name: invalid })}
            </div>
          )}
          {restricted && (
            <div className="ns-filter__hint">
              <p>{t("namespaces:filter.restrictedHint")}</p>
              {reachable > MAX_SCOPE_NAMESPACES && (
                <p>{t("namespaces:filter.scopeCapped", { max: MAX_SCOPE_NAMESPACES, total: reachable })}</p>
              )}
              <Button
                size="compact"
                icon="refresh"
                disabled={access.status === "checking"}
                onClick={() => void refreshAccess(clusterId)}
              >
                {access.status === "checking" ? t("namespaces:check.checking") : t("namespaces:check.again")}
              </Button>
            </div>
          )}
          <label className="ns-filter__option ns-filter__option--all">
            <Checkbox checked={selected === null} onChange={() => choose(null)} />
            {allLabel}
          </label>
          <div className="ns-filter__list">
            {groups.selected.map(option)}
            {groups.selected.length > 0 && groups.others.length > 0 && (
              <div role="separator" className="ns-filter__separator" />
            )}
            {groups.others.map(option)}
            {visible.length === 0 && <div className="ns-filter__empty">{t("resources:namespaces.none")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
