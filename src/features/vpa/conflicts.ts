// A VPA that changes running pods next to an HPA that scales the same workload on the same resource: the two fight
// (the VPA project's own warning, vertical-pod-autoscaler/docs/known-limitations.md: not "with the Horizontal Pod
// Autoscaler (HPA) on the same resource metric (CPU or memory)"; separate metrics are fine). The VPA raises
// the request, the HPA's utilization (usage ÷ request) falls and it removes replicas, the usage per pod rises, and so
// on. An HPA on custom or external metrics, or a VPA that only sets resources at creation (`Initial`) or only
// recommends (`Off`), is no conflict.
//
// The HPA's resources are its `Resource` metrics (every container of the pod) and `ContainerResource` metrics (one
// container). An `autoscaling/v2` HPA without metrics is defaulted by the API server to CPU utilization 80 %
// (kubernetes pkg/apis/autoscaling/v2/defaults.go), so an empty list counts as CPU.
//
// Whether the VPA controls the resource: with the template's container names known, exactly (`controls`); without them
// (the problems), only when it is certain from the VPA alone — a wildcard policy or no policies at all cover every
// container, a named container's policy covers that container. A container left out of the policies that is not
// in them by name is then not judged: no conflict is claimed from a guess (ADR-0111).
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion } from "../../resources/refs";
import { containerPoliciesOf, controls, DEFAULT_RESOURCES, targetOf, targets, UPDATING_MODES, updateModeOf, WILDCARD, type ContainerPolicy } from "./model";

const { arr, get, str } = status;

export interface HpaResource {
  resource: string;
  /** A `ContainerResource` metric's container; `undefined` for a `Resource` metric (all containers). */
  container?: string;
}

/** The CPU and memory resources an HPA scales on. */
export function hpaResources(hpa: KubeObject): HpaResource[] {
  const metrics = arr(get(hpa, "spec", "metrics"));
  if (metrics.length === 0) return [{ resource: "cpu" }];
  const out: HpaResource[] = [];
  for (const m of metrics) {
    const type = str(get(m, "type"));
    if (type === "Resource") {
      const resource = str(get(m, "resource", "name"));
      if (resource) out.push({ resource });
    } else if (type === "ContainerResource") {
      const resource = str(get(m, "containerResource", "name"));
      const container = str(get(m, "containerResource", "container"));
      if (resource && container) out.push({ resource, container });
    }
  }
  return out.filter((r) => (DEFAULT_RESOURCES as readonly string[]).includes(r.resource));
}

/** Whether the HPA scales the VPA's target (kind, name and group; the version may differ). */
export function sameTarget(vpa: KubeObject, hpa: KubeObject): boolean {
  if (vpa.metadata?.namespace !== hpa.metadata?.namespace) return false;
  const ref = get(hpa, "spec", "scaleTargetRef");
  const kind = str(get(ref, "kind"));
  const name = str(get(ref, "name"));
  if (!kind || !name) return false;
  const group = kindFromApiVersion(str(get(ref, "apiVersion")) ?? "", kind).group;
  return targets(targetOf(vpa), { group, kind }, name);
}

/** Whether the VPA certainly controls `resource` of `container` (or of some container), from its policies alone. */
function certainlyControls(policies: readonly ContainerPolicy[], resource: string, container: string | undefined): boolean {
  if (container !== undefined) {
    const named = policies.some((p) => p.containerName === container);
    const wildcard = policies.some((p) => p.containerName === WILDCARD);
    return named || wildcard || policies.length === 0 ? controls(policies, container, resource) : false;
  }
  if (policies.length === 0) return true;
  return policies.some((p) => p.mode !== "Off" && p.controlledResources.includes(resource));
}

export interface Conflict {
  hpa: string;
  /** The resources both scale on, sorted. */
  resources: string[];
}

/**
 * The HPAs that fight the VPA: it changes running pods (`Recreate`, `Auto`, `InPlaceOrRecreate`, `InPlace`), the HPA
 * scales the same target, and on a resource the VPA controls. `containers`: the target template's container names, when
 * known.
 */
export function conflictsOf(vpa: KubeObject, hpas: Iterable<KubeObject>, containers?: readonly string[]): Conflict[] {
  if (!UPDATING_MODES.has(updateModeOf(vpa))) return [];
  const policies = containerPoliciesOf(vpa);
  const out: Conflict[] = [];
  for (const hpa of hpas) {
    if (hpa.metadata?.deletionTimestamp || !sameTarget(vpa, hpa)) continue;
    const resources = new Set<string>();
    for (const { resource, container } of hpaResources(hpa)) {
      const controlled = containers
        ? (container !== undefined ? [container].filter((c) => containers.includes(c)) : containers).some((c) => controls(policies, c, resource))
        : certainlyControls(policies, resource, container);
      if (controlled) resources.add(resource);
    }
    if (resources.size > 0) out.push({ hpa: hpa.metadata?.name ?? "", resources: [...resources].sort() });
  }
  return out.sort((a, b) => a.hpa.localeCompare(b.hpa));
}
