import { SextantError, type KubeObject, type ObjectRef } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import applicationJson from "../fixtures/application.json";
import applicationRunningJson from "../fixtures/application-running.json";
import deploymentJson from "../fixtures/deployment.json";
import podJson from "../fixtures/pod.json";
import replicaSetJson from "../fixtures/replicaset.json";
import { startAction } from "./actions";
import { APPLICATION } from "./argo";
import { startFields } from "./details";
import { setLanguage, t } from "./i18n";
import { installationKey } from "./server";
import { startTree } from "./tree";

const app = applicationJson as unknown as KubeObject;
const REF: ObjectRef = { kind: APPLICATION, namespace: "argocd", name: "guestbook" };
const SERVER: KubeObject = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "argocd-server", namespace: "argocd", labels: { "app.kubernetes.io/name": "argocd-server" } },
  spec: { ports: [{ name: "http", port: 80 }, { name: "https", port: 443 }] },
};
const MANAGED = {
  items: [
    {
      group: "apps",
      kind: "Deployment",
      namespace: "sextant-argo",
      name: "guestbook-ui",
      targetState: JSON.stringify({ spec: { replicas: 2 } }),
      liveState: JSON.stringify({ spec: { replicas: 1 } }),
    },
  ],
};

let host: TestHost | null = null;
let root: HTMLElement;
let stop: () => void = () => undefined;

beforeEach(() => {
  setLanguage("en");
  root = document.createElement("main");
  document.body.append(root);
});
afterEach(() => {
  stop();
  host?.close();
  host = null;
  root.remove();
});

const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const requests = (h: TestHost) =>
  h.calls.filter((c) => c.method === "service.request").map((c) => c.params as { method: string; path: string; body?: unknown; capture?: string; auth?: string });

async function open(contribution: string, handlers: TestHostOptions["handlers"], selection: ObjectRef[] = [REF]) {
  host = await startTestHost({ context: { view: "action", contribution, selection, clusterId: "kind" }, handlers });
  stop = startAction(host.sextant, root, contribution);
  await settle();
  return host;
}

/** Answers of an installation in `argocd`: Services, ConfigMaps, the app. */
const installation = (extra: TestHostOptions["handlers"] = {}): TestHostOptions["handlers"] => ({
  "resources.list": () => ({ items: [SERVER], truncated: false }),
  "resources.get": ({ ref }) => {
    if (ref.kind.kind === "ConfigMap") throw new SextantError("notFound", "no ConfigMap");
    return app;
  },
  ...extra,
});

