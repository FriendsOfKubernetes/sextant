// Live terminal panes of the window and broadcast input between them (#154).
//
// Every pane (a shell session in a terminal dock tab) registers here while it is mounted. Broadcast is off by
// default; the user turns it on by choosing the target panes explicitly (at least two). While it is on, a keystroke
// typed into a target pane goes to every target pane — but the first keystroke of each activation asks for a
// confirmation (the pane shows it, and the dialog takes the keyboard focus), and every keystroke typed before the user
// confirms is dropped, not sent anywhere: nothing the user has not seen is broadcast. Broadcast stops when the user
// turns it off, refuses the confirmation, or any target pane closes.
import { create } from "zustand";
import type { ClusterId } from "../../api";

export interface PaneInfo {
  id: string;
  /** The dock tab the pane is in. */
  tabId: string;
  /** Title of that tab (already translated). */
  tabTitle: string;
  clusterId: ClusterId | null;
  /** What runs in the pane (already translated), e.g. "Shell in web-0/nginx". */
  label: string;
}

interface PanesState {
  panes: Record<string, PaneInfo>;
}

export const usePanes = create<PanesState>()(() => ({ panes: {} }));

const senders = new Map<string, (data: string) => void>();

export interface BroadcastState {
  /** Target pane ids while broadcast is on; `null` when off. */
  targets: string[] | null;
  /** The user confirmed sending to the targets (once per activation). */
  confirmed: boolean;
  /** The pane whose keystroke asked for the confirmation; it shows the dialog. */
  asking: string | null;
}

export const useBroadcast = create<BroadcastState>()(() => ({ targets: null, confirmed: false, asking: null }));


/** Registers a mounted pane; `send` types into its session. Returns the unregister function (on unmount). */
export function registerPane(info: PaneInfo, send: (data: string) => void): () => void {
  senders.set(info.id, send);
  usePanes.setState((s) => ({ panes: { ...s.panes, [info.id]: info } }));
  return () => {
    if (senders.get(info.id) === send) senders.delete(info.id);
    usePanes.setState((s) => {
      const panes = { ...s.panes };
      delete panes[info.id];
      return { panes };
    });
    // A target pane that goes away ends the broadcast: the user chose that set, not what is left of it.
    if (useBroadcast.getState().targets?.includes(info.id)) stopBroadcast();
  };
}

/** Updates what a registered pane shows in the target list (its tab was renamed, its cluster is known). */
export function updatePane(info: PaneInfo): void {
  if (!usePanes.getState().panes[info.id]) return;
  usePanes.setState((s) => ({ panes: { ...s.panes, [info.id]: info } }));
}

/** Turns broadcast on for `targets` (registered panes only, at least two); nothing is sent before a confirmation. */
export function startBroadcast(targets: string[]): boolean {
  const live = [...new Set(targets)].filter((id) => senders.has(id));
  if (live.length < 2) return false;
  useBroadcast.setState({ targets: live, confirmed: false, asking: null });
  return true;
}

export function stopBroadcast(): void {
  useBroadcast.setState({ targets: null, confirmed: false, asking: null });
}

/**
 * Input typed into pane `paneId`. Returns `true` when broadcast took it (sent to every target once confirmed, dropped
 * before that); `false` when the pane is not a target and the input goes to that pane only.
 */
export function broadcastInput(paneId: string, data: string): boolean {
  const { targets, confirmed, asking } = useBroadcast.getState();
  if (!targets?.includes(paneId)) return false;
  if (!confirmed) {
    // Dropped: the user confirms what follows, never what was typed before (it may hold Enter).
    if (asking === null) useBroadcast.setState({ asking: paneId });
    return true;
  }
  sendToTargets(targets, data);
  return true;
}

/** The user confirmed: keystrokes from now on go to every target (those typed before were dropped). */
export function confirmBroadcast(): void {
  if (!useBroadcast.getState().targets) return;
  useBroadcast.setState({ confirmed: true, asking: null });
}

/** The user refused: broadcast is off. */
export function cancelBroadcast(): void {
  stopBroadcast();
}

function sendToTargets(targets: string[], data: string): void {
  for (const id of targets) senders.get(id)?.(data);
}

/** For tests: forget every pane and turn broadcast off. */
export function resetBroadcast(): void {
  senders.clear();
  usePanes.setState({ panes: {} });
  stopBroadcast();
}
