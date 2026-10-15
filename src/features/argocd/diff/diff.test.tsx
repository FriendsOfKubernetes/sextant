import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockBackend, type ArgoStatus, type ManagedResource, type MockBackend, type ObjectRef } from "../../../api";
import { getAction } from "../../actions/registry";
import { ArgoDiffDialog } from "./index";
import "../../argocd-diff";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const APP: ObjectRef = {
  kind: { group: "argoproj.io", version: "v1alpha1", kind: "Application" },
  namespace: "argocd",
  name: "guestbook",
};

const deployment = (replicas: number) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "guestbook-ui", namespace: "shop" },
  spec: { replicas },
});

const changed: ManagedResource = {
  group: "apps",
  kind: "Deployment",
  namespace: "shop",
  name: "guestbook-ui",
  targetState: deployment(1),
  liveState: deployment(3),
  normalizedLiveState: deployment(3),
  predictedLiveState: deployment(1),
};

const service = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "guestbook-ui", namespace: "shop" },
  spec: { ports: [{ port: 80 }] },
};
const inSync: ManagedResource = {
  group: "",
  kind: "Service",
  namespace: "shop",
  name: "guestbook-ui",
  targetState: service,
  // Key order differs from Git: still the same object.
  liveState: { spec: service.spec, metadata: service.metadata, kind: "Service", apiVersion: "v1" },
  normalizedLiveState: null,
  predictedLiveState: null,
};

const secret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "db", namespace: "shop", annotations: { "sextant.dev/values-hidden": "true" } },
  data: { password: "" },
};
const pruned: ManagedResource = {
  group: "",
  kind: "Secret",
  namespace: "shop",
  name: "db",
  targetState: null,
  liveState: secret,
  normalizedLiveState: secret,
  predictedLiveState: secret,
};

function status(over: Partial<ArgoStatus> = {}): ArgoStatus {
  return {
    namespace: "argocd",
    signedIn: true,
    source: "secret",
    user: "admin",
    localUsers: true,
    sso: false,
    expired: false,
    saved: false,
    saveError: null,
    insecure: false,
    refused: [],
    ...over,
  };
}

const unauthorized = { code: "unauthorized", message: "sign in to Argo CD: there is no saved login" };

let backend: MockBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
});

function show() {
  render(<ArgoDiffDialog clusterId="c1" app={APP} close={() => {}} />);
}

/** The text of the editor whose aria-label starts with `label`. */
function editorText(label: string): string {
  const editor = screen.getAllByRole("textbox").find((el) => el.getAttribute("aria-label")?.startsWith(label));
  return editor?.textContent ?? "";
}

