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
import { startHistory } from "./history";
import { setLanguage, t } from "./i18n";
import { tokenSecretKey } from "./diff";
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
  h.calls
    .filter((c) => c.method === "service.request")
    .map((c) => c.params as { method: string; path: string; service: string; body?: unknown; capture?: string; auth?: string });

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

/** Sextant refusing a request it has nothing to send for (no session, no sign-in typed or remembered). */
const nothingToSend = () => {
  throw new SextantError("unauthorized", "sign in first");
};
const isTyped = (p: { body?: unknown }) => JSON.stringify(p.body ?? null).includes("{{signIn:");
const byText = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("Diff", () => {
  it("tries the saved login, then signs in with the admin Secret Sextant fills in, then shows desired ↔ live", async () => {
    let signedIn = false;
    const h = await open(
      "diff",
      installation({
        "service.request": (p) => {
          if (p.auth === "signIn:token" || isTyped(p)) return nothingToSend();
          if (p.path === "/api/v1/session") {
            signedIn = true;
            return { status: 200, body: { token: "<hidden>" } };
          }
          if (p.path === "/api/v1/session/userinfo") return { status: 200, body: { loggedIn: true, username: "admin" } };
          if (!signedIn) return nothingToSend();
          return { status: 200, body: MANAGED };
        },
      }),
    );
    const sent = requests(h);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/v1/applications/guestbook/managed-resources", auth: "session" });
    expect(sent[1]).toMatchObject({ method: "POST", path: "/api/v1/session", body: { username: "{{signIn:username}}", password: "{{signIn:password}}" } });
    expect(sent[2]).toMatchObject({ method: "GET", service: "argocd-server-token", auth: "signIn:token" });
    expect(sent[3]).toMatchObject({
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

  it("asks in Sextant's dialog when Argo CD refuses the admin Secret, and never sees what was typed", async () => {
    const typed: (string | null)[] = [];
    let password: string | null = null;
    let session = false;
    const h = await open(
      "diff",
      installation({
        "ui.signIn": () => {
          password = typed.shift() ?? null;
          return { signedIn: password !== null };
        },
        "service.request": (p) => {
          if (p.auth === "signIn:token") return nothingToSend();
          if (p.path === "/api/v1/session") {
            if (!isTyped(p)) return { status: 401, body: { error: "Invalid username or password" } };
            if (password === null) return nothingToSend();
            if (password !== "right") return { status: 401, body: { error: "Invalid username or password" } };
            session = true;
            return { status: 200, body: { token: "<hidden>" } };
          }
          if (p.path === "/api/v1/session/userinfo") return { status: 200, body: { loggedIn: true, username: "alice" } };
          return session ? { status: 200, body: MANAGED } : nothingToSend();
        },
      }),
    );
    expect(root.textContent).toContain(t("login.refused.adminSecret"));
    expect(root.querySelector("section.login")).not.toBeNull();
    // Cancelled in Sextant's dialog: asked again, nothing sent.
    byText(t("login.mode.password")).click();
    await settle();
    expect(root.querySelector("section.login")).not.toBeNull();
    typed.push("wrong");
    byText(t("login.mode.password")).click();
    await settle();
    expect(root.textContent).toContain(t("login.errors.invalid"));
    typed.push("right");
    byText(t("login.mode.password")).click();
    await settle();
    expect(h.calls.filter((c) => c.method === "ui.signIn").map((c) => c.params)).toEqual([
      { clusterId: "kind", namespace: "argocd", service: "argocd-server" },
      { clusterId: "kind", namespace: "argocd", service: "argocd-server" },
      { clusterId: "kind", namespace: "argocd", service: "argocd-server" },
    ]);
    // Every sign-in the extension sent is a placeholder Sextant fills in.
    const bodies = requests(h).filter((r) => r.path === "/api/v1/session").map((r) => JSON.stringify(r.body));
    expect(bodies.every((b) => b.includes("{{signIn:") || b.includes("{{secret:"))).toBe(true);
    expect(root.textContent).toContain(t("diff.signedInAs", { user: "alice" }));
    expect(root.textContent).not.toContain(t("diff.source.secret"));
    // Typed in Sextant's dialog (or remembered there): the session bar says so.
    expect(root.textContent).toContain(t("diff.source.signIn"));
  });

  it("after the admin Secret, signs in with the API token of a labelled Secret, by name, as the built-in view did", async () => {
    const h = await open(
      "diff",
      installation({
        "service.secrets": () => ({
          secrets: [
            { name: "b-token", key: "token" },
            { name: "a-token", key: "token" },
          ],
        }),
        "service.request": (p) => {
          if (p.auth === "signIn:token" || isTyped(p)) return nothingToSend();
          if (p.path === "/api/v1/session") return { status: 401, body: { error: "Invalid username or password" } };
          if (p.auth === "secret:a-token/token") return { status: 200, body: { loggedIn: false } };
          if (p.auth === "secret:b-token/token") {
            return p.path.endsWith("userinfo") ? { status: 200, body: { loggedIn: true, username: "ci-bot" } } : { status: 200, body: MANAGED };
          }
          return nothingToSend();
        },
      }),
    );
    expect(h.calls.find((c) => c.method === "service.secrets")?.params).toEqual({ clusterId: "kind", namespace: "argocd", service: "argocd-server-token" });
    const tokens = requests(h).filter((r) => r.auth?.startsWith("secret:"));
    // Each checked with userinfo, by name (a refused one too), then the diff read with the first Argo CD accepts.
    expect(tokens.map((r) => [r.auth, r.path, r.service])).toEqual([
      ["secret:a-token/token", "/api/v1/session/userinfo", "argocd-server-token"],
      ["secret:b-token/token", "/api/v1/session/userinfo", "argocd-server-token"],
      ["secret:b-token/token", "/api/v1/applications/guestbook/managed-resources", "argocd-server-token"],
      ["secret:b-token/token", "/api/v1/session/userinfo", "argocd-server-token"],
    ]);
    expect(h.storage.get(tokenSecretKey("kind", "argocd"))).toBe("b-token");
    expect(root.textContent).toContain(t("diff.signedInAs", { user: "ci-bot" }));
    expect(root.textContent).toContain(t("diff.source.tokenSecret", { name: "b-token" }));
    expect(root.textContent).toContain("Deployment sextant-argo/guestbook-ui");
    // Reload keeps the token that worked: nothing is tried again.
    byText(t("diff.reload")).click();
    await settle();
    expect(requests(h).slice(-2).map((r) => [r.auth, r.path])).toEqual([
      ["secret:b-token/token", "/api/v1/applications/guestbook/managed-resources"],
      ["secret:b-token/token", "/api/v1/session/userinfo"],
    ]);
    expect(h.calls.filter((c) => c.method === "service.secrets")).toHaveLength(1);
  });

  it("asks with the built-in's notes when Argo CD refused the admin password earlier and every token Secret", async () => {
    await open(
      "diff",
      installation({
        "service.secrets": () => ({ secrets: [{ name: "ci-token", key: "token" }] }),
        "service.request": (p) => {
          if (p.auth === "signIn:token" || isTyped(p)) return nothingToSend();
          // Refused in an earlier window: Sextant does not send the same password again.
          if (p.path === "/api/v1/session") return { status: 401, body: { message: "refused before" }, notSent: true };
          if (p.auth === "secret:ci-token/token") return { status: 401, body: { error: "invalid session" } };
          return nothingToSend();
        },
      }),
    );
    expect(root.querySelector("section.login")).not.toBeNull();
    expect(root.textContent).toContain(t("login.refused.adminSecret"));
    expect(root.textContent).toContain(t("login.refused.tokenSecret"));
    expect(root.textContent).not.toContain("refused before");
  });

  it("signs in with an API token typed in Sextant's dialog, sent as the bearer of each request", async () => {
    let token = false;
    const h = await open(
      "diff",
      installation({
        "resources.get": ({ ref }) => {
          if (ref.kind.kind === "ConfigMap" && ref.name === "argocd-cm") return { metadata: { name: ref.name }, data: { "admin.enabled": "false" } };
          if (ref.kind.kind === "ConfigMap") throw new SextantError("notFound", "no");
          return app;
        },
        "ui.signIn": () => {
          token = true;
          return { signedIn: true };
        },
        "service.request": (p) => {
          if (p.auth !== "signIn:token" || !token) return nothingToSend();
          if (p.path.endsWith("userinfo")) return { status: 200, body: { loggedIn: true, username: "ci" } };
          return { status: 200, body: MANAGED };
        },
      }),
    );
    // Without local users, the token is the way offered first.
    expect(root.textContent).toContain(t("login.noLocalUsers"));
    expect(byText(t("login.mode.token")).className).toContain("primary");
    expect(requests(h).some((r) => r.body !== undefined && !isTyped(r))).toBe(false);
    byText(t("login.mode.token")).click();
    await settle();
    expect(h.calls.find((c) => c.method === "ui.signIn")?.params).toMatchObject({ service: "argocd-server-token" });
    expect(requests(h).at(-2)).toMatchObject({ path: "/api/v1/applications/guestbook/managed-resources", auth: "signIn:token" });
    expect(root.textContent).toContain(t("diff.signedInAs", { user: "ci" }));
  });

  it("signs out by asking Sextant to forget the sessions and the remembered sign-ins", async () => {
    const h = await open(
      "diff",
      installation({
        "service.request": (p) => (p.path.endsWith("userinfo") ? { status: 200, body: {} } : { status: 200, body: MANAGED }),
        "service.forget": () => null,
      }),
    );
    byText(t("diff.signOut")).click();
    await settle();
    expect(h.calls.filter((c) => c.method === "service.forget").map((c) => c.params)).toEqual([
      { clusterId: "kind", namespace: "argocd", service: "argocd-server" },
      { clusterId: "kind", namespace: "argocd", service: "argocd-server-token" },
    ]);
    expect(root.querySelector("section.login")).not.toBeNull();
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
    byText(t("installation.use")).click();
    await settle();
    expect(h.storage.get(installationKey("kind"))).toBe("team-a");
    expect(requests(h)[0]).toMatchObject({ path: "/api/v1/applications/guestbook/managed-resources" });
    expect((h.calls.find((c) => c.method === "service.request")?.params as { namespace: string }).namespace).toBe("team-a");
  });

  it("reaches a Helm release's server, whatever its Service is named", async () => {
    const helm = { ...SERVER, metadata: { ...SERVER.metadata, name: "gitops-argocd-server" } };
    const h = await open(
      "diff",
      installation({
        "resources.list": () => ({ items: [helm], truncated: false }),
        "service.request": () => ({ status: 200, body: MANAGED }),
      }),
    );
    expect(requests(h)[0]).toMatchObject({ service: "argocd-server", path: "/api/v1/applications/guestbook/managed-resources" });
    expect(root.textContent).toContain("Deployment sextant-argo/guestbook-ui");
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

  it("hides the Resources and Sync history sections while the Application has none, as the built-in view did", async () => {
    const bare = { ...app, status: {} } as KubeObject;
    for (const [contribution, start] of [
      ["resources", startTree],
      ["history", startHistory],
    ] as const) {
      host = await startTestHost({
        context: { view: "details", contribution, selection: [REF], resourceVersion: "1" },
        handlers: { "resources.get": () => bare, "ui.setHidden": () => null },
      });
      stop = start(host.sextant, root);
      await settle();
      expect(host.calls.filter((c) => c.method === "ui.setHidden").map((c) => c.params), contribution).toEqual([{ hidden: true }]);
      stop();
      host.close();
      host = null;
    }
  });
});
