// The Pod Security Standards (https://kubernetes.io/docs/concepts/security/pod-security-standards/, as of Kubernetes
// v1.37), evaluated locally on a pod or the pod template of a workload: every control of the Baseline and the
// Restricted policy, each finding with the exact field path, the value found and a fix as a strategic merge patch
// fragment (see snippet.ts). Separate "hardening hints" (read-only root filesystem, requests and limits, the `latest`
// tag, the service account token) are not part of the standard and are labelled `hint`, never a violation. Pure.
//
// How the built-in Pod Security Admission reads the controls, followed here:
// - every list of containers counts: `containers`, `initContainers` and `ephemeralContainers`;
// - a container field left unset inherits the pod-level one where the standard says so (seccomp, runAsNonRoot);
// - `spec.os.name: windows` exempts Privilege Escalation, Seccomp (Restricted) and Capabilities (Restricted);
// - `hostUsers: false` (user namespaces) relaxes runAsNonRoot and runAsUser, and `/proc` mount at Baseline;
// - a control or allowed value added in a later version applies only from that version (`version`, the minor
//   number of `pod-security.kubernetes.io/<mode>-version`; `undefined` is `latest`);
// - a finding of a Baseline control is not reported again by the Restricted control that covers the same field
//   (a hostPath volume, an `Unconfined` seccomp profile, a capability outside the Baseline set).
import { arr, get, num, str } from "../../resources/status";

export type PssLevel = "baseline" | "restricted";
export type FindingLevel = PssLevel | "hint";
/** The strictest standard a pod meets. */
export type Posture = "restricted" | "baseline" | "privileged";

export const BASELINE_CHECKS = [
  "hostProcess",
  "hostNamespaces",
  "privileged",
  "capabilities",
  "hostPathVolumes",
  "hostPorts",
  "hostProbes",
  "appArmor",
  "seLinux",
  "procMount",
  "seccomp",
  "sysctls",
] as const;
export const RESTRICTED_CHECKS = [
  "volumeTypes",
  "privilegeEscalation",
  "runAsNonRoot",
  "runAsUser",
  "seccompRequired",
  "capabilitiesRestricted",
] as const;
export const HINT_CHECKS = ["readOnlyRootFilesystem", "resources", "latestTag", "serviceAccountToken"] as const;

export type CheckId = (typeof BASELINE_CHECKS)[number] | (typeof RESTRICTED_CHECKS)[number] | (typeof HINT_CHECKS)[number];

export interface Finding {
  check: CheckId;
  level: FindingLevel;
  /** The exact field from the object's root: `spec.template.spec.containers[0].securityContext.privileged`. */
  path: string;
  /** The value found, as text (`true`, `SYS_ADMIN`, `Unconfined`); absent when the field is missing. */
  value?: string;
  /** The container the finding is about. */
  container?: string;
  /** The volume the finding is about. */
  volume?: string;
  /**
   * Found only in this running Pod, not in its owner's template: added at admission (a webhook injecting a sidecar or
   * changing a field). Reported on the owner; the fix belongs to whatever adds it, not to the template.
   */
  admittedIn?: string;
  /** A strategic merge patch fragment from the object's root that fixes it (containers and volumes by name). */
  fix: Record<string, unknown>;
}

/** The pod template of an object: its metadata, its spec and where it sits in the object. */
export interface PodTemplate {
  metadata: Record<string, unknown>;
  spec: Record<string, unknown>;
  /** Path from the object's root to the template (`[]` for a Pod). */
  prefix: string[];
}

/** Kinds whose pod template is `spec.template`. */
const TEMPLATE_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "ReplicationController"]);

