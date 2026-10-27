// Small pieces the OpenShift details share: a note in a controller's words, a date, a text block, Yes/No, the type
// references of the OpenShift kinds for links.
import type { ReactNode } from "react";
import { formatDateTime } from "../../i18n";
import type { Ref } from "./model";

export const LABELS = "openshift:fields";

export const TYPES = {
  route: { apiVersion: "route.openshift.io/v1", kind: "Route" },
  deploymentConfig: { apiVersion: "apps.openshift.io/v1", kind: "DeploymentConfig" },
  buildConfig: { apiVersion: "build.openshift.io/v1", kind: "BuildConfig" },
  build: { apiVersion: "build.openshift.io/v1", kind: "Build" },
  imageStream: { apiVersion: "image.openshift.io/v1", kind: "ImageStream" },
  replicationController: { apiVersion: "v1", kind: "ReplicationController" },
};

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`os-note os-note--${tone}`}>{text}</p>;
}

export function Muted({ text }: { text: string }) {
  return <p className="os-muted">{text}</p>;
}

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

export const code = (value: string | undefined): ReactNode => (value ? <pre className="os-pre">{clip(value)}</pre> : null);

/** A reference as text: `ImageStreamTag frontend:latest`, `DockerImage quay.io/…`. */
export const refText = (ref: Ref | undefined): string | undefined => (ref ? (ref.kind ? `${ref.kind} ${ref.name}` : ref.name) : undefined);
