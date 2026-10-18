import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { compareModes, psaLabels, type Judged } from "./namespaces";
import { evaluateObject, fieldName, imageRepository, imageTag, postureOf, type Finding, type FindingLevel } from "./pss";
import { toYaml } from "./snippet";

type Spec = Record<string, unknown>;

/** A container that meets Restricted and gives no hint. */
function container(name = "app", extra: Record<string, unknown> = {}, securityContext: Record<string, unknown> = {}) {
  return {
    name,
    image: "nginx:1.27",
    resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { memory: "64Mi" } },
    ...extra,
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
      ...securityContext,
    },
  };
}

function pod(spec: Spec = {}, metadata: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "p", namespace: "ns", ...metadata },
    spec: { automountServiceAccountToken: false, containers: [container()], ...spec },
  };
}

const violations = (findings: Finding[]) => findings.filter((f) => f.level !== "hint");
const brief = (f: Finding) => ({ check: f.check, level: f.level, path: f.path, value: f.value });

describe("a pod that meets Restricted", () => {
  it("has no finding and no hint", () => {
    const found = evaluateObject("Pod", pod());
    expect(found).toEqual([]);
    expect(postureOf(found)).toBe("restricted");
  });
});

interface Case {
  name: string;
  obj: KubeObject;
  version?: number;
  /** The violations expected (hints are not compared). */
  expected: { check: string; level: FindingLevel; path: string; value?: string }[];
}

const SC = (c: Record<string, unknown>) => [container("app", {}, c)];

