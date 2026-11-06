import type { KubeObject, ObjectRef } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import applicationJson from "../fixtures/application.json";
import applicationManualJson from "../fixtures/application-manual.json";
import applicationRunningJson from "../fixtures/application-running.json";
import applicationSetJson from "../fixtures/applicationset.json";
import appProjectJson from "../fixtures/appproject.json";
import deploymentJson from "../fixtures/deployment.json";
import podJson from "../fixtures/pod.json";
import replicaSetJson from "../fixtures/replicaset.json";
import serviceJson from "../fixtures/service.json";
import manifest from "../sextant-extension.json";
import { refreshAll, runningForward, uiPath } from "./actions";
import {
  APPLICATION,
  RUNNING,
  defaultRevision,
  descendantKinds,
  destinationText,
  applicationDestination,
  flattenTree,
  generatedCount,
  managedResources,
  operationRunning,
  patchCall,
  refreshPatch,
  resourceTree,
  shortRevision,
  syncHistory,
  syncPatch,
  terminatePatch,
  type ManagedResource,
} from "./argo";
import { diffLines, diffRows, parseManagedResources, sideBySide, sidesOf, stateOf, yamlOf, type ArgoResource } from "./diffModel";
import { failureOf, signInNotes } from "./diff";
import { computedHealth, liveState, namespacesFor, type LiveList } from "./tree";
import {
  ADMIN_PASSWORD,
  adminSignIn,
  answerKind,
  chooseInstallation,
  isInsecure,
  loginOptionsOf,
  managedResourcesRequest,
  serviceOf,
  typedSignIn,
  uiPort,
  userInfo,
  userOf,
  type ArgoServer,
} from "./server";

const app = applicationJson as unknown as KubeObject;
const running = applicationRunningJson as unknown as KubeObject;
const deployment = deploymentJson as unknown as KubeObject;
const replicaSet = replicaSetJson as unknown as KubeObject;
const pod = podJson as unknown as KubeObject;
const copy = <T>(v: T): T => structuredClone(v);

describe("the Application's status", () => {
  it("knows a running operation as the manifest's conditions do", () => {
    expect(operationRunning(running)).toBe(true);
    expect(operationRunning(app)).toBe(false);
    const terminating = copy(app) as KubeObject & { status: Record<string, unknown> };
    terminating.status.operationState = { phase: "Terminating" };
    expect(operationRunning(terminating)).toBe(true);
    const asked = { ...copy(app), operation: { sync: {} } } as KubeObject;
    expect(operationRunning(asked)).toBe(true);
    // Terminate holds exactly while an operation runs, Sync exactly while none does, and the column says Syncing.
    const actions = manifest.contributes.actions;
    expect(actions.find((a) => a.id === "terminate")?.when).toEqual(RUNNING);
    expect(actions.find((a) => a.id === "sync")?.when).toEqual({ type: "not", of: RUNNING });
    expect(manifest.contributes.columns.find((c) => c.id === "sync")?.cases?.[0]?.when).toEqual(RUNNING);
  });

  it("shortens commits, keeps tags, and reads the destination and history", () => {
    expect(shortRevision("a".repeat(40))).toBe("aaaaaaa");
    expect(shortRevision("v1.2.3")).toBe("v1.2.3");
    expect(destinationText(applicationDestination(app))).toBe("in-cluster/sextant-argo");
    const history = syncHistory(app);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.id).toBeGreaterThanOrEqual(history.at(-1)!.id!);
    expect(generatedCount(applicationSetJson as unknown as KubeObject)).toBeGreaterThan(0);
    expect(appProjectJson.kind).toBe("AppProject");
  });
});

