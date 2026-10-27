import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type AccessQuery,
  type ClusterInfo,
  type MockBackend,
  type ResourceKind,
  type RulesReview,
  type WatchSpec,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { acquireSource, resetProblemSources } from "../problems/store";
import { CATEGORY_SOURCES } from "../problems/sources";
import { getAccess, restrictedScope } from "./accessStore";
import { resetNamespaceRestore, selectNamespaces, useSelectedNamespaces } from "./namespaces";

const CLUSTER: ClusterInfo = {
  id: "c1",
  context: "team",
  clusterName: "openshift",
  server: "https://api.example:6443",
  user: "ci",
  namespace: "dev",
  sourceId: "s1",
};

const kind = (group: string, k: string, plural: string, namespaced: boolean): ResourceKind => ({
  kindRef: { group, version: "v1", kind: k },
  plural,
  namespaced,
  verbs: ["get", "list", "watch"],
  printerColumns: [],
});

const KINDS: ResourceKind[] = [
  kind("", "Pod", "pods", true),
  kind("apps", "Deployment", "deployments", true),
  kind("", "Node", "nodes", false),
  kind("storage.k8s.io", "StorageClass", "storageclasses", false),
  kind("project.openshift.io", "Project", "projects", false),
];

/** Pods may be listed in these namespaces; the rest is refused. */
const READABLE = new Set(["dev", "team-a", "team-c", "proj-x", "late"]);

interface Setup {
  backend: MockBackend;
  specs: Map<string, WatchSpec>;
  questions: AccessQuery[][];
}

function setUp({ mayListNamespaces = false, known = ["team-a", "team-b"] } = {}): Setup {
  const specs = new Map<string, WatchSpec>();
  const questions: AccessQuery[][] = [];
  let n = 0;
  const backend = mockBackend(
    {
      rbac_can_i: (args) => {
        const queries = args.queries as AccessQuery[];
        questions.push(queries);
        expect(queries.length).toBeLessThanOrEqual(64);
        return queries.map((q) => {
          const allowed =
            q.resource === "namespaces"
              ? mayListNamespaces
              : q.resource === "pods"
                ? READABLE.has(q.namespace)
                : q.resource === "storageclasses";
          return { allowed, denied: false, reason: "", evaluationError: "" };
        });
      },
      rbac_whoami: () => ({ username: "system:serviceaccount:team-c:ci", serviceAccountNamespace: "team-c" }),
      rbac_rules_review: (args): RulesReview => ({
        namespace: args.namespace as string,
        resourceRules: [{ verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods"], resourceNames: [] }],
        nonResourceRules: [],
        incomplete: false,
        evaluationError: "",
      }),
      cluster_kinds: () => KINDS,
      watch_start: (args) => {
        const id = `watch-${++n}`;
        specs.set(id, args.spec as WatchSpec);
        return id;
      },
      watch_stop: () => undefined,
    },
    { settings: { clusters: { c1: { ...defaultClusterSettings(), knownNamespaces: known } } } },
  );
  useClustersStore.setState({ clusters: [CLUSTER], states: {} });
  return { backend, specs, questions };
}

function connect(): void {
  act(() => useClustersStore.setState({ states: { c1: { state: "connected" } } }));
}

/** Answers the project list (the only watch the check starts). */
async function answerProjects(setup: Setup, names: string[]): Promise<void> {
  let id: string | undefined;
  await waitFor(() => {
    id = [...setup.specs].find(([sid, s]) => s.kind.kind === "Project" && setup.backend.listenerCount(`watch:${sid}`) > 0)?.[0];
    expect(id).toBeDefined();
  });
  const spec = setup.specs.get(id!)!;
  expect(spec.metadataOnly).toBe(true);
  act(() =>
    setup.backend.emit(`watch:${id}`, {
      type: "snapshot",
      items: names.map((name) => ({ apiVersion: "project.openshift.io/v1", kind: "Project", metadata: { name, uid: name } })),
    }),
  );
}

let current: Setup | null = null;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetClustersStore();
});

afterEach(() => {
  resetProblemSources();
  resetNamespaceRestore();
  current?.backend.restore();
  current = null;
});

