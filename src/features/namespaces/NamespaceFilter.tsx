// Namespace filter in the table header: "All namespaces" or a multi-selection, with a filter box.
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type WatchSpec } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Checkbox, Icon, usePopup } from "../../components";
import { selectNamespaces } from "./namespaces";
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
  const popupId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { items } = useWatch(clusterId, NAMESPACES);

  const all = useMemo(() => {
    const names = new Set<string>();
    for (const ns of items.values()) if (ns.metadata?.name) names.add(ns.metadata.name);
    // Selected namespaces stay listed even when the list cannot be read (no permission to list namespaces).
    for (const ns of selected ?? []) names.add(ns);
    return [...names].sort();
  }, [items, selected]);

  const visible = all.filter((ns) => ns.toLowerCase().includes(filter.trim().toLowerCase()));

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

  const label =
    selected === null
      ? t("resources:namespaces.all")
      : selected.length <= 2
        ? selected.join(", ")
        : t("resources:namespaces.count", { count: selected.length });

  return (
    <div className="ns-filter" ref={ref}>
      <Button
        className="ns-filter__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={t("resources:namespaces.label", { value: label })}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ns-filter__label">{label}</span>
        <Icon name="chevronDown" />
      </Button>
      {open && (
        <div id={popupId} className="ns-filter__popup" role="dialog" aria-label={t("resources:namespaces.title")}>
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
            {visible.map((ns) => (
              <label key={ns} className="ns-filter__option">
                <Checkbox checked={selected?.includes(ns) ?? false} onChange={() => toggle(ns)} />
                {ns}
              </label>
            ))}
            {visible.length === 0 && <div className="ns-filter__empty">{t("resources:namespaces.none")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
