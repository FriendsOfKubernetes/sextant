// JobSet (#247): the discovered sidebar section "JobSet" with the kind JobSet. Its details tell its state and, when it
// failed, the controller's reason with the first failed Job and that Job's own reason; restarts against the limit; the
// success, failure and startup policies; the replicated jobs; its Jobs and pods. Failed JobSets (for a day) and
// restarts near the limit feed the problems screen (category `jobset`) and the section counter. Read-only (ADR-0114).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useJobSetProblemCount } from "./badge";
import "./jobset.css";
import "./register";

registerSectionBadge("jobset", useJobSetProblemCount, { tone: "danger", labelKey: "jobset:badge" });

export * from "./model";
