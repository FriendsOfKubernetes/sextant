import { describe, expect, it } from "vitest";
import { podResourceAmounts } from "./requests";

function pod(containers: Array<{ name: string; resources?: unknown }>, extra: Record<string, unknown> = {}) {
  return { spec: { containers, ...extra } };
}

describe("podResourceAmounts", () => {
  it("sums requests and limits of all containers: CPU in millicores, memory in bytes", () => {
    const amounts = podResourceAmounts(
      pod([
        {
          name: "app",
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "128Mi" },
          },
        },
        {
          name: "sidecar",
          resources: {
            requests: { cpu: "50m", memory: "32Mi" },
            limits: { cpu: "250m", memory: "64Mi" },
          },
        },
      ]),
    );
    expect(amounts.cpu).toEqual({
      request: 150,
      limit: 750,
      requestSetOn: 2,
      limitSetOn: 2,
      containers: 2,
    });
    expect(amounts.memory).toEqual({
      request: 96 * 1024 ** 2,
      limit: 192 * 1024 ** 2,
      requestSetOn: 2,
      limitSetOn: 2,
      containers: 2,
    });
    expect(amounts.byContainer.get("sidecar")).toEqual({
      cpu: { request: 50, limit: 250 },
      memory: { request: 32 * 1024 ** 2, limit: 64 * 1024 ** 2 },
    });
  });

  it("counts on how many containers a value is set when only some set it", () => {
    const amounts = podResourceAmounts(
      pod([
        {
          name: "app",
          resources: { requests: { cpu: "200m" }, limits: { memory: "1Gi" } },
        },
        { name: "sidecar" },
        {
          name: "proxy",
          resources: { requests: { cpu: "300m", memory: "10Mi" } },
        },
      ]),
    );
    expect(amounts.cpu).toEqual({
      request: 500,
      limit: undefined,
      requestSetOn: 2,
      limitSetOn: 0,
      containers: 3,
    });
    expect(amounts.memory).toEqual({
      request: 10 * 1024 ** 2,
      limit: 1024 ** 3,
      requestSetOn: 1,
      limitSetOn: 1,
      containers: 3,
    });
    expect(amounts.byContainer.get("sidecar")).toEqual({ cpu: {}, memory: {} });
    expect(amounts.byContainer.get("app")).toEqual({
      cpu: { request: 200 },
      memory: { limit: 1024 ** 3 },
    });
  });

  it("has no request and no limit when nothing is set", () => {
    const amounts = podResourceAmounts(pod([{ name: "app" }, { name: "b", resources: {} }]));
    expect(amounts.cpu).toEqual({
      request: undefined,
      limit: undefined,
      requestSetOn: 0,
      limitSetOn: 0,
      containers: 2,
    });
    expect(amounts.memory.requestSetOn).toBe(0);
    expect(amounts.byContainer.size).toBe(2);
  });

  it("reads different units: whole cores, fractions of a core, decimal and binary byte suffixes", () => {
    const amounts = podResourceAmounts(
      pod([
        { name: "a", resources: { requests: { cpu: "1", memory: "1G" } } },
        { name: "b", resources: { requests: { cpu: 0.5, memory: "512Mi" } } },
        {
          name: "c",
          resources: { requests: { cpu: "1500m", memory: "2048" } },
        },
      ]),
    );
    expect(amounts.cpu.request).toBe(3000);
    expect(amounts.memory.request).toBe(1e9 + 512 * 1024 ** 2 + 2048);
  });

  it("ignores init containers and values that are not quantities", () => {
    const amounts = podResourceAmounts(
      pod(
        [
          {
            name: "app",
            resources: { requests: { cpu: "bogus", memory: "8Mi" } },
          },
        ],
        {
          initContainers: [
            {
              name: "init",
              resources: { requests: { cpu: "4", memory: "4Gi" } },
            },
          ],
        },
      ),
    );
    expect(amounts.cpu.requestSetOn).toBe(0);
    expect(amounts.memory).toMatchObject({
      request: 8 * 1024 ** 2,
      requestSetOn: 1,
      containers: 1,
    });
    expect(amounts.byContainer.has("init")).toBe(false);
  });

  it("copes with an object that is not a pod", () => {
    expect(podResourceAmounts(null).cpu).toEqual({
      request: undefined,
      limit: undefined,
      requestSetOn: 0,
      limitSetOn: 0,
      containers: 0,
    });
    expect(podResourceAmounts({}).byContainer.size).toBe(0);
  });
});
