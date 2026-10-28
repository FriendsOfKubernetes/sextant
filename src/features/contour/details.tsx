// Details of Contour's objects (#233), one section for every kind of the section:
//   HTTPProxy                — see proxyDetails.tsx;
//   TLSCertificateDelegation — each delegated Secret (a link) and the namespaces that may use it ("*": all);
//   ExtensionService         — its state with Contour's errors, the Services behind it (links) with weights, the
//                              protocol, timeouts and load balancing.
// Conditions and YAML are the panel's own sections. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import {
  contourKind,
  delegationsOf,
  EXTENSION_SERVICE,
  extensionFields,
  HEALTH_TONE,
  healthOf,
  HTTP_PROXY,
  sameKind,
  TLS_DELEGATION,
  validCondition,
} from "./model";
import { Issues, ProxyView } from "./proxyDetails";

const LABELS = "contour:fields";
const DELEGATIONS_WRAP: ColumnWrap[] = ["nowrap", undefined];
const SERVICES_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

function DelegationView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? null;
  const rows = delegationsOf(obj).map((d) => [
    link(KINDS.secret, d.secretName, namespace),
    d.targetNamespaces.includes("*") ? t("contour:delegations.all") : chips(d.targetNamespaces),
  ]);
  const headers = [t("contour:delegations.secret"), t("contour:delegations.targets")];
  const body = table("contourDelegations", headers, rows, DELEGATIONS_WRAP);
  return (
    <>
      <p className="cm-explain">{t("contour:delegations.explain")}</p>
      {body ?? <p className="cm-muted">{t("contour:delegations.none")}</p>}
    </>
  );
}

function ExtensionView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const f = extensionFields(obj);
  const health = healthOf(EXTENSION_SERVICE, obj);
  const namespace = obj.metadata?.namespace ?? null;
  const failed = validCondition(obj)?.status === "False";
  const fields: FieldRow[] = [
    ["status", <StatusText key="s" value={t(`contour:health.${health}`)} tone={HEALTH_TONE[health]} />],
    ["protocol", f.protocol],
    ["timeout", f.timeout],
    ["idleTimeout", f.idleTimeout],
    ["loadBalancing", f.loadBalancing],
    ["upstreamValidation", f.validated ? t("contour:yes") : null],
  ];
  const rows = f.services.map((s) => [link(KINDS.service, s.name, namespace), s.port === undefined ? "" : String(s.port), s.weight === undefined ? "" : String(s.weight)]);
  const headers = [t("contour:extension.service"), t("contour:extension.port"), t("contour:extension.weight")];
  const services = table("contourExtensionServices", headers, rows, SERVICES_WRAP);
  return (
    <>
      {failed && <p className="cm-explain cm-explain--danger">{t("contour:explain.extensionInvalid", { reason: validCondition(obj)?.errors[0]?.reason ?? validCondition(obj)?.reason ?? "" })}</p>}
      <Fields rows={fields} labelPrefix={LABELS} />
      <Issues obj={obj} />
      {services && <Block id="contour:extension.services" title={t("contour:extension.services")}>{services}</Block>}
    </>
  );
}

export function ContourSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = contourKind(objectRef.kind);
  if (!obj || !def) return null;
  const kind = def.kind;
  const view = sameKind(kind, HTTP_PROXY) ? (
    <ProxyView clusterId={clusterId} obj={obj} />
  ) : sameKind(kind, TLS_DELEGATION) ? (
    <DelegationView obj={obj} />
  ) : (
    <ExtensionView obj={obj} />
  );
  return <Block id="details:sections.fields" title={t("details:sections.fields", { kind: kind.kind })}>{view}</Block>;
}
