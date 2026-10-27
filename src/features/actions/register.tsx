// Actions that change objects: edit, delete, scale, cordon/uncordon, drain, trigger, suspend/resume (restart:
// src/features/restart).
// Which kinds offer them is decided by `ResourceDef.actions` and `appliesTo` below; every change except "edit"
// goes through a dialog first.
import type { KindRef, KubeObject } from "../../api";
import { api } from "../../api";
import { i18n } from "../../i18n";
import { openEditTab } from "../editor";
import { newDeleteRunId } from "./deleteStore";
import { ConfirmAction, DeleteDialog, DrainDialog, ScaleDialog } from "./dialogs";
import { registerAction } from "./registry";

const is = (kind: KindRef, group: string, ...kinds: string[]) => kind.group === group && kinds.includes(kind.kind);

function field(obj: KubeObject, path: string[]): unknown {
  let value: unknown = obj;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

registerAction("edit", {
  placement: "primary",
  labelKey: "actions:edit.label",
  icon: "edit",
  appliesTo: () => true,
  run: ({ clusterId, refs }) => {
    if (refs[0]) openEditTab(clusterId, refs[0]);
  },
});

registerAction("delete", {
  placement: "primary",
  labelKey: "actions:delete.label",
  icon: "delete",
  danger: true,
  multiple: true,
  appliesTo: () => true,
  run: ({ clusterId, kind, objects, refs, openDialog }) => {
    // One run per dialog entry: a remount of the entry shows its run instead of starting another (deleteStore.ts).
    const runId = newDeleteRunId();
    openDialog((close) => (
      <DeleteDialog clusterId={clusterId} kind={kind} refs={refs} objects={objects} close={close} runId={runId} />
    ));
  },
});

registerAction("scale", {
  placement: "primary",
  labelKey: "actions:scale.label",
  icon: "scale",
  appliesTo: (_obj, kind) => is(kind, "apps", "Deployment", "StatefulSet", "ReplicaSet"),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    const replicas = field(obj, ["spec", "replicas"]);
    const current = typeof replicas === "number" ? replicas : 1;
    openDialog((close) => <ScaleDialog clusterId={clusterId} ref={ref} current={current} close={close} />);
  },
});

// "restart" is registered by src/features/restart (several objects, ReplicaSets, Rollouts and pods, #255).

registerAction("cordon", {
  placement: "primary",
  labelKey: "actions:cordon.label",
  icon: "cordon",
  appliesTo: (_obj, kind) => is(kind, "", "Node"),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    const cordon = field(obj, ["spec", "unschedulable"]) !== true;
    const mode = cordon ? "cordon" : "uncordon";
    openDialog((close) => (
      <ConfirmAction
        title={t(`actions:cordon.${mode}Title`, { name: ref.name })}
        confirmLabel={t(`actions:cordon.${mode}Confirm`)}
        close={close}
        onConfirm={() => api.actions.cordon(clusterId, ref.name, cordon)}
      >
        <p>{t(`actions:cordon.${mode}Text`, { name: ref.name })}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("drain", {
  placement: "primary",
  labelKey: "actions:drain.label",
  icon: "drain",
  danger: true,
  appliesTo: (_obj, kind) => is(kind, "", "Node"),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    openDialog((close) => <DrainDialog clusterId={clusterId} node={ref.name} close={close} />);
  },
});

registerAction("trigger", {
  placement: "primary",
  labelKey: "actions:trigger.label",
  icon: "trigger",
  appliesTo: (_obj, kind) => is(kind, "batch", "CronJob"),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    openDialog((close) => (
      <ConfirmAction
        title={t("actions:trigger.title", { name: ref.name })}
        confirmLabel={t("actions:trigger.confirm")}
        close={close}
        onConfirm={async () => {
          const job = await api.actions.triggerCronJob(clusterId, ref);
          return t("actions:trigger.done", { name: job.name });
        }}
      >
        <p>{t("actions:trigger.text")}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("suspend", {
  placement: "primary",
  labelKey: "actions:suspend.label",
  icon: "suspend",
  appliesTo: (_obj, kind) => is(kind, "batch", "CronJob"),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    const suspend = field(obj, ["spec", "suspend"]) !== true;
    const mode = suspend ? "suspend" : "resume";
    openDialog((close) => (
      <ConfirmAction
        title={t(`actions:suspend.${mode}Title`, { name: ref.name })}
        confirmLabel={t(`actions:suspend.${mode}Confirm`)}
        close={close}
        onConfirm={() => api.actions.suspendCronJob(clusterId, ref, suspend)}
      >
        <p>{t(`actions:suspend.${mode}Text`, { name: ref.name })}</p>
      </ConfirmAction>
    ));
  },
});
