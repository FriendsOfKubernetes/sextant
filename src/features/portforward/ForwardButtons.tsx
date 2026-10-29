import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ForwardInfo } from "../../api";
import { Button, ConfirmDialog } from "../../components";
import { copyText } from "../copy-name/clipboard";
import { stopForward, usePortForwards } from "./hooks";
import { isInternal, urlOf } from "./model";
import { openInBrowser } from "./openInBrowser";

/** Command feedback belongs to the surface, so removing a row cannot hide its failure. */
export function useForwardControls() {
  const state = usePortForwards();
  const { t } = useTranslation();
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<ForwardInfo | null>(null);
  const stop = async (forward: ForwardInfo) => {
    setActionError(null);
    try { await stopForward(forward.id); }
    catch (err) { setActionError(toApiError(err)); }
  };
  return {
    ...state,
    requestStop: (forward: ForwardInfo) => {
      if (isInternal(forward)) setConfirm(forward);
      else void stop(forward);
    },
    actionError,
    confirmation: confirm && <ConfirmDialog open title={t("portforward:confirm.title")} confirmLabel={t("portforward:actions.stop")} danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void stop(confirm); }}>
        <p>{t(`portforward:target.${confirm.target.type}`, { name: `${confirm.target.namespace}/${confirm.target.name}` })}</p>
        <p className="pf-route">{t("portforward:ports", { local: confirm.localPort, remote: confirm.remotePort })}</p>
        <p>{t(confirm.source === "vcluster" ? "portforward:confirm.vcluster" : "portforward:confirm.internal")}</p>
      </ConfirmDialog>,
  };
}

export function ForwardButtons({ forward, pending, onStop, onRetry }: {
  forward: ForwardInfo; pending: boolean; onStop: () => void; onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const failed = forward.status.state === "error";
  return <span className="pf-actions">
    <Button size="compact" iconOnly icon="external" label={t("portforward:actions.open")} disabled={failed || pending} onClick={() => openInBrowser(forward)} />
    <Button size="compact" iconOnly icon="copy" label={t("portforward:actions.copy")} disabled={pending} onClick={() => void copyText(urlOf(forward))} />
    {failed && !isInternal(forward) && onRetry && <Button size="compact" iconOnly icon="refresh" label={t("portforward:actions.retry")} disabled={pending} onClick={onRetry} />}
    <Button size="compact" disabled={pending} onClick={onStop}>{t(failed ? "portforward:actions.remove" : "portforward:actions.stop")}</Button>
  </span>;
}
