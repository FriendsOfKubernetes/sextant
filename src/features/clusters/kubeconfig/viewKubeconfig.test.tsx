// "View kubeconfig" (#228): the window shows only what the backend masked, "Copy" asks first and then lets the
// backend write the clipboard (no credential reaches the window), "Copy without credentials" copies at once.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockBackend, type ClusterInfo, type MockBackend } from "../../../api";
import { axeViolations } from "../../../test/axe";
import { closeKubeconfigView, KubeconfigViewDialog, KubeconfigViewSection, openKubeconfigView } from "./ViewKubeconfig";

const prod: ClusterInfo = {
  id: "prod-id",
  context: "prod",
  clusterName: "prod",
  server: "https://prod.example:6443",
  user: "admin",
  namespace: null,
  sourceId: "src-home",
};

const MASKED = `apiVersion: v1
kind: Config
clusters:
- name: prod
  cluster:
    server: https://prod.example:6443
users:
- name: admin
  user:
    token: <hidden>
contexts:
- name: prod
  context:
    cluster: prod
    user: admin
current-context: prod
`;

let backend: MockBackend;
const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

function setup() {
  backend = mockBackend({
    kubeconfig_view: () => MASKED,
    kubeconfig_copy: () => undefined,
  });
  render(<KubeconfigViewDialog />);
  act(() => openKubeconfigView(prod));
}

afterEach(() => {
  act(() => closeKubeconfigView());
  backend.restore();
});

describe("kubeconfig viewer", () => {
  it("shows the masked kubeconfig the backend returns and passes axe", async () => {
    setup();
    const dialog = await screen.findByRole("dialog", { name: "Kubeconfig of prod" });
    const yaml = await within(dialog).findByLabelText("Kubeconfig with credentials hidden");
    expect(yaml.textContent).toBe(MASKED);
    expect(calls("kubeconfig_view")[0]?.args).toEqual({ clusterId: "prod-id" });
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it("copies with credentials only after the confirmation, through the backend", async () => {
    setup();
    await screen.findByLabelText("Kubeconfig with credentials hidden");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    const confirm = await screen.findByRole("dialog", { name: "Copy the kubeconfig with credentials?" });
    expect(confirm.textContent).toContain("This copies credentials to the clipboard");
    expect(await axeViolations(confirm)).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls("kubeconfig_copy")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy with credentials" }));
    expect(await screen.findByText("The kubeconfig with credentials is on the clipboard.")).toBeInTheDocument();
    expect(calls("kubeconfig_copy")[0]?.args).toEqual({ clusterId: "prod-id", withCredentials: true });
  });

  it("copies without credentials at once", async () => {
    setup();
    await screen.findByLabelText("Kubeconfig with credentials hidden");
    fireEvent.click(screen.getByRole("button", { name: "Copy without credentials" }));
    await waitFor(() => expect(calls("kubeconfig_copy")).toHaveLength(1));
    expect(calls("kubeconfig_copy")[0]?.args).toEqual({ clusterId: "prod-id", withCredentials: false });
    expect(screen.queryByRole("dialog", { name: "Copy the kubeconfig with credentials?" })).not.toBeInTheDocument();
    expect(await screen.findByText("The kubeconfig without credentials is on the clipboard.")).toBeInTheDocument();
  });

  it("opens from the cluster settings", async () => {
    backend = mockBackend({ kubeconfig_view: () => MASKED });
    render(
      <>
        <KubeconfigViewSection clusterId={prod.id} cluster={prod} />
        <KubeconfigViewDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View kubeconfig" }));
    expect(await screen.findByRole("dialog", { name: "Kubeconfig of prod" })).toBeInTheDocument();
  });
});
