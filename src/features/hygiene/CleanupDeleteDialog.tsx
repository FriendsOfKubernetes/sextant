// The confirmation of the bulk deletion: every object listed, grouped by kind (kind, namespace and name only — no
// values of any kind), a warning when a namespace is among them, and above `TYPE_COUNT_ABOVE` objects the count must
// be typed. Once started, the run goes on to the end unless stopped (the object being deleted is finished first); the
// result lists every object with its outcome (`deleteRun.ts`).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { Button, Dialog, ErrorState } from "../../components";
import { deleteCandidates, deletionOrder, type Outcome } from "./deleteRun";
import { objectName, type Candidate } from "./rules";

/** Above this many objects the user types their number to confirm. */
export const TYPE_COUNT_ABOVE = 20;

export function CleanupDeleteDialog({
  clusterId,
  items,
  current,
  recheck,
  close,
}: {
  clusterId: ClusterId;
  items: Candidate[];
  current: () => ReadonlyMap<string, Candidate>;
  recheck: (namespaces: string[]) => Promise<void>;
  /** `deleted`: keys of the objects deleted (or already gone). */
  close: (deleted: string[]) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stop] = useState(() => ({ requested: false }));
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const count = items.length;
  const needsTyping = count > TYPE_COUNT_ABOVE;
  const ready = !needsTyping || typed.trim() === String(count);
  const busy = progress !== null && outcomes === null;

  const run = async () => {
    setProgress({ done: 0, total: count });
    const result = await deleteCandidates(clusterId, items, {
      current,
      recheck,
      onProgress: (done, total) => setProgress({ done, total }),
      shouldStop: () => stop.requested,
    });
    setOutcomes(result);
  };

  const finish = () => close((outcomes ?? []).filter((o) => o.id === "deleted" || o.id === "gone").map((o) => o.candidate.key));

  if (outcomes) {
    const deleted = outcomes.filter((o) => o.id === "deleted" || o.id === "gone").length;
    const failed = outcomes.filter((o) => o.id === "failed").length;
    return (
      <Dialog
        open
        title={t("hygiene:dialog.resultTitle")}
        onClose={finish}
        footer={
          <Button variant="primary" onClick={finish}>
            {t("common:actions.close")}
          </Button>
        }
      >
        <p>{t("hygiene:dialog.summary", { deleted, kept: outcomes.length - deleted - failed, failed })}</p>
        <ul className="cln-outcomes" aria-label={t("hygiene:dialog.resultTitle")}>
          {outcomes.map((o) => (
            <li key={o.candidate.key} className={`cln-outcome cln-outcome--${o.id}`} data-outcome={o.id}>
              <span className="cln-muted">{o.candidate.kind.kind}</span>
              <span>{objectName(o.candidate)}</span>
              <span>{t(`hygiene:dialog.outcome.${o.id}`)}</span>
              {o.id === "failed" && o.error && <ErrorState error={o.error} title={t(`errors:${o.error.code}`)} />}
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of deletionOrder(items)) {
    const list = groups.get(c.kind.kind);
    if (list) list.push(c);
    else groups.set(c.kind.kind, [c]);
  }
  const closeUnlessBusy = () => {
    if (!busy) close([]);
  };
  return (
    <Dialog
      open
      title={t("hygiene:dialog.title", { count })}
      onClose={closeUnlessBusy}
      footer={
        busy ? (
          <Button
            disabled={stopping}
            onClick={() => {
              stop.requested = true;
              setStopping(true);
            }}
          >
            {t("hygiene:dialog.stop")}
          </Button>
        ) : (
          <>
            <Button onClick={() => close([])}>{t("common:actions.cancel")}</Button>
            <Button variant="danger" disabled={!ready} onClick={() => void run()}>
              {t("hygiene:dialog.confirm")}
            </Button>
          </>
        )
      }
    >
      <p>{t("hygiene:dialog.text")}</p>
      {items.some((c) => c.rule === "namespace") && <p className="cln-note cln-note--warning">{t("hygiene:dialog.namespaceWarning")}</p>}
      <div className="cln-confirm-list">
        {[...groups.entries()].map(([kind, list]) => (
          <section key={kind} aria-label={kind}>
            <h4 className="cln-confirm-list__kind">{t("hygiene:dialog.group", { kind, count: list.length })}</h4>
            <ul className="action-dialog__names">
              {list.map((c) => (
                <li key={c.key}>{objectName(c)}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {needsTyping && !busy && (
        <label className="cln-type-count">
          {t("hygiene:dialog.typeCount", { count })}
          <input className="cln-type-count__input" value={typed} inputMode="numeric" onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      {progress && (
        <p role="status" className="cln-note">
          {t("hygiene:dialog.progress", { done: progress.done, total: progress.total })}
        </p>
      )}
    </Dialog>
  );
}
