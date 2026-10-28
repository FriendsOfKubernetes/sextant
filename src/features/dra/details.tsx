import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of the DRA kinds (section `dra`) and the DRA blocks of Pods and Nodes (#244):
//   ResourceClaim         — its state in words, the node its devices are bound to (or the node selector), who reserved
//                           it, the pod it was made for, its requests (CEL selectors as text) and the devices allocated;
//                           a pending claim lists the namespace's Pending pods that use it with the scheduler's words;
//   ResourceClaimTemplate — the requests its claims will have;
//   DeviceClass           — its CEL selectors as text, the drivers' configuration, the extended resource name;
//   ResourceSlice         — driver, pool, where its devices are, and each device with the claim that holds it;
//   Pod ("Devices")       — each claim it uses: the claim or template, its state and devices, the containers using it,
//                           and, while the pod waits for a node, the scheduler's DRA reasons;
//   Node ("DRA devices")  — the devices of the node's ResourceSlices with the claims that hold them.
// Read-only: nothing here changes the cluster. CEL is never evaluated.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { formatDateTime } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { isUnscheduled, schedulingCondition } from "../autoscaling/scheduling";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ClaimStateCell } from "./columns";
import { allocationIndex, useAllClaims, useNamespacePendingPods } from "./hooks";
import {
  allocatedDevicesOf,
  allocatedNodeOf,
  claimSpecOf,
  claimState,
  classConfigOf,
  classSelectorsOf,
  DEVICE_CLASS,
  draReasonsIn,
  extendedResourceOf,
  generatedFor,
  isAllocated,
  isKind,
  nodeSelectorText,
  podUsesClaim,
  requestsOf,
  reservedForOf,
  RESOURCE_CLAIM,
  RESOURCE_CLAIM_TEMPLATE,
  RESOURCE_SLICE,
  sliceDriver,
  slicePool,
  sliceScope,
  typeOf,
} from "./model";
import { Cel, DevicesTable, DraReasons, RequestsTable } from "./ui";

const { get, num, str } = status;
const LABELS = "dra:fields";
const DEVICE_ROWS = 200;

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

const RESULT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
const RESULTS_TABLE = "draResults";
const CLAIM_REQUESTS_TABLE = "draRequests";
const TEMPLATE_REQUESTS_TABLE = "draTemplateRequests";
const SLICE_DEVICES_TABLE = "draSliceDevices";
const DEVICE_CLASS_KIND = "DeviceClass";

function ResultsTable({ claim }: { claim: KubeObject }) {
  const { t } = useTranslation();
  const rows = allocatedDevicesOf(claim).map((d) => {
    const notes: string[] = [];
    if (d.adminAccess) notes.push(t("dra:results.adminAccess"));
    if (d.bindingFailed.length > 0) notes.push(t("dra:results.bindingFailed", { conditions: d.bindingFailed.join(", ") }));
    if (d.bindingPending.length > 0) notes.push(t("dra:results.bindingPending", { conditions: d.bindingPending.join(", ") }));
    return [d.request, d.driver, `${d.pool} / ${d.device}`, notes.join(" ")];
  });
  const view = table(RESULTS_TABLE, [t("dra:results.request"), t("dra:results.driver"), t("dra:results.device"), t("dra:results.notes")], rows, RESULT_WRAP);
  return <>{view}</>;
}

/** The namespace's Pending pods that use a pending claim, with what the scheduler said. */
function WaitingPods({ clusterId, claim }: { clusterId: ClusterId; claim: KubeObject }) {
  const { t } = useTranslation();
  const namespace = claim.metadata?.namespace ?? null;
  const name = claim.metadata?.name ?? "";
  const pods = useNamespacePendingPods(clusterId, namespace, true);
  if (pods.loading) return <p className="dra-muted">{t("dra:loading")}</p>;
  const waiting = pods.items.filter((p) => podUsesClaim(p, name) && isUnscheduled(p));
  if (waiting.length === 0) return <p className="dra-muted">{t(pods.unavailable ? "dra:waiting.unknown" : "dra:waiting.none")}</p>;
  return (
    <>
      {waiting.map((pod) => {
        const message = schedulingCondition(pod).message;
        return (
          <div key={pod.metadata?.uid ?? pod.metadata?.name} className="dra-waiting">
            {link(KINDS.pod, pod.metadata?.name, namespace)}
            {message && <p className="dra-message">{message}</p>}
            <DraReasons reasons={draReasonsIn(message)} />
          </div>
        );
      })}
    </>
  );
}

function ClaimView({ clusterId, claim }: { clusterId: ClusterId; claim: KubeObject }) {
  const { t } = useTranslation();
  const ns = claim.metadata?.namespace ?? null;
  const node = allocatedNodeOf(claim);
  const selector = node ? [] : nodeSelectorText(get(claim, "status", "allocation", "nodeSelector"));
  const consumers = reservedForOf(claim).map((c) =>
    c.apiGroup === "" && c.resource === "pods" ? link(KINDS.pod, c.name, ns) : `${c.resource}${c.apiGroup ? `.${c.apiGroup}` : ""}/${c.name}`,
  );
  const owner = generatedFor(claim);
  const state = claimState(claim);
  const rows: FieldRow[] = [
    ["state", <ClaimStateCell key="s" obj={claim} />],
    ["node", node ? link(KINDS.node, node) : null],
    ["nodeSelector", chips(selector)],
    ["allocatedAt", date(str(get(claim, "status", "allocation", "allocationTimestamp")))],
    ["madeFor", owner ? link(KINDS.pod, owner, ns) : null],
    ["reservedFor", consumers.length > 0 ? <span className="dt-links">{consumers}</span> : null],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <p className={state === "bindingFailed" ? "dra-message" : "dra-note"}>{t(`dra:hint.${state}`)}</p>
      <Block id="dra:requests.title" title={t("dra:requests.title")}>
        <RequestsTable requests={requestsOf(claimSpecOf(claim))} apiVersion={typeOf(claim, DEVICE_CLASS_KIND).apiVersion} id={CLAIM_REQUESTS_TABLE} />
      </Block>
      {isAllocated(claim) && (
        <Block id="dra:results.title" title={t("dra:results.title")}>
          <ResultsTable claim={claim} />
        </Block>
      )}
      {!isAllocated(claim) && (
        <Block id="dra:waiting.title" title={t("dra:waiting.title")}>
          <WaitingPods clusterId={clusterId} claim={claim} />
        </Block>
      )}
    </>
  );
}

function DeviceClassView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const selectors = classSelectorsOf(obj);
  const config = classConfigOf(obj);
  const classRows: FieldRow[] = [["extendedResource", extendedResourceOf(obj) ?? null]];
  return (
    <>
      <Fields rows={classRows} labelPrefix={LABELS} />
      <Block id="dra:class.selectors" title={t("dra:class.selectors")}>
        {selectors.length > 0 ? <Cel expressions={selectors} /> : <p className="dra-muted">{t("dra:class.noSelectors")}</p>}
        <p className="dra-muted">{t("dra:class.celNote")}</p>
      </Block>
      {config.length > 0 && (
        <Block id="dra:class.config" title={t("dra:class.config")}>
          {config.map((c, i) => (
            <div key={`${c.driver}:${i}`} className="dra-config">
              <strong>{c.driver}</strong>
              {c.parameters && <pre className="dt-pre">{c.parameters}</pre>}
            </div>
          ))}
        </Block>
      )}
    </>
  );
}

