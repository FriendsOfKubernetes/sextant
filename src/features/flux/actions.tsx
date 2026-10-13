// Flux actions, all through the shared merge patch (`api.resources.patch`): Reconcile now (the annotation
// `reconcile.fluxcd.io/requestedAt` that every Flux controller watches), Reconcile with source (the source first,
// then the object), Suspend (after confirmation) and Resume (`spec.suspend`).
import { api, type ClusterId, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { i18n } from "../../i18n";
import { kindFromApiVersion } from "../../resources";
import { ConfirmAction } from "../actions";
import { registerAction } from "../actions/registry";
import {
  fluxKind,
  helmChartOf,
  HELM_RELEASE,
  isKind,
  isSuspended,
  KUSTOMIZATION,
  sourceRefOf,
  type FluxRef,
} from "./model";

export const REQUESTED_AT_ANNOTATION = "reconcile.fluxcd.io/requestedAt";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

/** Asks the controller to reconcile the object now. */
export function requestReconcile(clusterId: ClusterId, ref: ObjectRef): Promise<KubeObject> {
  const patch = { metadata: { annotations: { [REQUESTED_AT_ANNOTATION]: new Date().toISOString() } } };
  return api.resources.patch(clusterId, ref, patch, "merge");
}

export function setSuspended(clusterId: ClusterId, ref: ObjectRef, suspend: boolean): Promise<KubeObject> {
  return api.resources.patch(clusterId, ref, { spec: { suspend } }, "merge");
}

const toObjectRef = (r: FluxRef): ObjectRef => ({
  kind: kindFromApiVersion(r.apiVersion, r.kind),
  namespace: r.namespace,
  name: r.name,
});

/**
 * What to reconcile, in order, for "Reconcile with source": the source of a Kustomization; the chart source of a
 * HelmRelease and then its HelmChart (the chart is pulled again only when the HelmChart reconciles); the object last.
 */
export function withSourceOrder(obj: KubeObject, ref: ObjectRef): ObjectRef[] {
  const refs = [sourceRefOf(obj), isKind(ref.kind, HELM_RELEASE) ? helmChartOf(obj) : undefined]
    .filter((r): r is FluxRef => Boolean(r))
    .map(toObjectRef);
  const key = (r: ObjectRef) => `${r.kind.group}/${r.kind.kind}/${r.namespace ?? ""}/${r.name}`;
  const unique = refs.filter((r, i) => refs.findIndex((other) => key(other) === key(r)) === i);
  return [...unique, ref];
}

const isFlux = (kind: KindRef) => Boolean(fluxKind(kind));

registerAction("reconcile", {
  labelKey: "flux:actions.reconcile",
  icon: "reconcile",
  multiple: true,
  appliesTo: (_obj, kind) => isFlux(kind),
  run: async ({ clusterId, refs }) => {
    for (const ref of refs) await requestReconcile(clusterId, ref);
  },
});

registerAction("reconcileWithSource", {
  labelKey: "flux:actions.reconcileWithSource",
  icon: "reconcileWithSource",
  appliesTo: (obj, kind) => isKind(kind, KUSTOMIZATION, HELM_RELEASE) && Boolean(sourceRefOf(obj)),
  run: async ({ clusterId, objects, refs }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    for (const r of withSourceOrder(obj, ref)) await requestReconcile(clusterId, r);
  },
});

registerAction("fluxSuspend", {
  labelKey: "flux:actions.suspend",
  icon: "suspend",
  appliesTo: (obj, kind) => isFlux(kind) && !isSuspended(obj),
  run: ({ clusterId, refs, openDialog }) => {
    const ref = refs[0];
    if (!ref) return;
    const names = { kind: ref.kind.kind, name: ref.name };
    openDialog((close) => (
      <ConfirmAction
        title={t("flux:suspend.title", names)}
        confirmLabel={t("flux:suspend.confirm")}
        close={close}
        onConfirm={async () => {
          await setSuspended(clusterId, ref, true);
        }}
      >
        <p>{t("flux:suspend.text", names)}</p>
      </ConfirmAction>
    ));
  },
});

registerAction("fluxResume", {
  labelKey: "flux:actions.resume",
  icon: "resume",
  multiple: true,
  appliesTo: (obj, kind) => isFlux(kind) && isSuspended(obj),
  run: async ({ clusterId, refs }) => {
    for (const ref of refs) await setSuspended(clusterId, ref, false);
  },
});
