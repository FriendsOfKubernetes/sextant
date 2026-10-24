// Actions on Argo CD objects, all through the Kubernetes API (`api.resources.patch`, merge): Sync (dialog: revision,
// prune, dry run; sets `operation`), Refresh / Hard refresh (the refresh annotation), Terminate (only while an
// operation runs; sets its phase to Terminating) and "Open Argo CD UI" (port-forward to argocd-server).
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { Checkbox, Dialog, type IconName } from "../../components";
import { i18n } from "../../i18n";
import { ConfirmAction } from "../actions";
import { registerAction } from "../actions/registry";
import {
  ARGO_GROUP,
  defaultRevision,
  isApplication,
  isMultiSource,
  operationRunning,
  refreshPatch,
  syncPatch,
  terminatePatch,
  type RefreshKind,
} from "./model";
import { NamespacePicker } from "./diff/NamespacePicker";
import { isAmbiguousInstallation, openArgoUi } from "./server";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

export function SyncDialog({
  clusterId,
  app,
  appRef,
  close,
}: {
  clusterId: ClusterId;
  app: KubeObject;
  appRef: ObjectRef;
  close: () => void;
}) {
  const { t } = useTranslation();
  const revisionId = useId();
  const multiSource = isMultiSource(app);
  const [revision, setRevision] = useState(() => defaultRevision(app));
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const valid = multiSource || revision.trim() !== "";

  const sync = async () => {
    const patch = syncPatch(app, { revision: multiSource ? null : revision.trim(), prune, dryRun });
    await api.resources.patch(clusterId, appRef, patch, "merge");
    return t(dryRun ? "argocd:sync.dryRunStarted" : "argocd:sync.started", { name: appRef.name });
  };

  return (
    <ConfirmAction
      title={t("argocd:sync.title", { name: appRef.name })}
      confirmLabel={t("argocd:sync.confirm")}
      close={close}
      canConfirm={valid}
      onConfirm={sync}
    >
      <div className="argo-sync">
        {multiSource ? (
          <p className="action-dialog__hint">{t("argocd:sync.multiSource")}</p>
        ) : (
          <div className="action-dialog__field">
            <label htmlFor={revisionId}>{t("argocd:sync.revision")}</label>
            <input
              id={revisionId}
              type="text"
              className="argo-sync__revision"
              value={revision}
              autoFocus
              spellCheck={false}
              onChange={(e) => setRevision(e.target.value)}
            />
            <span className="action-dialog__hint">{t("argocd:sync.revisionHint")}</span>
          </div>
        )}
        <label className="argo-sync__option">
          <Checkbox checked={prune} onChange={(e) => setPrune(e.target.checked)} />
          {t("argocd:sync.prune")}
        </label>
        <label className="argo-sync__option">
          <Checkbox checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          {t("argocd:sync.dryRun")}
        </label>
      </div>
    </ConfirmAction>
  );
}

registerAction("argoSync", {
  placement: "primary",
  labelKey: "argocd:actions.sync",
  icon: "sync",
  appliesTo: (obj, kind) => isApplication(kind) && !operationRunning(obj),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [app, ref] = [objects[0], refs[0]];
    if (!app || !ref) return;
    openDialog((close) => <SyncDialog clusterId={clusterId} app={app} appRef={ref} close={close} />);
  },
});

function registerRefresh(id: "argoRefresh" | "argoHardRefresh", refresh: RefreshKind, labelKey: string, icon: IconName) {
  registerAction(id, {
    labelKey,
    icon,
    // Refresh is a button of the details panel; Hard refresh is in "Actions" (#275).
    placement: id === "argoRefresh" ? "primary" : "more",
    multiple: true,
    appliesTo: (_obj, kind) => isApplication(kind),
    run: async ({ clusterId, refs }) => {
      for (const ref of refs) await api.resources.patch(clusterId, ref, refreshPatch(refresh), "merge");
    },
  });
}

registerRefresh("argoRefresh", "normal", "argocd:actions.refresh", "refresh");
registerRefresh("argoHardRefresh", "hard", "argocd:actions.hardRefresh", "hardRefresh");

registerAction("argoTerminate", {
  placement: "more",
  labelKey: "argocd:actions.terminate",
  icon: "terminate",
  danger: true,
  appliesTo: (obj, kind) => isApplication(kind) && operationRunning(obj),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    const terminate = async () => {
      await api.resources.patch(clusterId, ref, terminatePatch(), "merge");
    };
    openDialog((close) => (
      <ConfirmAction
        title={t("argocd:terminate.title", { name: ref.name })}
        confirmLabel={t("argocd:terminate.confirm")}
        danger
        close={close}
        onConfirm={terminate}
      >
        <p>{t("argocd:terminate.text", { name: ref.name })}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("argoOpenUi", {
  placement: "more",
  labelKey: "argocd:actions.openUi",
  icon: "external",
  appliesTo: (_obj, kind) => kind.group === ARGO_GROUP,
  run: async ({ clusterId, kind, refs, openDialog }) => {
    const ref = refs[0];
    // An Application opens on its own page; other objects on the list of applications.
    const path =
      ref && isApplication(kind) && ref.namespace
        ? `/applications/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`
        : "/applications";
    try {
      await openArgoUi(clusterId, path);
    } catch (err) {
      if (!isAmbiguousInstallation(err)) throw err;
      // Several look-alike installations: nothing is opened until the user chooses one of them.
      openDialog((close) => (
        <Dialog open title={t("argocd:installation.title")} onClose={close}>
          <NamespacePicker
            clusterId={clusterId}
            error={err}
            onChosen={async () => {
              await openArgoUi(clusterId, path);
              close();
            }}
          />
        </Dialog>
      ));
    }
  },
});
