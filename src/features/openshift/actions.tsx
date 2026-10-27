// OpenShift's two actions, each after a confirmation that shows the one request it sends (requests.ts): "Rollout
// latest" of a DeploymentConfig (`oc rollout latest`) and "Start build" of a BuildConfig (`oc start-build`). The core
// builds the body from the object's name and sends it once (api.openshift). "Rollout latest" is not offered for a
// paused config and waits while the latest version still rolls out — as `oc` refuses it, and as the core checks again
// right before sending. Window only: agents and extensions have no such call.
import { useTranslation } from "react-i18next";
import { api, useWatch, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { ConfirmAction } from "../actions";
import { registerAction } from "../actions/registry";
import { BUILD_CONFIG, DEPLOYMENT_CONFIG, isKind, rcNameOf, REPLICATION_CONTROLLER, rolloutBlock } from "./model";
import { code, Muted, Note } from "./parts";
import { requestText, rolloutLatestRequest, startBuildRequest } from "./requests";

function RolloutLatestDialog({ clusterId, dc, dcRef, close }: { clusterId: ClusterId; dc: KubeObject; dcRef: ObjectRef; close: () => void }) {
  const { t } = useTranslation();
  const ns = dc.metadata?.namespace;
  // The latest version's ReplicationController, as `oc` reads it before sending.
  const spec = ns ? { kind: REPLICATION_CONTROLLER, namespaces: [ns], labelSelector: null, fieldSelector: `metadata.name=${rcNameOf(dc)}` } : null;
  const rc = useWatch(clusterId, spec);
  const checked = rc.status !== "loading";
  const block = rolloutBlock(dc, [...rc.items.values()]);
  return (
    <ConfirmAction
      title={t("openshift:rolloutLatest.title", { name: dcRef.name })}
      confirmLabel={t("openshift:rolloutLatest.confirm")}
      close={close}
      canConfirm={checked && block === undefined}
      onConfirm={async () => {
        const created = await api.openshift.rolloutLatest(clusterId, dcRef);
        return t("openshift:rolloutLatest.done", { name: created.name });
      }}
    >
      <p>{t("openshift:rolloutLatest.text")}</p>
      {block && <Note text={t(`openshift:rolloutLatest.${block}`, { name: rcNameOf(dc) })} tone="warning" />}
      <Muted text={t("openshift:request")} />
      {code(requestText(rolloutLatestRequest(dc)))}
    </ConfirmAction>
  );
}

function StartBuildDialog({ clusterId, bc, bcRef, close }: { clusterId: ClusterId; bc: KubeObject; bcRef: ObjectRef; close: () => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmAction
      title={t("openshift:startBuild.title", { name: bcRef.name })}
      confirmLabel={t("openshift:startBuild.confirm")}
      close={close}
      onConfirm={async () => {
        const created = await api.openshift.startBuild(clusterId, bcRef);
        return t("openshift:startBuild.done", { name: created.name });
      }}
    >
      <p>{t("openshift:startBuild.text")}</p>
      <Muted text={t("openshift:request")} />
      {code(requestText(startBuildRequest(bc)))}
    </ConfirmAction>
  );
}

registerAction("openshiftRolloutLatest", {
  placement: "primary",
  labelKey: "openshift:rolloutLatest.label",
  icon: "restart",
  appliesTo: (obj, kind) => isKind(kind, DEPLOYMENT_CONFIG) && Boolean(obj.metadata?.namespace),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    openDialog((close) => <RolloutLatestDialog clusterId={clusterId} dc={obj} dcRef={ref} close={close} />);
  },
});

registerAction("openshiftStartBuild", {
  placement: "primary",
  labelKey: "openshift:startBuild.label",
  icon: "trigger",
  appliesTo: (obj, kind) => isKind(kind, BUILD_CONFIG) && Boolean(obj.metadata?.namespace),
  run: ({ clusterId, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    openDialog((close) => <StartBuildDialog clusterId={clusterId} bc={obj} bcRef={ref} close={close} />);
  },
});

