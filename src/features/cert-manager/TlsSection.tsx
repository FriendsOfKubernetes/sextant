// "Certificate" in the details of a TLS Secret (`kubernetes.io/tls`, or any Secret with a `tls.crt` key), with or
// without cert-manager: the backend reads the Secret with the user's credentials and parses `tls.crt` and `ca.crt`
// (`api.tls.certificateInfo`); only the certificates' fields come here, never a value. Read again when the Secret
// changes (its resourceVersion). The Certificate that issued it is linked when cert-manager's annotation names one.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type CertificateInfo, type ClusterId, type KubeObject, type SecretCertificates } from "../../api";
import { ErrorState, LoadingIndicator } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { Block, chips, Fields, link, type FieldRow } from "../details";
import { formatDateTime } from "../../i18n";
import { ExpiryText } from "./details";
import { annotationOf, CERT_MANAGER_GROUP } from "./model";

const LABELS = "certmanager:tls.fields";
/** cert-manager's annotation on the Secrets it writes. */
export const SECRET_CERTIFICATE_ANNOTATION = "cert-manager.io/certificate-name";
export const TLS_SECRET_TYPE = "kubernetes.io/tls";

/** A Secret that holds a certificate: a TLS Secret, or one with a `tls.crt` key (its value is hidden, the key is not). */
export function holdsCertificate(obj: KubeObject | null): boolean {
  if (!obj) return false;
  if ((obj as { type?: unknown }).type === TLS_SECRET_TYPE) return true;
  const data = (obj as { data?: unknown }).data;
  return typeof data === "object" && data !== null && "tls.crt" in data;
}

type Load = { state: "loading" } | { state: "ready"; info: SecretCertificates } | { state: "error"; error: ApiError };

function useCertificates(clusterId: ClusterId, namespace: string, name: string, version: string | undefined): Load {
  const [load, setLoad] = useState<{ key: string; value: Load } | null>(null);
  const key = JSON.stringify([clusterId, namespace, name, version ?? ""]);
  useEffect(() => {
    let cancelled = false;
    api.tls.certificateInfo(clusterId, namespace, name).then(
      (info) => !cancelled && setLoad({ key, value: { state: "ready", info } }),
      (err: unknown) => !cancelled && setLoad({ key, value: { state: "error", error: toApiError(err) } }),
    );
    return () => {
      cancelled = true;
    };
    // `key` stands for the arguments.
  }, [key]);
  return load?.key === key ? load.value : { state: "loading" };
}

/** The fields of one certificate. */
function certificateRows(cert: CertificateInfo, t: (key: string, options?: Record<string, unknown>) => string): FieldRow[] {
  const key = [cert.keyAlgorithm, cert.keySize ? String(cert.keySize) : undefined].filter(Boolean).join(" ");
  return [
    ["subject", cert.subject],
    ["dnsNames", chips(cert.dnsNames)],
    ["ipAddresses", chips(cert.ipAddresses)],
    ["uris", chips(cert.uris)],
    ["emails", chips(cert.emails)],
    ["issuer", cert.selfSigned ? t("certmanager:tls.selfSigned") : cert.issuer],
    ["notBefore", <time key="b" dateTime={cert.notBefore}>{formatDateTime(cert.notBefore)}</time>],
    ["notAfter", <ExpiryText key="a" notAfter={cert.notAfter} notBefore={cert.notBefore} />],
    ["key", key],
    ["signature", cert.signatureAlgorithm],
    ["serial", <code key="s">{cert.serial}</code>],
    ["fingerprint", <code key="f" className="cm-fingerprint">{cert.fingerprintSha256}</code>],
    ["isCA", cert.isCa ? t("certmanager:yes") : undefined],
  ];
}

/** One line per certificate of a list: its common name (or subject) and when it expires. */
function certificateList(list: readonly CertificateInfo[]): ReactNode {
  if (list.length === 0) return null;
  return (
    <ol className="cm-cert-list">
      {list.map((c) => (
        <li key={c.fingerprintSha256}>
          <span className="cm-cert-list__name" title={c.subject}>
            {c.commonName ?? c.subject}
          </span>
          <ExpiryText notAfter={c.notAfter} notBefore={c.notBefore} />
        </li>
      ))}
    </ol>
  );
}

function errorText(error: ApiError, t: (key: string) => string): string | undefined {
  if (error.code === "forbidden") return t("certmanager:tls.forbidden");
  if (error.code === "notFound") return t("certmanager:tls.noCertificate");
  if (error.code === "invalid") return t("certmanager:tls.invalid");
  return undefined;
}

export function TlsCertificateView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  const version = obj.metadata?.resourceVersion;
  const load = useCertificates(clusterId, namespace, name, typeof version === "string" ? version : undefined);
  const issuedBy = annotationOf(obj, SECRET_CERTIFICATE_ANNOTATION);
  const owner = issuedBy
    ? link({ apiVersion: `${CERT_MANAGER_GROUP}/v1`, kind: "Certificate" }, issuedBy, namespace)
    : null;

  if (load.state === "loading") return <LoadingIndicator text={t("certmanager:tls.loading")} />;
  if (load.state === "error") {
    const known = errorText(load.error, t);
    return known ? <p className="cm-muted">{known}</p> : <ErrorState title={t("certmanager:tls.failed")} error={load.error} />;
  }
  const { chain, ca, caInvalid, chainTruncated } = load.info;
  const leaf = chain[0];
  if (!leaf) return <p className="cm-muted">{t("certmanager:tls.noCertificate")}</p>;
  const rows: FieldRow[] = [
    ["issuedBy", owner],
    ...certificateRows(leaf, t),
    ["chain", t("certmanager:tls.chainLength", { count: chain.length })],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {chain.length > 1 && (
        <Block id="certmanager:tls.chainTitle" title={t("certmanager:tls.chainTitle")}>
          {certificateList(chain)}
          {chainTruncated && <p className="cm-muted">{t("certmanager:tls.truncated")}</p>}
        </Block>
      )}
      {(ca.length > 0 || caInvalid) && (
        <Block id="certmanager:tls.caTitle" title={t("certmanager:tls.caTitle")}>
          {caInvalid ? <p className="cm-muted">{t("certmanager:tls.caInvalid")}</p> : certificateList(ca)}
        </Block>
      )}
    </>
  );
}

/** The `tlsCertificate` details section of Secrets. */
export function TlsCertificateSection({ clusterId, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj || !holdsCertificate(obj)) return null;
  return (
    <Block id="certmanager:tls.title" title={t("certmanager:tls.title")}>
      <TlsCertificateView clusterId={clusterId} obj={obj} />
    </Block>
  );
}
