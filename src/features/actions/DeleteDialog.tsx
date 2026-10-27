// The confirmation, progress and result of Delete, for one object or a selection (ADR-0126). Nothing reaches the
// cluster before "Delete". The confirmation names the objects (the first MAX_LISTED, then a count), marks those a
// controller or a GitOps tool will likely create again, warns that a Namespace takes everything inside along, and above
// TYPE_COUNT_ABOVE objects (the Cleanup page's rule, ADR-0081) the count must be typed. While it runs, Escape, × and
// the backdrop do nothing; several objects get a progress line and "Stop", which starts nothing more. The end lists
// every object with its outcome unless every one was deleted; one object deleted (or already gone) closes the dialog.
// The run lives in `deleteStore.ts` under the dialog entry's id, so the dialog unmounting neither loses it nor lets a
// remount start a second one.
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject, ObjectRef } from "../../api";
import { Button, Dialog, ErrorState } from "../../components";
import { TYPE_COUNT_ABOVE } from "../hygiene/CleanupDeleteDialog";
import { MAX_LISTED, planDelete, type DeleteItem, type DeleteOutcome } from "./deleteRun";
import { deleteRunOf, forgetDeleteRun, newDeleteRunId } from "./deleteStore";

/** "demo/web" for a namespaced object, "node-1" otherwise. */
const nameOf = (r: ObjectRef): string => (r.namespace ? `${r.namespace}/${r.name}` : r.name);

export function DeleteDialog({
  clusterId,
  kind,
  refs,
  objects,
  close,
  runId,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  refs: ObjectRef[];
  /** The watched objects of `refs` (same order): their uids are sent as preconditions, their owners warned about. */
  objects?: KubeObject[];
  close: () => void;
  /** The dialog entry's id: the run is kept under it across unmounts (one is made when absent). */
  runId?: string;
}) {
  const { t } = useTranslation();
  const [ownId] = useState(newDeleteRunId);
  const run = deleteRunOf(runId ?? ownId, clusterId, () => planDelete(refs, objects));
  const { phase, current, stopRequested, outcomes } = useSyncExternalStore(run.subscribe, run.snapshot, run.snapshot);
  const [typed, setTyped] = useState("");
  const { items } = run;
  const count = items.length;
  const single = count === 1;
  const needsTyping = count > TYPE_COUNT_ABOVE;
  const ready = !needsTyping || typed.trim() === String(count);
  const busy = phase === "running";

  const closeDialog = () => {
    forgetDeleteRun(run.id);
    close();
  };
  const confirm = () => {
    void run.start((result) => {
      if (result.every((o) => o.id === "deleted" || (single && o.id === "gone"))) closeDialog();
    });
  };

  // One object is named by its kind alone; a count takes the plural forms (Russian "one" also covers 21, 31…).
  const title = single ? t("actions:delete.titleSingle", { kind: kind.kind }) : t("actions:delete.title", { count, kind: kind.kind });

  if (phase === "result") return <ResultView title={title} outcomes={outcomes} close={closeDialog} />;

  // Deleting cannot be cancelled halfway: while it runs, Escape / × / the backdrop do nothing, so the dialog always
  // ends with the full result; "Stop" only keeps the objects not yet started.
  const closeUnlessBusy = () => {
    if (!busy) closeDialog();
  };
  const footer =
    busy && !single ? (
      <Button disabled={stopRequested} onClick={run.stop}>
        {stopRequested ? t("bulk:delete.stopping") : t("bulk:delete.stop")}
      </Button>
    ) : (
      <>
        <Button disabled={busy} onClick={closeDialog}>
          {t("common:actions.cancel")}
        </Button>
        <Button variant="danger" disabled={busy || !ready} onClick={confirm}>
          {busy ? t("actions:dialog.working") : t("actions:delete.confirm")}
        </Button>
      </>
    );

  const owned = items.filter((i) => i.controller).length;
  const synced = items.filter((i) => i.gitops).length;
  const namespaces = items.some((i) => i.ref.kind.group === "" && i.ref.kind.kind === "Namespace");
  const hidden = count - MAX_LISTED;
  const running = busy ? items[current] : undefined;
  return (
    <Dialog open title={title} onClose={closeUnlessBusy} footer={footer}>
      <p>{single ? t("actions:delete.textSingle", { kind: kind.kind }) : t("actions:delete.text", { count, kind: kind.kind })}</p>
      <ul className="action-dialog__names">
        {items.slice(0, MAX_LISTED).map((item) => (
          <li key={nameOf(item.ref)}>
            {nameOf(item.ref)}
            <ItemNotes item={item} />
          </li>
        ))}
      </ul>
      {hidden > 0 && <p>{t("bulk:delete.more", { count: hidden })}</p>}
      {owned > 0 && (
        <p className="delete-dialog__warning" data-testid="delete-owned">
          {single ? t("bulk:delete.ownedSingle") : t("bulk:delete.owned", { count: owned })}
        </p>
      )}
      {synced > 0 && (
        <p className="delete-dialog__warning" data-testid="delete-gitops">
          {single ? t("bulk:delete.gitopsSingle") : t("bulk:delete.gitops", { count: synced })}
        </p>
      )}
      {namespaces && (
        <p className="delete-dialog__warning" data-testid="delete-namespaces">
          {t("bulk:delete.namespaces")}
        </p>
      )}
      {needsTyping && !busy && (
        <label className="delete-dialog__type">
          {t("bulk:delete.typeCount", { number: count })}
          <input className="delete-dialog__type-input" value={typed} inputMode="numeric" onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      {running && !single && (
        <p role="status" className="action-dialog__hint">
          {t("bulk:delete.progress", { name: nameOf(running.ref), current: current + 1, total: count })}
        </p>
      )}
    </Dialog>
  );
}

/** What comes back after the deletion: a controller, a GitOps tool. */
function ItemNotes({ item }: { item: DeleteItem }) {
  const { t } = useTranslation();
  if (!item.controller && !item.gitops) return null;
  return (
    <span className="delete-dialog__note">
      {item.controller && t("bulk:delete.recreatedBy", { owner: `${item.controller.kind.kind} ${item.controller.name}` })}
      {item.gitops && t(`bulk:delete.syncedBy.${item.gitops.tool}`, { name: item.gitops.name })}
    </span>
  );
}

function ResultView({ title, outcomes, close }: { title: string; outcomes: DeleteOutcome[]; close: () => void }) {
  const { t } = useTranslation();
  const deleted = outcomes.filter((o) => o.id === "deleted").length;
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <Button variant="primary" onClick={close}>
          {t("actions:dialog.close")}
        </Button>
      }
    >
      <p>{t("bulk:delete.summary", { deleted, total: outcomes.length })}</p>
      <ul className="delete-dialog__outcomes" aria-label={t("bulk:delete.results")}>
        {outcomes.map((o) => (
          <li key={nameOf(o.item.ref)} className={`delete-dialog__outcome delete-dialog__outcome--${o.id}`} data-outcome={o.id}>
            {t(`bulk:delete.outcome.${o.id}`, { name: nameOf(o.item.ref) })}
            {(o.id === "forbidden" || o.id === "failed") && o.error && <ErrorState error={o.error} />}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
