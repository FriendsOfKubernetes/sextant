// Pod details: status, node, IPs, service account, QoS, volumes and every container (image, ports, probes, env,
// mounts, state, restarts). `ContainerList` also shows the pod template of workloads (without statuses).
import type { TFunction } from "i18next";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../../api";
import { Tabs } from "../../../components";
import { status } from "../../../resources";
import { ContainerTools } from "../../terminal/ContainerTools";
import { formatList, formatNumber } from "../../../i18n/format";
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
import { HANDLER_LABELS, probeRows, SECONDS_FIELDS, showsProbes, type ProbeRow, type ProbeTiming } from "./probes";

const { arr, get, num, podStatus, record, str } = status;

/** What tells one opened object from another: the container selection starts over when it changes. */
export function objectKeyOf(clusterId: ClusterId, ref: ObjectRef): string {
  return [clusterId, ref.namespace ?? "", ref.name].join("|");
}

export function PodDetails({
  obj,
  clusterId,
  objectRef,
}: {
  obj: KubeObject;
  clusterId: ClusterId;
  objectRef: ObjectRef;
}) {
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
  const volumes = get(spec, "volumes");
  const containers = get(spec, "containers");
  const statuses = get(st, "containerStatuses");
  const initContainers = get(spec, "initContainers");
  const initStatuses = get(st, "initContainerStatuses");
  return (
    <>
      <Fields rows={rows} />
      <Volumes volumes={volumes} namespace={ns} />
      <ContainerList
        objectKey={objectKeyOf(clusterId, objectRef)}
        title={t("details:pod.containers")}
        containers={containers}
        statuses={statuses}
        initTitle={t("details:pod.initContainers")}
        initContainers={initContainers}
        initStatuses={initStatuses}
        namespace={ns}
        tools={(name, init, containerStatus) =>
          init ? null : (
            <ContainerTools
              clusterId={clusterId}
              pod={objectRef}
              obj={obj}
              container={name}
              status={containerStatus}
            />
          )
        }
      />
    </>
  );
}

/** Buttons shown in a container's header (pod details): its name, whether it is an init container, its status. */
type ContainerToolsRender = (name: string, init: boolean, status: unknown) => ReactNode;

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
  const content = table("pod.volumes", [t("details:columns.name"), t("details:columns.type"), t("details:columns.source")], rows);
  if (!content) return null;
  return <Block id="details:pod.volumes" title={t("details:pod.volumes")}>{content}</Block>;
}

interface ContainerItem {
  name: string;
  init: boolean;
  container: unknown;
  status: unknown;
}

function itemsOf(containers: unknown, statuses: unknown, init: boolean): ContainerItem[] {
  const byName = new Map(arr(statuses).map((s) => [str(get(s, "name")), s]));
  return arr(containers).map((container) => {
    const name = str(get(container, "name")) ?? "";
    return { name, init, container, status: byName.get(name) };
  });
}

/**
 * The containers of a pod, or of a pod template (without statuses). Two or more (init containers included, they come
 * first) are tabs, one container at a time; one is shown as it is. The tab survives updates of the object `objectKey`
 * names; another object starts at the first container.
 */
export function ContainerList({
  objectKey,
  title,
  containers,
  statuses,
  initTitle,
  initContainers,
  initStatuses,
  namespace,
  tools,
}: {
  objectKey: string;
  title: string;
  containers: unknown;
  statuses?: unknown;
  initTitle: string;
  initContainers?: unknown;
  initStatuses?: unknown;
  namespace: string | null;
  /** Buttons in each container's header (a pod's containers; not a template's). */
  tools?: ContainerToolsRender;
}) {
  const init = itemsOf(initContainers, initStatuses, true);
  const regular = itemsOf(containers, statuses, false);
  if (init.length + regular.length === 0) return null;
  if (init.length + regular.length > 1)
    return (
      <ContainerTabs
        key={objectKey}
        title={title}
        items={[...init, ...regular]}
        namespace={namespace}
        tools={tools}
      />
    );
  const render = (items: ContainerItem[], blockTitle: string) =>
    items.length > 0 && (
      <Block id={items[0]!.init ? "initContainers" : "containers"} title={blockTitle}>
        {items.map((item) => (
          <Container
            key={item.name}
            init={item.init}
            container={item.container}
            status={item.status}
            namespace={namespace}
            tools={tools?.(item.name, item.init, item.status)}
          />
        ))}
      </Block>
    );
  return (
    <>
      {render(init, initTitle)}
      {render(regular, title)}
    </>
  );
}

