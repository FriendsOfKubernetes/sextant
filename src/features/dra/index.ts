// Dynamic Resource Allocation (#244, ADR-0116): the discovered sidebar section "Dynamic Resource Allocation" —
// ResourceClaims, ResourceClaimTemplates, DeviceClasses and ResourceSlices of resource.k8s.io in whichever version the
// cluster serves — with each claim's state, requests (CEL selectors as text, never evaluated), allocated devices,
// node and consumers; the "Devices" page (every slice's devices by node, with the claim that holds each); the
// "Devices" block of Pods (their claims and, while waiting, the scheduler's DRA reasons) and the "DRA devices" block
// of Nodes. Pods waiting for devices feed the problems screen (category `dra`, never given to agents) and the
// section counter. Read-only.
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useDraProblemCount } from "./badge";
import "./dra.css";
import "./provider";
import "./register";

registerSectionBadge("dra", useDraProblemCount, { tone: "danger", labelKey: "dra:badge" });

export * from "./model";
