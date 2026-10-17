// Cluster overview (task 08): the first page of the sidebar section "Cluster" (the problems page comes after it). The
// main view opens the first page of that section when no other section is chosen, so this is what a freshly connected
// cluster shows.
import { registerPage } from "../../layout/pages";
import { OverviewPage } from "./OverviewPage";

export const OVERVIEW_PAGE_ID = "overview";

registerPage({
  id: OVERVIEW_PAGE_ID,
  section: "cluster",
  order: 0,
  labelKey: "metrics:overview.sidebar",
  icon: "overview",
  Component: OverviewPage,
});

export { OverviewPage, podPhase, WARNING_LIMIT, workloadState } from "./OverviewPage";
