import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Where the fill levels show (#152): the Usage column of the PVC table (a bar and the percent of the space, the worse
// of space and inodes colouring it by the thresholds), a "Usage" section in a claim's details and a "Volume usage"
// section in a pod's details (each of its claims). All read the cluster's shared poll (usageStore.ts).
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterId, type KubeObject, type VolumeUsage } from "../../api";
import { useAppStore } from "../../app/store";
import { ErrorState } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, type ColumnDef } from "../../resources";
import { Block, Fields, link, type FieldRow } from "../details";
import { UsageBar } from "../metrics";
import { DISK_FORMAT } from "./problems";
import { bytesPercent, bytesTotal, bytesUsed, claimKey, claimLevel, inodesPercent, inodesUsedOf, thresholdsOf, type Level, type Thresholds } from "./usage";
import { latestClaimUsage, useVolumeUsage, type UsageState } from "./usageStore";
import { ResizableTable } from "../../components/Table";

const { arr, get, str } = status;
const USAGE_LABELS = "storage:usage.fields";

function useThresholds(): Thresholds {
  return thresholdsOf(useSettings().settings?.notifications);
}

/** The bar of one claim's space, coloured by the worse level of space and inodes. */
export function ClaimBar({ usage, thresholds }: { usage: VolumeUsage; thresholds: Thresholds }) {
  const { t } = useTranslation();
  const bytes = bytesPercent(usage);
  const inodes = inodesPercent(usage);
  const level = claimLevel(usage, thresholds);
  const title = [
    bytes === undefined ? null : t("storage:usage.spaceTitle", { percent: DISK_FORMAT.percent(bytes), used: DISK_FORMAT.bytes(bytesUsed(usage) ?? 0), capacity: DISK_FORMAT.bytes(bytesTotal(usage) ?? 0) }),
    inodes === undefined ? null : t("storage:usage.inodesTitle", { percent: DISK_FORMAT.percent(inodes) }),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`st-usage st-usage--${level}`} data-level={level}>
      <UsageBar percent={bytes === undefined ? undefined : Math.round(bytes)} label={bytes === undefined ? t("storage:usage.notMeasured") : DISK_FORMAT.percent(bytes)} title={title} />
    </span>
  );
}

function UsageCell({ clusterId, claim }: { clusterId: ClusterId; claim: KubeObject }) {
  const usage = useVolumeUsage(clusterId);
  const thresholds = useThresholds();
  const value = usage.byClaim.get(claimKey(claim.metadata?.namespace, claim.metadata?.name));
  if (!value) return null;
  return <ClaimBar usage={value} thresholds={thresholds} />;
}

const activeCluster = () => useAppStore.getState().activeClusterId;

export const usageColumn: ColumnDef = {
  id: "usage",
  titleKey: "storage:usage.column",
  width: "110px",
  after: "size",
  value: (o) => {
    const u = latestClaimUsage(activeCluster(), o.metadata?.namespace, o.metadata?.name);
    return u ? bytesPercent(u) : undefined;
  },
  render: (o, ctx) => <UsageCell clusterId={ctx.clusterId} claim={o} />,
};

/** Why there is no value: still loading, an error, or no running pod mounts the claim. */
function Missing({ state }: { state: UsageState }) {
  const { t } = useTranslation();
  if (state.loading) return <p className="st-muted">{t("storage:usage.loading")}</p>;
  if (state.error) return <ErrorState error={state.error} title={t("storage:usage.failed")} />;
  return <p className="st-muted">{t("storage:usage.notMounted")}</p>;
}

/** Where the numbers come from, and what was left out. */
function SourceNote({ state }: { state: UsageState }) {
  const { t } = useTranslation();
  const report = state.report;
  if (!report) return null;
  const notes: string[] = [];
  notes.push(report.source === "kubelet" ? t("storage:usage.fromKubelet") : t("storage:usage.fromPrometheus"));
  if (report.kubeletForbidden) notes.push(t("storage:usage.kubeletForbidden"));
  if (report.nodesFailed > 0) notes.push(t("storage:usage.nodesFailed", { count: report.nodesFailed }));
  if (report.truncated) notes.push(t("storage:usage.truncated"));
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="st-muted">
          {n}
        </p>
      ))}
    </>
  );
}

function LevelText({ level }: { level: Level }) {
  const { t } = useTranslation();
  if (level === "ok") return null;
  return <p className={`st-level st-level--${level}`}>{t(`storage:usage.level.${level}`)}</p>;
}

