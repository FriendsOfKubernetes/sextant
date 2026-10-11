// Actions that change objects: edit, delete, scale, restart, cordon/uncordon, drain, trigger, suspend/resume.
// Which kinds offer them is decided by `ResourceDef.actions` and `appliesTo` below; every change except "edit"
// goes through a dialog first.
import type { KindRef, KubeObject } from "../../api";
import { api } from "../../api";
import { i18n } from "../../i18n";
import { openEditTab } from "../editor";
import { ConfirmAction, DeleteDialog, ScaleDialog } from "./dialogs";
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
  labelKey: "actions:edit.label",
  icon: "✎",
  appliesTo: () => true,
  run: ({ clusterId, refs }) => {
    if (refs[0]) openEditTab(clusterId, refs[0]);
  },
});

registerAction("delete", {
  labelKey: "actions:delete.label",
  icon: "×",
  danger: true,
  multiple: true,
  appliesTo: () => true,
  run: ({ clusterId, kind, refs, openDialog }) => {
    openDialog((close) => <DeleteDialog clusterId={clusterId} kind={kind} refs={refs} close={close} />);
  },
});

registerAction("scale", {
  labelKey: "actions:scale.label",
  icon: "↕",
  appliesTo: (_obj, kind) => is(kind, "apps", "Deployment", "StatefulSet", "ReplicaSet"),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    const replicas = field(obj, ["spec", "replicas"]);
    const current = typeof replicas === "number" ? replicas : 1;
    openDialog((close) => <ScaleDialog clusterId={clusterId} ref={ref} current={current} close={close} />);
  },
});

registerAction("restart", {
  labelKey: "actions:restart.label",
  icon: "↻",
  appliesTo: (_obj, kind) => is(kind, "apps", "Deployment", "StatefulSet", "DaemonSet"),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    const names = { kind: ref.kind.kind, name: ref.name };
    openDialog((close) => (
      <ConfirmAction
        title={t("actions:restart.title", names)}
        confirmLabel={t("actions:restart.confirm")}
        close={close}
        onConfirm={() => api.actions.restart(clusterId, ref)}
      >
        <p>{t("actions:restart.text", names)}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("cordon", {
  labelKey: "actions:cordon.label",
  icon: "⊘",
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
  labelKey: "actions:drain.label",
  icon: "⇣",
  danger: true,
  appliesTo: (_obj, kind) => is(kind, "", "Node"),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    openDialog((close) => (
      <ConfirmAction
        danger
        title={t("actions:drain.title", { name: ref.name })}
        confirmLabel={t("actions:drain.confirm")}
        // Pods the node kept (a disruption budget…) get their own title; a refused cordon (403) keeps the
        // generic text for its code.
        errorTitle={(error) => (error.message.includes("could not be evicted") ? t("actions:drain.failed") : undefined)}
        close={close}
        onConfirm={() => api.actions.drain(clusterId, ref.name)}
      >
        <p>{t("actions:drain.text", { name: ref.name })}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("trigger", {
  labelKey: "actions:trigger.label",
  icon: "▶",
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
  labelKey: "actions:suspend.label",
  icon: "⏸",
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
