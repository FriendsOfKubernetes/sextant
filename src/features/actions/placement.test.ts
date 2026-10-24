// Which actions are buttons of the details panel and which are in its "Actions" menu (#275): everyday operations and
// the kind's own main state change are buttons; everything occasional, comparative, in-depth or exotic is in the menu.
import { describe, expect, it } from "vitest";
import "../../app/features";
import type { ActionId } from "../../resources/registry";
import { getAction, placementOf } from "./registry";

const PRIMARY: ActionId[] = [
  "logs",
  "exec",
  "portForward",
  "edit",
  "delete",
  "scale",
  "restart",
  "trigger",
  "suspend",
  "cordon",
  "drain",
  "diagnose",
  "reconcile",
  "fluxSuspend",
  "fluxResume",
  "argoSync",
  "argoRefresh",
  "rolloutPromote",
  "rolloutPause",
  "rolloutResume",
  "rolloutAbort",
  "workflowSuspend",
  "workflowResume",
  "workflowStop",
];

const MORE: ActionId[] = [
  "setImage",
  "compareWith",
  "rolloutUndo",
  "reconcileWithSource",
  "argoHardRefresh",
  "argoDiff",
  "argoTerminate",
  "argoOpenUi",
  "rolloutPromoteFull",
  "rolloutRetry",
  "workflowTerminate",
  "snapshotCreate",
  "snapshotRestore",
  "veleroBackup",
  "veleroRestore",
];

/** Offered next to the name in the details header instead (#274); the table's row menu keeps them. */
const HEADER: ActionId[] = ["copyNamespacedName", "copyName", "pin", "unpin"];

describe("the details panel's placement of every built-in action", () => {
  it.each(PRIMARY)("%s is a button", (id) => {
    const action = getAction(id);
    expect(action, id).toBeDefined();
    expect(placementOf(action!)).toBe("primary");
    expect(action!.inDetails).not.toBe(false);
  });

  it.each(MORE)("%s is in the Actions menu, declared so", (id) => {
    const action = getAction(id);
    expect(action, id).toBeDefined();
    expect(action!.placement).toBe("more");
  });

  it.each(HEADER)("%s is left to the header and the row menu", (id) => {
    expect(getAction(id)?.inDetails).toBe(false);
  });
});
