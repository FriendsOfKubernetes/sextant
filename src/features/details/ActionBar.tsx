// Buttons of the registered actions (src/features/actions/registry.ts) that apply to one object, in the order of
// its kind's `ResourceDef.actions`. Used at the top of the details panel; nothing is rendered when no action fits.
// Standard-size buttons with the action's icon and label; the toolbar wraps whole buttons onto the next line.
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { Button } from "../../components";
import { useResourceDef } from "../../resources";
import { actionLabel, getActionsFor, runAction, useActionsVersion, type ActionDef } from "../actions/registry";

function variantOf(action: ActionDef): "danger" | "default" {
  return action.danger ? "danger" : "default";
}

export function ActionBar({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const def = useResourceDef(kind);
  useActionsVersion();
  const actions = getActionsFor([obj], kind, def.actions);
  if (actions.length === 0) return null;
  return (
    <div className="dt-actions" role="toolbar" aria-label={t("details:actions")}>
      {actions.map((action) => (
        <Button
          key={action.id}
          variant={variantOf(action)}
          icon={action.icon}
          onClick={() => void runAction(action, clusterId, kind, [obj])}
        >
          {actionLabel(action, t)}
        </Button>
      ))}
    </div>
  );
}
