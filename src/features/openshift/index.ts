// OpenShift (#267): the discovered sidebar section "OpenShift" — Routes, DeploymentConfigs, BuildConfigs, Builds,
// ImageStreams and Projects, each shown only where the cluster serves it. A Route's details tell whether a router
// admitted it, where it answers, its TLS termination (inline certificate fields only as "set") and its backends with
// their shares and pods; a Route can be diagnosed like an Ingress. A DeploymentConfig's details tell its rollout state,
// triggers and ReplicationControllers; a BuildConfig's its source (no credentials in a URI) and builds; a Build's its
// phase, failure and pod with the logs; an ImageStream's its tags and import errors; a Project's its annotations.
// "Rollout latest" and "Start build" send what `oc` sends, after a confirmation that shows it. Routes not admitted,
// failed rollouts, recent failed Builds and failing imports feed the problems screen (category `openshift`) and the
// section counter (ADR-0120).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useOpenShiftProblemCount } from "./badge";
import "./openshift.css";
import "./register";

registerSectionBadge("openshift", useOpenShiftProblemCount, { tone: "danger", labelKey: "openshift:badge" });

export * from "./model";