describe("the patches", () => {
  it("Sync carries the app's sync options and retry, as `argocd app sync`", () => {
    const withRetry = copy(app) as KubeObject & { spec: { syncPolicy: Record<string, unknown> } };
    withRetry.spec.syncPolicy.retry = { limit: 2 };
    expect(syncPatch(withRetry, { revision: "main", prune: true, dryRun: false })).toEqual({
      operation: {
        initiatedBy: { username: "sextant" },
        sync: { prune: true, dryRun: false, revision: "main", syncOptions: ["CreateNamespace=true"] },
        retry: { limit: 2 },
      },
    });
    // Each source's own revision: none named.
    expect(syncPatch(applicationManualJson as unknown as KubeObject, { revision: null, prune: false, dryRun: true })).toEqual({
      operation: { initiatedBy: { username: "sextant" }, sync: { prune: false, dryRun: true, syncOptions: ["CreateNamespace=true"] } },
    });
    expect(defaultRevision(app)).toBe("HEAD");
  });

  it("Refresh, Hard refresh and Terminate are merge patches of the Application", () => {
    expect(refreshPatch("normal")).toEqual({ metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } } });
    expect(refreshPatch("hard")).toEqual({ metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } });
    expect(terminatePatch()).toEqual({ status: { operationState: { phase: "Terminating" } } });
    const ref: ObjectRef = { kind: APPLICATION, namespace: "argocd", name: "guestbook" };
    expect(patchCall(ref, terminatePatch())).toEqual({
      ref: { kind: APPLICATION, namespace: "argocd", name: "guestbook" },
      patch: { status: { operationState: { phase: "Terminating" } } },
      patchType: "merge",
    });
  });

  it("refreshes every selected Application under one confirmation per 50, stopping at the first failure", async () => {
    const calls: { items: unknown[] }[] = [];
    let fail = false;
    const sextant = {
      resources: {
        patchMany: async (p: { items: unknown[] }) => {
          calls.push(p);
          return fail ? { items: [{ error: { code: "conflict", message: "changed" } }], sent: 1 } : { items: p.items.map(() => ({ object: {} })), sent: p.items.length };
        },
      },
    } as never;
    const refs: ObjectRef[] = Array.from({ length: 51 }, (_, i) => ({ kind: APPLICATION, namespace: "argocd", name: `app-${i}` }));
    await refreshAll(sextant, refs, "hard");
    expect(calls.map((c) => c.items.length)).toEqual([50, 1]);
    expect(calls[0]!.items[0]).toEqual(patchCall(refs[0]!, refreshPatch("hard")));
    fail = true;
    await expect(refreshAll(sextant, refs.slice(0, 2), "normal")).rejects.toThrow("changed");
  });
});

describe("the resource tree", () => {
  const resources = managedResources(app);

  it("lists what the managed resources own, by owner references", () => {
    expect(descendantKinds(resources)).toEqual([
      { kind: { group: "", version: "v1", kind: "Pod" }, namespaces: ["sextant-argo"] },
      { kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, namespaces: ["sextant-argo"] },
    ]);
    const tree = resourceTree(
      resources,
      new Map([
        ["apps/ReplicaSet", [replicaSet]],
        ["/Pod", [pod]],
      ]),
    );
    const rows = flattenTree(tree).map(({ level, node }) => `${level} ${node.ref.kind.kind} ${node.ref.name}`);
    expect(rows).toEqual([
      "1 Service guestbook-ui",
      "1 Deployment guestbook-ui",
      "2 ReplicaSet guestbook-ui-6d476cf4df",
      "3 Pod guestbook-ui-6d476cf4df-sfw78",
    ]);
  });

  it("computes the health Argo CD 3.x keeps only in its API, from lists that are read", () => {
    const ready = (items: KubeObject[]): LiveList => ({ items, status: "ready", forbidden: [] });
    const lists = new Map<string, LiveList>([
      ["apps/Deployment", ready([deployment])],
      ["/Service", ready([])],
    ]);
    const health = computedHealth(resources, lists);
    expect(health.get("apps/Deployment/sextant-argo/guestbook-ui")?.status).toBe("Healthy");
    expect(health.get("/Service/sextant-argo/guestbook-ui")?.status).toBe("Missing");
    // A list still loading, or a namespace the cluster refused, decides nothing.
    lists.set("/Service", { items: [], status: "loading", forbidden: [] });
    lists.set("apps/Deployment", { items: [], status: "ready", forbidden: ["sextant-argo"] });
    expect(computedHealth(resources, lists).size).toBe(0);
    // A health the Application carries is shown as it is.
    const carried: ManagedResource[] = resources.map((r) => ({ ...r, health: "Healthy" }));
    expect(computedHealth(carried, new Map([["/Service", ready([serviceJson as unknown as KubeObject])]])).size).toBe(0);
  });

  it("shows a descendant's own state and lists each kind once in the namespaces needed", () => {
    expect(liveState(pod, { kind: "Pod" })).toBe("Running");
    expect(liveState(replicaSet, { kind: "ReplicaSet" })).toMatch(/^\d+\/\d+$/);
    const pods = { kind: { group: "", version: "v1", kind: "Pod" }, namespaces: ["b", "a"] };
    expect(namespacesFor(pods.kind, [pods], [{ ...pods, namespaces: ["c", "a"] }])).toEqual(["a", "b", "c"]);
  });
});

