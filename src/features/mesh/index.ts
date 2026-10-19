// Service mesh views (#155): the discovered sidebar sections "Istio" (VirtualServices, DestinationRules, Gateways,
// ServiceEntries, Sidecars, WorkloadEntries, PeerAuthentications, RequestAuthentications, AuthorizationPolicies,
// Telemetry) and "Linkerd" (ServiceProfiles, Servers, HTTPRoutes, authorization policies and authentications), each
// shown only for the kinds the cluster serves, with details in plain words; the "Service mesh" section of Pods and
// workloads (membership, mTLS mode, who may call); the "Request routing" page (`RequestCheck.tsx`, engine
// `routing.ts`); and Istio configuration mistakes for the problems screen (`problems.ts` → `provider.ts`) and the
// section counter. Read-only: nothing here writes to the cluster or talks to a proxy.
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./mesh.css";
import "./provider";
import "./register";
import "./RequestCheck";
import { useMeshProblemCount } from "./badge";

registerSectionBadge("istio", useMeshProblemCount, { tone: "danger", labelKey: "mesh:problemsCount" });
