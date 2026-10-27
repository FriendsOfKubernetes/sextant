// k3s and RKE2 (#270, ADR-0123): the discovered sidebar section "k3s / RKE2" — the "Distribution" page (what the nodes
// tell of the distribution and version, the bundled components with a readable state, the Services ServiceLB serves),
// k3s Addons and, where served, etcd snapshots — the discovered section "Helm controller" (helm-controller's
// HelmCharts with their install Job and its logs, HelmChartConfigs), and the "k3s" / "RKE2" block of Nodes (role,
// version, the node's arguments with secret values hidden). A HelmChart whose install failed or keeps failing and a
// bundled component's Deployment not available feed the problems screen (category `k3s`, never given to agents) and
// the section counters. Read-only.
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useHelmControllerProblemCount, useK3sProblemCount } from "./badge";
import "./k3s.css";
import "./provider";
import "./register";

registerSectionBadge("helmController", useHelmControllerProblemCount, { tone: "danger", labelKey: "k3s:badge" });
registerSectionBadge("k3s", useK3sProblemCount, { tone: "danger", labelKey: "k3s:badge" });

export * from "./model";
