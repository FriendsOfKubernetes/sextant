// The workspace switcher at the top of the cluster rail: "All clusters" or one workspace, whose clusters alone the
// rail then shows. Switching only filters the rail: no cluster is connected or disconnected.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { useAppStore } from "../../app/store";
import { Icon, usePopup } from "../../components";
import { activeWorkspace, switchWorkspace } from "./model";
import { openManager, save } from "./ui";
import "./views.css";

export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const expanded = useAppStore((s) => s.railExpanded);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  usePopup(ref, () => setOpen(false), open);
  const workspaces = settings?.workspaces ?? [];
  const current = activeWorkspace(settings);
  const label = current ? t("views:workspace.current", { name: current.name }) : t("views:workspace.switcher");
  const choose = (id: string | null) => {
    setOpen(false);
    save((s) => switchWorkspace(s, id));
  };
  return (
    <div className="workspace-switch" ref={ref}>
      <button
        type="button"
        className={`fleet-rail${current ? " fleet-rail--active" : ""}${expanded ? " fleet-rail--expanded" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="workspace" size={20} />
        {expanded && (
          <span className="fleet-rail__name" aria-hidden="true">
            {current ? current.name : t("views:workspace.all")}
          </span>
        )}
      </button>
      {open && (
        <div className="rt-menu workspace-switch__menu" role="menu" aria-label={t("views:workspace.switcher")}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            className="rt-menu__item"
            onClick={() => choose(null)}
          >
            {t("views:workspace.all")}
          </button>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={current?.id === w.id}
              className="rt-menu__item"
              onClick={() => choose(w.id)}
            >
              {w.name}
            </button>
          ))}
          <p className="workspace-switch__hint">{t("views:workspace.hint")}</p>
          <button
            type="button"
            role="menuitem"
            className="rt-menu__item"
            onClick={() => {
              setOpen(false);
              openManager("workspaces");
            }}
          >
            {t("views:workspace.manage")}
          </button>
        </div>
      )}
    </div>
  );
}
