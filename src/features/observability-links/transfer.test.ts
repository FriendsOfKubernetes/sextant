import { describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type ClusterInfo, type KubeconfigSource } from "../../api";
import type { ObservabilityLinks } from "../../api/generated/ObservabilityLinks";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { applyImport, buildExport, exportText, ImportError, parseImport, planImport } from "../views/transfer";
import { readObservabilityLinks } from "./transfer";

const SOURCES: KubeconfigSource[] = [{ id: "s1", path: "/home/me/.kube/config", kind: "default", error: null }];
const CLUSTER: ClusterInfo = {
  id: "c1",
  context: "prod",
  clusterName: "prod",
  server: "https://prod:6443",
  user: "admin",
  namespace: null,
  sourceId: "s1",
};
const LINKS: ObservabilityLinks = {
  grafanaUrl: "https://grafana.example.com",
  dashboards: { pod: "/d/x?var-pod={pod}" },
  tracesUrl: null,
  traces: "/t?s={service}",
};

function withLinks(links: ObservabilityLinks | null): AppSettings {
  const settings = defaultAppSettings();
  return { ...settings, clusters: { c1: { ...defaultClusterSettings(), observabilityLinks: links } } };
}

describe("export of views", () => {
  it("carries the links only when ticked", () => {
    const settings = withLinks(LINKS);
    const plain = buildExport(settings, [CLUSTER], SOURCES, { includeAgentAccess: false });
    expect(plain.clusters[0]!.settings.observabilityLinks).toBeUndefined();
    const ticked = buildExport(settings, [CLUSTER], SOURCES, { includeAgentAccess: false, includeObservabilityLinks: true });
    expect(ticked.clusters[0]!.settings.observabilityLinks).toEqual(LINKS);
  });

  it("imports checked links onto the same cluster", () => {
    const text = exportText(
      buildExport(withLinks(LINKS), [CLUSTER], SOURCES, { includeAgentAccess: false, includeObservabilityLinks: true }),
    );
    const plan = planImport(parseImport(text), withLinks(null), [CLUSTER], SOURCES);
    expect(plan.clusters[0]!.added).toContain("observabilityLinks");
    const applied = applyImport(withLinks(null), plan, { overwrite: false, agentAccess: false });
    expect(applied.clusters.c1!.observabilityLinks).toEqual(LINKS);
  });

  it("refuses a file whose template leaves the base URL's site", () => {
    const file = buildExport(withLinks(LINKS), [CLUSTER], SOURCES, { includeAgentAccess: false, includeObservabilityLinks: true });
    file.clusters[0]!.settings.observabilityLinks = { ...LINKS, dashboards: { pod: "https://evil.example.com/{pod}" } };
    expect(() => parseImport(exportText(file))).toThrow(ImportError);
  });
});

describe("reading links strictly", () => {
  it.each([
    [{ ...LINKS, extra: 1 }, "unknown field"],
    [{ ...LINKS, grafanaUrl: "http://grafana.example.com" }, "not an accepted URL"],
    [{ ...LINKS, dashboards: { secret: "/d/x" } }, "unknown field"],
    [{ ...LINKS, traces: "javascript:alert(1)" }, "not an accepted template"],
    [{ ...LINKS, dashboards: { pod: "/d/{unknown}" } }, "not an accepted template"],
    ["text", "not an object"],
  ])("%j", (value, problem) => {
    const read = readObservabilityLinks(value, "$.l");
    expect(read.links).toBeNull();
    expect(read.problems.join("; ")).toContain(problem);
  });

  it("keeps valid links", () => {
    expect(readObservabilityLinks(LINKS, "$.l")).toEqual({ links: LINKS, problems: [] });
  });
});