function ContainerTabs({
  title,
  items,
  namespace,
  tools,
}: {
  title: string;
  items: ContainerItem[];
  namespace: string | null;
  tools?: ContainerToolsRender;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | undefined>();
  // A container that is gone from the list gives way to the first one.
  const selected = items.find((item) => item.name === chosen) ?? items[0]!;
  const tabs = items.map((item) => {
    const current = item.status ? stateOf(item.status, t) : undefined;
    const restarts = item.status ? (num(get(item.status, "restartCount")) ?? 0) : 0;
    return {
      id: item.name,
      title: current && [current.state, current.reason].filter(Boolean).join(": "),
      label: (
        <>
          {/* The spaces are for screen readers: the tab lays its parts out in a row on its own. */}
          <span className="dt-tab__name">{item.name}</span>
          {item.init && (
            <>
              {" "}
              <span className="dt-tag">{t("details:pod.init")}</span>
            </>
          )}
          {current && <> {statusText(current.state, stateTone(current.state, current.reason))}</>}
          {restarts > 0 && (
            <>
              {" "}
              <span className="dt-muted">{t("details:pod.restartCount", { count: restarts })}</span>
            </>
          )}
        </>
      ),
    };
  });
  return (
    <Block id="containers" title={title}>
      <Tabs
        label={t("details:pod.tabs")}
        tabs={tabs}
        selected={selected.name}
        onSelect={setChosen}
        className="dt-container-tabs"
      >
        <Container
          init={selected.init}
          container={selected.container}
          status={selected.status}
          namespace={namespace}
          tools={tools?.(selected.name, selected.init, selected.status)}
        />
      </Tabs>
    </Block>
  );
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
  const ref = (field: string) => ({
    name: str(get(from, field, "name")),
    key: str(get(from, field, "key")),
  });
  if (get(from, "secretKeyRef")) return t("details:env.secretKey", ref("secretKeyRef"));
  if (get(from, "configMapKeyRef")) return t("details:env.configMapKey", ref("configMapKeyRef"));
  if (get(from, "fieldRef"))
    return t("details:env.field", {
      path: str(get(from, "fieldRef", "fieldPath")),
    });
  if (get(from, "resourceFieldRef"))
    return t("details:env.resource", {
      resource: str(get(from, "resourceFieldRef", "resource")),
    });
  return null;
}

function Container({
  init = false,
  container,
  status: st,
  namespace,
  tools,
}: {
  /** An init container: it has probes only as a restartable sidecar. */
  init?: boolean;
  container: unknown;
  status: unknown;
  namespace: string | null;
  tools?: ReactNode;
}) {
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
    "container.env",
    [t("details:columns.name"), t("details:columns.value")],
    arr(get(container, "env")).map((e) => [str(get(e, "name")), envValue(e, t)]),
  );
  const envFrom = table(
    "container.envFrom",
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
    "container.mounts",
    [t("details:columns.path"), t("details:columns.volume"), t("details:columns.access")],
    arr(get(container, "volumeMounts")).map((m) => [
      str(get(m, "mountPath")),
      [str(get(m, "name")), str(get(m, "subPath"))].filter(Boolean).join(" / "),
      get(m, "readOnly") === true ? t("details:pod.readOnly") : t("details:pod.readWrite"),
    ]),
  );
  const state = current ? statusText(current.state, stateTone(current.state, current.reason)) : null;
  const ready = st !== undefined && get(st, "ready") === true ? muted(t("details:pod.ready")) : null;
  // Plain init containers cannot have probes; a sidecar (a restartable init container) can.
  const probes = showsProbes(container, init ? "init" : "container");

  return (
    <div className="dt-container dt-disclosure-group" data-container={name}>
      <div className="dt-container__head">
        <span className="dt-container__name">{name}</span>
        {state}
        {muted(current?.reason)}
        {ready}
        {tools}
      </div>
      <Fields rows={rows} />
      {probes && <Probes container={container} />}
      {env && <Block id="details:pod.env" title={t("details:pod.env")}>{env}</Block>}
      {envFrom && <Block id="details:pod.envFrom" title={t("details:pod.envFrom")}>{envFrom}</Block>}
      {mounts && <Block id="details:pod.mounts" title={t("details:pod.mounts")}>{mounts}</Block>}
    </div>
  );
}

