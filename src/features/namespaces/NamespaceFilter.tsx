// Namespace filter in the table header: "All namespaces" or a multi-selection, with a filter box; the namespaces
// selected when the list opens are listed first (`order.ts`).
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type WatchSpec } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Checkbox, Icon, usePopup, usePopupPosition } from "../../components";
import { formatList } from "../../i18n/format";
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
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // The selection when the list was opened: those namespaces are listed first until it is opened again (#219).
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const popupId = useId();
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
    // Selected namespaces stay listed even when the list cannot be read (no permission to list namespaces).
    for (const ns of selected ?? []) names.add(ns);
    return [...names].sort();
  }, [items, selected]);

  const groups = orderNamespaces(all, pinned, filter);
  const visible = [...groups.selected, ...groups.others];

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

  const option = (ns: string) => (
    <label key={ns} className="ns-filter__option">
      <Checkbox checked={selected?.includes(ns) ?? false} onChange={() => toggle(ns)} />
      {ns}
    </label>
  );

  const label =
    selected === null
      ? t("resources:namespaces.all")
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
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Enter selects the typed namespace, also one that is not listed (no permission to list namespaces).
              const typed = filter.trim();
              if (e.key === "Enter" && typed) {
                e.preventDefault();
                if (!(selected ?? []).includes(typed)) toggle(visible.length === 1 ? (visible[0] ?? typed) : typed);
                setFilter("");
              }
            }}
            autoFocus
          />
          <label className="ns-filter__option ns-filter__option--all">
            <Checkbox checked={selected === null} onChange={() => choose(null)} />
            {t("resources:namespaces.all")}
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
