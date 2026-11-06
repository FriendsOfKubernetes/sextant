// Kinds of Flux and Argo Rollouts that Sextant's own features still read after the tools' views moved into Sextant's
// extensions (ADR-0162): Cleanup scans Flux objects for the Secrets and ConfigMaps they name (`hygiene/kinds.ts`), and
// Restart restarts an Argo Rollout as `kubectl argo rollouts restart` does (`restart/`). The versions are the ones current
// Flux and Argo Rollouts serve; requests use the cluster's served version (`resolve_kind`).
import type { KindRef } from "../api";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const FLUX_SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const FLUX_KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
export const FLUX_HELM_GROUP = "helm.toolkit.fluxcd.io";
export const FLUX_IMAGE_GROUP = "image.toolkit.fluxcd.io";
export const FLUX_NOTIFICATION_GROUP = "notification.toolkit.fluxcd.io";

export const GIT_REPOSITORY = k(FLUX_SOURCE_GROUP, "v1", "GitRepository");
export const OCI_REPOSITORY = k(FLUX_SOURCE_GROUP, "v1", "OCIRepository");
export const HELM_REPOSITORY = k(FLUX_SOURCE_GROUP, "v1", "HelmRepository");
export const HELM_CHART = k(FLUX_SOURCE_GROUP, "v1", "HelmChart");
export const BUCKET = k(FLUX_SOURCE_GROUP, "v1", "Bucket");
export const KUSTOMIZATION = k(FLUX_KUSTOMIZE_GROUP, "v1", "Kustomization");
export const HELM_RELEASE = k(FLUX_HELM_GROUP, "v2", "HelmRelease");
export const IMAGE_REPOSITORY = k(FLUX_IMAGE_GROUP, "v1", "ImageRepository");
export const PROVIDER = k(FLUX_NOTIFICATION_GROUP, "v1beta3", "Provider");
export const RECEIVER = k(FLUX_NOTIFICATION_GROUP, "v1", "Receiver");

/** Argo Rollouts' Rollout. Argo CD and Argo Workflows share its group: match by group and kind. */
export const ARGO_ROLLOUT = k("argoproj.io", "v1alpha1", "Rollout");

/** Whether `kind` is one of `of`, by group and kind (any version). */
export const isKindOf = (kind: Pick<KindRef, "group" | "kind">, ...of: KindRef[]): boolean =>
  of.some((k) => k.group === kind.group && k.kind === kind.kind);
