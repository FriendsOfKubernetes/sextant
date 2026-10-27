// A DeploymentConfig's details: its rollout state and why (the Progressing condition's message), the replicas, the
// latest version and what caused it, the strategy, its triggers (an ImageChange trigger's ImageStreamTag linked to its
// ImageStream), and its rollouts — the ReplicationControllers labelled with its name, newest first, each with the
// deployer's phase and pods ready. "Rollout latest" is an action of the panel (actions.tsx).
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, link, mapChips, table, type ColumnWrap, type FieldRow } from "../details";
import { DcStateText } from "./columns";
import { useDcControllers } from "./hooks";
import { dcCauses, dcReason, dcReplicas, dcState, dcStrategy, dcTriggers, imageStreamOf, latestVersionOf, PHASE_TONE, rolloutsOf } from "./model";
import { date, LABELS, Muted, Note, refText, TYPES } from "./parts";

const { get } = status;

/** Rollouts listed in one view; the rest are counted. */
export const MAX_LISTED = 20;

const TRIGGER_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined];
const ROLLOUT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", undefined, "nowrap"];
const TABLE_DC_TRIGGERS = "openshiftDcTriggers";
const TABLE_ROLLOUTS = "openshiftRollouts";

export function DcView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const state = dcState(obj);
  const reason = dcReason(obj);
  const replicas = dcReplicas(obj);
  const strategy = dcStrategy(obj);
  const rcs = useDcControllers(clusterId, obj);
  const yes = (value: boolean | undefined) => (value === undefined ? "" : value ? t("openshift:yes") : t("openshift:no"));
  const rows: FieldRow[] = [
    ["status", <DcStateText key="s" obj={obj} />],
    ["replicas", t("openshift:readyOfDesired", { ready: replicas.ready, desired: replicas.desired })],
    ["updated", String(replicas.updated)],
    ["available", String(replicas.available)],
    ["latestVersion", String(latestVersionOf(obj))],
    ["causes", chips(dcCauses(obj))],
    ["strategy", strategy.type],
    ["maxSurge", strategy.maxSurge],
    ["maxUnavailable", strategy.maxUnavailable],
    ["timeoutSeconds", strategy.timeoutSeconds?.toString()],
    ["hooks", chips(strategy.hooks)],
    ["selector", mapChips(get(obj, "spec", "selector"))],
  ];
  const triggers = dcTriggers(obj).map((tr) => {
    const stream = imageStreamOf(tr.from);
    const fromNs = tr.from?.namespace ?? ns;
    return [
      tr.type,
      stream ? link(TYPES.imageStream, stream, fromNs, tr.from?.name) : (refText(tr.from) ?? ""),
      yes(tr.automatic),
      [tr.containers.join(", "), tr.lastTriggeredImage].filter(Boolean).join("\n"),
    ];
  });
  const rollouts = rolloutsOf(obj, rcs.items);
  const listed = rollouts.slice(0, MAX_LISTED).map((r) => [
    link(TYPES.replicationController, r.name, ns),
    r.version === undefined ? "" : String(r.version),
    r.phase ? <StatusText key="p" value={r.phase} tone={PHASE_TONE(r.phase)} /> : "",
    t("openshift:podsReady", { ready: r.ready, total: r.replicas }),
    r.reason ?? "",
    date(r.created),
  ]);
  return (
    <>
      {state === "failed" && reason && <Note text={reason} tone="danger" />}
      {(state === "progressing" || state === "unavailable") && reason && <Note text={reason} tone="warning" />}
      {state === "paused" && <Muted text={t("openshift:pausedNote")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("openshift:triggers.title")}>
        {table(
          TABLE_DC_TRIGGERS,
          [t("openshift:triggers.type"), t("openshift:triggers.image"), t("openshift:triggers.automatic"), t("openshift:triggers.containers")],
          triggers,
          TRIGGER_WRAP,
        )}
        {triggers.length === 0 && <Muted text={t("openshift:triggers.none")} />}
      </Block>
      <Block title={t("openshift:rollouts.title")}>
        {rcs.loading && <Muted text={t("openshift:loading")} />}
        {rcs.error && <Muted text={t("openshift:listError")} />}
        {table(
          TABLE_ROLLOUTS,
          [
            t("openshift:rollouts.controller"),
            t("openshift:rollouts.version"),
            t("openshift:rollouts.phase"),
            t("openshift:rollouts.pods"),
            t("openshift:rollouts.reason"),
            t("openshift:rollouts.created"),
          ],
          listed,
          ROLLOUT_WRAP,
        )}
        {!rcs.loading && !rcs.error && rollouts.length === 0 && <Muted text={t("openshift:rollouts.none")} />}
        {rollouts.length > MAX_LISTED && <Muted text={t("openshift:more", { count: rollouts.length - MAX_LISTED })} />}
        {rcs.truncated && <Muted text={t("openshift:truncated")} />}
      </Block>
    </>
  );
}
