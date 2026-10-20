// Why a Service, Ingress or route gets no traffic (#208): a diagnosis that walks the path link by link — Ingress class
// and controller, TLS, rules and backends, a route's Gateways and backends, the Service's pods, ports and
// EndpointSlices, network policies — and stops at the first broken link, in plain words. From objects only: no probe
// pod is started and no traffic is sent. Entry points: the "Diagnose" action and the "Diagnosis" details tab.
import "./diagnose.css";
import "./register";

export { diagnose, diagnosedKind, isDiagnosable } from "./engine";
export type { Chain, ClusterView, Finding, Status } from "./model";
