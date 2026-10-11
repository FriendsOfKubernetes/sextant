// Pod details: status, node, IPs, service account, QoS, volumes and every container (image, ports, env, mounts,
// state, restarts). `ContainerList` also shows the pod template of workloads (without statuses).
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import type { Tone } from "../../../resources/status";
import {
  Block,
  chips,
  Fields,
  KINDS,
  link,
  mapChips,
  muted,
  nsOf,
  pre,
  statusText,
  strings,
  table,
  text,
  tolerations,
  type FieldRow,
} from "../ui";

const { arr, get, num, podStatus, record, str } = status;

export function PodDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec");
  const st = get(obj, "status");
  const ns = nsOf(obj);
  const podIps = arr(get(st, "podIPs"))
    .map((p) => str(get(p, "ip")))
    .filter(Boolean)
    .join(", ");
  const rows: FieldRow[] = [
    ["status", statusText(podStatus(obj))],
    ["node", link(KINDS.node, str(get(spec, "nodeName")))],
    ["podIps", podIps || str(get(st, "podIP"))],
    ["hostIp", str(get(st, "hostIP"))],
    ["serviceAccount", link(KINDS.serviceAccount, str(get(spec, "serviceAccountName")), ns)],
    ["priorityClass", link(KINDS.priorityClass, str(get(spec, "priorityClassName")))],
    ["qosClass", str(get(st, "qosClass"))],
    ["restartPolicy", str(get(spec, "restartPolicy"))],
    ["nodeSelector", mapChips(get(spec, "nodeSelector"))],
    ["tolerations", chips(tolerations(get(spec, "tolerations")))],
    ["statusMessage", str(get(st, "message"))],
  ];
  const initTitle = t("details:pod.initContainers");
  const title = t("details:pod.containers");
  const initContainers = get(spec, "initContainers");
  const initStatuses = get(st, "initContainerStatuses");
  const containers = get(spec, "containers");
  const statuses = get(st, "containerStatuses");
  const volumes = get(spec, "volumes");
  return (
    <>
      <Fields rows={rows} />
      <Volumes volumes={volumes} namespace={ns} />
      <ContainerList title={initTitle} containers={initContainers} statuses={initStatuses} namespace={ns} />
      <ContainerList title={title} containers={containers} statuses={statuses} namespace={ns} />
    </>
  );
}

/** Each volume with its source type and the object it points to (ConfigMap, Secret, PVC), linked. */
function Volumes({ volumes, namespace }: { volumes: unknown; namespace: string | null }) {
  const { t } = useTranslation();
  const rows = arr(volumes).map((v) => {
    const name = str(get(v, "name")) ?? "";
    const source = Object.keys(record(v)).find((k) => k !== "name") ?? "";
    let target: ReactNode = null;
    if (source === "configMap") target = link(KINDS.configMap, str(get(v, "configMap", "name")), namespace);
    else if (source === "secret") target = link(KINDS.secret, str(get(v, "secret", "secretName")), namespace);
    else if (source === "persistentVolumeClaim")
      target = link(KINDS.pvc, str(get(v, "persistentVolumeClaim", "claimName")), namespace);
    else if (source === "hostPath") target = str(get(v, "hostPath", "path"));
    return [name, source, target];
  });
  const content = table([t("details:columns.name"), t("details:columns.type"), t("details:columns.source")], rows);
  if (!content) return null;
  return <Block title={t("details:pod.volumes")}>{content}</Block>;
}

export function ContainerList({
  title,
  containers,
  statuses,
  namespace,
}: {
  title: string;
  containers: unknown;
  statuses?: unknown;
  namespace: string | null;
}) {
  const list = arr(containers);
  if (list.length === 0) return null;
  const byName = new Map(arr(statuses).map((s) => [str(get(s, "name")), s]));
  const items = list.map((c) => {
    const name = str(get(c, "name")) ?? "";
    return <Container key={name} container={c} status={byName.get(name)} namespace={namespace} />;
  });
  return <Block title={title}>{items}</Block>;
}

interface State {
  state: string;
  reason?: string;
  detail?: string;
}

function stateOf(s: unknown, t: TFunction): State | undefined {
  const state = record(get(s, "state"));
  const key = Object.keys(state)[0];
  if (!key) return undefined;
  const reason = str(get(state, key, "reason"));
  const exitCode = num(get(state, key, "exitCode"));
  const message = str(get(state, key, "message"));
  const detail = [exitCode !== undefined ? t("details:pod.exitCode", { code: exitCode }) : undefined, message]
    .filter(Boolean)
    .join(", ");
  return { state: key, reason, detail: detail || undefined };
}

