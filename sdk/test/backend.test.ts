// @vitest-environment node
// sdk/src/backend.ts: the backend side of the SDK, with the component's host module replaced by a stand-in.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<[string, string]> = [];
const lines: Array<[string, string]> = [];

vi.mock("sextant:extension/host@1.0.0", () => ({
  call: (method: string, params: string) => {
    calls.push([method, params]);
    if (method === "clusters.list") return JSON.stringify([{ id: "a" }, { id: "b" }]);
    if (method === "credentials.get") return JSON.stringify(null);
    throw Object.assign(new Error("refused"), { payload: { code: "forbidden", message: `${method} is not granted` } });
  },
  log: (level: string, message: string) => lines.push([level, message]),
}));

const { defineBackend, host } = await import("../src/backend");
const { SextantError } = await import("../src/errors");

beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
});

describe("defineBackend", () => {
  const handle = defineBackend({
    echo: (params) => params,
    clusters: () => host.clusters.list().length,
    fails: () => {
      throw new Error("on purpose");
    },
    denied: () => host.resources.list({ clusterId: "a", kind: { group: "", kind: "Pod" } }),
  });

  it("reads the parameters and writes the answer as JSON", async () => {
    expect(await handle("echo", JSON.stringify({ a: [1, 2] }))).toBe('{"a":[1,2]}');
    expect(await handle("echo", "")).toBe("null");
    expect(await handle("clusters", "null")).toBe("2");
    expect(calls).toEqual([["clusters.list", "{}"]]);
  });

  it("turns every failure into the message the frame's call fails with", async () => {
    await expect(handle("fails", "null")).rejects.toBe("on purpose");
    await expect(handle("denied", "null")).rejects.toBe("resources.list is not granted");
    await expect(handle("toString", "null")).rejects.toBe("unknown method toString");
  });
});

describe("problem judges", () => {
  const handle = defineBackend(
    { ping: () => "pong" },
    {
      problemJudges: {
        hosts: (objects) =>
          objects
            .filter((o) => !Array.isArray(o.values[".spec.hosts"]))
            .map((o) => ({ uid: o.metadata.uid, fact: "no-hosts", values: { name: o.metadata.name } })),
        slow: async () => [],
        fails: () => {
          throw new Error("cannot judge");
        },
      },
    },
  );
  const object = (uid: string, values: Record<string, unknown>) => ({
    apiVersion: "networking.istio.io/v1",
    kind: "VirtualService",
    metadata: { name: `vs-${uid}`, namespace: "shop", uid },
    values,
  });

  it("answers `problemJudge:<id>` with the judge's facts", async () => {
    const params = JSON.stringify({ objects: [object("a", { ".spec.hosts": ["web"] }), object("b", {})] });
    expect(JSON.parse(await handle("problemJudge:hosts", params))).toEqual([{ uid: "b", fact: "no-hosts", values: { name: "vs-b" } }]);
    expect(await handle("problemJudge:slow", "{}")).toBe("[]");
    // The frames' methods still answer, and a judge is no frame method.
    expect(await handle("ping", "null")).toBe('"pong"');
    await expect(handle("hosts", "null")).rejects.toBe("unknown method hosts");
  });

  it("fails an unknown judge or a judge that throws", async () => {
    await expect(handle("problemJudge:nope", "{}")).rejects.toBe("unknown problem judge nope");
    await expect(handle("problemJudge:fails", "{}")).rejects.toBe("cannot judge");
    await expect(handle("problemJudge:toString", "{}")).rejects.toBe("unknown problem judge toString");
  });
});

describe("host", () => {
  it("throws a SextantError with the API's code", () => {
    try {
      host.secret.value({ clusterId: "a", namespace: "n", name: "s", key: "k" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SextantError);
      expect((err as InstanceType<typeof SextantError>).code).toBe("forbidden");
      expect((err as InstanceType<typeof SextantError>).method).toBe("secret.value");
    }
  });

  it("reads credentials and writes the log", () => {
    expect(host.credentials.get("token")).toBeNull();
    expect(calls).toEqual([["credentials.get", '{"name":"token"}']]);
    host.log.warn("careful");
    expect(lines).toEqual([["warn", "careful"]]);
  });
});
