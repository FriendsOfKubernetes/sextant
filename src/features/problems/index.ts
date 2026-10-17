// Cluster problems (#136): the page "Problems" in the sidebar section "Cluster" (after the overview) with everything
// that is red in the cluster, and a counter on the section's header. The detection rules (`model.ts`) and the shared
// watches (`store.ts`) are also what the background notifications (features/notifications) use.
import { registerPage } from "../../layout/pages";
import { registerSectionBadge } from "../../layout/sectionBadges";
import { PROBLEMS_PAGE_ID } from "./constants";
import { useProblemCount } from "./hooks";
import { ProblemsPage } from "./ProblemsPage";

registerPage({
  id: PROBLEMS_PAGE_ID,
  section: "cluster",
  order: 10,
  labelKey: "problems:sidebar",
  icon: "warning",
  Component: ProblemsPage,
});

registerSectionBadge("cluster", useProblemCount, { tone: "danger", labelKey: "problems:badge" });

export { PROBLEMS_PAGE_ID } from "./constants";
export { useClusterProblems, useProblemCount, useProblemSources } from "./hooks";
export { detect, isActive, NOTIFY_CATEGORIES, PROBLEM_CATEGORIES, resolve, type Problem, type ProblemCategory } from "./model";
export { ProblemsPage } from "./ProblemsPage";