function SliceView({ clusterId, slice }: { clusterId: ClusterId; slice: KubeObject }) {
  const { t } = useTranslation();
  const open = useDetailsDisclosure("dra:devices.title")?.open ?? true;
  const claims = useAllClaims(clusterId, open);
  const scope = sliceScope(slice);
  const rows: FieldRow[] = [
    ["driver", sliceDriver(slice)],
    ["pool", slicePool(slice)],
    ["poolGeneration", String(num(get(slice, "spec", "pool", "generation")) ?? "")],
    ["poolSlices", String(num(get(slice, "spec", "pool", "resourceSliceCount")) ?? "")],
    ["reach", scope.type === "node" ? link(KINDS.node, scope.node) : t(`dra:scope.${scope.type}`)],
    ["nodeSelector", scope.type === "selector" ? chips(scope.text) : null],
  ];
  const allocation = claims.loading || claims.unavailable || claims.truncated ? undefined : allocationIndex(claims.items);
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block id="dra:devices.title" title={t("dra:devices.title")}>
        <DevicesTable slices={[slice]} allocation={allocation} id={SLICE_DEVICES_TABLE} max={DEVICE_ROWS} />
      </Block>
    </>
  );
}

export function DraSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, RESOURCE_CLAIM)) return <ClaimView clusterId={clusterId} claim={obj} />;
  if (isKind(kind, RESOURCE_CLAIM_TEMPLATE)) {
    return (
      <Block id="dra:requests.title" title={t("dra:requests.title")}>
        <RequestsTable requests={requestsOf(claimSpecOf(obj))} apiVersion={typeOf(obj, DEVICE_CLASS_KIND).apiVersion} id={TEMPLATE_REQUESTS_TABLE} />
      </Block>
    );
  }
  if (isKind(kind, DEVICE_CLASS)) return <DeviceClassView obj={obj} />;
  if (isKind(kind, RESOURCE_SLICE)) return <SliceView clusterId={clusterId} slice={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof isKind>[0]): boolean =>
  [RESOURCE_CLAIM, RESOURCE_CLAIM_TEMPLATE, DEVICE_CLASS, RESOURCE_SLICE].some((k) => isKind(kind, k));
