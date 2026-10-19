// Whether a workload is in a mesh (#155), read from its pod (or a workload's pod template) and its namespace:
//   Istio    sidecar        a container `istio-proxy`
//            native sidecar an init container `istio-proxy` with `restartPolicy: Always`
//            ambient        label `istio.io/dataplane-mode=ambient` on the pod or its namespace (`none` on the pod
//                           opts out); a sidecar wins over ambient
//            injection      label `sidecar.istio.io/inject` on the pod, `istio-injection` or `istio.io/rev` on the
//                           namespace (`istio.io/rev` on the pod picks the revision)
//   Linkerd  proxy          a container `linkerd-proxy` (or a native-sidecar init container of that name)
//            injection      annotation `linkerd.io/inject` (enabled, ingress, disabled) on the pod or its namespace
// A pod whose injection is on but that has no proxy was created before injection was turned on (or the injector
// failed): it joins the mesh after a restart. A pod template never has the proxy (it is added when the pod is
// created), so for a workload the membership is what its pods are expected to get.
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, record, str } = status;

export interface PodShape {
  containers: { name: string; image?: string }[];
  initContainers: { name: string; image?: string; restartPolicy?: string }[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface NamespaceShape {
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).map(([k, v]) => [k, String(v)]));

function containers(value: unknown) {
  return arr(value).map((c) => ({
    name: str(get(c, "name")) ?? "",
    image: str(get(c, "image")),
    restartPolicy: str(get(c, "restartPolicy")),
  }));
}

/** A pod, or the pod template of a workload (`spec.template`). */
export function podShape(obj: KubeObject, template: boolean): PodShape {
  const meta = template ? get(obj, "spec", "template", "metadata") : obj.metadata;
  const spec = template ? get(obj, "spec", "template", "spec") : get(obj, "spec");
  return {
    containers: containers(get(spec, "containers")),
    initContainers: containers(get(spec, "initContainers")),
    labels: stringRecord(get(meta, "labels")),
    annotations: stringRecord(get(meta, "annotations")),
  };
}

export function namespaceShape(obj: KubeObject | undefined): NamespaceShape | undefined {
  if (!obj) return undefined;
  return { labels: stringRecord(obj.metadata?.labels), annotations: stringRecord(obj.metadata?.annotations) };
}

export type IstioMode = "sidecar" | "nativeSidecar" | "ambient" | "none";

export interface IstioMembership {
  mode: IstioMode;
  /** Injection turned on for the pod (sidecar expected). */
  injection: boolean;
  /** Where injection or ambient was turned on. */
  via?: "pod" | "namespace";
  revision?: string;
  /** The pod opted out (`sidecar.istio.io/inject=false` or `istio.io/dataplane-mode=none`). */
  optedOut: boolean;
  proxyImage?: string;
  /** Injection is on but the pod has no proxy: it joins after a restart. */
  restartNeeded: boolean;
}

export type LinkerdMode = "proxy" | "nativeProxy" | "none";

export interface LinkerdMembership {
  mode: LinkerdMode;
  /** `linkerd.io/inject` as in effect: enabled, ingress or disabled. */
  inject?: string;
  via?: "pod" | "namespace";
  controlPlane?: string;
  proxyVersion?: string;
  restartNeeded: boolean;
}

const proxyIn = (pod: PodShape, name: string) => {
  const sidecar = pod.containers.find((c) => c.name === name);
  if (sidecar) return { native: false, image: sidecar.image };
  const native = pod.initContainers.find((c) => c.name === name && c.restartPolicy === "Always");
  return native ? { native: true, image: native.image } : undefined;
};

export function istioMembership(pod: PodShape, ns: NamespaceShape | undefined, template = false): IstioMembership {
  const nsLabels = ns?.labels ?? {};
  const proxy = proxyIn(pod, "istio-proxy");
  const podInject = pod.labels["sidecar.istio.io/inject"] ?? pod.annotations["sidecar.istio.io/inject"];
  const nsInjection = nsLabels["istio-injection"];
  const revision = pod.labels["istio.io/rev"] ?? nsLabels["istio.io/rev"] ?? revisionFromStatus(pod.annotations["sidecar.istio.io/status"]);
  const podOptOut = podInject === "false";
  let injection = false;
  let via: "pod" | "namespace" | undefined;
  if (podInject === "true") {
    injection = true;
    via = "pod";
  } else if (!podOptOut && nsInjection !== "disabled" && (nsInjection === "enabled" || nsLabels["istio.io/rev"] !== undefined)) {
    injection = true;
    via = "namespace";
  } else if (!podOptOut && pod.labels["istio.io/rev"] !== undefined && nsInjection !== "disabled") {
    injection = true;
    via = "pod";
  }
  const podMode = pod.labels["istio.io/dataplane-mode"];
  const ambientOptOut = podMode === "none";
  const ambient = !proxy && !ambientOptOut && (podMode === "ambient" || nsLabels["istio.io/dataplane-mode"] === "ambient");
  const mode: IstioMode = proxy ? (proxy.native ? "nativeSidecar" : "sidecar") : ambient ? "ambient" : "none";
  return {
    mode,
    injection,
    via: proxy || injection ? via : ambient ? (podMode === "ambient" ? "pod" : "namespace") : undefined,
    revision,
    optedOut: podOptOut || ambientOptOut,
    proxyImage: proxy?.image,
    restartNeeded: !template && injection && !proxy && !ambient,
  };
}

function revisionFromStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return str(get(parsed, "revision")) || undefined;
  } catch {
    return undefined;
  }
}

export function linkerdMembership(pod: PodShape, ns: NamespaceShape | undefined, template = false): LinkerdMembership {
  const proxy = proxyIn(pod, "linkerd-proxy");
  const podInject = pod.annotations["linkerd.io/inject"];
  const nsInject = ns?.annotations["linkerd.io/inject"];
  const inject = podInject ?? nsInject;
  const on = inject === "enabled" || inject === "ingress";
  return {
    mode: proxy ? (proxy.native ? "nativeProxy" : "proxy") : "none",
    inject,
    via: podInject !== undefined ? "pod" : nsInject !== undefined ? "namespace" : undefined,
    controlPlane: pod.labels["linkerd.io/control-plane-ns"],
    proxyVersion: pod.annotations["linkerd.io/proxy-version"],
    restartNeeded: !template && on && !proxy,
  };
}