/** Kinds with a pod template (or a pod): what the page and the details judge. */
export const POD_SPEC_KINDS = new Set([...TEMPLATE_KINDS, "CronJob", "Pod"]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The pod template of a Pod, a CronJob or a kind with `spec.template`; `undefined` for other kinds. */
export function podTemplateOf(kind: string, obj: unknown): PodTemplate | undefined {
  if (kind === "Pod") return { metadata: record(get(obj, "metadata")), spec: record(get(obj, "spec")), prefix: [] };
  const prefix = kind === "CronJob" ? ["spec", "jobTemplate", "spec", "template"] : TEMPLATE_KINDS.has(kind) ? ["spec", "template"] : null;
  if (!prefix) return undefined;
  const template = get(obj, ...prefix);
  if (template === undefined) return undefined;
  return { metadata: record(get(template, "metadata")), spec: record(get(template, "spec")), prefix };
}

// ---------- Allowed values ----------

/** Baseline: capabilities that may be added. */
export const BASELINE_CAPABILITIES = new Set([
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
]);

/** Baseline: the safe sysctls, with the minor version each is allowed from. */
export const SAFE_SYSCTLS: ReadonlyMap<string, number> = new Map([
  ["kernel.shm_rmid_forced", 0],
  ["net.ipv4.ip_local_port_range", 0],
  ["net.ipv4.ip_unprivileged_port_start", 0],
  ["net.ipv4.tcp_syncookies", 0],
  ["net.ipv4.ping_group_range", 0],
  ["net.ipv4.ip_local_reserved_ports", 27],
  ["net.ipv4.tcp_keepalive_time", 29],
  ["net.ipv4.tcp_fin_timeout", 29],
  ["net.ipv4.tcp_keepalive_intvl", 29],
  ["net.ipv4.tcp_keepalive_probes", 29],
  ["net.ipv4.tcp_rmem", 32],
  ["net.ipv4.tcp_wmem", 32],
  ["net.ipv4.tcp_slow_start_after_idle", 37],
  ["net.ipv4.tcp_notsent_lowat", 37],
]);

/** Baseline: SELinux types, with the minor version each is allowed from. */
const SELINUX_TYPES: ReadonlyMap<string, number> = new Map([
  ["container_t", 0],
  ["container_init_t", 0],
  ["container_kvm_t", 0],
  ["container_engine_t", 31],
]);

/** Restricted: the volume types allowed. */
export const RESTRICTED_VOLUME_TYPES = new Set([
  "configMap",
  "csi",
  "downwardAPI",
  "emptyDir",
  "ephemeral",
  "persistentVolumeClaim",
  "projected",
  "secret",
]);

/** Every volume source of `core/v1.Volume` (what the type of a volume is read from). */
const VOLUME_SOURCES = new Set([
  ...RESTRICTED_VOLUME_TYPES,
  "hostPath",
  "gcePersistentDisk",
  "awsElasticBlockStore",
  "gitRepo",
  "nfs",
  "iscsi",
  "glusterfs",
  "rbd",
  "flexVolume",
  "cinder",
  "cephfs",
  "flocker",
  "fc",
  "azureFile",
  "vsphereVolume",
  "quobyte",
  "azureDisk",
  "photonPersistentDisk",
  "portworxVolume",
  "scaleIO",
  "storageos",
  "image",
]);

const PROFILE_TYPES = new Set(["RuntimeDefault", "Localhost"]);
export const APPARMOR_ANNOTATION = "container.apparmor.security.beta.kubernetes.io/";

/** The minor version a control applies from (Baseline and Restricted controls without a note: always). */
const SINCE: Partial<Record<CheckId, number>> = {
  hostProbes: 34,
  seccompRequired: 19,
  capabilitiesRestricted: 22,
  runAsUser: 23,
};

/** Minor version of `v1.N`; `undefined` for `latest`, a missing label or a value that is not a version. */
export function minorOf(version: string | undefined): number | undefined {
  const m = /^v1\.(\d+)$/.exec(version ?? "");
  return m ? Number(m[1]) : undefined;
}

// ---------- Evaluation ----------

type ContainerList = "containers" | "initContainers" | "ephemeralContainers";
const LISTS: ContainerList[] = ["containers", "initContainers", "ephemeralContainers"];

interface ContainerRef {
  list: ContainerList;
  index: number;
  name: string;
  c: Record<string, unknown>;
}

class Builder {
  readonly findings: Finding[] = [];
  /** The template's path with a trailing dot (`spec.template.`), `""` for a Pod. */
  readonly root: string;
  constructor(
    private readonly template: PodTemplate,
    readonly version: number,
  ) {
    this.root = template.prefix.length > 0 ? `${template.prefix.join(".")}.` : "";
  }

  applies(check: CheckId): boolean {
    return (SINCE[check] ?? 0) <= this.version;
  }

  /** A fragment under the pod template, wrapped up to the object's root. */
  wrap(fragment: Record<string, unknown>): Record<string, unknown> {
    let out = fragment;
    for (const key of [...this.template.prefix].reverse()) out = { [key]: out };
    return out;
  }

  podPath(field: string): string {
    return `${this.root}spec.${field}`;
  }

  containerPath(ref: ContainerRef, field: string): string {
    return `${this.root}spec.${ref.list}[${ref.index}].${field}`;
  }

  /** A fix of one container (merged by name). */
  containerFix(ref: ContainerRef, fields: Record<string, unknown>): Record<string, unknown> {
    return this.wrap({ spec: { [ref.list]: [{ name: ref.name, ...fields }] } });
  }

  podFix(fields: Record<string, unknown>): Record<string, unknown> {
    return this.wrap({ spec: fields });
  }

  add(finding: Finding): void {
    this.findings.push(finding);
  }
}

function containersOf(spec: Record<string, unknown>): ContainerRef[] {
  const out: ContainerRef[] = [];
  for (const list of LISTS) {
    arr(spec[list]).forEach((c, index) => out.push({ list, index, name: str(get(c, "name")) ?? "", c: record(c) }));
  }
  return out;
}

const text = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The findings of a pod template: Baseline and Restricted controls and the hardening hints. `version`: the minor
 * version the standard is read at (`undefined`: latest).
 */
export function evaluateTemplate(template: PodTemplate, version?: number): Finding[] {
  const b = new Builder(template, version ?? Number.POSITIVE_INFINITY);
  const { spec, metadata } = template;
  const sc = record(spec.securityContext);
  const containers = containersOf(spec);
  const windows = str(get(spec, "os", "name")) === "windows";
  const userNamespace = spec.hostUsers === false;

  // --- Baseline ---

  // HostProcess
  if (get(sc, "windowsOptions", "hostProcess") === true) {
    b.add({
      check: "hostProcess",
      level: "baseline",
      path: b.podPath("securityContext.windowsOptions.hostProcess"),
      value: "true",
      fix: b.podFix({ securityContext: { windowsOptions: { hostProcess: false } } }),
    });
  }
  for (const ref of containers) {
    if (get(ref.c, "securityContext", "windowsOptions", "hostProcess") === true) {
      b.add({
        check: "hostProcess",
        level: "baseline",
        path: b.containerPath(ref, "securityContext.windowsOptions.hostProcess"),
        value: "true",
        container: ref.name,
        fix: b.containerFix(ref, { securityContext: { windowsOptions: { hostProcess: false } } }),
      });
    }
  }

  // Host Namespaces
  for (const field of ["hostNetwork", "hostPID", "hostIPC"]) {
    if (spec[field] === true) {
      b.add({ check: "hostNamespaces", level: "baseline", path: b.podPath(field), value: "true", fix: b.podFix({ [field]: false }) });
    }
  }

  // Privileged Containers
  for (const ref of containers) {
    if (get(ref.c, "securityContext", "privileged") === true) {
      b.add({
        check: "privileged",
        level: "baseline",
        path: b.containerPath(ref, "securityContext.privileged"),
        value: "true",
        container: ref.name,
        fix: b.containerFix(ref, { securityContext: { privileged: false } }),
      });
    }
  }

  // Capabilities (Baseline)
  for (const ref of containers) {
    const added = arr(get(ref.c, "securityContext", "capabilities", "add")).map((c) => String(c));
    const outside = added.filter((c) => !BASELINE_CAPABILITIES.has(c));
    if (outside.length === 0) continue;
    const kept = added.filter((c) => BASELINE_CAPABILITIES.has(c));
    b.add({
      check: "capabilities",
      level: "baseline",
      path: b.containerPath(ref, "securityContext.capabilities.add"),
      value: outside.join(", "),
      container: ref.name,
      fix: b.containerFix(ref, { securityContext: { capabilities: { add: kept.length > 0 ? kept : null } } }),
    });
  }

  // HostPath Volumes
  const volumes = arr(spec.volumes).map((v, index) => ({ index, name: str(get(v, "name")) ?? "", v: record(v) }));
  for (const { index, name, v } of volumes) {
    if (v.hostPath === undefined || v.hostPath === null) continue;
    b.add({
      check: "hostPathVolumes",
      level: "baseline",
      path: b.podPath(`volumes[${index}].hostPath`),
      value: str(get(v, "hostPath", "path")),
      volume: name,
      fix: b.podFix({ volumes: [{ name, hostPath: null, emptyDir: {} }] }),
    });
  }

  // Host Ports
  for (const ref of containers) {
    arr(ref.c.ports).forEach((port, j) => {
      const hostPort = num(get(port, "hostPort"));
      if (hostPort === undefined || hostPort === 0) return;
      b.add({
        check: "hostPorts",
        level: "baseline",
        path: b.containerPath(ref, `ports[${j}].hostPort`),
        value: String(hostPort),
        container: ref.name,
        fix: b.containerFix(ref, { ports: [{ containerPort: num(get(port, "containerPort")) ?? 0, hostPort: null }] }),
      });
    });
  }

  // Host Probes / Lifecycle Hooks (v1.34+): containers and init containers.
  if (b.applies("hostProbes")) {
    for (const ref of containers) {
      if (ref.list === "ephemeralContainers") continue;
      const handlers: [string[], string][] = [];
      for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) handlers.push([[probe], probe]);
      for (const hook of ["postStart", "preStop"]) handlers.push([["lifecycle", hook], `lifecycle.${hook}`]);
      for (const [at, field] of handlers) {
        for (const handler of ["httpGet", "tcpSocket"]) {
          const host = str(get(ref.c, ...at, handler, "host"));
          if (!host) continue;
          let fix: Record<string, unknown> = { [handler]: { host: null } };
          for (const key of [...at].reverse()) fix = { [key]: fix };
          b.add({
            check: "hostProbes",
            level: "baseline",
            path: b.containerPath(ref, `${field}.${handler}.host`),
            value: host,
            container: ref.name,
            fix: b.containerFix(ref, fix),
          });
        }
      }
    }
  }

  // AppArmor
  const appArmor = str(get(sc, "appArmorProfile", "type"));
  if (appArmor !== undefined && !PROFILE_TYPES.has(appArmor)) {
    b.add({
      check: "appArmor",
      level: "baseline",
      path: b.podPath("securityContext.appArmorProfile.type"),
      value: appArmor,
      fix: b.podFix({ securityContext: { appArmorProfile: { type: "RuntimeDefault" } } }),
    });
  }
  for (const ref of containers) {
    const type = str(get(ref.c, "securityContext", "appArmorProfile", "type"));
    if (type === undefined || PROFILE_TYPES.has(type)) continue;
    b.add({
      check: "appArmor",
      level: "baseline",
      path: b.containerPath(ref, "securityContext.appArmorProfile.type"),
      value: type,
      container: ref.name,
      fix: b.containerFix(ref, { securityContext: { appArmorProfile: { type: "RuntimeDefault" } } }),
    });
  }
  for (const [key, raw] of Object.entries(record(metadata.annotations))) {
    if (!key.startsWith(APPARMOR_ANNOTATION)) continue;
    const value = String(raw);
    if (value === "runtime/default" || value.startsWith("localhost/")) continue;
    b.add({
      check: "appArmor",
      level: "baseline",
      path: `${b.root}metadata.annotations["${key}"]`,
      value,
      container: key.slice(APPARMOR_ANNOTATION.length),
      fix: b.wrap({ metadata: { annotations: { [key]: "runtime/default" } } }),
    });
  }

  // SELinux
  const seLinux = (options: unknown, path: (field: string) => string, fix: (o: Record<string, unknown>) => Record<string, unknown>, container?: string) => {
    const type = str(get(options, "type"));
    const since = type ? SELINUX_TYPES.get(type) : undefined;
    if (type && (since === undefined || since > b.version)) {
      b.add({ check: "seLinux", level: "baseline", path: path("type"), value: type, container, fix: fix({ type: "container_t" }) });
    }
    for (const field of ["user", "role"]) {
      const value = str(get(options, field));
      if (value) b.add({ check: "seLinux", level: "baseline", path: path(field), value, container, fix: fix({ [field]: null }) });
    }
  };
  seLinux(
    sc.seLinuxOptions,
    (field) => b.podPath(`securityContext.seLinuxOptions.${field}`),
    (o) => b.podFix({ securityContext: { seLinuxOptions: o } }),
  );
  for (const ref of containers) {
    seLinux(
      get(ref.c, "securityContext", "seLinuxOptions"),
      (field) => b.containerPath(ref, `securityContext.seLinuxOptions.${field}`),
      (o) => b.containerFix(ref, { securityContext: { seLinuxOptions: o } }),
      ref.name,
    );
  }

  // /proc Mount Type: relaxed at Baseline for a pod in a user namespace; Restricted still wants Default.
  for (const ref of containers) {
    const procMount = str(get(ref.c, "securityContext", "procMount"));
    if (procMount === undefined || procMount === "Default") continue;
    b.add({
      check: "procMount",
      level: userNamespace ? "restricted" : "baseline",
      path: b.containerPath(ref, "securityContext.procMount"),
      value: procMount,
      container: ref.name,
      fix: b.containerFix(ref, { securityContext: { procMount: "Default" } }),
    });
  }

  // Seccomp (Baseline): never Unconfined.
  const podSeccomp = str(get(sc, "seccompProfile", "type"));
  if (podSeccomp !== undefined && !PROFILE_TYPES.has(podSeccomp)) {
    b.add({
      check: "seccomp",
      level: "baseline",
      path: b.podPath("securityContext.seccompProfile.type"),
      value: podSeccomp,
      fix: b.podFix({ securityContext: { seccompProfile: { type: "RuntimeDefault" } } }),
    });
  }
  for (const ref of containers) {
    const type = str(get(ref.c, "securityContext", "seccompProfile", "type"));
    if (type === undefined || PROFILE_TYPES.has(type)) continue;
    b.add({
      check: "seccomp",
      level: "baseline",
      path: b.containerPath(ref, "securityContext.seccompProfile.type"),
      value: type,
      container: ref.name,
      fix: b.containerFix(ref, { securityContext: { seccompProfile: { type: "RuntimeDefault" } } }),
    });
  }

  // Sysctls
  const sysctls = arr(sc.sysctls);
  const allowedSysctl = (name: string) => {
    const since = SAFE_SYSCTLS.get(name);
    return since !== undefined && since <= b.version;
  };
  const keptSysctls = sysctls.filter((s) => allowedSysctl(str(get(s, "name")) ?? ""));
  sysctls.forEach((s, index) => {
    const name = str(get(s, "name")) ?? "";
    if (allowedSysctl(name)) return;
    b.add({
      check: "sysctls",
      level: "baseline",
      path: b.podPath(`securityContext.sysctls[${index}].name`),
      value: name,
      fix: b.podFix({ securityContext: { sysctls: keptSysctls.length > 0 ? keptSysctls : null } }),
    });
  });

  // --- Restricted ---

  // Volume Types (a hostPath volume is a Baseline finding already).
  for (const { index, name, v } of volumes) {
    const type = Object.keys(v).find((key) => VOLUME_SOURCES.has(key) && v[key] !== null && v[key] !== undefined);
    if (!type || type === "hostPath" || RESTRICTED_VOLUME_TYPES.has(type)) continue;
    b.add({
      check: "volumeTypes",
      level: "restricted",
      path: b.podPath(`volumes[${index}].${type}`),
      value: type,
      volume: name,
      fix: b.podFix({ volumes: [{ name, [type]: null, persistentVolumeClaim: { claimName: name } }] }),
    });
  }

  // Privilege Escalation (Linux only).
  if (!windows) {
    for (const ref of containers) {
      const value = get(ref.c, "securityContext", "allowPrivilegeEscalation");
      if (value === false) continue;
      b.add({
        check: "privilegeEscalation",
        level: "restricted",
        path: b.containerPath(ref, "securityContext.allowPrivilegeEscalation"),
        value: text(value),
        container: ref.name,
        fix: b.containerFix(ref, { securityContext: { allowPrivilegeEscalation: false } }),
      });
    }
  }

  // Running as Non-root (relaxed in a user namespace).
  if (!userNamespace) {
    const podNonRoot = sc.runAsNonRoot;
    if (podNonRoot === false) {
      b.add({
        check: "runAsNonRoot",
        level: "restricted",
        path: b.podPath("securityContext.runAsNonRoot"),
        value: "false",
        fix: b.podFix({ securityContext: { runAsNonRoot: true } }),
      });
    }
    for (const ref of containers) {
      const value = get(ref.c, "securityContext", "runAsNonRoot");
      if (value === true || (value === undefined && podNonRoot === true)) continue;
      // Unset under an explicit pod-level `false`: the pod's finding above covers it (one fix for all).
      if (value === undefined && podNonRoot === false) continue;
      b.add({
        check: "runAsNonRoot",
        level: "restricted",
        path: b.containerPath(ref, "securityContext.runAsNonRoot"),
        value: text(value),
        container: ref.name,
        fix:
          value === undefined
            ? b.podFix({ securityContext: { runAsNonRoot: true } })
            : b.containerFix(ref, { securityContext: { runAsNonRoot: true } }),
      });
    }
  }

  // Running as Non-root user (v1.23+; relaxed in a user namespace).
  if (!userNamespace && b.applies("runAsUser")) {
    if (num(sc.runAsUser) === 0) {
      b.add({
        check: "runAsUser",
        level: "restricted",
        path: b.podPath("securityContext.runAsUser"),
        value: "0",
        fix: b.podFix({ securityContext: { runAsUser: 1000 } }),
      });
    }
    for (const ref of containers) {
      if (num(get(ref.c, "securityContext", "runAsUser")) !== 0) continue;
      b.add({
        check: "runAsUser",
        level: "restricted",
        path: b.containerPath(ref, "securityContext.runAsUser"),
        value: "0",
        container: ref.name,
        fix: b.containerFix(ref, { securityContext: { runAsUser: 1000 } }),
      });
    }
  }

  // Seccomp (v1.19+, Linux only): set to RuntimeDefault or Localhost, on the pod or on every container. An
  // explicit Unconfined is a Baseline finding already.
  // A pod-level Unconfined is a Baseline finding that covers the containers which inherit it.
  if (!windows && b.applies("seccompRequired") && podSeccomp === undefined) {
    for (const ref of containers) {
      if (str(get(ref.c, "securityContext", "seccompProfile", "type")) !== undefined) continue;
      b.add({
        check: "seccompRequired",
        level: "restricted",
        path: b.containerPath(ref, "securityContext.seccompProfile.type"),
        container: ref.name,
        fix: b.podFix({ securityContext: { seccompProfile: { type: "RuntimeDefault" } } }),
      });
    }
  }

  // Capabilities (v1.22+, Linux only): drop ALL, add back NET_BIND_SERVICE only (others outside the Baseline set
  // are Baseline findings already).
  if (!windows && b.applies("capabilitiesRestricted")) {
    for (const ref of containers) {
      const caps = get(ref.c, "securityContext", "capabilities");
      const drop = arr(get(caps, "drop")).map(String);
      const added = arr(get(caps, "add")).map(String);
      const keep = added.includes("NET_BIND_SERVICE") ? ["NET_BIND_SERVICE"] : null;
      if (!drop.includes("ALL")) {
        b.add({
          check: "capabilitiesRestricted",
          level: "restricted",
          path: b.containerPath(ref, "securityContext.capabilities.drop"),
          value: drop.length > 0 ? drop.join(", ") : undefined,
          container: ref.name,
          fix: b.containerFix(ref, { securityContext: { capabilities: { drop: ["ALL"] } } }),
        });
      }
      const extra = added.filter((c) => c !== "NET_BIND_SERVICE" && BASELINE_CAPABILITIES.has(c));
      if (extra.length > 0) {
        b.add({
          check: "capabilitiesRestricted",
          level: "restricted",
          path: b.containerPath(ref, "securityContext.capabilities.add"),
          value: extra.join(", "),
          container: ref.name,
          fix: b.containerFix(ref, { securityContext: { capabilities: { add: keep } } }),
        });
      }
    }
  }

  // --- Hardening hints (not the standard) ---

  for (const ref of containers) {
    if (ref.list === "ephemeralContainers") continue;
    if (!windows && get(ref.c, "securityContext", "readOnlyRootFilesystem") !== true) {
      b.add({
        check: "readOnlyRootFilesystem",
        level: "hint",
        path: b.containerPath(ref, "securityContext.readOnlyRootFilesystem"),
        value: text(get(ref.c, "securityContext", "readOnlyRootFilesystem")),
        container: ref.name,
        fix: b.containerFix(ref, { securityContext: { readOnlyRootFilesystem: true } }),
      });
    }
    const missing: string[] = [];
    const resources: Record<string, Record<string, string>> = {};
    for (const [group, resource, example] of [
      ["requests", "cpu", "100m"],
      ["requests", "memory", "128Mi"],
      ["limits", "memory", "128Mi"],
    ] as const) {
      if (get(ref.c, "resources", group, resource) !== undefined) continue;
      missing.push(`${group}.${resource}`);
      resources[group] = { ...resources[group], [resource]: example };
    }
    if (missing.length > 0) {
      b.add({
        check: "resources",
        level: "hint",
        path: b.containerPath(ref, "resources"),
        value: missing.join(", "),
        container: ref.name,
        fix: b.containerFix(ref, { resources }),
      });
    }
    const image = str(ref.c.image);
    const tag = image ? imageTag(image) : undefined;
    if (image && (tag === undefined || tag === "latest")) {
      b.add({
        check: "latestTag",
        level: "hint",
        path: b.containerPath(ref, "image"),
        value: image,
        container: ref.name,
        fix: b.containerFix(ref, { image: `${imageRepository(image)}:<version>` }),
      });
    }
  }
  if (spec.automountServiceAccountToken !== false) {
    b.add({
      check: "serviceAccountToken",
      level: "hint",
      path: b.podPath("automountServiceAccountToken"),
      value: text(spec.automountServiceAccountToken),
      fix: b.podFix({ automountServiceAccountToken: false }),
    });
  }

  return b.findings;
}

