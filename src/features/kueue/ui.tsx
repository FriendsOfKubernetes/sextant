// Pieces the Kueue details share: link targets of the kinds, notes and dates.
import type { ReactNode } from "react";
import { formatDateTime } from "../../i18n";
import { KUEUE_GROUP } from "./model";

export const TYPES = {
  clusterQueue: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "ClusterQueue" },
  localQueue: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "LocalQueue" },
  workload: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "Workload" },
  resourceFlavor: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "ResourceFlavor" },
  cohort: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "Cohort" },
  admissionCheck: { apiVersion: `${KUEUE_GROUP}/v1beta2`, kind: "AdmissionCheck" },
};

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`kueue-note kueue-note--${tone}`}>{text}</p>;
}

export function Muted({ text }: { text: string }) {
  return <p className="kueue-muted">{text}</p>;
}

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

