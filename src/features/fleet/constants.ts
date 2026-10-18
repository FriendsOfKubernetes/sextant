// Ids and limits of the overview of several clusters ("All clusters", #144).

/** `useAppStore().homeView` while the overview is open. */
export const FLEET_VIEW = "fleet";

/** Clusters the overview shows at most: each holds watches, and connecting each can start a sign-in. */
export const MAX_SELECTED = 10;

/** Clusters "Connect all selected" connects at once; the rest wait their turn. */
export const CONNECT_CONCURRENCY = 2;

/** Objects of one kind kept per cluster (compact rows, not the objects); beyond it new ones are left out. */
export const MAX_KEPT_ROWS = 5000;

/** Rows a table shows per cluster after the filters; the rest is counted ("N more"). */
export const MAX_SHOWN_ROWS = 200;

/** Warning events listed per cluster (the newest). */
export const MAX_EVENTS = 200;

/** Kinds "Find by name" searches by default in each cluster (`group/Kind`), when the cluster serves them. */
export const FIND_KINDS: readonly string[] = [
  "/Pod",
  "apps/Deployment",
  "apps/StatefulSet",
  "apps/DaemonSet",
  "/Service",
  "networking.k8s.io/Ingress",
];