const server = (insecure = false): ArgoServer => ({
  clusterId: "kind",
  namespace: "argocd",
  server: { metadata: { name: "argocd-server", namespace: "argocd" } },
  insecure,
  options: { localUsers: true, admin: true, sso: false },
});

describe("the requests to Argo CD's API", () => {
  it("sign in with the admin Secret through Sextant, which keeps the token", () => {
    expect(adminSignIn(server())).toEqual({
      clusterId: "kind",
      namespace: "argocd",
      service: "argocd-server",
      method: "POST",
      path: "/api/v1/session",
      body: { username: "admin", password: "{{secret:argocd-initial-admin-secret/password}}" },
      capture: ".token",
    });
    expect(ADMIN_PASSWORD).toBe("{{secret:argocd-initial-admin-secret/password}}");
    // Plain HTTP only when the installation says its server runs without TLS.
    expect(adminSignIn(server(true)).service).toBe("argocd-server-http");
    const services = manifest.contributes.services;
    expect(services.map((s) => [s.id, s.labelSelector, s.port, s.scheme])).toEqual([
      ["argocd-server", "app.kubernetes.io/name=argocd-server", "https", "https"],
      ["argocd-server-http", "app.kubernetes.io/name=argocd-server", "http", "http"],
      ["argocd-server-token", "app.kubernetes.io/name=argocd-server", "https", "https"],
      ["argocd-server-token-http", "app.kubernetes.io/name=argocd-server", "http", "http"],
    ]);
    // Only the password services receive the admin Secret's key; each asks for its own sign-in in Sextant's dialog.
    expect(services.map((s) => ("secrets" in s ? s.secrets : []))).toEqual([
      [{ name: "argocd-initial-admin-secret", key: "password" }],
      [{ name: "argocd-initial-admin-secret", key: "password" }],
      [],
      [],
    ]);
    expect(services.map((s) => s.signIn.fields.map((f) => f.id))).toEqual([["username", "password"], ["username", "password"], ["token"], ["token"]]);
    expect(serviceOf(server(), "token")).toBe("argocd-server-token");
    expect(serviceOf(server(true), "token")).toBe("argocd-server-token-http");
  });

  it("sign in with what was typed in Sextant's dialog, never with a value of the extension's", () => {
    expect(typedSignIn(server())).toEqual({
      clusterId: "kind",
      namespace: "argocd",
      service: "argocd-server",
      method: "POST",
      path: "/api/v1/session",
      body: { username: "{{signIn:username}}", password: "{{signIn:password}}" },
      capture: ".token",
    });
    expect(managedResourcesRequest(server(), { namespace: "team-a", name: "guestbook" })).toEqual({
      clusterId: "kind",
      namespace: "argocd",
      service: "argocd-server",
      method: "GET",
      path: "/api/v1/applications/guestbook/managed-resources",
      query: { appNamespace: "team-a" },
      auth: "session",
    });
    // An API token goes as the bearer of each request, through its own service.
    expect(managedResourcesRequest(server(), { namespace: "argocd", name: "guestbook" }, "token")).toMatchObject({
      service: "argocd-server-token",
      auth: "signIn:token",
    });
    expect(userInfo(server())).toMatchObject({ method: "GET", path: "/api/v1/session/userinfo", auth: "session" });
    expect(userInfo(server(), "token")).toMatchObject({ service: "argocd-server-token", auth: "signIn:token" });
    expect(userOf({ loggedIn: true, username: "admin" })).toBe("admin");
    expect(userOf({})).toBeNull();
  });

  it("reads answers by status and failures as words", () => {
    expect(answerKind(200)).toBe("ok");
    expect(answerKind(401)).toBe("unauthorized");
    expect(answerKind(403)).toBe("forbidden");
    expect(answerKind(404)).toBe("forbidden");
    expect(answerKind(503)).toBe("unreachable");
    expect(answerKind(500)).toBe("other");
    expect(failureOf({ status: 403, body: { error: "permission denied", code: 7 } })).toEqual({
      key: "diff.errors.forbidden",
      detail: "permission denied",
    });
  });

  it("finds the installation, never choosing between several by itself", () => {
    const svc = (namespace: string, name = "argocd-server"): KubeObject => ({ metadata: { name, namespace } });
    expect(chooseInstallation([], null)).toEqual({ type: "none" });
    expect(chooseInstallation([svc("gitops")], null)).toMatchObject({ type: "found", namespace: "gitops" });
    expect(chooseInstallation([svc("argocd"), svc("team-a")], null)).toEqual({ type: "several", namespaces: ["argocd", "team-a"] });
    expect(chooseInstallation([svc("argocd"), svc("team-a")], "team-a")).toMatchObject({ type: "found", namespace: "team-a" });
    // A remembered choice that is no longer there is not taken.
    expect(chooseInstallation([svc("argocd"), svc("team-a")], "gone")).toMatchObject({ type: "several" });
  });

  it("reads the installation's settings as Argo CD does", () => {
    expect(isInsecure({ "server.insecure": " TRUE " })).toBe(true);
    expect(isInsecure({})).toBe(false);
    expect(loginOptionsOf({})).toEqual({ localUsers: true, admin: true, sso: false });
    expect(loginOptionsOf({ "admin.enabled": "false", "oidc.config": "x" })).toEqual({ localUsers: false, admin: false, sso: true });
    expect(loginOptionsOf({ "admin.enabled": "false", "accounts.alice": "apiKey, login" }).localUsers).toBe(true);
    expect(signInNotes({ ...server(true), options: { localUsers: false, admin: false, sso: true } }, { expired: true })).toEqual([
      "login.expired",
      "login.insecure",
      "login.noLocalUsers",
      "login.sso",
    ]);
    expect(signInNotes(server(), { savedRefused: true, adminRefused: true })).toEqual(["login.refused.saved", "login.refused.adminSecret"]);
  });

  it("opens the UI on the Application's page through a forward of its UI port", () => {
    expect(uiPort({ metadata: { name: "s" }, spec: { ports: [{ name: "http", port: 80 }, { name: "https", port: 443 }] } })).toBe(443);
    expect(uiPort({ metadata: { name: "s" }, spec: { ports: [{ name: "web", port: 8080 }] } })).toBe(8080);
    expect(uiPath({ kind: APPLICATION, namespace: "argocd", name: "guest book" })).toBe("/applications/argocd/guest%20book");
    expect(uiPath({ kind: { group: "argoproj.io", version: "v1alpha1", kind: "AppProject" }, namespace: "argocd", name: "p" })).toBe("/applications");
    const forward = {
      id: "f1",
      cluster: "kind",
      target: { type: "service" as const, namespace: "argocd", name: "argocd-server" },
      remotePort: 443,
      localPort: 40000,
      status: { state: "active" as const },
      source: "extension" as never,
    };
    expect(runningForward([forward], "kind", "argocd", "argocd-server", 443)).toBe(forward);
    expect(runningForward([forward], "kind", "argocd", "argocd-server", 80)).toBeUndefined();
  });
});

