// Buttons of the registered actions (src/features/actions/registry.ts) that apply to one object, in the order of
// its kind's `ResourceDef.actions`. Used at the top of the details panel; nothing is rendered when no action fits.
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { useResourceDef } from "../../resources";
import { getActionsFor, runAction, useActionsVersion } from "../actions/registry";

export function ActionBar({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const def = useResourceDef(kind);
  useActionsVersion();
  const actions = getActionsFor([obj], kind, def.actions);
  if (actions.length === 0) return null;
  return (
    <div className="dt-actions" role="toolbar" aria-label={t("details:actions")}>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`btn btn--small${action.danger ? " btn--danger" : ""}`}
          onClick={() => void runAction(action, clusterId, kind, [obj])}
        >
          <span aria-hidden className="dt-actions__icon">
            {action.icon}
          </span>
          {t(action.labelKey)}
        </button>
      ))}
    </div>
  );
}
