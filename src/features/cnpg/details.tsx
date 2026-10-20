// Details of CloudNativePG objects (one section, `cnpg`):
//   Cluster         — its state in words, ready instances, the current primary and a primary change in progress
//                     (switchover or failover), the instances with their roles and health from the status, backups
//                     (last successful and failed, the recoverability point) and continuous archiving;
//   Backup          — phase, Cluster, method, times and the error;
//   ScheduledBackup — schedule, Cluster, whether suspended, last and next run;
//   Pooler          — Cluster, type, instances and pool mode.
// Conditions and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatDateTime } from "../../i18n";
import { status, StatusText } from "../../resources";
import { Block, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { BackupStateText, ClusterStateText } from "./columns";
import {
  archivingOf,
  BACKUP,
  backupMethodOf,
  backupState,
  clusterInfo,
  clusterNameOf,
  CNPG_GROUP,
  cnpgKind,
  isKind,
  lastBackupOf,
  PG_CLUSTER,
  POOLER,
  SCHEDULED_BACKUP,
  type Condition,
} from "./model";

const { get, num, str } = status;
const LABELS = "cnpg:fields";
const CLUSTER_TYPE = { apiVersion: `${CNPG_GROUP}/v1`, kind: "Cluster" };

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** A condition as working (True), failing (False) or unknown, in the given words. */
function conditionText(c: Condition | undefined, ok: string, bad: string, unknown: string): ReactNode {
  if (!c) return null;
  if (c.status === "True") return <StatusText value={ok} tone="success" />;
  if (c.status === "False") return <StatusText value={bad} tone="danger" />;
  return <StatusText value={unknown} tone="warning" />;
}

const MEMBER_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];

function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`cnpg-note cnpg-note--${tone}`}>{text}</p>;
}

function ClusterView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = clusterInfo(obj);
  const archiving = archivingOf(obj);
  const lastBackup = lastBackupOf(obj);
  const rows: FieldRow[] = [
    ["status", <ClusterStateText key="s" obj={obj} />],
    ["phase", info.phase],
    ["instances", t("cnpg:instancesReady", { ready: info.ready, total: info.instances })],
    ["primary", link(KINDS.pod, info.currentPrimary, ns)],
    ["targetPrimary", info.changingPrimary && info.targetPrimary !== "pending" ? link(KINDS.pod, info.targetPrimary, ns) : null],
    ["image", info.image],
    ["storage", info.storageSize],
  ];
  let change: string | undefined;
  if (info.state === "failover") change = t("cnpg:failover", { primary: info.currentPrimary ?? "" });
  else if (info.changingPrimary)
    change = t("cnpg:switchover", {
      from: info.currentPrimary ?? "",
      to: info.targetPrimary ?? "",
    });
  const members = info.members.map((m) => [
    link(KINDS.pod, m.name, ns),
    t(`cnpg:role.${m.role}`),
    m.health ? (
      <StatusText
        key="h"
        value={m.health}
        tone={m.health === "healthy" ? "success" : m.health === "failed" ? "danger" : "warning"}
      />
    ) : (
      ""
    ),
    m.timeline === undefined ? "" : String(m.timeline),
  ]);
  const backupRows: FieldRow[] = [
    ["archiving", conditionText(archiving, t("cnpg:archivingOk"), t("cnpg:archivingFailing"), t("cnpg:unknown"))],
    ["lastBackup", conditionText(lastBackup, t("cnpg:backupOk"), t("cnpg:backupFailing"), t("cnpg:unknown"))],
    ["lastSuccessfulBackup", date(info.lastSuccessfulBackup)],
    ["lastFailedBackup", date(info.lastFailedBackup)],
    ["firstRecoverabilityPoint", date(info.firstRecoverabilityPoint)],
  ];
  const membersTable = table(
    "cnpgInstances",
    [t("cnpg:members.instance"), t("cnpg:members.role"), t("cnpg:members.health"), t("cnpg:members.timeline")],
    members,
    MEMBER_WRAP,
  );
  const failingMessages = [archiving, lastBackup].filter((c) => c?.status === "False" && c.message).map((c) => c!.message!);
  return (
    <>
      {change && <Note text={change} tone={info.state === "failover" ? "danger" : "warning"} />}
      {info.state === "unhealthy" && info.phaseReason && <Note text={info.phaseReason} tone="danger" />}
      {info.replicaCluster && <p className="cnpg-muted">{t("cnpg:replicaCluster")}</p>}
      <Fields rows={rows} labelPrefix={LABELS} />
      {members.length > 0 && <Block title={t("cnpg:members.title")}>{membersTable}</Block>}
      <Block title={t("cnpg:backups")}>
        <Fields rows={backupRows} labelPrefix={LABELS} />
        {!archiving && !lastBackup && !info.lastSuccessfulBackup && <p className="cnpg-muted">{t("cnpg:noBackups")}</p>}
        {failingMessages.map((m) => (
          <Note key={m} text={m} tone="danger" />
        ))}
      </Block>
    </>
  );
}

function BackupView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const error = str(get(obj, "status", "error"));
  const rows: FieldRow[] = [
    ["status", <BackupStateText key="s" obj={obj} />],
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), ns)],
    ["method", backupMethodOf(obj)],
    ["target", str(get(obj, "spec", "target"))],
    ["startedAt", date(str(get(obj, "status", "startedAt")))],
    ["stoppedAt", date(str(get(obj, "status", "stoppedAt")))],
    ["backupId", str(get(obj, "status", "backupId"))],
    ["destination", str(get(obj, "status", "destinationPath"))],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {error && backupState(obj) === "failed" && (
        <Block title={t("cnpg:error")}>
          <Note text={error} tone="danger" />
        </Block>
      )}
    </>
  );
}

function ScheduledBackupView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), ns)],
    ["schedule", str(get(obj, "spec", "schedule"))],
    ["suspended", get(obj, "spec", "suspend") === true ? t("cnpg:yes") : t("cnpg:no")],
    ["method", backupMethodOf(obj)],
    ["lastScheduleTime", date(str(get(obj, "status", "lastScheduleTime")))],
    ["nextScheduleTime", date(str(get(obj, "status", "nextScheduleTime")))],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

function PoolerView({ obj }: { obj: KubeObject }) {
  const ns = obj.metadata?.namespace ?? null;
  const rows: FieldRow[] = [
    ["cluster", link(CLUSTER_TYPE, clusterNameOf(obj), ns)],
    ["type", str(get(obj, "spec", "type")) ?? "rw"],
    ["poolerInstances", num(get(obj, "spec", "instances"))?.toString()],
    ["poolMode", str(get(obj, "spec", "pgbouncer", "poolMode"))],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

export function CnpgSection({ objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, PG_CLUSTER)) return <ClusterView obj={obj} />;
  if (isKind(kind, BACKUP)) return <BackupView obj={obj} />;
  if (isKind(kind, SCHEDULED_BACKUP)) return <ScheduledBackupView obj={obj} />;
  if (isKind(kind, POOLER)) return <PoolerView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof cnpgKind>[0]): boolean => cnpgKind(kind) !== undefined;
