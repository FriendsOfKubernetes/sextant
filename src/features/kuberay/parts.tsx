// Small pieces the KubeRay details share: a note in the operator's words, a date, a Yes/No, a logs button and the
// Serve applications of one RayCluster of a RayService.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Button } from "../../components";
import { formatDateTime } from "../../i18n";
import { StatusText } from "../../resources";
import { table, type ColumnWrap } from "../details";
import { openLogsTab, openSelectorLogsTab } from "../logs";
import { appTone, type ServeApp } from "./model";

export const LABELS = "kuberay:fields";
export const RAY_CLUSTER_TYPE = { apiVersion: "ray.io/v1", kind: "RayCluster" };

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`kr-note kr-note--${tone}`}>{text}</p>;
}

export function Muted({ text }: { text: string }) {
  return <p className="kr-muted">{text}</p>;
}

export const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

export const code = (value: string | undefined): ReactNode => (value ? <pre className="kr-pre">{clip(value)}</pre> : null);

/** Opens the logs of one pod (the head). */
export function PodLogsButton({ clusterId, pod, label }: { clusterId: ClusterId; pod: KubeObject; label: string }) {
  return (
    <Button size="compact" icon="logs" onClick={() => void openLogsTab(clusterId, pod)}>
      {label}
    </Button>
  );
}

/** Opens the merged logs of the pods `selector` matches in `namespace`. */
export function SelectorLogsButton({
  clusterId,
  namespace,
  selector,
  title,
  text,
}: {
  clusterId: ClusterId;
  namespace: string;
  selector: string;
  title: string;
  text: string;
}) {
  return (
    <Button size="compact" icon="logs" onClick={() => void openSelectorLogsTab(clusterId, namespace, selector, title)}>
      {text}
    </Button>
  );
}

const APP_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, undefined];

/** The Serve applications of one cluster: name, status, deployments (healthy of all) and the message. */
export function AppsTable({ id, apps }: { id: string; apps: ServeApp[] }) {
  const { t } = useTranslation();
  const rows = apps.map((a) => [
    a.name,
    a.status ? <StatusText key="s" value={a.status} tone={appTone(a.status)} /> : "",
    t("kuberay:deploymentsHealthy", { healthy: a.deployments.filter((d) => d.status === "HEALTHY").length, total: a.deployments.length }),
    [a.message, ...a.deployments.filter((d) => d.status !== "HEALTHY" && d.message).map((d) => `${d.name}: ${d.message}`)]
      .filter(Boolean)
      .map((m) => clip(m!))
      .join("\n"),
  ]);
  return (
    <>
      {table(
        id,
        [t("kuberay:apps.name"), t("kuberay:apps.status"), t("kuberay:apps.deployments"), t("kuberay:apps.message")],
        rows,
        APP_WRAP,
      )}
    </>
  );
}
