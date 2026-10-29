import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ForwardInfo } from "../../api";
import { ConfirmDialog } from "../../components";
import { formatNumber } from "../../i18n/format";
import { getPortForwards, stopForward } from "./hooks";
import { isInternal, targetName } from "./model";

/** A confirmed snapshot of targets; events can remove entries while earlier commands are still in flight. */
export function useBulkStop() {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<ForwardInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const stop = async (rows: ForwardInfo[]) => {
    setTargets(null);
    setBusy(true);
    setError(null);
    let failure: ApiError | null = null;
    for (const row of rows) {
      const current = getPortForwards();
      if (current.pending.has(row.id) || !current.forwards.some(f => f.id === row.id && !isInternal(f))) continue;
      try { await stopForward(row.id, true); }
      catch (err) { failure = toApiError(err); }
    }
    setError(failure);
    setBusy(false);
  };
  return {
    busy, error, ask: setTargets,
    confirmation: targets && <ConfirmDialog open title={t("portforward:confirm.title")}
      confirmLabel={t("portforward:actions.stop")} danger onCancel={() => setTargets(null)} onConfirm={() => void stop(targets)}>
      <p>{t("portforward:confirm.many", { value: formatNumber(targets.length) })}</p>
      <ul className="pf-confirm-targets">{targets.map(f => <li key={f.id}>
        {t(`portforward:target.${f.target.type}`, { name: targetName(f.target) })}
        <span className="pf-route">{t("portforward:ports", { local: f.localPort, remote: f.remotePort })}</span>
      </li>)}</ul>
    </ConfirmDialog>,
  };
}
