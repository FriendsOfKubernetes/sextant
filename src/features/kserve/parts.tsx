// Small pieces the KServe details share: notes, dates, a URI shown without credentials, links to runtimes.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../i18n";
import { safeUri } from "./model";
import type { RuntimeRef } from "./runtimes";

export const LABELS = "kserve:fields";
export const ISVC_TYPE = { apiVersion: "serving.kserve.io/v1beta1", kind: "InferenceService" };
export const SR_TYPE = { apiVersion: "serving.kserve.io/v1alpha1", kind: "ServingRuntime" };
export const CSR_TYPE = { apiVersion: "serving.kserve.io/v1alpha1", kind: "ClusterServingRuntime" };
export const KSVC_TYPE = { apiVersion: "serving.knative.dev/v1", kind: "Service" };
export const REVISION_TYPE = { apiVersion: "serving.knative.dev/v1", kind: "Revision" };
export const DEPLOYMENT_TYPE = { apiVersion: "apps/v1", kind: "Deployment" };

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`ks-note ks-note--${tone}`}>{clip(text)}</p>;
}

export function Muted({ text }: { text: string }) {
  return <p className="ks-muted">{text}</p>;
}

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

/** A URI without userinfo, query and fragment, and a word when something was left out. */
export function Uri({ value }: { value: string | undefined }) {
  const { t } = useTranslation();
  const safe = safeUri(value);
  if (!safe) return null;
  return (
    <span className="ks-uri">
      <code>{safe.text}</code>
      {safe.hidden && <span className="ks-hint">{t("kserve:uriHidden")}</span>}
    </span>
  );
}

export const uri = (value: string | undefined): ReactNode => (value ? <Uri key="u" value={value} /> : null);

export const runtimeType = (ref: Pick<RuntimeRef, "cluster">) => (ref.cluster ? CSR_TYPE : SR_TYPE);