/** The tag of an image reference; `undefined` without one. A digest pins the image: `@sha256:…` counts as a tag. */
export function imageTag(image: string): string | undefined {
  if (image.includes("@")) return image.slice(image.indexOf("@") + 1);
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : undefined;
}

/** The image without its tag or digest. */
export function imageRepository(image: string): string {
  if (image.includes("@")) return image.slice(0, image.indexOf("@"));
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

/** The findings of an object with a pod template; `[]` for other kinds. */
export function evaluateObject(kind: string, obj: unknown, version?: number): Finding[] {
  const template = podTemplateOf(kind, obj);
  return template ? evaluateTemplate(template, version) : [];
}

/** The strictest standard met: no Baseline finding is Baseline, none of either is Restricted. */
export function postureOf(findings: readonly Pick<Finding, "level">[]): Posture {
  if (findings.some((f) => f.level === "baseline")) return "privileged";
  if (findings.some((f) => f.level === "restricted")) return "baseline";
  return "restricted";
}

/** Whether a pod with these findings meets `level` (`privileged` is always met). */
export function meets(findings: readonly Pick<Finding, "level">[], level: Posture): boolean {
  if (level === "privileged") return true;
  return !findings.some((f) => f.level === "baseline" || (level === "restricted" && f.level === "restricted"));
}

/** A finding's field as a short name for lists (`privileged`, `hostNetwork`, `capabilities.add`). */
export function fieldName(finding: Pick<Finding, "path">): string {
  const path = finding.path.replace(/\[[^\]]*\]/g, "");
  const parts = path.split(".");
  if (parts.length >= 2 && ["add", "drop", "type", "user", "role", "host", "name"].includes(parts[parts.length - 1]!)) {
    return parts.slice(-2).join(".");
  }
  return parts[parts.length - 1] ?? path;
}

