// Gateway API (#128): the sidebar section "Gateway API" — GatewayClasses, Gateways, HTTP/GRPC/TLS/TCP/UDP routes,
// ReferenceGrants and BackendTLSPolicies with useful columns, and details that read the traffic path: listeners and
// their status, a route's parents and rules, plain-language explanations of the common failures and the
// ReferenceGrant a cross-namespace reference needs. Read-only; the section shows only the kinds the cluster serves.
// `model.ts` is the shared, pure model later views (reverse links, topology, the request check) build on.
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./gateway.css";
import { useGatewayProblemCount } from "./problems";
import "./policies";
import "./register";

registerSectionBadge("gatewayApi", useGatewayProblemCount, { tone: "danger", labelKey: "gateway:problems.count" });

export * from "./model";
export { useGatewayProblemCount, useGatewayProblems } from "./problems";
