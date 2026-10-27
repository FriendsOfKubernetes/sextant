// Pieces the OLM details share: link targets of the kinds, notes and dates.
import type { ReactNode } from "react";
import { formatDateTime } from "../../i18n";
import { OLM_GROUP } from "./model";

export const TYPES = {
  subscription: { apiVersion: `${OLM_GROUP}/v1alpha1`, kind: "Subscription" },
  csv: { apiVersion: `${OLM_GROUP}/v1alpha1`, kind: "ClusterServiceVersion" },
  installPlan: { apiVersion: `${OLM_GROUP}/v1alpha1`, kind: "InstallPlan" },
  catalogSource: { apiVersion: `${OLM_GROUP}/v1alpha1`, kind: "CatalogSource" },
  crd: { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition" },
  deployment: { apiVersion: "apps/v1", kind: "Deployment" },
};

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`olm-note olm-note--${tone}`}>{text}</p>;
}

export function Muted({ text }: { text: string }) {
  return <p className="olm-muted">{text}</p>;
}

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** `reason: message`, either may be missing. */
export const reasonText = (reason: string | undefined, message: string | undefined): string => [reason, message].filter(Boolean).join(": ");
