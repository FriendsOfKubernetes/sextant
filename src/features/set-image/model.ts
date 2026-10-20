// What "Set image…" works on (#215): the kinds, where their pod spec is, their containers and init containers with
// the current images (ephemeral containers never: their image cannot change), the changes the user typed and, for a
// Pod, the controller that owns it. The patch itself is built and sent by the core (`workload_set_image`).
import type { KindRef, KubeObject, SetImageChange } from "../../api";
import type { OwnerRef } from "../../resources/status";

export type SetImageKind = "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob" | "Pod";

/** The kinds "Set image…" is offered on, as the registry names them. */
export const SET_IMAGE_KINDS: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "apps", kind: "Deployment" },
  { group: "apps", kind: "StatefulSet" },
  { group: "apps", kind: "DaemonSet" },
  { group: "batch", kind: "CronJob" },
  { group: "", kind: "Pod" },
];

const POD_SPEC_PATHS: Record<SetImageKind, readonly string[]> = {
  Deployment: ["spec", "template", "spec"],
  StatefulSet: ["spec", "template", "spec"],
  DaemonSet: ["spec", "template", "spec"],
  CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
  Pod: ["spec"],
};

export function setImageKind(kind: Pick<KindRef, "group" | "kind">): SetImageKind | null {
  const known = SET_IMAGE_KINDS.some((k) => k.group === kind.group && k.kind === kind.kind);
  return known ? (kind.kind as SetImageKind) : null;
}

/** One container as the dialog lists it. */
export interface ContainerImage {
  name: string;
  /** In `initContainers` (a sidecar with `restartPolicy: Always` is one too). */
  init: boolean;
  image: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function podSpecOf(obj: KubeObject, kind: SetImageKind): Record<string, unknown> | null {
  let node: unknown = obj;
  for (const key of POD_SPEC_PATHS[kind]) node = isRecord(node) ? node[key] : undefined;
  return isRecord(node) ? node : null;
}

/** Init containers first, then containers, each in the order of the spec; ephemeral containers are left out. */
export function containersOf(obj: KubeObject, kind: SetImageKind): ContainerImage[] {
  const spec = podSpecOf(obj, kind);
  const list = (field: string, init: boolean): ContainerImage[] => {
    const items = spec?.[field];
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      return [{ name: item.name, init, image: typeof item.image === "string" ? item.image : "" }];
    });
  };
  return [...list("initContainers", true), ...list("containers", false)];
}

/** The key of a container in the dialog's state. */
export const containerKey = (c: Pick<ContainerImage, "name" | "init">): string => `${c.init ? "init" : "app"}/${c.name}`;

/**
 * The containers whose typed image (without surrounding spaces, which a paste often brings) differs from the current
 * one, as the core takes them.
 */
export function changesOf(containers: readonly ContainerImage[], typed: Record<string, string>): SetImageChange[] {
  return containers.flatMap((c) => {
    const image = typed[containerKey(c)]?.trim();
    if (image === undefined || image === c.image) return [];
    return [{ container: c.name, init: c.init, from: c.image, image }];
  });
}

/** The controller of a Pod (an owner reference with `controller: true`), whose own image wins over the Pod's. */
export function podController(obj: KubeObject): OwnerRef | null {
  const owners = obj.metadata?.ownerReferences;
  if (!Array.isArray(owners)) return null;
  for (const owner of owners) {
    if (!isRecord(owner) || owner.controller !== true) continue;
    const { apiVersion, kind, name } = owner;
    if (typeof apiVersion === "string" && typeof kind === "string" && typeof name === "string") {
      return { apiVersion, kind, name };
    }
  }
  return null;
}

/** A static Pod's mirror: the kubelet runs it from a file on the node, the API server only shows it. */
export function isMirrorPod(obj: KubeObject): boolean {
  const annotations = obj.metadata?.annotations;
  return isRecord(annotations) && "kubernetes.io/config.mirror" in annotations;
}

/** Owners whose own controller is the place to change the image (a Deployment's ReplicaSet, a CronJob's Job). */
export const LOOK_THROUGH: readonly string[] = ["ReplicaSet", "Job"];
