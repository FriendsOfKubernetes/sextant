import { describe, expect, it } from "vitest";
import { EXEC_CLIP, probeRows, shellQuote, showsProbes, type ProbeHandler } from "./probes";

const handlerOf = (probe: Record<string, unknown>): ProbeHandler => probeRows({ livenessProbe: probe })[0]!.handler;

describe("probe handlers", () => {
  it.each<[string, Record<string, unknown>, ProbeHandler]>([
    [
      "HTTP GET without a host goes to the pod IP: just the port and path",
      { httpGet: { path: "/healthz", port: 8080 } },
      { type: "httpGet", target: ":8080/healthz", scheme: "HTTP", headers: [] },
    ],
    [
      "HTTP GET with a named port and no path",
      { httpGet: { port: "http" } },
      { type: "httpGet", target: ":http/", scheme: "HTTP", headers: [] },
    ],
    [
      "HTTP GET with a host and HTTPS is a whole URL",
      { httpGet: { scheme: "HTTPS", host: "example.com", port: 8443, path: "ready" } },
      { type: "httpGet", target: "https://example.com:8443/ready", scheme: "HTTPS", headers: [] },
    ],
    [
      "HTTP GET with an IPv6 host puts it in brackets",
      { httpGet: { host: "fd00::1", port: 80, path: "/" } },
      { type: "httpGet", target: "http://[fd00::1]:80/", scheme: "HTTP", headers: [] },
    ],
    [
      "HTTP GET headers are named, never their values",
      {
        httpGet: {
          port: 80,
          path: "/",
          scheme: "HTTPS",
          httpHeaders: [
            { name: "Authorization", value: "Bearer secret" },
            { name: "X-Probe", value: "1" },
          ],
        },
      },
      { type: "httpGet", target: ":80/", scheme: "HTTPS", headers: ["Authorization", "X-Probe"] },
    ],
    ["TCP", { tcpSocket: { port: 5432 } }, { type: "tcpSocket", target: ":5432" }],
    ["TCP with a host", { tcpSocket: { host: "db", port: "pg" } }, { type: "tcpSocket", target: "db:pg" }],
    ["gRPC", { grpc: { port: 9090 } }, { type: "grpc", target: ":9090" }],
    [
      "gRPC with a service",
      { grpc: { port: 9090, service: "liveness" } },
      { type: "grpc", target: ":9090", service: "liveness" },
    ],
    [
      "exec quotes what a shell would need quoted",
      { exec: { command: ["sh", "-c", "pg_isready -U $USER && echo 'ok'"] } },
      {
        type: "exec",
        command: `sh -c 'pg_isready -U $USER && echo '\\''ok'\\'''`,
        shown: `sh -c 'pg_isready -U $USER && echo '\\''ok'\\'''`,
        clipped: false,
      },
    ],
    ["no handler", { periodSeconds: 5 }, { type: "none" }],
  ])("%s", (_name, probe, expected) => {
    expect(handlerOf(probe)).toEqual(expected);
  });

  it("clips a long exec command and keeps the whole one", () => {
    const long = "x".repeat(EXEC_CLIP + 50);
    const handler = handlerOf({ exec: { command: ["echo", long] } });
    expect(handler).toMatchObject({ type: "exec", command: `echo ${long}`, clipped: true });
    if (handler.type !== "exec") throw new Error("not exec");
    expect([...handler.shown]).toHaveLength(EXEC_CLIP + 1);
    expect(handler.shown.endsWith("…")).toBe(true);
  });

  it.each([
    ["plain", "plain"],
    ["", "''"],
    ["a b", "'a b'"],
    ["/bin/grpc_health_probe", "/bin/grpc_health_probe"],
    ["--addr=:9090", "--addr=:9090"],
    ["it's", `'it'\\''s'`],
  ])("shellQuote(%j) is %s", (arg, quoted) => {
    expect(shellQuote(arg)).toBe(quoted);
  });
});

describe("probe timing", () => {
  it("fills in the Kubernetes defaults and marks them", () => {
    const [row] = probeRows({ readinessProbe: { tcpSocket: { port: 80 } } });
    expect(row!.timings).toEqual([
      { field: "initialDelaySeconds", value: 0, isDefault: true },
      { field: "periodSeconds", value: 10, isDefault: true },
      { field: "timeoutSeconds", value: 1, isDefault: true },
      { field: "successThreshold", value: 1, isDefault: true },
      { field: "failureThreshold", value: 3, isDefault: true },
    ]);
    expect(row!.terminationGracePeriodSeconds).toBeUndefined();
    expect(row!.budgetSeconds).toBe(30);
  });

  it("keeps set values, zero included, and the probe-level grace period", () => {
    const [row] = probeRows({
      livenessProbe: {
        httpGet: { port: 80 },
        initialDelaySeconds: 15,
        periodSeconds: 20,
        timeoutSeconds: 0,
        failureThreshold: 6,
        terminationGracePeriodSeconds: 5,
      },
    });
    expect(row!.timings.filter((timing) => !timing.isDefault).map((timing) => [timing.field, timing.value])).toEqual([
      ["initialDelaySeconds", 15],
      ["periodSeconds", 20],
      ["timeoutSeconds", 0],
      ["failureThreshold", 6],
    ]);
    expect(row!.terminationGracePeriodSeconds).toBe(5);
    // Liveness: period × failures, the start delay is not part of a failure.
    expect(row!.budgetSeconds).toBe(120);
  });

  it("gives a startup probe its whole time to start, the delay included", () => {
    const [row] = probeRows({
      startupProbe: { exec: { command: ["true"] }, initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 30 },
    });
    expect(row!.budgetSeconds).toBe(160);
  });
});

describe("which probes and whether to show them", () => {
  it("lists liveness, readiness and startup in that order and skips the rest", () => {
    const rows = probeRows({
      startupProbe: { tcpSocket: { port: 1 } },
      livenessProbe: { tcpSocket: { port: 2 } },
      readinessProbe: null,
    });
    expect(rows.map((row) => row.kind)).toEqual(["liveness", "startup"]);
    expect(probeRows({ name: "app" })).toEqual([]);
  });

  it.each<[string, unknown, "container" | "init" | "ephemeral", boolean]>([
    ["a regular container", { name: "app" }, "container", true],
    ["a plain init container", { name: "setup" }, "init", false],
    ["a sidecar (restartable init container)", { name: "proxy", restartPolicy: "Always" }, "init", true],
    ["an ephemeral container", { name: "debugger" }, "ephemeral", false],
  ])("%s", (_name, container, role, shown) => {
    expect(showsProbes(container, role)).toBe(shown);
  });
});