describe("the access check of a user who may not list Namespaces", () => {
  it("finds candidates, asks about each, and makes “All namespaces” the accessible ones", async () => {
    current = setUp();
    const { result } = renderHook(() => useSelectedNamespaces("c1"));
    await waitFor(() => expect(result.current).toBeNull());
    connect();
    // Waits for the first answer instead of watching cluster-wide.
    expect(result.current).toBeUndefined();
    await answerProjects(current, ["proj-x"]);
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));

    const access = getAccess("c1");
    expect(access.listNamespaces).toBe(false);
    expect(access.username).toBe("system:serviceaccount:team-c:ci");
    expect(Object.fromEntries(access.found)).toEqual({
      dev: ["context"],
      "team-c": ["serviceAccount"],
      "proj-x": ["project"],
    });
    expect(Object.fromEntries(access.namespaces)).toEqual({
      dev: "accessible",
      "proj-x": "accessible",
      "team-c": "accessible",
      "team-a": "accessible",
      "team-b": "noAccess",
    });
    expect(result.current).toEqual(["dev", "proj-x", "team-a", "team-c"]);
    expect(restrictedScope("c1")).toBe(result.current);

    // Cluster-scoped kinds by one batch, namespaced ones by the rules of each accessible namespace.
    expect(Object.fromEntries(access.clusterKinds)).toEqual({
      "/Node": false,
      "project.openshift.io/Project": false,
      "storage.k8s.io/StorageClass": true,
    });
    expect([...access.rules.keys()].sort()).toEqual(["dev", "proj-x", "team-a", "team-c"]);
    const calls = current.backend.calls.map((c) => c.cmd);
    expect(calls.filter((c) => c === "rbac_whoami")).toHaveLength(1);
    expect(calls.filter((c) => c === "rbac_rules_review")).toHaveLength(4);
    // Only the user's own permissions are asked: nothing is written.
    expect(calls.every((c) => /^(rbac_|cluster_kinds|watch_|settings_get|streams_reset)/.test(c))).toBe(true);
  });

  it("asks about a namespace typed later, and the selection itself is kept", async () => {
    current = setUp({ known: [] });
    const { result } = renderHook(() => useSelectedNamespaces("c1"));
    await waitFor(() => expect(result.current).toBeNull());
    connect();
    await answerProjects(current, []);
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    expect(result.current).toEqual(["dev", "team-c"]);

    await act(() => selectNamespaces("c1", ["late"]));
    expect(result.current).toEqual(["late"]);
    expect(current.backend.settings.clusters.c1?.knownNamespaces).toEqual(["late"]);
    await waitFor(() => expect(getAccess("c1").namespaces.get("late")).toBe("accessible"));
    expect(current.questions.some((q) => q.length === 1 && q[0]?.namespace === "late")).toBe(true);

    // Back to all: the typed one is known now, so it is part of "All accessible".
    await act(() => selectNamespaces("c1", null));
    await waitFor(() => expect(result.current).toEqual(["dev", "late", "team-c"]));
  });

  it("makes the problem sources watch the accessible namespaces", async () => {
    current = setUp();
    expect(restrictedScope("c1")).toBeNull();
    connect();
    await answerProjects(current, []);
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    const release = acquireSource("c1", CATEGORY_SOURCES.pods[0]!);
    await waitFor(() => expect([...current!.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(true));
    const pods = [...current.specs.values()].filter((s) => s.kind.kind === "Pod");
    expect(pods.at(-1)?.namespaces).toEqual(["dev", "team-a", "team-c"]);
    release();
  });
});

describe("the access check of a user who may list Namespaces", () => {
  it("changes nothing: one review, then “All namespaces” is cluster-wide", async () => {
    current = setUp({ mayListNamespaces: true });
    const { result } = renderHook(() => useSelectedNamespaces("c1"));
    connect();
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    expect(result.current).toBeNull();
    expect(getAccess("c1").listNamespaces).toBe(true);
    expect(current.questions).toHaveLength(1);
    expect(current.backend.calls.some((c) => c.cmd === "rbac_whoami" || c.cmd === "rbac_rules_review")).toBe(false);
    expect(restrictedScope("c1")).toBeNull();
  });

  it("changes nothing when the review fails", async () => {
    current = setUp();
    current.backend.on("rbac_can_i", () => {
      throw { code: "forbidden", message: "no reviews" };
    });
    const { result } = renderHook(() => useSelectedNamespaces("c1"));
    connect();
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    expect(result.current).toBeNull();
    expect(getAccess("c1").listNamespaces).toBeNull();
    expect(getAccess("c1").error?.code).toBe("forbidden");
  });

  it("forgets the check when the cluster disconnects", async () => {
    current = setUp();
    expect(restrictedScope("c1")).toBeNull();
    connect();
    await answerProjects(current, []);
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    expect(restrictedScope("c1")).not.toBeNull();
    act(() => useClustersStore.setState({ states: { c1: { state: "disconnected" } } }));
    expect(getAccess("c1").status).toBe("idle");
    expect(restrictedScope("c1")).toBeNull();
  });
});
