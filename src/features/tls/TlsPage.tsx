// "TLS certificates" (Config section): the `kubernetes.io/tls` Secrets of the namespaces in view, soonest to expire
// first, with or without cert-manager. The backend lists them with the user's credentials and returns only when each
// certificate expires and whom it is for (`api.tls.expiryScan`, at most 1000 Secrets); it runs when the page opens,
// when the namespace filter changes and on "Refresh" — never in the background, since every scan reads the Secrets
// (keys included) from the API server. The expiry warning setting can be changed here too (as in Settings).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type TlsExpiry, type TlsExpiryScan } from "../../api";
import { Button, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { formatDateTime, formatList } from "../../i18n";
import { KINDS, link } from "../details";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { useNow } from "../problems/hooks";
import { CertExpiryField } from "../notifications/CertExpiryField";
import { useExpiryDays } from "./hooks";
import { EXPIRY_TONE, expiryOf } from "./model";
import { ResizableTable } from "../../components/Table";

/** `tls::SCAN_MAX_NAMESPACES` in the backend. */
const SCAN_MAX_NAMESPACES = 200;

type Scan = { state: "loading" } | { state: "ready"; scan: TlsExpiryScan } | { state: "error"; error: ApiError };

function useScan(clusterId: ClusterId, namespaces: string[] | null | undefined, round: number): Scan {
  const [result, setResult] = useState<{ key: string; value: Scan } | null>(null);
  // `undefined` (the filter not restored yet) is a key of its own: the scan starts once it is known.
  const key = JSON.stringify([clusterId, namespaces === undefined ? "?" : namespaces, round]);
  useEffect(() => {
    // The namespace filter is restored from the settings first: no scan of everything before it is known.
    if (namespaces === undefined) return;
    let cancelled = false;
    api.tls.expiryScan(clusterId, namespaces).then(
      (scan) => !cancelled && setResult({ key, value: { state: "ready", scan } }),
      (err: unknown) => !cancelled && setResult({ key, value: { state: "error", error: toApiError(err) } }),
    );
    return () => {
      cancelled = true;
    };
    // `key` stands for the arguments.
  }, [key]);
  return result?.key === key ? result.value : { state: "loading" };
}

function ExpiryCell({ item, now, days }: { item: TlsExpiry; now: number; days: number }) {
  const { t } = useTranslation();
  if (item.invalid) return <StatusText value={t("tls:page.unreadable")} tone="danger" />;
  const expiry = expiryOf(item.notAfter ?? undefined, now, days);
  if (!expiry) return null;
  const text =
    expiry.state === "expired" ? t("tls:expiry.expired") : t("tls:expiry.daysLeft", { count: Math.max(0, expiry.daysLeft) });
  return <StatusText value={text} tone={EXPIRY_TONE[expiry.state]} />;
}

export function TlsCertificatesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  const [round, setRound] = useState(0);
  const scan = useScan(clusterId, namespaces, round);
  const days = useExpiryDays();
  const now = useNow(60_000);

  const items = scan.state === "ready" ? scan.scan.items : [];
  const warned = items.filter((i) => {
    const state = i.invalid ? "invalid" : expiryOf(i.notAfter ?? undefined, now, days)?.state;
    return state === "invalid" || state === "expired" || state === "expiring";
  }).length;

  return (
    <div className="cm-page">
      <h2 className="cm-page__title">{t("tls:page.title")}</h2>
      <p className="cm-muted">{t("tls:page.hint")}</p>
      <div className="cm-page__toolbar">
        <NamespaceFilter clusterId={clusterId} />
        <CertExpiryField className="cm-threshold" />
        <Button size="compact" icon="refresh" disabled={scan.state === "loading"} onClick={() => setRound((n) => n + 1)}>
          {t("tls:page.refresh")}
        </Button>
        {scan.state === "ready" && (
          <span className="cm-muted" role="status">
            {warned > 0
              ? t("tls:page.totalWarned", { count: items.length, warned })
              : t("tls:page.total", { count: items.length })}
          </span>
        )}
      </div>

      {scan.state === "loading" && <LoadingIndicator text={t("tls:page.loading")} />}
      {scan.state === "error" && (
        <ErrorState
          title={scan.error.code === "forbidden" ? t("tls:page.forbidden") : t("tls:page.failed")}
          error={scan.error}
          onRetry={() => setRound((n) => n + 1)}
        />
      )}
      {scan.state === "ready" && (
        <>
          {scan.scan.forbidden.length > 0 && (
            <p className="cm-muted">{t("tls:page.forbiddenIn", { namespaces: formatList(scan.scan.forbidden) })}</p>
          )}
          {scan.scan.truncated && <p className="cm-muted">{t("tls:page.truncated", { count: items.length })}</p>}
          {scan.scan.namespacesTruncated && <p className="cm-muted">{t("tls:page.namespacesTruncated", { count: SCAN_MAX_NAMESPACES })}</p>}
          {items.length === 0 ? (
            <p className="cm-muted">{t("tls:page.none")}</p>
          ) : (
            <ResizableTable tableId="certManager.tls" className="cm-table">
              <thead>
                <tr>
                  <th>{t("tls:page.columns.name")}</th>
                  <th>{t("tls:page.columns.namespace")}</th>
                  <th>{t("tls:page.columns.names")}</th>
                  <th>{t("tls:page.columns.issuer")}</th>
                  <th>{t("tls:page.columns.notAfter")}</th>
                  <th>{t("tls:page.columns.expires")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.namespace}/${item.name}`}>
                    <td>{link(KINDS.secret, item.name, item.namespace)}</td>
                    <td>{item.namespace}</td>
                    <td className="cm-table__names">{formatList(item.dnsNames.length > 0 ? item.dnsNames : item.commonName ? [item.commonName] : [])}</td>
                    <td>{item.issuerCommonName}</td>
                    <td>{item.notAfter ? <time dateTime={item.notAfter}>{formatDateTime(item.notAfter)}</time> : null}</td>
                    <td>
                      <ExpiryCell item={item} now={now} days={days} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          )}
        </>
      )}
    </div>
  );
}
