import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { compileSearch, matchesSearch, searchTerms } from "./search";
import { joinSelectors, serverSelectors } from "./selectors";

const pod = (labels: Record<string, string>, phase = "Running"): KubeObject => ({
  metadata: { name: "web-1", namespace: "shop", labels },
  status: { phase },
});

describe("selector terms of a search", () => {
  it("become label and field selectors the API server can apply", () => {
    expect(serverSelectors(searchTerms("app=web tier!=db web"), "/Pod")).toEqual({
      labelSelector: "app=web,tier!=db",
      fieldSelector: null,
    });
    expect(serverSelectors(searchTerms("status.phase=Running spec.nodeName==node-1 app.kubernetes.io/name=x"), "/Pod")).toEqual({
      labelSelector: "app.kubernetes.io/name=x",
      fieldSelector: "spec.nodeName=node-1,status.phase=Running",
    });
    // `app=` is "has the label"; metadata.name works for every kind.
    expect(serverSelectors(["app=", "metadata.name=x"], "apps/Deployment")).toEqual({
      labelSelector: "app",
      fieldSelector: "metadata.name=x",
    });
  });

  it("leaves what is not a valid selector to the window", () => {
    // A field the kind cannot be selected by reads as a label key (dots are allowed in label keys).
    expect(serverSelectors(["status.phase=Running"], "apps/Deployment")).toEqual({
      labelSelector: "status.phase=Running",
      fieldSelector: null,
    });
    expect(serverSelectors(["app!=", "-bad=x", `app=${"x".repeat(64)}`, "status.phase=", "web"], "/Pod")).toEqual({
      labelSelector: null,
      fieldSelector: null,
    });
    expect(joinSelectors("a=b", null, " ", "c=d")).toBe("a=b,c=d");
    expect(joinSelectors(null, undefined)).toBeNull();
  });

  it("are matched in the window as the API server matches them", () => {
    const running = pod({ app: "web" });
    const pending = pod({ app: "web" }, "Pending");
    expect(compileSearch("status.phase=Running", "/Pod")(running)).toBe(true);
    expect(compileSearch("status.phase=Running", "/Pod")(pending)).toBe(false);
    expect(compileSearch("status.phase!=Running", "/Pod")(pending)).toBe(true);
    // Without the kind (other callers) a dotted key stays a label term, as before.
    expect(matchesSearch(running, "status.phase=Running")).toBe(false);
    expect(compileSearch("app=web shop", "/Pod")(running)).toBe(true);
    expect(compileSearch("app= tier!=db", "/Pod")(running)).toBe(true);
    expect(compileSearch("app=api", "/Pod")(running)).toBe(false);
  });

  it("read fields the way the API server names and defaults them", () => {
    const event: KubeObject = { metadata: { name: "e" }, source: { component: "kubelet" }, reportingController: "kubelet" };
    expect(compileSearch("source=kubelet", "/Event")(event)).toBe(true);
    expect(compileSearch("reportingComponent=kubelet", "/Event")(event)).toBe(true);
    const job: KubeObject = { metadata: { name: "j" }, status: { succeeded: 1 } };
    expect(compileSearch("status.successful=1", "batch/Job")(job)).toBe(true);
    expect(compileSearch("status.successful=0", "batch/Job")({ metadata: { name: "new" } })).toBe(true);
    // Unset booleans are "false" to the API server.
    expect(compileSearch("spec.hostNetwork=false", "/Pod")(pod({}))).toBe(true);
    expect(compileSearch("spec.unschedulable=false", "/Node")({ metadata: { name: "n" }, spec: {} })).toBe(true);
    expect(compileSearch("spec.unschedulable=false", "/Node")({ metadata: { name: "n" }, spec: { unschedulable: true } })).toBe(false);
  });
});
