import { describe, expect, it } from "vitest";
import en from "../../locales/en/upgrade.json";
import {
  DEPRECATIONS,
  findDeprecation,
  parseMinor,
  RAW_TABLE,
  replacementAt,
  REVIEWED_FOR,
  scanApis,
  splitApiVersion,
  tableProblems,
} from "./table";

describe("the built-in deprecation table", () => {
  it("is valid and sorted by removal, group, version and kind", () => {
    expect(tableProblems(RAW_TABLE)).toEqual([]);
    expect(DEPRECATIONS.length).toBeGreaterThan(40);
    expect(REVIEWED_FOR).toBeGreaterThanOrEqual(35);
  });

  it("finds a problem in a broken table", () => {
    const broken = {
      source: "https://kubernetes.io/x",
      reviewedFor: "1.35",
      apis: [
        { group: "policy", version: "v1beta1", kind: "PodDisruptionBudget", deprecatedIn: "1.21", removedIn: "1.25", replacement: "policy/v1" },
        { group: "batch", version: "v1beta1", kind: "CronJob", deprecatedIn: "1.25", removedIn: "1.21", replacement: "batch/v1" },
        { group: "batch", version: "v1beta1", kind: "CronJob", deprecatedIn: "1.21", removedIn: "1.25", replacement: null },
      ],
    };
    const problems = tableProblems(broken);
    expect(problems).toContain("batch/v1beta1 CronJob: removed before it is deprecated");
    expect(problems).toContain("batch/v1beta1 CronJob: out of order");
    expect(problems).toContain("batch/v1beta1 CronJob: listed twice");
    expect(problems.some((p) => p.includes("is not a group/version (or a note)"))).toBe(true);
  });

  it("covers the removals of the Kubernetes deprecation guide", () => {
    const removed = (apiVersion: string, kind: string) => {
      const { group, version } = splitApiVersion(apiVersion);
      return findDeprecation(group, version, kind)?.removedIn;
    };
    expect(removed("extensions/v1beta1", "Deployment")).toBe(16);
    expect(removed("apps/v1beta2", "StatefulSet")).toBe(16);
    expect(removed("networking.k8s.io/v1beta1", "Ingress")).toBe(22);
    expect(removed("apiextensions.k8s.io/v1beta1", "CustomResourceDefinition")).toBe(22);
    expect(removed("policy/v1beta1", "PodSecurityPolicy")).toBe(25);
    expect(removed("batch/v1beta1", "CronJob")).toBe(25);
    expect(removed("autoscaling/v2beta2", "HorizontalPodAutoscaler")).toBe(26);
    expect(removed("storage.k8s.io/v1beta1", "CSIStorageCapacity")).toBe(27);
    expect(removed("flowcontrol.apiserver.k8s.io/v1beta2", "FlowSchema")).toBe(29);
    expect(removed("flowcontrol.apiserver.k8s.io/v1beta3", "PriorityLevelConfiguration")).toBe(32);
  });

  it("has a text for every note", () => {
    for (const d of DEPRECATIONS) {
      if (d.note) expect(en.notes).toHaveProperty(d.note);
    }
  });

  it("follows a replacement that is itself removed by the target", () => {
    const v1beta1 = findDeprecation("flowcontrol.apiserver.k8s.io", "v1beta1", "FlowSchema")!;
    expect(replacementAt(v1beta1, 26).apiVersion).toBe("flowcontrol.apiserver.k8s.io/v1beta2");
    expect(replacementAt(v1beta1, 29).apiVersion).toBe("flowcontrol.apiserver.k8s.io/v1beta3");
    expect(replacementAt(v1beta1, 33).apiVersion).toBe("flowcontrol.apiserver.k8s.io/v1");
    const psp = findDeprecation("extensions", "v1beta1", "PodSecurityPolicy")!;
    expect(replacementAt(psp, 20).apiVersion).toBe("policy/v1beta1");
    expect(replacementAt(psp, 25)).toEqual({ apiVersion: null, note: "podSecurityAdmission" });
  });

  it("asks the scan for every entry with its replacement", () => {
    const apis = scanApis();
    expect(apis).toHaveLength(DEPRECATIONS.length);
    expect(apis).toContainEqual({
      api: { group: "extensions", version: "v1beta1", kind: "Ingress" },
      replacement: { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
    });
    expect(apis).toContainEqual({ api: { group: "policy", version: "v1beta1", kind: "PodSecurityPolicy" }, replacement: null });
  });

  it("reads minor versions of servers and of the table", () => {
    expect(parseMinor("1.25")).toBe(25);
    expect(parseMinor("v1.31.4-eks-a1b2")).toBe(31);
    expect(parseMinor("v1.30.5-gke.1014001")).toBe(30);
    expect(parseMinor("2.1")).toBeNull();
    expect(parseMinor("")).toBeNull();
    expect(parseMinor(null)).toBeNull();
  });
});
