// Placeholder sidebar of the skeleton: lists registered pages. The resource-tables stage replaces this file
// with the full section tree (Workloads, Config, Network, …).
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { getPages } from "../pages";

export function Sidebar({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { view } = useClusterView(clusterId);
  const setView = useAppStore((s) => s.setView);
  const pages = getPages();
  return (
    <ul className="sidebar__list">
      {pages.map((page) => (
        <li key={page.id}>
          <button
            type="button"
            className={page.id === view ? "sidebar__item sidebar__item--active" : "sidebar__item"}
            aria-current={page.id === view ? "page" : undefined}
            onClick={() => setView(clusterId, page.id)}
          >
            {t(page.labelKey)}
          </button>
        </li>
      ))}
    </ul>
  );
}
