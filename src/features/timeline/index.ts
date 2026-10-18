// Change timeline (#145): what changed in a cluster, when and by whom — to answer "what changed before it broke".
// Read-only. The recorder (`recorder.ts`) opens no watch of its own: it observes the watches the window already has
// open and records object changes as diffs of spec and metadata (status and bookkeeping left out), names the field
// managers behind each change (`timeline_managers`), and keeps them in a bounded ring per cluster (in a file only when
// the user turns that on). What happened before Sextant was running comes from what the cluster keeps — field
// managers' last changes, rollout revisions, Helm release revisions (`timeline_history`) — and is marked partial.
// Problems and Warning events that began soon after a change, on the object or what depends on it, are shown with it.
//
// Registered here:
//  - the page "Timeline" in the sidebar section "Cluster" (after "Problems", before the map);
//  - the details tab "Changes" of every kind.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { ChangesSection } from "./ChangesTab";
import { startRecorder } from "./recorder";
import { TIMELINE_PAGE_ID, TimelinePage } from "./TimelinePage";
import "./timeline.css";

startRecorder();

registerPage({
  id: TIMELINE_PAGE_ID,
  section: "cluster",
  order: 15,
  labelKey: "timeline:sidebar",
  icon: "changeTimeline",
  Component: TimelinePage,
});

registerDetailsSection({
  id: "timelineChanges",
  order: 85,
  placement: "tab",
  labelKey: "timeline:tab",
  appliesTo: (kind) => !(kind.group === "" && kind.kind === "Event") && !(kind.group === "events.k8s.io" && kind.kind === "Event"),
  Component: ChangesSection,
});

export { TIMELINE_PAGE_ID, TimelinePage } from "./TimelinePage";
