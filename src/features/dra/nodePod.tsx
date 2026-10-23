// The DRA blocks of Pod and Node details (#244). A pod without `spec.resourceClaims` and a node without
// ResourceSlices draw nothing, and nothing is watched for a cluster that does not serve the kinds.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { isUnscheduled, schedulingCondition } from "../autoscaling/scheduling";
import { Block, chips, link, table, type ColumnWrap } from "../details";
import { allocationIndex, useAllClaims, useNamespaceClaims, useServed, useSlices, MAX_SLICES } from "./hooks";
import { allocatedDevicesOf, claimState, deviceKey, draReasonsIn, isKind, NODE, POD, podClaimsOf, RESOURCE_CLAIM, RESOURCE_SLICE, STATE_TONE, usesClaims } from "./model";
import { DevicesTable, DraReasons } from "./ui";

const CLAIM_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined, undefined];
const NODE_DEVICE_ROWS = 200;
const POD_CLAIMS_TABLE = "draPodClaims";
const NODE_DEVICES_TABLE = "draNodeDevices";

function PodDevices({ clusterId, pod }: { clusterId: ClusterId; pod: KubeObject }) {
  const { t } = useTranslation();
  const namespace = pod.metadata?.namespace ?? null;
  const served = useServed(clusterId, RESOURCE_CLAIM);
  const claims = useNamespaceClaims(clusterId, namespace, served !== null);
  const byName = new Map(claims.items.map((c) => [c.metadata?.name ?? "", c]));
  const known = !claims.loading && !claims.unavailable && !claims.truncated;
  const rows: ReactNode[][] = podClaimsOf(pod).map((c) => {
    const claim = c.claimName ? byName.get(c.claimName) : undefined;
    let source: ReactNode;
    let state: ReactNode;
    if (c.notNeeded) {
      source = t("dra:pod.notNeeded", { template: c.template ?? "" });
      state = null;
    } else if (!c.claimName) {
      source = t("dra:pod.fromTemplate", { template: c.template ?? "" });
      state = <StatusText value={t("dra:pod.notCreated")} tone="warning" />;
    } else {
      source = link({ apiVersion: claim?.apiVersion ?? "resource.k8s.io/v1", kind: "ResourceClaim" }, c.claimName, namespace);
      if (claim) {
        const s = claimState(claim);
        state = <StatusText value={t(`dra:state.${s}`)} tone={STATE_TONE[s]} />;
      } else state = known ? <StatusText value={t("dra:pod.missing")} tone="danger" /> : claims.loading ? t("dra:loading") : t("dra:pod.unknown");
    }
    const devices = claim ? chips(allocatedDevicesOf(claim).map((d) => deviceKey(d))) : null;
    return [c.name, source, state, devices, c.containers.join(", ")];
  });
  const view = table(POD_CLAIMS_TABLE, [t("dra:pod.name"), t("dra:pod.claim"), t("dra:pod.state"), t("dra:pod.devices"), t("dra:pod.containers")], rows, CLAIM_WRAP);
  const waiting = isUnscheduled(pod);
  const message = waiting ? schedulingCondition(pod).message : undefined;
  const reasons = draReasonsIn(message);
  return (
    <Block title={t("dra:pod.title")}>
      {view}
      {waiting && reasons.length > 0 && (
        <>
          <p className="dra-message">{message}</p>
          <DraReasons reasons={reasons} />
        </>
      )}
      {served === null && <p className="dra-muted">{t("dra:pod.notServed")}</p>}
    </Block>
  );
}

export function DraPodSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj || !usesClaims(obj)) return null;
  return <PodDevices clusterId={clusterId} pod={obj} />;
}

function NodeDevices({ clusterId, node }: { clusterId: ClusterId; node: string }) {
  const { t } = useTranslation();
  const slices = useSlices(clusterId, node);
  const claims = useAllClaims(clusterId, slices.items.length > 0);
  if (slices.items.length === 0) return null;
  const allocation = claims.loading || claims.unavailable || claims.truncated ? undefined : allocationIndex(claims.items);
  return (
    <Block title={t("dra:node.title")}>
      <DevicesTable slices={slices.items} allocation={allocation} id={NODE_DEVICES_TABLE} max={NODE_DEVICE_ROWS} />
      {slices.truncated && <p className="dra-muted">{t("dra:node.truncated", { count: MAX_SLICES })}</p>}
    </Block>
  );
}

export function DraNodeSection({ clusterId, obj }: DetailsSectionProps) {
  const served = useServed(clusterId, RESOURCE_SLICE);
  const name = obj?.metadata?.name;
  if (!served || !name) return null;
  return <NodeDevices clusterId={clusterId} node={name} />;
}

export const podApplies = (kind: Parameters<typeof isKind>[0]): boolean => isKind(kind, POD);
export const nodeApplies = (kind: Parameters<typeof isKind>[0]): boolean => isKind(kind, NODE);
