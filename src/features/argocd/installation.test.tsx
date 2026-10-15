// The choice of the Argo CD installation when several namespaces look like one (#55): the diff dialog and "Open Argo
// CD UI" offer the namespaces the backend listed, save the choice in the cluster's settings and go on with it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mockBackend, type ArgoStatus, type MockBackend, type ObjectRef } from "../../api";
import { getAction } from "../actions/registry";
import { ArgoDiffDialog } from "./diff";
import { ambiguousNamespaces } from "./server";
import "./actions";

const APP: ObjectRef = {
  kind: { group: "argoproj.io", version: "v1alpha1", kind: "Application" },
  namespace: "argocd",
  name: "guestbook",
};

const AMBIGUOUS = {
  code: "notFound",
  message:
    "ambiguous Argo CD installation: several namespaces look like it (aaa, gitops), and nothing a namespace's tenant cannot create tells the real one; Sextant does not pick one by itself",
};

const status = (namespace: string): ArgoStatus => ({
  namespace,
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
});

let backend: MockBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
});

/** A backend whose Argo CD calls fail as ambiguous until the user's choice is in the settings. */
function ambiguousBackend(): MockBackend {
  const chosen = () => backend?.settings.clusters.c1?.argocdNamespace ?? null;
  const unlessChosen = <T,>(value: () => T) => () => {
    if (chosen() !== "gitops") throw AMBIGUOUS;
    return value();
  };
  backend = mockBackend({
    argocd_status: unlessChosen(() => status("gitops")),
    argocd_diff: unlessChosen(() => []),
    portforward_list: () => [],
    portforward_start: (args) => ({
      id: "pf-1",
      cluster: "c1",
      target: args.target,
      remotePort: args.remotePort,
      localPort: 54321,
      status: { state: "active" },
    }),
  });
  return backend;
}

async function choose(namespace: string) {
  const form = await screen.findByRole("form", { name: "Choose the Argo CD installation" });
  expect(within(form).getByRole("alert")).toHaveTextContent("aaa, gitops");
  fireEvent.click(within(form).getByRole("radio", { name: namespace }));
  fireEvent.click(within(form).getByRole("button", { name: "Use this installation" }));
}

describe("an ambiguous Argo CD installation", () => {
  it("lists the namespaces the backend named", () => {
    expect(ambiguousNamespaces(AMBIGUOUS)).toEqual(["aaa", "gitops"]);
    expect(ambiguousNamespaces({ code: "notFound", message: "Argo CD server not found (x)" })).toEqual([]);
  });

  it("lets the diff dialog choose the installation, saves the choice and reads the diff", async () => {
    const mock = ambiguousBackend();
    render(<ArgoDiffDialog clusterId="c1" app={APP} close={() => {}} />);

    await choose("gitops");

    expect(await screen.findByText("Argo CD manages no resources for this application.")).toBeInTheDocument();
    expect(mock.settings.clusters.c1?.argocdNamespace).toBe("gitops");
  });

  it("lets Open Argo CD UI choose the installation, then opens the chosen one", async () => {
    const mock = ambiguousBackend();
    const dialogs: ReactNode[] = [];
    let closed = false;
    const action = getAction("argoOpenUi");
    await action?.run({
      clusterId: "c1",
      kind: APP.kind,
      objects: [],
      refs: [APP],
      openDialog: (renderDialog) => {
        dialogs.push(
          renderDialog(() => {
            closed = true;
          }),
        );
        return () => {};
      },
    });
    expect(mock.openedUrls).toEqual([]);
    render(<>{dialogs[0]}</>);

    await choose("gitops");

    await waitFor(() => expect(mock.openedUrls).toEqual(["https://localhost:54321/applications/argocd/guestbook"]));
    const started = mock.calls.find((c) => c.cmd === "portforward_start")?.args as { target: unknown };
    expect(started.target).toEqual({ type: "service", namespace: "gitops", name: "argocd-server" });
    expect(closed).toBe(true);
  });
});