/** Severity of a finding (the page's filter): Baseline high, Restricted medium, hints low. */
export type Severity = "high" | "medium" | "low";
export function severityOf(level: FindingLevel): Severity {
  return level === "baseline" ? "high" : level === "restricted" ? "medium" : "low";
}

// ---------- Who is judged, and what a running Pod adds ----------

/** Controllers whose pods (or ReplicaSets, Jobs) are judged through the controller's template. */
const JUDGED_CONTROLLERS: Record<string, ReadonlySet<string>> = {
  Pod: new Set(["ReplicaSet", "StatefulSet", "DaemonSet", "Job", "ReplicationController"]),
  ReplicaSet: new Set(["Deployment"]),
  Job: new Set(["CronJob"]),
};

/**
 * Whether an object is judged on its own: a workload always; a Pod, ReplicaSet or Job unless its controller is a kind
 * whose template is judged (a Pod of a Deployment's ReplicaSet, a Job of a CronJob). A Pod of a controller Sextant does
 * not judge (an Argo Rollout's ReplicaSet is judged, a static Pod's Node, a Tekton run) is judged itself.
 */
export function judgedOnItsOwn(kind: string, controllerKind: string | undefined): boolean {
  if (!controllerKind) return true;
  return !JUDGED_CONTROLLERS[kind]?.has(controllerKind);
}

