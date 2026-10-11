// YAML editor feature: the "edit" and "create" dock tabs and the dock's "+" (Create resource) button.
import type { ClusterId, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { registerDockAction, registerDockTab } from "../../layout/dock/registry";
import { CreateTab, type CreateTabPayload } from "./CreateTab";
import { EditTab, type EditTabPayload } from "./EditTab";
import "./editor.css";

export { describeRef, type CreateTabPayload } from "./CreateTab";
export type { EditTabPayload } from "./EditTab";
export { YamlEditor, type YamlEditorProps } from "./YamlEditor";
export { toYaml } from "../details/yaml";

registerDockTab("edit", EditTab);
registerDockTab("create", CreateTab);

registerDockAction({
  id: "create-resource",
  order: 10,
  labelKey: "actions:create.open",
  icon: "+",
  available: ({ activeClusterId }) => activeClusterId !== null,
  run: ({ activeClusterId }) => {
    if (activeClusterId) openCreateTab(activeClusterId);
  },
});

/** Opens the editor for `ref` in the dock, or switches to it when it is already open. Returns the tab id. */
export function openEditTab(clusterId: ClusterId, ref: ObjectRef): string {
  const payload: EditTabPayload = { clusterId, ref };
  return useAppStore.getState().openDockTab({
    id: `edit:${clusterId}:${ref.kind.group}/${ref.kind.kind}:${ref.namespace ?? ""}/${ref.name}`,
    type: "edit",
    title: i18n.t("actions:editor.tabTitle", { kind: ref.kind.kind, name: ref.name }),
    payload,
  });
}

/** Opens a new "Create resource" tab for `clusterId`. Returns the tab id. */
export function openCreateTab(clusterId: ClusterId): string {
  const payload: CreateTabPayload = { clusterId };
  return useAppStore.getState().openDockTab({
    type: "create",
    title: i18n.t("actions:create.tabTitle"),
    payload,
  });
}