/** A container's probes, one row each: what is checked and how often, defaults muted; "No probes" without any. */
function Probes({ container }: { container: unknown }) {
  const { t } = useTranslation();
  const probes = probeRows(container);
  const content =
    probes.length === 0
      ? muted(t("details:probes.none"))
      : table(
          "container.probes",
          [t("details:columns.probe"), t("details:columns.check"), t("details:columns.timing")],
          probes.map((probe) => [t(PROBE_LABELS[probe.kind]), probeHandler(probe, t), probeTiming(probe, t)]),
          ["nowrap", undefined, undefined],
        );
  return <Block id="details:probes.title" title={t("details:probes.title")}>{content}</Block>;
}

const PROBE_LABELS = {
  liveness: "details:probes.liveness",
  readiness: "details:probes.readiness",
  startup: "details:probes.startup",
} as const;

/** "Restarted after about 30 seconds of failed checks" and the like, one sentence per probe kind. */
const BUDGET_HINTS = {
  liveness: "details:probes.hint.liveness",
  readiness: "details:probes.hint.readiness",
  startup: "details:probes.hint.startup",
} as const;

const TIMING_LABELS = {
  initialDelaySeconds: "details:probes.delay",
  periodSeconds: "details:probes.period",
  timeoutSeconds: "details:probes.timeout",
  successThreshold: "details:probes.success",
  failureThreshold: "details:probes.failure",
} as const;

function probeHandler({ handler }: ProbeRow, t: TFunction): ReactNode {
  if (handler.type === "none") return null;
  let target: ReactNode;
  let extra: ReactNode = null;
  if (handler.type === "exec") {
    target = (
      <code className="dt-probe__code" title={handler.clipped ? handler.command : undefined}>
        {handler.shown}
      </code>
    );
  } else {
    target = <code className="dt-probe__code">{handler.target}</code>;
    if (handler.type === "httpGet") {
      // Without a host the target carries no scheme: a scheme other than HTTP is named beside it.
      const scheme = !handler.target.includes("://") && handler.scheme !== "HTTP" ? handler.scheme : undefined;
      const headers = handler.headers.length;
      extra = (
        <>
          {scheme && <span className="dt-tag">{scheme}</span>}
          {headers > 0 && (
            <span className="dt-muted" title={formatList(handler.headers)}>
              {t("details:probes.headers", { count: headers })}
            </span>
          )}
        </>
      );
    } else if (handler.type === "grpc" && handler.service) {
      extra = muted(t("details:probes.grpcService", { service: handler.service }));
    }
  }
  return (
    <span className="dt-probe__handler">
      <span className="dt-tag">{HANDLER_LABELS[handler.type]}</span>
      {target}
      {extra}
    </span>
  );
}

/** Delay, period, timeout and thresholds (a default muted, titled and named for screen readers), then the hint. */
function probeTiming(probe: ProbeRow, t: TFunction): ReactNode {
  const seconds = (count: number) => t("common:age.seconds", { count });
  const defaultText = t("details:probes.default");
  const item = (key: string, label: string, value: string, isDefault: boolean) => (
    <span
      key={key}
      className={isDefault ? "dt-probe__item dt-muted" : "dt-probe__item"}
      title={isDefault ? defaultText : undefined}
    >
      <span className="dt-probe__label">{label}</span> {value}
      {isDefault && <span className="visually-hidden"> {defaultText}</span>}
    </span>
  );
  const valueOf = ({ field, value }: ProbeTiming) => (SECONDS_FIELDS.has(field) ? seconds(value) : formatNumber(value));
  const items = probe.timings.map((timing) =>
    item(timing.field, t(TIMING_LABELS[timing.field]), valueOf(timing), timing.isDefault),
  );
  if (probe.terminationGracePeriodSeconds !== undefined)
    items.push(item("grace", t("details:probes.grace"), seconds(probe.terminationGracePeriodSeconds), false));
  return (
    <>
      <span className="dt-probe__timing">{items}</span>
      <span className="dt-probe__hint dt-muted">{t(BUDGET_HINTS[probe.kind], { count: probe.budgetSeconds })}</span>
    </>
  );
}
