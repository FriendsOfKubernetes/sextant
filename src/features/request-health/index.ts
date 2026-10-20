// Workload request metrics (#212): the "Requests" details section of Deployments, StatefulSets, DaemonSets and Pods —
// request rate, error rate and latency from Istio, Linkerd, ingress-nginx, Grafana Beyla or Cilium Hubble metrics in
// Prometheus, and CPU throttling per container. The core finds the sources and builds every query
// (`metrics_request_health`, ADR-0095); nothing is changed in the cluster.
import { registerDetailsSection } from "../../layout/details/registry";
import { requestHealthApplies } from "./model";
import { RequestHealthSection } from "./RequestHealthSection";

// Right after the CPU/memory metrics (50), before right-sizing (55).
registerDetailsSection({ id: "requestHealth", order: 52, appliesTo: requestHealthApplies, Component: RequestHealthSection });

export { revealRequestHealth } from "./hooks";