const CASES: Case[] = [
  // --- Baseline ---
  {
    name: "HostProcess on the pod",
    obj: pod({ securityContext: { windowsOptions: { hostProcess: true } } }),
    expected: [{ check: "hostProcess", level: "baseline", path: "spec.securityContext.windowsOptions.hostProcess", value: "true" }],
  },
  {
    name: "HostProcess on a container",
    obj: pod({ containers: SC({ windowsOptions: { hostProcess: true } }) }),
    expected: [{ check: "hostProcess", level: "baseline", path: "spec.containers[0].securityContext.windowsOptions.hostProcess", value: "true" }],
  },
  ...["hostNetwork", "hostPID", "hostIPC"].map(
    (field): Case => ({
      name: `${field}: true`,
      obj: pod({ [field]: true }),
      expected: [{ check: "hostNamespaces", level: "baseline", path: `spec.${field}`, value: "true" }],
    }),
  ),
  { name: "hostNetwork: false is allowed", obj: pod({ hostNetwork: false }), expected: [] },
  {
    name: "a privileged container",
    obj: pod({ containers: SC({ privileged: true }) }),
    expected: [{ check: "privileged", level: "baseline", path: "spec.containers[0].securityContext.privileged", value: "true" }],
  },
  {
    name: "a privileged init container",
    obj: pod({ initContainers: [container("init", {}, { privileged: true })] }),
    expected: [{ check: "privileged", level: "baseline", path: "spec.initContainers[0].securityContext.privileged", value: "true" }],
  },
  {
    name: "a privileged ephemeral container",
    obj: pod({ ephemeralContainers: [{ name: "debug", image: "busybox:1", securityContext: { privileged: true, allowPrivilegeEscalation: false, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" }, capabilities: { drop: ["ALL"] } } }] }),
    expected: [{ check: "privileged", level: "baseline", path: "spec.ephemeralContainers[0].securityContext.privileged", value: "true" }],
  },
  {
    name: "a capability outside the Baseline set",
    obj: pod({ containers: SC({ capabilities: { drop: ["ALL"], add: ["SYS_ADMIN", "NET_RAW"] } }) }),
    expected: [{ check: "capabilities", level: "baseline", path: "spec.containers[0].securityContext.capabilities.add", value: "SYS_ADMIN, NET_RAW" }],
  },
  {
    name: "a Baseline capability other than NET_BIND_SERVICE is a Restricted violation",
    obj: pod({ containers: SC({ capabilities: { drop: ["ALL"], add: ["CHOWN", "NET_BIND_SERVICE"] } }) }),
    expected: [{ check: "capabilitiesRestricted", level: "restricted", path: "spec.containers[0].securityContext.capabilities.add", value: "CHOWN" }],
  },
  { name: "NET_BIND_SERVICE may be added back", obj: pod({ containers: SC({ capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] } }) }), expected: [] },
  {
    name: "capabilities not dropping ALL",
    obj: pod({ containers: SC({ capabilities: { drop: ["NET_RAW"] } }) }),
    expected: [{ check: "capabilitiesRestricted", level: "restricted", path: "spec.containers[0].securityContext.capabilities.drop", value: "NET_RAW" }],
  },
  {
    name: "a hostPath volume (Baseline only, not again as a volume type)",
    obj: pod({ volumes: [{ name: "data", hostPath: { path: "/var/lib" } }] }),
    expected: [{ check: "hostPathVolumes", level: "baseline", path: "spec.volumes[0].hostPath", value: "/var/lib" }],
  },
  {
    name: "a host port",
    obj: pod({ containers: [container("app", { ports: [{ containerPort: 80 }, { containerPort: 443, hostPort: 8443 }] })] }),
    expected: [{ check: "hostPorts", level: "baseline", path: "spec.containers[0].ports[1].hostPort", value: "8443" }],
  },
  { name: "hostPort 0 is allowed", obj: pod({ containers: [container("app", { ports: [{ containerPort: 80, hostPort: 0 }] })] }), expected: [] },
  {
    name: "a probe with a host (v1.34+)",
    obj: pod({ containers: [container("app", { livenessProbe: { httpGet: { host: "10.0.0.1", port: 80 } } })] }),
    expected: [{ check: "hostProbes", level: "baseline", path: "spec.containers[0].livenessProbe.httpGet.host", value: "10.0.0.1" }],
  },
  {
    name: "a lifecycle hook with a host",
    obj: pod({ initContainers: [container("init", { lifecycle: { preStop: { tcpSocket: { host: "db", port: 5432 } } } })] }),
    expected: [{ check: "hostProbes", level: "baseline", path: "spec.initContainers[0].lifecycle.preStop.tcpSocket.host", value: "db" }],
  },
  {
    name: "a probe with a host before v1.34",
    obj: pod({ containers: [container("app", { livenessProbe: { httpGet: { host: "10.0.0.1", port: 80 } } })] }),
    version: 33,
    expected: [],
  },
  { name: "an empty probe host", obj: pod({ containers: [container("app", { readinessProbe: { httpGet: { host: "", port: 80 } } })] }), expected: [] },
  {
    name: "AppArmor Unconfined on a container",
    obj: pod({ containers: SC({ appArmorProfile: { type: "Unconfined" } }) }),
    expected: [{ check: "appArmor", level: "baseline", path: "spec.containers[0].securityContext.appArmorProfile.type", value: "Unconfined" }],
  },
  {
    name: "AppArmor Unconfined on the pod",
    obj: pod({ securityContext: { appArmorProfile: { type: "Unconfined" } } }),
    expected: [{ check: "appArmor", level: "baseline", path: "spec.securityContext.appArmorProfile.type", value: "Unconfined" }],
  },
  { name: "AppArmor Localhost", obj: pod({ containers: SC({ appArmorProfile: { type: "Localhost", localhostProfile: "x" } }) }), expected: [] },
  {
    name: "the AppArmor annotation set to unconfined",
    obj: pod({}, { annotations: { "container.apparmor.security.beta.kubernetes.io/app": "unconfined" } }),
    expected: [
      {
        check: "appArmor",
        level: "baseline",
        path: 'metadata.annotations["container.apparmor.security.beta.kubernetes.io/app"]',
        value: "unconfined",
      },
    ],
  },
  { name: "the AppArmor annotation set to localhost/x", obj: pod({}, { annotations: { "container.apparmor.security.beta.kubernetes.io/app": "localhost/x" } }), expected: [] },
  {
    name: "an SELinux type outside the list",
    obj: pod({ containers: SC({ seLinuxOptions: { type: "spc_t" } }) }),
    expected: [{ check: "seLinux", level: "baseline", path: "spec.containers[0].securityContext.seLinuxOptions.type", value: "spc_t" }],
  },
  { name: "container_engine_t (since v1.31)", obj: pod({ securityContext: { seLinuxOptions: { type: "container_engine_t" } } }), expected: [] },
  {
    name: "container_engine_t before v1.31",
    obj: pod({ securityContext: { seLinuxOptions: { type: "container_engine_t" } } }),
    version: 30,
    expected: [{ check: "seLinux", level: "baseline", path: "spec.securityContext.seLinuxOptions.type", value: "container_engine_t" }],
  },
  {
    name: "an SELinux user and role",
    obj: pod({ securityContext: { seLinuxOptions: { user: "system_u", role: "system_r" } } }),
    expected: [
      { check: "seLinux", level: "baseline", path: "spec.securityContext.seLinuxOptions.user", value: "system_u" },
      { check: "seLinux", level: "baseline", path: "spec.securityContext.seLinuxOptions.role", value: "system_r" },
    ],
  },
  {
    name: "an Unmasked /proc mount",
    obj: pod({ containers: SC({ procMount: "Unmasked" }) }),
    expected: [{ check: "procMount", level: "baseline", path: "spec.containers[0].securityContext.procMount", value: "Unmasked" }],
  },
  {
    name: "an Unmasked /proc mount in a user namespace is Restricted only",
    obj: pod({ hostUsers: false, containers: SC({ procMount: "Unmasked" }) }),
    expected: [{ check: "procMount", level: "restricted", path: "spec.containers[0].securityContext.procMount", value: "Unmasked" }],
  },
  {
    name: "seccomp Unconfined on the pod (its containers inherit it: one finding)",
    obj: pod({ securityContext: { seccompProfile: { type: "Unconfined" } }, containers: SC({ seccompProfile: undefined }) }),
    expected: [{ check: "seccomp", level: "baseline", path: "spec.securityContext.seccompProfile.type", value: "Unconfined" }],
  },
  {
    name: "seccomp Unconfined on a container",
    obj: pod({ containers: SC({ seccompProfile: { type: "Unconfined" } }) }),
    expected: [{ check: "seccomp", level: "baseline", path: "spec.containers[0].securityContext.seccompProfile.type", value: "Unconfined" }],
  },
  {
    name: "an unsafe sysctl",
    obj: pod({ securityContext: { sysctls: [{ name: "kernel.shm_rmid_forced", value: "1" }, { name: "kernel.msgmax", value: "1" }] } }),
    expected: [{ check: "sysctls", level: "baseline", path: "spec.securityContext.sysctls[1].name", value: "kernel.msgmax" }],
  },
  { name: "net.ipv4.tcp_rmem (since v1.32)", obj: pod({ securityContext: { sysctls: [{ name: "net.ipv4.tcp_rmem", value: "4096 87380 6291456" }] } }), expected: [] },
  {
    name: "net.ipv4.tcp_rmem before v1.32",
    obj: pod({ securityContext: { sysctls: [{ name: "net.ipv4.tcp_rmem", value: "4096 87380 6291456" }] } }),
    version: 31,
    expected: [{ check: "sysctls", level: "baseline", path: "spec.securityContext.sysctls[0].name", value: "net.ipv4.tcp_rmem" }],
  },
  // --- Restricted ---
  {
    name: "a volume type outside the Restricted list",
    obj: pod({ volumes: [{ name: "cm", configMap: { name: "x" } }, { name: "share", nfs: { server: "nfs", path: "/" } }] }),
    expected: [{ check: "volumeTypes", level: "restricted", path: "spec.volumes[1].nfs", value: "nfs" }],
  },
  {
    name: "allowPrivilegeEscalation not set",
    obj: pod({ containers: SC({ allowPrivilegeEscalation: undefined }) }),
    expected: [{ check: "privilegeEscalation", level: "restricted", path: "spec.containers[0].securityContext.allowPrivilegeEscalation" }],
  },
  {
    name: "allowPrivilegeEscalation: true",
    obj: pod({ containers: SC({ allowPrivilegeEscalation: true }) }),
    expected: [{ check: "privilegeEscalation", level: "restricted", path: "spec.containers[0].securityContext.allowPrivilegeEscalation", value: "true" }],
  },
  {
    name: "runAsNonRoot unset on the container without the pod-level true",
    obj: pod({ containers: SC({ runAsNonRoot: undefined }) }),
    expected: [{ check: "runAsNonRoot", level: "restricted", path: "spec.containers[0].securityContext.runAsNonRoot" }],
  },
  { name: "runAsNonRoot from the pod level", obj: pod({ securityContext: { runAsNonRoot: true }, containers: SC({ runAsNonRoot: undefined }) }), expected: [] },
  {
    name: "runAsNonRoot: false on the pod (one finding for the containers that inherit it)",
    obj: pod({ securityContext: { runAsNonRoot: false }, containers: SC({ runAsNonRoot: undefined }) }),
    expected: [{ check: "runAsNonRoot", level: "restricted", path: "spec.securityContext.runAsNonRoot", value: "false" }],
  },
  {
    name: "a container overriding the pod-level runAsNonRoot with false",
    obj: pod({ securityContext: { runAsNonRoot: true }, containers: SC({ runAsNonRoot: false }) }),
    expected: [{ check: "runAsNonRoot", level: "restricted", path: "spec.containers[0].securityContext.runAsNonRoot", value: "false" }],
  },
  {
    name: "runAsUser 0",
    obj: pod({ securityContext: { runAsUser: 0 }, containers: SC({ runAsUser: 0 }) }),
    expected: [
      { check: "runAsUser", level: "restricted", path: "spec.securityContext.runAsUser", value: "0" },
      { check: "runAsUser", level: "restricted", path: "spec.containers[0].securityContext.runAsUser", value: "0" },
    ],
  },
  { name: "runAsUser 0 before v1.23", obj: pod({ containers: SC({ runAsUser: 0 }) }), version: 22, expected: [] },
  {
    name: "a user namespace relaxes runAsNonRoot and runAsUser",
    obj: pod({ hostUsers: false, containers: SC({ runAsNonRoot: undefined, runAsUser: 0 }) }),
    expected: [],
  },
  {
    name: "no seccomp profile anywhere",
    obj: pod({ containers: SC({ seccompProfile: undefined }) }),
    expected: [{ check: "seccompRequired", level: "restricted", path: "spec.containers[0].securityContext.seccompProfile.type" }],
  },
  { name: "seccomp from the pod level", obj: pod({ securityContext: { seccompProfile: { type: "RuntimeDefault" } }, containers: SC({ seccompProfile: undefined }) }), expected: [] },
  {
    name: "a Windows pod is exempt from privilege escalation, seccomp and capabilities",
    obj: pod({ os: { name: "windows" }, containers: SC({ allowPrivilegeEscalation: undefined, seccompProfile: undefined, capabilities: undefined }) }),
    expected: [],
  },
];

describe("the controls, one by one", () => {
  it.each(CASES)("$name", ({ obj, version, expected }) => {
    const found = violations(evaluateObject("Pod", obj, version)).map(brief);
    expect(found).toEqual(expected.map((e) => ({ value: undefined, ...e })));
  });
});

describe("the levels together", () => {
  it("a bare container misses every Restricted control and meets Baseline", () => {
    const found = evaluateObject("Pod", pod({ containers: [{ name: "app", image: "nginx:1.27" }] }));
    expect(new Set(violations(found).map((f) => f.check))).toEqual(
      new Set(["privilegeEscalation", "runAsNonRoot", "seccompRequired", "capabilitiesRestricted"]),
    );
    expect(postureOf(found)).toBe("baseline");
    expect(postureOf(evaluateObject("Pod", pod({ hostPID: true })))).toBe("privileged");
  });
});

describe("pod templates", () => {
  it("a Deployment's fields are under spec.template, a CronJob's under spec.jobTemplate", () => {
    const template = { metadata: {}, spec: { automountServiceAccountToken: false, containers: SC({ privileged: true }) } };
    const deployment = { kind: "Deployment", metadata: { name: "d" }, spec: { template } };
    const cron = { kind: "CronJob", metadata: { name: "c" }, spec: { jobTemplate: { spec: { template } } } };
    expect(violations(evaluateObject("Deployment", deployment)).map((f) => f.path)).toEqual([
      "spec.template.spec.containers[0].securityContext.privileged",
    ]);
    expect(violations(evaluateObject("CronJob", cron)).map((f) => f.path)).toEqual([
      "spec.jobTemplate.spec.template.spec.containers[0].securityContext.privileged",
    ]);
    expect(evaluateObject("Service", deployment)).toEqual([]);
  });

  it("the fix is a strategic merge patch from the object's root", () => {
    const deployment = {
      kind: "Deployment",
      spec: { template: { spec: { automountServiceAccountToken: false, containers: SC({ privileged: true }), volumes: [{ name: "logs", hostPath: { path: "/var/log" } }] } } },
    };
    const [privileged, hostPath] = violations(evaluateObject("Deployment", deployment));
    expect(toYaml(privileged!.fix)).toBe(
      ["spec:", "  template:", "    spec:", "      containers:", "        - name: app", "          securityContext:", "            privileged: false", ""].join("\n"),
    );
    expect(toYaml(hostPath!.fix)).toBe(
      ["spec:", "  template:", "    spec:", "      volumes:", "        - name: logs", "          hostPath: null", "          emptyDir: {}", ""].join("\n"),
    );
    const caps = violations(evaluateObject("Pod", pod({ containers: SC({ capabilities: { drop: ["NET_RAW"] } }) })))[0]!;
    expect(toYaml(caps.fix)).toContain('drop: [ALL]');
  });

  it("names a finding by its field", () => {
    expect(fieldName({ path: "spec.template.spec.containers[0].securityContext.privileged" })).toBe("privileged");
    expect(fieldName({ path: "spec.containers[1].securityContext.capabilities.add" })).toBe("capabilities.add");
    expect(fieldName({ path: "spec.hostNetwork" })).toBe("hostNetwork");
  });
});

describe("hardening hints", () => {
  it("are hints, never violations", () => {
    const bare = pod({ automountServiceAccountToken: undefined, containers: [container("app", { image: "nginx", resources: {} }, { readOnlyRootFilesystem: false })] });
    const hints = evaluateObject("Pod", bare).filter((f) => f.level === "hint");
    expect(hints.map((f) => [f.check, f.path, f.value])).toEqual([
      ["readOnlyRootFilesystem", "spec.containers[0].securityContext.readOnlyRootFilesystem", "false"],
      ["resources", "spec.containers[0].resources", "requests.cpu, requests.memory, limits.memory"],
      ["latestTag", "spec.containers[0].image", "nginx"],
      ["serviceAccountToken", "spec.automountServiceAccountToken", undefined],
    ]);
    expect(postureOf(hints)).toBe("restricted");
  });

  it("reads image tags and digests", () => {
    expect(imageTag("nginx")).toBeUndefined();
    expect(imageTag("nginx:latest")).toBe("latest");
    expect(imageTag("registry:5000/team/app")).toBeUndefined();
    expect(imageTag("registry:5000/team/app:1.2")).toBe("1.2");
    expect(imageTag("nginx@sha256:abc")).toBe("sha256:abc");
    expect(imageRepository("registry:5000/team/app:1.2")).toBe("registry:5000/team/app");
    const latest = evaluateObject("Pod", pod({ containers: [container("app", { image: "nginx:latest" })] }));
    expect(latest.map((f) => f.check)).toEqual(["latestTag"]);
    expect(toYaml(latest[0]!.fix)).toContain('image: "nginx:<version>"');
  });
});

describe("namespace labels", () => {
  const ns = (labels: Record<string, string>): KubeObject => ({ metadata: { name: "team", labels } });
  const judged = (obj: KubeObject): Judged => ({ kind: "Pod", obj, findings: evaluateObject("Pod", obj) });

  it("reads the modes, their levels and versions", () => {
    expect(
      psaLabels(
        ns({
          "pod-security.kubernetes.io/enforce": "baseline",
          "pod-security.kubernetes.io/enforce-version": "v1.30",
          "pod-security.kubernetes.io/warn": "restricted",
          "pod-security.kubernetes.io/audit": "strict",
        }),
      ),
    ).toEqual([
      { mode: "enforce", level: "baseline", raw: "baseline", version: "v1.30" },
      { mode: "audit", level: undefined, raw: "strict", version: "latest" },
      { mode: "warn", level: "restricted", raw: "restricted", version: "latest" },
    ]);
    expect(psaLabels(ns({}))).toEqual([]);
  });

  it("compares each mode's level, at its pinned version, with the workloads", () => {
    const good = judged(pod());
    const rootUser = judged(pod({ containers: SC({ runAsUser: 0 }) }));
    const privileged = judged(pod({ containers: SC({ privileged: true }) }));
    const labels = psaLabels(
      ns({
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/audit-version": "v1.22",
        "pod-security.kubernetes.io/warn": "baseline",
      }),
    );
    const result = compareModes(labels, [good, rootUser, privileged]);
    const failing = (mode: string) => result.find((r) => r.label.mode === mode)!.failing;
    expect(failing("enforce")).toEqual([rootUser, privileged]);
    // runAsUser 0 is allowed by Restricted before v1.23.
    expect(failing("audit")).toEqual([privileged]);
    expect(failing("warn")).toEqual([privileged]);
  });
});
