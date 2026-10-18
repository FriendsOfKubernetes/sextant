// Cleanup (#147): objects that look unused or left over — ConfigMaps and Secrets nothing refers to, claims no Pod
// mounts, Released or unclaimed volumes, Services without endpoints, ReplicaSets beyond the revision history,
// finished Pods and Jobs, empty namespaces — each with why it looks unused and what deleting it would touch, and a
// bulk deletion that lists everything and checks each object again right before deleting it. Frontend only: the
// rules are pure (`rules.ts`) over the resource map's shared watches; the deletion is the ordinary `resource_delete`
// with uid and resourceVersion preconditions. Agents and extensions get nothing new.
//
// The page is "Cleanup" in the Cluster section: it is a view across kinds like the map and the security posture, and
// "Cleanup" says what it is for in plain words (and translates plainly), where "hygiene" would be a metaphor.
import { registerPage } from "../../layout/pages";
import { CLEANUP_PAGE_ID, CleanupPage } from "./CleanupPage";

// After the overview (0), the problems (10), the map (20) and the security posture (30).
registerPage({
  id: CLEANUP_PAGE_ID,
  section: "cluster",
  order: 45,
  labelKey: "hygiene:sidebar",
  icon: "cleanup",
  Component: CleanupPage,
});

export { CLEANUP_PAGE_ID, CleanupPage } from "./CleanupPage";
