// Which IngressClass an Ingress belongs to, and how to find the pods of the controller behind it. A class is named by
// `spec.ingressClassName`, or by the deprecated `kubernetes.io/ingress.class` annotation, or else it is the class
// marked default. Controller pods are found only for controllers whose usual installation labels them in a known way
// (`KNOWN_CONTROLLERS`); for any other the answer is "unknown", never a guess.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { nameOf } from "./objects";

const { get, record, str } = status;

export const DEFAULT_CLASS_ANNOTATION = "ingressclass.kubernetes.io/is-default-class";
export const LEGACY_CLASS_ANNOTATION = "kubernetes.io/ingress.class";

/** `spec.controller` of an IngressClass → the labels the controller's own installation puts on its pods. */
export const KNOWN_CONTROLLERS: Readonly<Record<string, string>> = {
  "k8s.io/ingress-nginx": "app.kubernetes.io/name=ingress-nginx",
  "nginx.org/ingress-controller": "app.kubernetes.io/name=nginx-ingress",
  "traefik.io/ingress-controller": "app.kubernetes.io/name=traefik",
  "ingress.k8s.aws/alb": "app.kubernetes.io/name=aws-load-balancer-controller",
};

/** The label selector of a controller's pods, `undefined` for a controller Sextant does not know. */
export function controllerSelector(controller: string): string | undefined {
  return Object.hasOwn(KNOWN_CONTROLLERS, controller) ? KNOWN_CONTROLLERS[controller] : undefined;
}

export type ClassResolution =
  | { type: "named"; name: string; via: "spec" | "annotation"; ingressClass: KubeObject | undefined }
  | { type: "default"; ingressClass: KubeObject }
  | { type: "manyDefaults"; names: string[] }
  | { type: "none" };

export const isDefaultClass = (cls: KubeObject) => record(cls.metadata?.annotations)[DEFAULT_CLASS_ANNOTATION] === "true";

export function resolveClass(ingress: KubeObject, classes: readonly KubeObject[]): ClassResolution {
  const byName = (name: string) => classes.find((c) => nameOf(c) === name);
  const named = str(get(ingress, "spec", "ingressClassName"));
  if (named) return { type: "named", name: named, via: "spec", ingressClass: byName(named) };
  const annotated = str(record(ingress.metadata?.annotations)[LEGACY_CLASS_ANNOTATION]);
  if (annotated) return { type: "named", name: annotated, via: "annotation", ingressClass: byName(annotated) };
  const defaults = classes.filter(isDefaultClass);
  if (defaults.length === 1) return { type: "default", ingressClass: defaults[0]! };
  if (defaults.length > 1) return { type: "manyDefaults", names: defaults.map(nameOf).sort() };
  return { type: "none" };
}

export const controllerOf = (cls: KubeObject | undefined) => (cls ? str(get(cls, "spec", "controller")) : undefined);
