// Details of a SealedSecret (section `sealedSecrets`): the Synced condition with the controller's error and what it
// means, the scope it was sealed for, the target Secret (a link and how it stands to the SealedSecret, from its
// metadata only), the template's type and flags, the sealed keys by name and sealed size, and the controller found in
// the cluster with its sealing keys (metadata only). Conditions, events and YAML are the panel's own sections.
// Read-only; no value, sealed or decrypted, is shown here (ADR-0109).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatDateTime } from "../../i18n";
import { StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { formatBytes } from "../metrics/format";
import { SyncCell } from "./columns";
import { useControllers, useSealingKeys, useTargetSecret } from "./hooks";
import {
  controllerSummary,
  failureHint,
  isSealedSecret,
  keyState,
  RELATION_TONE,
  scopeOf,
  sealedKeys,
  syncOf,
  targetName,
  targetRelation,
  templateOf,
  usesLegacyData,
} from "./model";

const LABELS = "sealedsecrets:fields";
const DEPLOYMENT_TYPE = { apiVersion: "apps/v1", kind: "Deployment" };

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** How the target Secret stands: missing, owned by this SealedSecret, taken over, or in the controller's way. */
function TargetState({ clusterId, sealed }: { clusterId: ClusterId; sealed: KubeObject }) {
  const { t } = useTranslation();
  const { value, error } = useTargetSecret(clusterId, sealed.metadata?.namespace, targetName(sealed));
  if (error) return <span className="ss-muted">{t("sealedsecrets:target.unknown")}</span>;
  if (value === undefined) return <span className="ss-muted">{t("sealedsecrets:loading")}</span>;
  if (value === null) return <StatusText value={t("sealedsecrets:target.missing")} tone="danger" />;
  const relation = targetRelation(sealed, value);
  return <StatusText value={t(`sealedsecrets:target.${relation}`)} tone={RELATION_TONE[relation]} />;
}

/** The controller's error and what it means. */
function Failure({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const sync = syncOf(obj);
  const legacy = usesLegacyData(obj);
  if (sync.state !== "failed" || !sync.message) {
    if (sync.noStatus) return <p className="ss-note">{t("sealedsecrets:noStatus")}</p>;
    if (sync.stale) return <p className="ss-note">{t("sealedsecrets:stale")}</p>;
    return legacy ? <p className="ss-note">{t("sealedsecrets:hint.legacyData")}</p> : null;
  }
  const hint = failureHint(sync.message);
  return (
    <Block title={t("sealedsecrets:lastError")}>
      <p className="ss-message">{sync.message}</p>
      {hint && <p className="ss-note">{t(`sealedsecrets:hint.${hint}`)}</p>}
    </Block>
  );
}

const KEYS_WRAP: ColumnWrap[] = ["nowrap", "nowrap"];

function Keys({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const keys = sealedKeys(obj);
  const templated = templateOf(obj).dataKeys.map((k) => (k.omitted ? t("sealedsecrets:keys.omitted", { name: k.name }) : k.name));
  const keysTable = table(
    "sealedSecretKeys",
    [t("sealedsecrets:keys.name"), t("sealedsecrets:keys.size")],
    keys.map((k) => [k.name, formatBytes(k.sealedBytes)]),
    KEYS_WRAP,
  );
  const rows: FieldRow[] = [["templated", chips(templated)]];
  if (keys.length === 0 && templated.length === 0) return null;
  return (
    <Block title={t("sealedsecrets:keys.title")}>
      <p className="ss-muted">{t("sealedsecrets:keys.namesOnly")}</p>
      {keysTable}
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}

const CONTROLLER_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined];
const KEY_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

function SealingKeys({ clusterId, namespaces }: { clusterId: ClusterId; namespaces: string[] }) {
  const { t } = useTranslation();
  const { value } = useSealingKeys(clusterId, namespaces);
  const rows = (value ?? []).map((s) => [
    link(KINDS.secret, s.metadata?.name, s.metadata?.namespace ?? null),
    keyState(s) ?? "",
    date(typeof s.metadata?.creationTimestamp === "string" ? s.metadata.creationTimestamp : undefined),
  ]);
  const keysTable = table(
    "sealedSecretSealingKeys",
    [t("sealedsecrets:sealingKeys.name"), t("sealedsecrets:sealingKeys.state"), t("sealedsecrets:sealingKeys.created")],
    rows,
    KEY_WRAP,
  );
  return (
    <>
      <h4 className="ss-subtitle">{t("sealedsecrets:sealingKeys.title")}</h4>
      {value === undefined ? <p className="ss-muted">{t("sealedsecrets:loading")}</p> : keysTable}
      {value !== undefined && rows.length === 0 && <p className="ss-muted">{t("sealedsecrets:sealingKeys.none")}</p>}
      <p className="ss-muted">{t("sealedsecrets:sealingKeys.certificateNotShown")}</p>
    </>
  );
}

/** The controller found in the cluster by kubeseal's default name or the Helm chart's label. */
function Controller({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { deployments, error } = useControllers(clusterId);
  let body: ReactNode;
  if (deployments === undefined) body = <p className="ss-muted">{t("sealedsecrets:loading")}</p>;
  else if (deployments.length === 0)
    body = <p className="ss-note">{t(error ? "sealedsecrets:controller.cannotRead" : "sealedsecrets:controller.notFound")}</p>;
  else {
    const rows = deployments.map((d) => {
      const s = controllerSummary(d);
      const tone = s.ready >= s.desired && s.desired > 0 ? "success" : "danger";
      return [
        link(DEPLOYMENT_TYPE, d.metadata?.name, d.metadata?.namespace ?? null),
        <StatusText key="r" value={t("sealedsecrets:controller.ready", { ready: s.ready, desired: s.desired })} tone={tone} />,
        chips(s.images),
      ];
    });
    const namespaces = [...new Set(deployments.map((d) => d.metadata?.namespace ?? "").filter(Boolean))];
    const controllers = table(
      "sealedSecretController",
      [t("sealedsecrets:controller.deployment"), t("sealedsecrets:controller.replicas"), t("sealedsecrets:controller.image")],
      rows,
      CONTROLLER_WRAP,
    );
    body = (
      <>
        {controllers}
        <SealingKeys clusterId={clusterId} namespaces={namespaces} />
      </>
    );
  }
  return <Block title={t("sealedsecrets:controller.title")}>{body}</Block>;
}

function SealedSecretView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const sync = syncOf(obj);
  const scope = scopeOf(obj);
  const template = templateOf(obj);
  const yesNo = (v: boolean | undefined) => (v === undefined ? null : t(v ? "sealedsecrets:yes" : "sealedsecrets:no"));
  const rows: FieldRow[] = [
    ["status", <SyncCell key="s" obj={obj} />],
    ["since", date(sync.since)],
    ["checked", date(sync.checked)],
    [
      "generation",
      sync.observedGeneration !== undefined && sync.generation !== undefined
        ? t("sealedsecrets:generation", { observed: sync.observedGeneration, generation: sync.generation })
        : null,
    ],
    ["scope", t(`sealedsecrets:scopeHint.${scope}`, { scope: t(`sealedsecrets:scope.${scope}`) })],
    ["target", link(KINDS.secret, targetName(obj), ns)],
    ["targetState", <TargetState key="ts" clusterId={clusterId} sealed={obj} />],
    ["type", template.type],
    ["immutable", yesNo(template.immutable)],
    ["ownerReference", t(template.skipOwnerReferences ? "sealedsecrets:ownerReference.skipped" : "sealedsecrets:ownerReference.set")],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <Failure obj={obj} />
      <Keys obj={obj} />
      <Controller clusterId={clusterId} />
    </>
  );
}

export function SealedSecretsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isSealedSecret(objectRef.kind)) return null;
  return <SealedSecretView clusterId={clusterId} obj={obj} />;
}

export const appliesTo = isSealedSecret;