function stateTone(state: string, reason?: string): Tone {
  if (state === "running") return "success";
  if (state === "terminated") return reason === "Completed" ? "muted" : "danger";
  return reason && /Err|BackOff|Crash/.test(reason) ? "danger" : "warning";
}

/** The value of an env variable, or where it comes from (a secret key is named, never read). */
function envValue(env: unknown, t: TFunction): ReactNode {
  const value = get(env, "value");
  if (typeof value === "string") return pre(value);
  const from = get(env, "valueFrom");
  const ref = (field: string) => ({ name: str(get(from, field, "name")), key: str(get(from, field, "key")) });
  if (get(from, "secretKeyRef")) return t("details:env.secretKey", ref("secretKeyRef"));
  if (get(from, "configMapKeyRef")) return t("details:env.configMapKey", ref("configMapKeyRef"));
  if (get(from, "fieldRef")) return t("details:env.field", { path: str(get(from, "fieldRef", "fieldPath")) });
  if (get(from, "resourceFieldRef"))
    return t("details:env.resource", { resource: str(get(from, "resourceFieldRef", "resource")) });
  return null;
}

function Container({ container, status: st, namespace }: { container: unknown; status: unknown; namespace: string | null }) {
  const { t } = useTranslation();
  const name = str(get(container, "name")) ?? "";
  const current = st ? stateOf(st, t) : undefined;
  const last = st ? stateOf({ state: get(st, "lastState") }, t) : undefined;
  const ports = arr(get(container, "ports")).map((p) => {
    const portName = str(get(p, "name"));
    const value = `${num(get(p, "containerPort")) ?? ""}/${str(get(p, "protocol")) ?? "TCP"}`;
    return portName ? `${portName}: ${value}` : value;
  });
  const resources = (kind: string) =>
    Object.entries(record(get(container, "resources", kind))).map(([k, v]) => `${k}=${String(v)}`);

  const rows: FieldRow[] = [
    ["image", str(get(container, "image"))],
    ["imagePullPolicy", str(get(container, "imagePullPolicy"))],
    ["stateDetail", current?.detail],
    ["restarts", st !== undefined ? text(get(st, "restartCount")) : undefined],
    ["lastState", last && [last.state, last.reason, last.detail].filter(Boolean).join(", ")],
    ["ports", chips(ports)],
    ["command", strings(get(container, "command")).join(" ")],
    ["args", strings(get(container, "args")).join(" ")],
    ["requests", chips(resources("requests"))],
    ["limits", chips(resources("limits"))],
  ];

  const env = table(
    [t("details:columns.name"), t("details:columns.value")],
    arr(get(container, "env")).map((e) => [str(get(e, "name")), envValue(e, t)]),
  );
  const envFrom = table(
    [t("details:columns.prefix"), t("details:columns.type"), t("details:columns.source")],
    arr(get(container, "envFrom")).map((e) => {
      const prefix = str(get(e, "prefix"));
      const cm = str(get(e, "configMapRef", "name"));
      const secret = str(get(e, "secretRef", "name"));
      return [
        prefix ? t("details:env.prefix", { prefix }) : "",
        cm ? t("details:env.allOfConfigMap") : t("details:env.allOfSecret"),
        cm ? link(KINDS.configMap, cm, namespace) : link(KINDS.secret, secret, namespace),
      ];
    }),
  );
  const mounts = table(
    [t("details:columns.path"), t("details:columns.volume"), t("details:columns.access")],
    arr(get(container, "volumeMounts")).map((m) => [
      str(get(m, "mountPath")),
      [str(get(m, "name")), str(get(m, "subPath"))].filter(Boolean).join(" / "),
      get(m, "readOnly") === true ? t("details:pod.readOnly") : t("details:pod.readWrite"),
    ]),
  );
  const state = current ? statusText(current.state, stateTone(current.state, current.reason)) : null;
  const ready = st !== undefined && get(st, "ready") === true ? muted(t("details:pod.ready")) : null;

  return (
    <div className="dt-container" data-container={name}>
      <div className="dt-container__head">
        <span className="dt-container__name">{name}</span>
        {state}
        {muted(current?.reason)}
        {ready}
      </div>
      <Fields rows={rows} />
      {env && <Block title={t("details:pod.env")}>{env}</Block>}
      {envFrom && <Block title={t("details:pod.envFrom")}>{envFrom}</Block>}
      {mounts && <Block title={t("details:pod.mounts")}>{mounts}</Block>}
    </div>
  );
}