const TEMPLATE_PREFIX = /^spec\.(?:jobTemplate\.spec\.)?template\./;

/**
 * What a finding is about, independent of where the pod spec sits and of list positions (an injected container moves
 * the others): the check, the path from the pod spec with containers and volumes by name, and the value.
 */
export function signature(f: Pick<Finding, "check" | "path" | "value" | "container" | "volume">): string {
  const path = f.path
    .replace(TEMPLATE_PREFIX, "")
    .replace(/^spec\.(containers|initContainers|ephemeralContainers)\[\d+\]/, (_m, list: string) => `spec.${list}[${f.container ?? ""}]`)
    .replace(/^spec\.volumes\[\d+\]/, `spec.volumes[${f.volume ?? ""}]`)
    .replace(/\[\d+\]/g, "[*]");
  return `${f.check}|${path}|${f.value ?? ""}`;
}

/**
 * The violations of running Pods that their owner's template does not have (`admittedIn`: the first Pod seen with
 * each). Hints are left out: what admission adds to them (an injected sidecar's filesystem) is not worth a row.
 */
export function admittedFindings(owner: readonly Finding[], pods: readonly { name: string; findings: readonly Finding[] }[]): Finding[] {
  const known = new Set(owner.map(signature));
  const out: Finding[] = [];
  for (const pod of pods) {
    for (const f of pod.findings) {
      if (f.level === "hint") continue;
      const sig = signature(f);
      if (known.has(sig)) continue;
      known.add(sig);
      out.push({ ...f, admittedIn: pod.name });
    }
  }
  return out;
}
