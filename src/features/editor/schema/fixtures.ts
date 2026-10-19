// Compact schemas the way `openapi_kind_schema` sends them, trimmed from a real cluster's apps/v1 and a CRD.
import type { KindSchema, SchemaNode } from "../../../api";

const str: SchemaNode = { types: ["string"] };
const int: SchemaNode = { types: ["integer"], format: "int32" };
const bool: SchemaNode = { types: ["boolean"] };
const ref = (name: string, description?: string): SchemaNode => ({ ref: name, ...(description ? { description } : {}) });
const list = (items: SchemaNode, description?: string): SchemaNode => ({ types: ["array"], items, ...(description ? { description } : {}) });

const objectMeta: SchemaNode = {
  types: ["object"],
  description: "ObjectMeta is metadata that all persisted resources must have.",
  properties: {
    name: { ...str, description: "Name must be unique within a namespace." },
    namespace: str,
    labels: { types: ["object"], additionalProperties: str, description: "Map of string keys and values." },
    annotations: { types: ["object"], additionalProperties: str },
  },
};

const container: SchemaNode = {
  types: ["object"],
  description: "A single application container that you want to run within a pod.",
  required: ["name"],
  properties: {
    name: { ...str, description: "Name of the container specified as a DNS_LABEL." },
    image: { ...str, description: "Container image name." },
    imagePullPolicy: { ...str, enum: ["Always", "IfNotPresent", "Never"] },
    ports: list(ref("io.k8s.api.core.v1.ContainerPort"), "List of ports to expose from the container."),
    env: list(ref("io.k8s.api.core.v1.EnvVar")),
    resources: ref("io.k8s.api.core.v1.ResourceRequirements"),
    args: list(str),
    tty: bool,
  },
};

export const deploymentSchema: KindSchema = {
  group: "apps",
  version: "v1",
  kind: "Deployment",
  root: {
    types: ["object"],
    description: "Deployment enables declarative updates for Pods and ReplicaSets.",
    properties: {
      apiVersion: str,
      kind: str,
      metadata: ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta", "Standard object's metadata."),
      spec: ref("io.k8s.api.apps.v1.DeploymentSpec", "Specification of the desired behavior of the Deployment."),
      status: ref("io.k8s.api.apps.v1.DeploymentStatus"),
    },
  },
  definitions: {
    "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": objectMeta,
    "io.k8s.api.apps.v1.DeploymentSpec": {
      types: ["object"],
      required: ["selector", "template"],
      properties: {
        replicas: { ...int, description: "Number of desired pods.", default: 1 },
        paused: bool,
        selector: ref("io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector"),
        strategy: ref("io.k8s.api.apps.v1.DeploymentStrategy"),
        template: ref("io.k8s.api.core.v1.PodTemplateSpec"),
      },
    },
    "io.k8s.api.apps.v1.DeploymentStatus": { types: ["object"], properties: { replicas: int, readyReplicas: int } },
    "io.k8s.api.apps.v1.DeploymentStrategy": {
      types: ["object"],
      properties: {
        type: { ...str, enum: ["Recreate", "RollingUpdate"], description: "Type of deployment." },
        rollingUpdate: { types: ["object"], properties: { maxSurge: ref("io.k8s.apimachinery.pkg.util.intstr.IntOrString") } },
      },
    },
    "io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector": {
      types: ["object"],
      properties: { matchLabels: { types: ["object"], additionalProperties: str } },
    },
    "io.k8s.apimachinery.pkg.util.intstr.IntOrString": { types: ["integer", "string"], format: "int-or-string" },
    "io.k8s.apimachinery.pkg.api.resource.Quantity": { types: ["string", "number"] },
    "io.k8s.api.core.v1.PodTemplateSpec": {
      types: ["object"],
      properties: {
        metadata: ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"),
        spec: ref("io.k8s.api.core.v1.PodSpec"),
      },
    },
    "io.k8s.api.core.v1.PodSpec": {
      types: ["object"],
      required: ["containers"],
      properties: {
        containers: list(ref("io.k8s.api.core.v1.Container"), "List of containers belonging to the pod."),
        initContainers: list(ref("io.k8s.api.core.v1.Container")),
        restartPolicy: { ...str, enum: ["Always", "OnFailure", "Never"], default: "Always" },
        nodeSelector: { types: ["object"], additionalProperties: str },
        hostNetwork: bool,
      },
    },
    "io.k8s.api.core.v1.Container": container,
    "io.k8s.api.core.v1.ContainerPort": {
      types: ["object"],
      required: ["containerPort"],
      properties: { containerPort: int, name: str, protocol: { ...str, enum: ["TCP", "UDP", "SCTP"], default: "TCP" } },
    },
    "io.k8s.api.core.v1.EnvVar": { types: ["object"], required: ["name"], properties: { name: str, value: str } },
    "io.k8s.api.core.v1.ResourceRequirements": {
      types: ["object"],
      properties: {
        limits: { types: ["object"], additionalProperties: ref("io.k8s.apimachinery.pkg.api.resource.Quantity") },
        requests: { types: ["object"], additionalProperties: ref("io.k8s.apimachinery.pkg.api.resource.Quantity") },
      },
    },
  },
};

/** A CRD: inline schema, a field that keeps unknown fields, int-or-string, and a part cut by the backend's depth limit. */
export const widgetSchema: KindSchema = {
  group: "example.com",
  version: "v1",
  kind: "Widget",
  root: {
    types: ["object"],
    properties: {
      apiVersion: str,
      kind: str,
      metadata: ref("io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"),
      spec: {
        types: ["object"],
        required: ["size"],
        properties: {
          size: { types: ["integer", "string"] },
          config: { types: ["object"], preserveUnknown: true },
          deep: { truncated: true },
        },
      },
    },
  },
  definitions: { "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": objectMeta },
};

/** `text` with `¦` as the cursor → the text without it and the cursor's offset. */
export function cursor(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf("¦");
  if (offset < 0) throw new Error("no cursor");
  return { text: marked.slice(0, offset) + marked.slice(offset + 1), offset };
}
