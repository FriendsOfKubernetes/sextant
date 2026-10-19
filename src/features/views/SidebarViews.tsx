// Above the sidebar's sections: the active cluster's favourites strip (pinned objects and views) and its saved views
// (its own and those for every cluster). Nothing is shown while there are none.
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { useAppStore } from "../../app/store";
import { Icon, type IconName } from "../../components";
import { findResourceDef } from "../../resources";
import { DEFAULT_ENTRY_ICON } from "../../resources/registry";
import { isPinned, newId, pinsFor, togglePin, unpin, viewsFor, type Pin, type SavedView } from "./model";
import { openManager, openPin, openSavedView, save } from "./ui";
import "./views.css";

/** A view's icon, or the icon of the pinned object's kind. */
export function pinIcon(pin: Pin): IconName {
  if (pin.target.type === "view") return "savedView";
  return findResourceDef({ group: pin.target.group, kind: pin.target.kind })?.sidebar?.icon ?? DEFAULT_ENTRY_ICON;
}

export function SidebarViews() {
  const { t } = useTranslation();
  const clusterId = useAppStore((s) => s.activeClusterId);
  const { settings } = useSettings();
  if (!clusterId || !settings) return null;
  const views = viewsFor(settings, clusterId);
  const pins = pinsFor(settings, clusterId);
  if (views.length === 0 && pins.length === 0) return null;
  const allViews = settings.views;

  const pinLabel = (pin: Pin): string => {
    if (pin.target.type === "view") {
      const viewId = pin.target.view;
      return allViews.find((v) => v.id === viewId)?.name ?? viewId;
    }
    return pin.target.name;
  };
  const viewPin = (view: SavedView): Pin => ({ id: newId("p"), cluster: clusterId, target: { type: "view", view: view.id } });

  return (
    <div className="views-sidebar">
      {pins.length > 0 && (
        <section aria-label={t("views:sidebar.favourites")}>
          <div className="views-sidebar__header">
            <Icon name="pin" size={12} />
            <span>{t("views:sidebar.favourites")}</span>
          </div>
          <ul className="views-sidebar__list">
            {pins.map((pin) => {
              const name = pinLabel(pin);
              const open =
                pin.target.type === "view"
                  ? t("views:sidebar.openView", { name })
                  : t("views:sidebar.openObject", { kind: pin.target.kind, name });
              const icon = pinIcon(pin);
              return (
                <li key={pin.id} className="views-sidebar__row">
                  <button
                    type="button"
                    className="sidebar__item sidebar__item--nested views-sidebar__open"
                    title={open}
                    aria-label={open}
                    onClick={() => openPin(pin, allViews)}
                  >
                    <Icon name={icon} className="sidebar__icon" />
                    <span className="sidebar__label">{name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--small views-sidebar__tool"
                    aria-label={t("views:sidebar.unpin", { name })}
                    title={t("views:sidebar.unpin", { name })}
                    onClick={() => save((s) => unpin(s, pin.id))}
                  >
                    <Icon name="unpin" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {views.length > 0 && (
        <section aria-label={t("views:sidebar.views")}>
          <div className="views-sidebar__header">
            <Icon name="savedView" size={12} />
            <span>{t("views:sidebar.views")}</span>
            <button
              type="button"
              className="icon-btn icon-btn--small views-sidebar__manage"
              aria-label={t("views:sidebar.manage")}
              title={t("views:sidebar.manage")}
              onClick={() => openManager("views")}
            >
              <Icon name="settings" size={12} />
            </button>
          </div>
          <ul className="views-sidebar__list">
            {views.map((view) => {
              const pinned = isPinned(settings, viewPin(view));
              return (
                <li key={view.id} className="views-sidebar__row">
                  <button
                    type="button"
                    className="sidebar__item sidebar__item--nested views-sidebar__open"
                    title={view.cluster === null ? `${view.name} (${t("views:sidebar.allClusters")})` : view.name}
                    aria-label={t("views:sidebar.openView", { name: view.name })}
                    onClick={() => openSavedView(clusterId, view)}
                  >
                    <Icon name="savedView" className="sidebar__icon" />
                    <span className="sidebar__label">{view.name}</span>
                  </button>
                  {!pinned && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--small views-sidebar__tool"
                      aria-label={t("views:sidebar.pinView", { name: view.name })}
                      title={t("views:sidebar.pinView", { name: view.name })}
                      onClick={() => save((s) => togglePin(s, viewPin(view)))}
                    >
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