describe("Argo CD diff", () => {
  it("is the argoDiff action of Applications", () => {
    const action = getAction("argoDiff");
    expect(action?.appliesTo({}, APP.kind)).toBe(true);
    expect(action?.appliesTo({}, { group: "apps", version: "v1", kind: "Deployment" })).toBe(false);
  });

  it("shows desired and live side by side, the differing resources first", async () => {
    backend = mockBackend({
      argocd_diff: () => [inSync, changed],
      argocd_status: () => status(),
    });
    show();

    const list = await screen.findByRole("list", { name: "Resources of the application" });
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      "Deployment shop/guestbook-uiDiffers",
      "Service shop/guestbook-uiIn sync",
    ]);
    expect(screen.getByText("1 of 2 resource differs")).toBeInTheDocument();
    expect(screen.getByText("Signed in to Argo CD as admin · from the standard Argo CD secret")).toBeInTheDocument();
    await waitFor(() => expect(editorText("Desired state of Deployment shop/guestbook-ui")).toContain("replicas: 1"));
    expect(editorText("Live state of Deployment shop/guestbook-ui")).toContain("replicas: 3");
    expect(document.querySelector(".cm-mergeView")).not.toBeNull();
    expect(backend.calls.find((c) => c.cmd === "argocd_diff")?.args).toEqual({ clusterId: "c1", app: APP });

    fireEvent.click(items[1]!);
    // Nothing differs: the identical lines are folded away.
    await waitFor(() => expect(editorText("Live state of Service shop/guestbook-ui")).toMatch(/\d+ unchanged lines/));
  });

  it("says that Secret values are hidden and that an object is missing in Git", async () => {
    backend = mockBackend({ argocd_diff: () => [pruned], argocd_status: () => status() });
    show();

    expect(await screen.findByText("Secret values are hidden on both sides.")).toBeInTheDocument();
    expect(screen.getAllByText("Not in Git (to be pruned)").length).toBeGreaterThan(0);
    await waitFor(() => expect(editorText("Live state of Secret shop/db")).toContain('password: ""'));
    expect(editorText("Desired state of Secret shop/db")).toBe("");
  });

  it("asks to sign in when the backend cannot, and reads the diff after signing in with Remember", async () => {
    let signedIn = false;
    backend = mockBackend({
      argocd_diff: () => {
        if (!signedIn) throw unauthorized;
        return [changed];
      },
      argocd_status: () => status({ signedIn, source: signedIn ? "saved" : null, user: signedIn ? "admin" : null }),
      argocd_login: () => {
        signedIn = true;
        return status({ source: "saved" });
      },
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    expect(within(form).getByText(/argocd-secret holds only a bcrypt hash/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "pw-1" } });
    fireEvent.click(within(form).getByLabelText("Remember on this computer (system keychain)"));
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Deployment shop/guestbook-ui")).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === "argocd_login")?.args).toEqual({
      clusterId: "c1",
      login: { username: "admin", password: "pw-1", remember: true },
    });
    expect(screen.getByText("Signed in to Argo CD as admin · with the saved login")).toBeInTheDocument();
  });

  it("signs in with an API token, sending only the token", async () => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => status({ signedIn: false, source: null, user: null }),
      argocd_login: () => status({ source: "manual" }),
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    fireEvent.click(within(form).getByRole("button", { name: "API token" }));
    fireEvent.change(within(form).getByLabelText("API token"), { target: { value: " tok-1 " } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(backend?.calls.find((c) => c.cmd === "argocd_login")?.args).toEqual({
        clusterId: "c1",
        login: { token: "tok-1", remember: false },
      }),
    );
  });

  it.each([
    [{ code: "unauthorized", message: "Argo CD refused" }, status({ signedIn: false }), "Argo CD refused the user name or password."],
    [
      { code: "unreachable", message: "connection refused" },
      status({ signedIn: false }),
      "Argo CD is not reachable: its server has no ready pod or does not answer.",
    ],
    [
      { code: "unauthorized", message: "no local users" },
      status({ signedIn: false, localUsers: false, sso: true }),
      "This Argo CD signs in only through SSO, which Sextant does not support: use an API token.",
    ],
  ])("explains a failed sign-in in plain words (%o)", async (error, current, text) => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => current,
      argocd_login: () => {
        throw error;
      },
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    fireEvent.click(within(form).getByRole("button", { name: "User and password" }));
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(text);
  });

  it("a refused password gives one error, not the same sentence twice", async () => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => status({ signedIn: false }),
      argocd_login: () => {
        throw { code: "unauthorized", message: 'Argo CD refused the user name or password of "admin"' };
      },
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("Argo CD refused the user name or password.");
  });

  it("tells about SSO and an expired session, and offers the token first without local users", async () => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => status({ signedIn: false, localUsers: false, sso: true, expired: true }),
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    const notes = within(form).getAllByRole("note").map((n) => n.textContent);
    expect(notes).toEqual([
      "The Argo CD session has expired and signing in again with the saved login did not work.",
      "This Argo CD has no local users who may sign in with a password: use an API token.",
      "Sign-in through SSO is not supported in Sextant.",
    ]);
    expect(within(form).getByRole("button", { name: "API token" })).toHaveAttribute("aria-pressed", "true");
  });

  it("names the logins Argo CD refused, so a changed admin password can be typed in", async () => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => status({ signedIn: false, source: null, refused: ["saved", "adminSecret"] }),
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    const notes = within(form).getAllByRole("note").map((n) => n.textContent);
    expect(notes).toEqual([
      "Argo CD refused the saved login: its password or token may have changed. Sign in with the current one (with Remember to replace the saved login).",
      "Argo CD refused the admin password from argocd-initial-admin-secret: it may have been changed in Argo CD. Enter the current password.",
    ]);
  });

  it("says when the connection to Argo CD is plain HTTP", async () => {
    backend = mockBackend({
      argocd_diff: () => {
        throw unauthorized;
      },
      argocd_status: () => status({ signedIn: false, insecure: true }),
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    expect(within(form).getByRole("note")).toHaveTextContent(/without TLS .*plain HTTP/);
  });

  it("forgets the saved login and shows the sign-in window", async () => {
    backend = mockBackend({
      argocd_diff: () => [changed],
      argocd_status: () => status({ source: "saved", saved: true }),
      argocd_logout: () => status({ signedIn: false, source: null, user: null }),
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: "Forget saved login" }));

    expect(await screen.findByRole("form", { name: "Sign in to Argo CD" })).toBeInTheDocument();
    expect(backend.calls.find((c) => c.cmd === "argocd_logout")?.args).toEqual({
      clusterId: "c1",
      options: { forget: true },
    });
  });

  it("offers to forget a saved login also when the session came from somewhere else", async () => {
    backend = mockBackend({
      argocd_diff: () => [changed],
      argocd_status: () => status({ source: "secret", saved: true }),
    });
    show();

    expect(await screen.findByRole("button", { name: "Forget saved login" })).toBeInTheDocument();
  });

  it("does not offer to forget a login that is not saved", async () => {
    backend = mockBackend({
      argocd_diff: () => [changed],
      argocd_status: () => status({ source: "secret", saved: false }),
    });
    show();

    await screen.findByText("Deployment shop/guestbook-ui");
    expect(screen.queryByRole("button", { name: "Forget saved login" })).toBeNull();
  });

  it("says once that the login was not saved when the system keychain refuses it, and still shows the diff", async () => {
    let signedIn = false;
    backend = mockBackend({
      argocd_diff: () => {
        if (!signedIn) throw unauthorized;
        return [changed];
      },
      argocd_status: () => status({ signedIn, source: signedIn ? "manual" : null, user: signedIn ? "admin" : null }),
      argocd_login: () => {
        signedIn = true;
        return status({ source: "manual", saveError: "the system credential store: no secret service is running" });
      },
    });
    show();

    const form = await screen.findByRole("form", { name: "Sign in to Argo CD" });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "pw-1" } });
    fireEvent.click(within(form).getByLabelText("Remember on this computer (system keychain)"));
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Deployment shop/guestbook-ui")).toBeInTheDocument();
    const notes = screen.getAllByText(/could not be saved|was not saved|signed in, but/i);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent(
      "Signed in, but the login could not be saved: the system credential store: no secret service is running",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows other errors with a retry", async () => {
    let calls = 0;
    backend = mockBackend({
      argocd_diff: () => {
        calls++;
        if (calls === 1) throw { code: "forbidden", message: "permission denied" };
        return [changed];
      },
      argocd_status: () => status(),
    });
    show();

    expect(await screen.findByRole("alert")).toHaveTextContent("Argo CD does not show this application to the signed-in account.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Deployment shop/guestbook-ui")).toBeInTheDocument();
  });

  it("says Sextant does not pick between several look-alike installations and names them", async () => {
    const ambiguous = {
      code: "notFound",
      message: "ambiguous Argo CD installation: several namespaces look like it (aaa, gitops), and nothing tells the real one",
    };
    backend = mockBackend({
      argocd_diff: () => {
        throw ambiguous;
      },
      argocd_status: () => {
        throw ambiguous;
      },
    });
    show();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Several namespaces of this cluster look like an Argo CD installation");
    expect(alert).toHaveTextContent("aaa, gitops");
    expect(alert).not.toHaveTextContent("there is no argocd-server Service");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