const resource = (fields: Partial<ArgoResource>): ArgoResource => ({
  group: "apps",
  kind: "Deployment",
  namespace: "sextant-argo",
  name: "web",
  targetState: null,
  liveState: null,
  normalizedLiveState: null,
  predictedLiveState: null,
  ...fields,
});

describe("the diff", () => {
  it("parses the states Argo CD sends as JSON text, without managed fields", () => {
    const [item] = parseManagedResources({
      items: [
        {
          group: "",
          kind: "ConfigMap",
          namespace: "a",
          name: "c",
          targetState: JSON.stringify({ data: { x: "1" } }),
          liveState: JSON.stringify({ data: { x: "2" }, metadata: { name: "c", managedFields: [{}] } }),
          normalizedLiveState: "null",
          predictedLiveState: "",
        },
      ],
    });
    expect(item!.targetState).toEqual({ data: { x: "1" } });
    expect(item!.liveState).toEqual({ data: { x: "2" }, metadata: { name: "c" } });
    expect(item!.normalizedLiveState).toBeNull();
    expect(item!.predictedLiveState).toBeNull();
  });

  it("pairs the predicted and normalized states and names the four states", () => {
    const changed = resource({ targetState: { a: 1 }, predictedLiveState: { a: 2 }, liveState: { a: 3 }, normalizedLiveState: { a: 1 } });
    expect(sidesOf(changed)).toEqual({ desired: { a: 2 }, live: { a: 1 } });
    expect(stateOf(changed)).toBe("changed");
    expect(stateOf(resource({ targetState: { b: 1, a: 2 }, liveState: { a: 2, b: 1 } }))).toBe("inSync");
    expect(stateOf(resource({ targetState: { a: 1 } }))).toBe("missingLive");
    expect(stateOf(resource({ liveState: { a: 1 } }))).toBe("missingTarget");
    const rows = diffRows([
      resource({ name: "z", targetState: { a: 1 }, liveState: { a: 1 } }),
      resource({ name: "y", liveState: { a: 1 } }),
      resource({ name: "x", targetState: { a: 1 }, liveState: { a: 2 } }),
    ]);
    expect(rows.map((r) => r.state)).toEqual(["changed", "missingTarget", "inSync"]);
    expect(yamlOf({ b: { d: 1, c: "x" }, a: [1] })).toBe("a:\n- 1\nb:\n  c: x\n  d: 1\n");
  });

  it("diffs lines as a shortest edit and folds long unchanged runs", () => {
    const ops = diffLines(["a", "b", "c", "d"], ["a", "c", "d", "e"]);
    expect(ops).toEqual([
      { type: "same", text: "a" },
      { type: "removed", text: "b" },
      { type: "same", text: "c" },
      { type: "same", text: "d" },
      { type: "added", text: "e" },
    ]);
    expect(diffLines([], [])).toEqual([]);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const rows = sideBySide(lines.join("\n"), [...lines.slice(0, 10), "changed", ...lines.slice(11)].join("\n"));
    const folds = rows.filter((r) => r.type === "fold");
    expect(folds.map((f) => (f.type === "fold" ? f.count : 0))).toEqual([7, 6]);
    const changedRow = rows.find((r) => r.type === "line" && r.changed);
    expect(changedRow).toEqual({ type: "line", left: { no: 11, text: "line 10" }, right: { no: 11, text: "changed" }, changed: true });
  });
});
