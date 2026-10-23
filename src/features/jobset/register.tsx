// Registers the JobSet kind in the sidebar section `jobset` (shown only where the cluster serves it) and its details.
// Read-only: the kind offers the generic Edit and Delete only.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { jobSetColumns } from "./columns";
import { JobSetSection } from "./details";
import { isJobSet, isProblem, JOBSET } from "./model";

registerResource({
  kind: JOBSET,
  sidebar: { section: "jobset", order: 10, labelKey: "jobset:sidebar.jobSets", icon: "jobset" },
  columns: jobSetColumns,
  actions: ["edit", "delete"],
  namespaced: true,
  problem: isProblem,
});

registerDetailsSection({ id: "jobset", order: 20, appliesTo: isJobSet, Component: JobSetSection });
