// Columns of the cert-manager tables. Every kind with a Ready condition shows it colored with its reason; Certificates
// also show the Secret, the issuer and when the certificate expires (colored by the expiry warning setting); Orders
// and Challenges show their ACME state and reason.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { status } from "../../resources";
import { useExpiryDays } from "./hooks";
import {
  acmeReason,
  acmeState,
  acmeTone,
  certificateFields,
  certificateNameOf,
  challengeType,
  EXPIRY_TONE,
  expiryOf,
  issuerRefOf,
  issuerText,
  issuerType,
  ownerName,
  readyMessage,
  readyReason,
  readyStatus,
  readyTone,
} from "./model";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `certmanager:columns.${id}`,
  value,
  ...options,
});

function Truncated({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <span title={text}>{text}</span>;
}

const readyColumn = col("ready", readyStatus, {
  width: "80px",
  render: (o) => {
    const value = readyStatus(o);
    return value ? <StatusText value={value} tone={readyTone(value)} /> : null;
  },
});

const reasonColumn = col("reason", readyReason, { width: "minmax(100px, 1fr)" });

const statusColumn = col("status", readyMessage, {
  width: "minmax(180px, 3fr)",
  render: (o) => <Truncated text={readyMessage(o)} />,
});

const issuerColumn = col("issuer", (o) => issuerText(issuerRefOf(o)), { width: "minmax(120px, 1fr)" });

/** Days until expiry, colored by the expiry warning setting. */
function ExpiresIn({ notAfter, now }: { notAfter: string | undefined; now: number }) {
  const { t } = useTranslation();
  const days = useExpiryDays();
  const expiry = expiryOf(notAfter, now, days);
  if (!expiry || !notAfter) return null;
  const text =
    expiry.state === "expired"
      ? t("certmanager:expiry.expired")
      : t("certmanager:expiry.daysLeft", { count: Math.max(0, expiry.daysLeft) });
  return (
    <span title={notAfter}>
      <StatusText value={text} tone={EXPIRY_TONE[expiry.state]} />
    </span>
  );
}

const expiresColumn = col("expires", (o) => certificateFields(o).notAfter, {
  width: "110px",
  render: (o, ctx) => <ExpiresIn notAfter={certificateFields(o).notAfter} now={ctx.now} />,
});

const secretColumn = col("secret", (o) => certificateFields(o).secretName, { width: "minmax(120px, 1fr)" });

export const certificateColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  readyColumn,
  secretColumn,
  issuerColumn,
  expiresColumn,
  statusColumn,
  ageColumn,
];

/** A CertificateRequest's approval: Denied wins, then Approved=True; `pending` without either. */
export function approvalOf(o: KubeObject): "approved" | "denied" | "pending" {
  const conditions = status.arr(get(o, "status", "conditions"));
  const has = (type: string) => conditions.some((c) => get(c, "type") === type && get(c, "status") === "True");
  if (has("Denied")) return "denied";
  return has("Approved") ? "approved" : "pending";
}

const APPROVAL_TONE = { approved: "success", denied: "danger", pending: "warning" } as const;

function Approval({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const value = approvalOf(obj);
  return <StatusText value={t(`certmanager:approval.${value}`)} tone={APPROVAL_TONE[value]} />;
}

const approvedColumn = col("approved", approvalOf, { width: "100px", render: (o) => <Approval obj={o} /> });

const ownerCertificateColumn = col("certificate", certificateNameOf, { width: "minmax(120px, 1fr)" });

export const requestColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  approvedColumn,
  readyColumn,
  reasonColumn,
  ownerCertificateColumn,
  issuerColumn,
  statusColumn,
  ageColumn,
];

const typeColumn = col("type", (o) => issuerType(o), { width: "100px" });

export const issuerColumns = (namespaced: boolean): ColumnDef[] => [
  nameColumn,
  ...(namespaced ? [namespaceColumn] : []),
  readyColumn,
  typeColumn,
  reasonColumn,
  statusColumn,
  ageColumn,
];

const stateColumn = col("state", acmeState, {
  width: "100px",
  render: (o) => {
    const value = acmeState(o);
    return value ? <StatusText value={value} tone={acmeTone(value)} /> : null;
  },
});

const acmeReasonColumn = col("acmeReason", acmeReason, {
  width: "minmax(200px, 3fr)",
  render: (o) => <Truncated text={acmeReason(o)} />,
});

const requestOwnerColumn = col("request", (o) => ownerName(o, "CertificateRequest"), { width: "minmax(120px, 1fr)" });

export const orderColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, requestOwnerColumn, acmeReasonColumn, ageColumn];

const domainColumn = col("domain", (o) => str(get(o, "spec", "dnsName")), { width: "minmax(140px, 2fr)" });
const challengeTypeColumn = col("challengeType", challengeType, { width: "90px" });

export const challengeColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn,
  domainColumn,
  challengeTypeColumn,
  acmeReasonColumn,
  ageColumn,
];
