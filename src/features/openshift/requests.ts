// What OpenShift's two actions send, as the confirmation shows it before anything is sent. The core builds the same
// bodies itself from the object's name (`crates/sextant-core/src/resources/openshift.rs`, `deployment_request` and
// `build_request`; a test on each side pins the same text): the window never sends a body of its own.
import type { KubeObject } from "../../api";

export interface Request {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

const ns = (obj: KubeObject) => obj.metadata?.namespace ?? "";
const name = (obj: KubeObject) => obj.metadata?.name ?? "";

/** `oc rollout latest dc/<name>` (pkg/cli/rollout/latest.go in github.com/openshift/oc). */
export function rolloutLatestRequest(dc: KubeObject): Request {
  return {
    method: "POST",
    path: `/apis/apps.openshift.io/v1/namespaces/${ns(dc)}/deploymentconfigs/${name(dc)}/instantiate`,
    body: { kind: "DeploymentRequest", apiVersion: "apps.openshift.io/v1", name: name(dc), latest: true, force: true },
  };
}

/** `oc start-build <name>` without flags (pkg/cli/startbuild/startbuild.go). */
export function startBuildRequest(bc: KubeObject): Request {
  return {
    method: "POST",
    path: `/apis/build.openshift.io/v1/namespaces/${ns(bc)}/buildconfigs/${name(bc)}/instantiate`,
    body: {
      kind: "BuildRequest",
      apiVersion: "build.openshift.io/v1",
      metadata: { name: name(bc) },
      triggeredBy: [{ message: "Manually triggered" }],
      sourceStrategyOptions: {},
      dockerStrategyOptions: {},
    },
  };
}

/** The body with its keys sorted at every level, as the core serializes it. */
export function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]))
        : v;
  return JSON.stringify(sort(value));
}

/** The request as the confirmation shows it: the line, then the body indented. */
export const requestText = (r: Request): string => `${r.method} ${r.path}\n${JSON.stringify(r.body, null, 2)}`;