describe("Diff", () => {
  it("signs in by itself with the admin Secret Sextant fills in, then shows desired ↔ live", async () => {
    let signedIn = false;
    const h = await open(
      "diff",
      installation({
        "service.request": (p) => {
          if (p.path === "/api/v1/session") {
            signedIn = true;
            return { status: 200, body: { token: "<hidden>" } };
          }
          if (p.path === "/api/v1/session/userinfo") return { status: 200, body: { loggedIn: true, username: "admin" } };
          if (!signedIn) throw new SextantError("unauthorized", "no session for this service: sign in first");
          return { status: 200, body: MANAGED };
        },
      }),
    );
    const sent = requests(h);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/v1/applications/guestbook/managed-resources", auth: "session" });
    expect(sent[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/session",
      body: { username: "admin", password: "{{secret:argocd-initial-admin-secret/password}}" },
      capture: ".token",
    });
    expect(root.textContent).toContain(t("diff.signedInAs", { user: "admin" }));
    expect(root.textContent).toContain(t("diff.source.secret"));
    expect(root.textContent).toContain("Deployment sextant-argo/guestbook-ui");
    expect(root.querySelector("td.removed")?.textContent).toContain("replicas: 2");
    expect(root.querySelector("td.added")?.textContent).toContain("replicas: 1");
  });

  it("asks for a user and password when Argo CD refuses the admin Secret, and signs in with exactly those", async () => {
    let typed = false;
    const h = await open(
      "diff",
      installation({
        "service.request": (p) => {
          if (p.path === "/api/v1/session") {
            if (p.body.password === "right") {
              typed = true;
              return { status: 200, body: { token: "<hidden>" } };
            }
            return { status: 401, body: { error: "Invalid username or password" } };
          }
          if (p.path === "/api/v1/session/userinfo") return { status: 200, body: { loggedIn: true, username: "alice" } };
          return typed ? { status: 200, body: MANAGED } : { status: 401, body: {} };
        },
      }),
    );
    expect(root.textContent).toContain(t("login.refused.adminSecret"));
    expect(root.textContent).toContain(t("login.typed"));
    const form = root.querySelector("form")!;
    (root.querySelector("#username") as HTMLInputElement).value = "alice";
    const password = root.querySelector("#password") as HTMLInputElement;
    password.value = "wrong";
    password.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(root.textContent).toContain(t("login.errors.invalid"));
    password.value = "right";
    password.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    const typedSignIns = requests(h).filter((r) => r.path === "/api/v1/session").slice(1);
    expect(typedSignIns.map((r) => r.body)).toEqual([
      { username: "alice", password: "wrong" },
      { username: "alice", password: "right" },
    ]);
    expect(root.textContent).toContain(t("diff.signedInAs", { user: "alice" }));
    expect(root.textContent).toContain(t("diff.source.manual"));
    expect(h.storage.get("session/kind/argocd")).toBe("manual");
  });

  it("signs out by asking Sextant to forget the session", async () => {
    const h = await open(
      "diff",
      installation({
        "service.request": (p) => (p.path.endsWith("userinfo") ? { status: 200, body: {} } : { status: 200, body: MANAGED }),
        "service.forget": () => null,
      }),
    );
    const signOut = [...root.querySelectorAll("button")].find((b) => b.textContent === t("diff.signOut"))!;
    signOut.click();
    await settle();
    expect(h.calls.find((c) => c.method === "service.forget")?.params).toMatchObject({ namespace: "argocd", service: "argocd-server" });
    expect(root.querySelector("form")).not.toBeNull();
  });

  it("does not choose between several installations, and remembers the user's choice", async () => {
    const other = { ...SERVER, metadata: { ...SERVER.metadata, namespace: "team-a" } };
    const h = await open(
      "diff",
      installation({
        "resources.list": () => ({ items: [SERVER, other], truncated: false }),
        "service.request": () => ({ status: 200, body: MANAGED }),
      }),
    );
    expect(requests(h)).toEqual([]);
    expect(root.textContent).toContain(t("installation.several", { namespaces: "argocd, team-a" }));
    const radio = root.querySelector<HTMLInputElement>('input[value="team-a"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    [...root.querySelectorAll("button")].find((b) => b.textContent === t("installation.use"))!.click();
    await settle();
    expect(h.storage.get(installationKey("kind"))).toBe("team-a");
    expect(requests(h)[0]).toMatchObject({ path: "/api/v1/applications/guestbook/managed-resources" });
    expect((h.calls.find((c) => c.method === "service.request")?.params as { namespace: string }).namespace).toBe("team-a");
  });

  it("talks plain HTTP only when the installation's server runs without TLS", async () => {
    const h = await open(
      "diff",
      installation({
        "resources.get": ({ ref }) => {
          if (ref.kind.kind === "ConfigMap" && ref.name === "argocd-cmd-params-cm") return { metadata: { name: ref.name }, data: { "server.insecure": "true" } };
          if (ref.kind.kind === "ConfigMap") throw new SextantError("notFound", "no");
          return app;
        },
        "service.request": () => ({ status: 200, body: MANAGED }),
      }),
    );
    expect((h.calls.find((c) => c.method === "service.request")?.params as { service: string }).service).toBe("argocd-server-http");
  });
});

describe("the other actions", () => {
  it("Sync sends the operation with the typed revision and closes", async () => {
    const h = await open("sync", { "resources.get": () => app, "resources.patch": () => app });
    (root.querySelector("#revision") as HTMLInputElement).value = "main";
    (root.querySelector("#prune") as HTMLInputElement).checked = true;
    root.querySelector<HTMLButtonElement>("button.primary")!.click();
    await settle();
    expect(h.calls.find((c) => c.method === "resources.patch")?.params).toMatchObject({
      ref: { name: "guestbook" },
      patchType: "merge",
      patch: { operation: { initiatedBy: { username: "sextant" }, sync: { revision: "main", prune: true, dryRun: false } } },
    });
    expect(h.notices).toEqual([t("sync.started", { name: "guestbook" })]);
    expect(h.closedByFrame).toBe(true);
  });

  it("Terminate sets the running operation's phase", async () => {
    const h = await open("terminate", { "resources.patch": () => applicationRunningJson });
    root.querySelector<HTMLButtonElement>("button.danger")!.click();
    await settle();
    expect(h.calls.find((c) => c.method === "resources.patch")?.params).toMatchObject({ patch: { status: { operationState: { phase: "Terminating" } } } });
  });

  it("Open Argo CD UI forwards the UI port and asks to open the app's page", async () => {
    const h = await open(
      "open-ui",
      installation({
        "portForward.list": () => ({ forwards: [] }),
        "portForward.start": () => ({ id: "f1", localPort: 40123, address: "127.0.0.1:40123" }),
        "ui.openUrl": () => ({ opened: true }),
      }),
    );
    expect(h.calls.find((c) => c.method === "portForward.start")?.params).toMatchObject({
      namespace: "argocd",
      kind: "Service",
      name: "argocd-server",
      port: 443,
    });
    expect(h.calls.find((c) => c.method === "ui.openUrl")?.params).toEqual({ url: "https://localhost:40123/applications/argocd/guestbook" });
    expect(h.closedByFrame).toBe(true);
  });
});

describe("details", () => {
  it("lists the Application's fields with links", async () => {
    host = await startTestHost({ context: { view: "details", contribution: "fields", selection: [REF], resourceVersion: "1" }, handlers: { "resources.get": () => app } });
    stop = startFields(host.sextant, root);
    await settle();
    expect(root.textContent).toContain(t("fields.syncPolicy"));
    expect(root.textContent).toContain("in-cluster");
    expect(root.textContent).toContain("CreateNamespace=true");
  });

  it("shows the resource tree with what the resources own", async () => {
    host = await startTestHost({ context: { view: "details", contribution: "resources", selection: [REF], resourceVersion: "1" }, handlers: { "resources.get": () => app } });
    stop = startTree(host.sextant, root);
    await settle();
    const byKind = (kind: string) => host!.watches.find((w) => (w.params as { kind: { kind: string } }).kind.kind === kind)!;
    byKind("Deployment").emit({ type: "snapshot", items: [deploymentJson as never] });
    byKind("ReplicaSet").emit({ type: "snapshot", items: [replicaSetJson as never] });
    byKind("Pod").emit({ type: "snapshot", items: [podJson as never] });
    byKind("Service").emit({ type: "snapshot", items: [] });
    await settle();
    const rows = [...root.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Missing");
    expect(rows[1]).toContain("Healthy");
    expect(rows[3]).toContain("Running");
  });
});
