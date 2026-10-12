// Section tree of a cluster, in Lens order: Cluster, Nodes, Workloads, Config, Network, Storage, Namespaces, Events,
// Helm, Access Control, Custom Resources. Entries come from the resource registry (tables) and from `registerPage`
// (overview, events, Helm, port forwarding, …); a section without entries is not shown. Custom Resources lists
// "Definitions" and the cluster's custom kinds grouped by API group, from discovery (names, groups, versions — the
// CRDs themselves, with their schemas, are not downloaded for the sidebar).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import {
  customResourceKinds,
  findKind,
  findResourceDef,
  getResourceDefs,
  SIDEBAR_SECTIONS,
  useClusterKinds,
  useRegistryVersion,
  viewIdOf,
} from "../../resources";
import { getPages } from "../pages";
import "./sidebar.css";

/** Sections shown as one link (their only entry) instead of a collapsible group. */
const SINGLE_ENTRY = new Set(["cluster", "nodes", "namespaces", "events", "settings"]);

interface Entry {
  id: string;
  order: number;
  /** i18n key, or a literal label from cluster data (CRD kinds). */
  labelKey?: string;
  label?: string;
}

interface Section {
  id: string;
  entries: Entry[];
  /** Custom resources by API group. */
  groups?: { group: string; entries: Entry[] }[];
}

export function Sidebar({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { view } = useClusterView(clusterId);
  const setView = useAppStore((s) => s.setView);
  const setSearch = useAppStore((s) => s.setSearch);
  const registryVersion = useRegistryVersion();
  const { kinds } = useClusterKinds(clusterId);

  // `registryVersion` re-reads the registries when kinds are registered or extended.
  const sections = useMemo(() => buildSections(kinds, registryVersion), [kinds, registryVersion]);

  const activeSection = sections.find(
    (s) => s.entries.some((e) => e.id === view) || s.groups?.some((g) => g.entries.some((e) => e.id === view)),
  )?.id;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeSection ? [activeSection] : []));
  const isOpen = (id: string) => expanded.has(id) || id === activeSection;
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (isOpen(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const open = (id: string) => {
    if (id !== view) setSearch(clusterId, "");
    setView(clusterId, id);
  };
  const label = (e: Entry) => (e.labelKey ? t(e.labelKey) : (e.label ?? e.id));
  const item = (e: Entry, nested = true) => (
    <li key={e.id}>
      <button
        type="button"
        className={`sidebar__item${nested ? " sidebar__item--nested" : ""}${e.id === view ? " sidebar__item--active" : ""}`}
        aria-current={e.id === view ? "page" : undefined}
        onClick={() => open(e.id)}
      >
        {label(e)}
      </button>
    </li>
  );

  return (
    <ul className="sidebar__list">
      {sections.map((section) => {
        const only = section.entries[0];
        if (SINGLE_ENTRY.has(section.id) && section.entries.length === 1 && !section.groups?.length && only) {
          return item(only, false);
        }
        const sectionOpen = isOpen(section.id);
        return (
          <li key={section.id} className="sidebar__section">
            <button
              type="button"
              className="sidebar__item sidebar__group"
              aria-expanded={sectionOpen}
              onClick={() => toggle(section.id)}
            >
              <span className="sidebar__chevron" aria-hidden>
                {sectionOpen ? "▾" : "▸"}
              </span>
              {t(`resources:sections.${section.id}`, { defaultValue: section.id })}
            </button>
            {sectionOpen && (
              <ul className="sidebar__list sidebar__list--nested">
                {section.entries.map((e) => item(e))}
                {section.groups?.map((g) => {
                  const groupKey = `${section.id}:${g.group}`;
                  const groupOpen = isOpen(groupKey) || g.entries.some((e) => e.id === view);
                  return (
                    <li key={g.group}>
                      <button
                        type="button"
                        className="sidebar__item sidebar__item--nested sidebar__group"
                        aria-expanded={groupOpen}
                        onClick={() => toggle(groupKey)}
                      >
                        <span className="sidebar__chevron" aria-hidden>
                          {groupOpen ? "▾" : "▸"}
                        </span>
                        {g.group}
                      </button>
                      {groupOpen && (
                        <ul className="sidebar__list sidebar__list--nested">{g.entries.map((e) => item(e))}</ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function buildSections(kinds: ReturnType<typeof useClusterKinds>["kinds"], _registryVersion: number): Section[] {
  const bySection = new Map<string, Entry[]>();
  const add = (section: string, entry: Entry) => {
    const list = bySection.get(section) ?? [];
    list.push(entry);
    bySection.set(section, list);
  };
  for (const def of getResourceDefs()) {
    if (!def.sidebar) continue;
    // Once discovery is known, kinds the cluster does not serve are hidden.
    if (kinds && !findKind(kinds, def.kind)) continue;
    add(def.sidebar.section, { id: viewIdOf(def.kind), order: def.sidebar.order, labelKey: def.sidebar.labelKey });
  }
  for (const page of getPages()) add(page.section, { id: page.id, order: page.order, labelKey: page.labelKey });

  const groups = new Map<string, Entry[]>();
  const addCustom = (group: string, kind: string) => {
    const list = groups.get(group) ?? [];
    const id = viewIdOf({ group, kind });
    if (!list.some((e) => e.id === id)) list.push({ id, order: 0, label: kind });
    groups.set(group, list);
  };
  for (const k of customResourceKinds(kinds)) {
    const { group, kind } = k.kindRef;
    if (!findResourceDef({ group, kind })) addCustom(group, kind);
  }
  const crGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, entries]) => ({ group, entries: entries.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "")) }));

  const order = [...SIDEBAR_SECTIONS, ...[...bySection.keys()].filter((s) => !(SIDEBAR_SECTIONS as readonly string[]).includes(s))];
  const sections: Section[] = [];
  for (const id of order) {
    const entries = (bySection.get(id) ?? []).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const sectionGroups = id === "customResources" ? crGroups : undefined;
    if (entries.length === 0 && !sectionGroups?.length) continue;
    sections.push({ id, entries, groups: sectionGroups });
  }
  return sections;
}
