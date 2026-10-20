// A container's liveness, readiness and startup probes in plain form: the handler (HTTP GET, TCP, gRPC, exec) and
// the timing, with the Kubernetes defaults filled in for omitted fields and marked as such. Pure: no i18n, no React.
import { status } from "../../../resources";

const { arr, get, num, str } = status;

export const PROBE_KINDS = ["liveness", "readiness", "startup"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** The API server's defaults for omitted probe fields (`SetDefaults_Probe`). */
export const PROBE_DEFAULTS = {
  initialDelaySeconds: 0,
  periodSeconds: 10,
  timeoutSeconds: 1,
  successThreshold: 1,
  failureThreshold: 3,
} as const;
export type TimingField = keyof typeof PROBE_DEFAULTS;
const TIMING_FIELDS = Object.keys(PROBE_DEFAULTS) as TimingField[];

/** Fields counted in seconds (the others are counts of checks). */
export const SECONDS_FIELDS: ReadonlySet<TimingField> = new Set(["initialDelaySeconds", "periodSeconds", "timeoutSeconds"]);

/** An exec command longer than this is clipped (the whole one goes to the title). */
export const EXEC_CLIP = 200;

/** Handler names as Kubernetes writes them; never translated. */
export const HANDLER_LABELS = { httpGet: "HTTP GET", tcpSocket: "TCP", grpc: "gRPC", exec: "exec" } as const;

export type ProbeHandler =
  /** `target` is `scheme://host:port/path` with a host, else `:port/path` (the pod IP); `scheme` as written, upper case. */
  | { type: "httpGet"; target: string; scheme: string; headers: string[] }
  | { type: "tcpSocket"; target: string }
  | { type: "grpc"; target: string; service?: string }
  /** `command` lightly shell-quoted; `shown` is it clipped to `EXEC_CLIP`. */
  | { type: "exec"; command: string; shown: string; clipped: boolean }
  | { type: "none" };

export interface ProbeTiming {
  field: TimingField;
  value: number;
  /** Omitted in the object: the value is the Kubernetes default. */
  isDefault: boolean;
}

export interface ProbeRow {
  kind: ProbeKind;
  handler: ProbeHandler;
  timings: ProbeTiming[];
  /** The probe-level `terminationGracePeriodSeconds`, only when set. */
  terminationGracePeriodSeconds?: number;
  /**
   * About how long failing checks take to act: `periodSeconds × failureThreshold`; for a startup probe the whole time
   * the container has to start, so `initialDelaySeconds` is added.
   */
  budgetSeconds: number;
}

/** Where a container sits in the pod spec. */
export type ContainerRole = "container" | "init" | "ephemeral";

/**
 * Whether a container can have probes, so the block (or "No probes") is shown: regular containers and restartable
 * init containers (sidecars, `restartPolicy: Always`); plain init containers and ephemeral containers cannot.
 */
export function showsProbes(container: unknown, role: ContainerRole): boolean {
  if (role === "container") return true;
  if (role === "init") return str(get(container, "restartPolicy")) === "Always";
  return false;
}

/** The probes a container has, in the order liveness, readiness, startup. */
export function probeRows(container: unknown): ProbeRow[] {
  const rows: ProbeRow[] = [];
  for (const kind of PROBE_KINDS) {
    const probe = get(container, `${kind}Probe`);
    if (probe === null || typeof probe !== "object") continue;
    rows.push(probeRow(kind, probe));
  }
  return rows;
}

function probeRow(kind: ProbeKind, probe: unknown): ProbeRow {
  const timings = TIMING_FIELDS.map((field) => {
    const value = num(get(probe, field));
    return value === undefined
      ? { field, value: PROBE_DEFAULTS[field], isDefault: true }
      : { field, value, isDefault: false };
  });
  const value = (field: TimingField) => timings.find((timing) => timing.field === field)!.value;
  const grace = num(get(probe, "terminationGracePeriodSeconds"));
  const failing = value("periodSeconds") * value("failureThreshold");
  return {
    kind,
    handler: handlerOf(probe),
    timings,
    ...(grace !== undefined ? { terminationGracePeriodSeconds: grace } : {}),
    budgetSeconds: kind === "startup" ? value("initialDelaySeconds") + failing : failing,
  };
}

function handlerOf(probe: unknown): ProbeHandler {
  const http = get(probe, "httpGet");
  if (http && typeof http === "object") {
    const scheme = (str(get(http, "scheme")) ?? "HTTP").toUpperCase();
    const host = str(get(http, "host"));
    const rawPath = str(get(http, "path")) ?? "";
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const where = `:${portText(get(http, "port"))}${path}`;
    const headers = arr(get(http, "httpHeaders"))
      .map((h) => str(get(h, "name")))
      .filter((name): name is string => Boolean(name));
    return {
      type: "httpGet",
      target: host ? `${scheme.toLowerCase()}://${hostText(host)}${where}` : where,
      scheme,
      headers,
    };
  }
  const tcp = get(probe, "tcpSocket");
  if (tcp && typeof tcp === "object") {
    const host = str(get(tcp, "host"));
    return { type: "tcpSocket", target: `${host ? hostText(host) : ""}:${portText(get(tcp, "port"))}` };
  }
  const grpc = get(probe, "grpc");
  if (grpc && typeof grpc === "object") {
    const service = str(get(grpc, "service"));
    return { type: "grpc", target: `:${portText(get(grpc, "port"))}`, ...(service ? { service } : {}) };
  }
  const exec = get(probe, "exec");
  if (exec && typeof exec === "object") {
    const command = arr(get(exec, "command"))
      .filter((part): part is string => typeof part === "string")
      .map(shellQuote)
      .join(" ");
    const parts = [...command];
    const clipped = parts.length > EXEC_CLIP;
    return { type: "exec", command, shown: clipped ? `${parts.slice(0, EXEC_CLIP).join("")}…` : command, clipped };
  }
  return { type: "none" };
}

/** A port is a number or a named container port. */
function portText(port: unknown): string {
  if (typeof port === "number" || typeof port === "string") return String(port);
  return "";
}

/** An IPv6 address in brackets, as in a URL. */
function hostText(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** An argument as a POSIX shell would need it: plain when safe, else in single quotes. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