/** Space and inodes of one claim as rows. */
function UsageRows({ usage, thresholds }: { usage: VolumeUsage; thresholds: Thresholds }) {
  const { t } = useTranslation();
  const bytes = bytesPercent(usage);
  const inodes = inodesPercent(usage);
  const rows: FieldRow[] = [
    [
      "space",
      bytes === undefined
        ? null
        : t("storage:usage.spaceValue", {
            percent: DISK_FORMAT.percent(bytes),
            used: DISK_FORMAT.bytes(bytesUsed(usage) ?? 0),
            capacity: DISK_FORMAT.bytes(bytesTotal(usage) ?? 0),
          }),
    ],
    ["available", usage.availableBytes == null ? null : DISK_FORMAT.bytes(usage.availableBytes)],
    [
      "inodes",
      inodes === undefined
        ? null
        : t("storage:usage.inodesValue", {
            percent: DISK_FORMAT.percent(inodes),
            used: DISK_FORMAT.count(inodesUsedOf(usage) ?? 0),
            total: DISK_FORMAT.count(usage.inodes ?? 0),
          }),
    ],
  ];
  return (
    <>
      <ClaimBar usage={usage} thresholds={thresholds} />
      <LevelText level={claimLevel(usage, thresholds)} />
      <Fields rows={rows} labelPrefix={USAGE_LABELS} />
    </>
  );
}

export function ClaimUsageSection({ clusterId, objectRef }: DetailsSectionProps) {
  const open = useDetailsDisclosure("storage:usage.title")?.open ?? true;
  const { t } = useTranslation();
  const state = useVolumeUsage(open ? clusterId : null);
  const thresholds = useThresholds();
  const usage = state.byClaim.get(claimKey(objectRef.namespace, objectRef.name));
  return (
    <Block id="storage:usage.title" title={t("storage:usage.title")}>
      {usage ? <UsageRows usage={usage} thresholds={thresholds} /> : <Missing state={state} />}
      <SourceNote state={state} />
    </Block>
  );
}

/** The claims a pod mounts: `[volume name, claim name]`. */
export function podClaims(pod: KubeObject | null): [string, string][] {
  return arr(get(pod, "spec", "volumes"))
    .map((v): [string, string] | null => {
      const claim = str(get(v, "persistentVolumeClaim", "claimName"));
      const name = str(get(v, "name"));
      return claim && name ? [name, claim] : null;
    })
    .filter((v): v is [string, string] => v !== null);
}

const PVC_TYPE = { apiVersion: "v1", kind: "PersistentVolumeClaim" };

export function PodVolumeUsageSection({ clusterId, obj }: DetailsSectionProps) {
  const claims = podClaims(obj);
  // A pod without claims shows nothing and polls nothing.
  if (claims.length === 0 || !obj) return null;
  return <PodVolumes clusterId={clusterId} pod={obj} claims={claims} />;
}

function PodVolumes({ clusterId, pod, claims }: { clusterId: ClusterId; pod: KubeObject; claims: [string, string][] }) {
  const open = useDetailsDisclosure("storage:usage.podTitle")?.open ?? true;
  const { t } = useTranslation();
  const state = useVolumeUsage(open ? clusterId : null);
  const thresholds = useThresholds();
  const namespace = pod.metadata?.namespace ?? null;
  return (
    <Block id="storage:usage.podTitle" title={t("storage:usage.podTitle")}>
      <ResizableTable tableId="storage.usage" className="st-table">
        <thead>
          <tr>
            <th>{t("storage:usage.volume")}</th>
            <th>{t("storage:usage.claim")}</th>
            <th>{t("storage:usage.column")}</th>
          </tr>
        </thead>
        <tbody>
          {claims.map(([volume, claim]) => {
            const usage = state.byClaim.get(claimKey(namespace, claim));
            return (
              <tr key={volume}>
                <td>{volume}</td>
                <td>{link(PVC_TYPE, claim, namespace)}</td>
                <td>{usage ? <ClaimBar usage={usage} thresholds={thresholds} /> : state.loading ? t("storage:usage.loading") : t("storage:usage.notMeasured")}</td>
              </tr>
            );
          })}
        </tbody>
      </ResizableTable>
      {state.error && <ErrorState error={state.error} title={t("storage:usage.failed")} />}
      <SourceNote state={state} />
    </Block>
  );
}
