// Broadcast input UI (#154): choosing the target panes, the banner every target pane shows while broadcast is on, and
// the confirmation before the first keystroke of each activation is sent.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterId } from "../../api";
import { Button, Checkbox, Dialog } from "../../components";
import { formatList } from "../../i18n/format";
import { useClustersStore } from "../clusters/clustersStore";
import { displayNameOf } from "../clusters/clusterSettings";
import {
  cancelBroadcast,
  confirmBroadcast,
  startBroadcast,
  stopBroadcast,
  useBroadcast,
  usePanes,
  type PaneInfo,
} from "./broadcast";

/** The display names of clusters (the "no cluster" text for a terminal without one), in the order given. */
function useClusterNames(): (ids: (ClusterId | null)[]) => string[] {
  const { t } = useTranslation();
  const clusters = useClustersStore((s) => s.clusters);
  const { settings } = useSettings();
  return (ids) =>
    [...new Set(ids)].map((id) => {
      if (id === null) return t("terminal:broadcast.noCluster");
      const cluster = clusters.find((c) => c.id === id);
      return cluster ? displayNameOf(cluster, settings ?? null) : id;
    });
}

/** The clusters of the current broadcast targets, joined for a sentence. */
function useTargetClusters(): { count: number; clusters: string } {
  const targets = useBroadcast((s) => s.targets);
  const panes = usePanes((s) => s.panes);
  const names = useClusterNames();
  const ids = (targets ?? []).map((id) => panes[id]?.clusterId ?? null);
  return { count: targets?.length ?? 0, clusters: formatList(names(ids)) };
}

/** "Broadcast…" in a terminal tab's bar; "Stop broadcast" while it is on. */
export function BroadcastButton({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const on = useBroadcast((s) => s.targets !== null);
  const [choosing, setChoosing] = useState(false);
  return (
    <>
      {on ? (
        <Button size="compact" variant="danger" icon="close" onClick={stopBroadcast}>
          {t("terminal:broadcast.stop")}
        </Button>
      ) : (
        <Button size="compact" icon="shell" onClick={() => setChoosing(true)}>
          {t("terminal:broadcast.button")}
        </Button>
      )}
      {choosing && <BroadcastDialog tabId={tabId} close={() => setChoosing(false)} />}
    </>
  );
}

/**
 * Chooses the target panes. Nothing is selected at first; the panes of the tab's cluster are listed first, panes of
 * other clusters separately, so they are only ever included by an explicit choice.
 */
export function BroadcastDialog({ tabId, close }: { tabId: string; close: () => void }) {
  const { t } = useTranslation();
  const panes = usePanes((s) => s.panes);
  const names = useClusterNames();
  const [selected, setSelected] = useState<string[]>([]);
  const all = Object.values(panes);
  const home = all.find((p) => p.tabId === tabId)?.clusterId ?? null;
  const same = all.filter((p) => p.clusterId === home);
  const others = all.filter((p) => p.clusterId !== home);
  const chosenClusters = names(selected.map((id) => panes[id]?.clusterId ?? null));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
  const row = (p: PaneInfo) => (
    <li key={p.id}>
      <label className="terminal-form__option">
        <Checkbox checked={selected.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
        <span>{t("terminal:broadcast.paneRow", { tab: p.tabTitle, pane: p.label })}</span>
        {p.clusterId !== home && <small className="terminal-form__hint">{names([p.clusterId])[0]}</small>}
      </label>
    </li>
  );
  const start = () => {
    if (startBroadcast(selected)) close();
  };
  return (
    <Dialog
      open
      title={t("terminal:broadcast.title")}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={selected.length < 2} onClick={start}>
            {t("terminal:broadcast.start")}
          </Button>
        </>
      }
    >
      <div className="terminal-form">
        <p className="terminal-form__hint">{t("terminal:broadcast.hint")}</p>
        <section className="terminal-form__field" aria-label={t("terminal:broadcast.sameCluster", { cluster: names([home])[0] })}>
          <span className="terminal-form__label">{t("terminal:broadcast.sameCluster", { cluster: names([home])[0] })}</span>
          <ul className="terminal-broadcast__list">{same.map(row)}</ul>
        </section>
        {others.length > 0 && (
          <section className="terminal-form__field" aria-label={t("terminal:broadcast.otherClusters")}>
            <span className="terminal-form__label">{t("terminal:broadcast.otherClusters")}</span>
            <ul className="terminal-broadcast__list">{others.map(row)}</ul>
          </section>
        )}
        {selected.length < 2 ? (
          <p className="terminal-form__hint">{t("terminal:broadcast.needTwo")}</p>
        ) : (
          <p className="terminal-form__hint">
            {t("terminal:broadcast.selected", { count: selected.length, clusters: formatList(chosenClusters) })}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Shown on top of every target pane while broadcast is on. */
export function BroadcastBanner() {
  const { t } = useTranslation();
  const { count, clusters } = useTargetClusters();
  return (
    <div className="terminal__broadcast" role="status">
      <span className="terminal__status-text">{t("terminal:broadcast.banner", { count, clusters })}</span>
      <Button size="compact" onClick={stopBroadcast}>
        {t("terminal:broadcast.stop")}
      </Button>
    </div>
  );
}

/**
 * Asked at the first keystroke of an activation. The dialog takes the keyboard focus and keeps it while open, so
 * nothing more is typed into a terminal; what was typed before confirming is dropped (`broadcastInput`). Refusing
 * turns broadcast off.
 */
export function BroadcastConfirm() {
  const { t } = useTranslation();
  const { count, clusters } = useTargetClusters();
  const cancel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const button = cancel.current;
    button?.focus();
    const dialog = button?.closest("[role='dialog']");
    // Focus that leaves the dialog (Tab past its last button, a script) is brought back.
    const onFocusIn = (e: FocusEvent) => {
      if (dialog && !(e.target instanceof Node && dialog.contains(e.target))) cancel.current?.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  return (
    <Dialog
      open
      title={t("terminal:broadcast.confirmTitle")}
      onClose={cancelBroadcast}
      footer={
        <>
          <Button ref={cancel} onClick={cancelBroadcast}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="primary" onClick={confirmBroadcast}>
            {t("terminal:broadcast.confirmButton")}
          </Button>
        </>
      }
    >
      <p>{t("terminal:broadcast.confirm", { count, clusters })}</p>
      <p>{t("terminal:broadcast.confirmDropped")}</p>
    </Dialog>
  );
}
