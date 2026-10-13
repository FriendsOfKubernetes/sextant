import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockBackend,
  type CloudAccounts,
  type CloudCliStatus,
  type CloudCluster,
  type CloudProblem,
  type CloudSearch,
  type ClusterInfo,
  type KubeconfigSource,
  type MockBackend,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { AppShell } from "../../layout";
import { resetClustersStore } from "./clustersStore";
import "./index";

const homeConfig: KubeconfigSource = { id: "src-home", path: "/home/me/.kube/config", kind: "default", error: null };

const STATUS: CloudCliStatus[] = [
  { provider: "aws", available: true, version: "2.15.30", path: "/usr/bin/aws", installUrl: "https://aws.example/install", plugin: null },
  {
    provider: "gcp",
    available: false,
    version: null,
    path: null,
    installUrl: "https://cloud.google.com/sdk/docs/install",
    plugin: { name: "gke-gcloud-auth-plugin", available: false, installCommand: "gcloud components install gke-gcloud-auth-plugin", installUrl: "https://g.example" },
  },
  {
    provider: "azure",
    available: true,
    version: "2.58.0",
    path: "/usr/bin/az",
    installUrl: "https://az.example",
    plugin: { name: "kubelogin", available: false, installCommand: "az aks install-cli", installUrl: "https://k.example" },
  },
];

const AWS_ACCOUNTS: CloudAccounts = {
  provider: "aws",
  accounts: [
    { id: "default", name: "default", region: null, isDefault: false },
    { id: "dev", name: "dev", region: "eu-west-1", isDefault: true },
  ],
  regions: ["us-east-1", "eu-west-1"],
  problem: null,
};

function eks(name: string): CloudCluster {
  return {
    provider: "aws",
    name,
    account: "dev",
    location: "eu-west-1",
    resourceGroup: null,
    cloudId: `arn:aws:eks:eu-west-1:111122223333:cluster/${name}`,
    endpoint: `https://${name}.eks.example`,
    certificateAuthority: "Y2E=",
    version: "1.29",
    status: "ACTIVE",
    context: `arn:aws:eks:eu-west-1:111122223333:cluster/${name}`,
  };
}

const SIGNED_OUT: CloudProblem = {
  provider: "aws",
  kind: "notLoggedIn",
  scope: null,
  message: "Error when retrieving token from sso: Token has expired and refresh failed",
  command: "aws sso login --profile dev",
  url: null,
};

let backend: MockBackend;
let clipboard: string[];
let clusters: ClusterInfo[];

function setup(handlers: Parameters<typeof mockBackend>[0] = {}) {
  clusters = [];
  backend = mockBackend({
    clusters_list: () => clusters,
    kubeconfig_sources: () => [homeConfig],
    cluster_state: () => ({ state: "disconnected" }),
    cloud_status: () => STATUS,
    cloud_accounts: () => AWS_ACCOUNTS,
    ...handlers,
  });
}

const commands = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

async function openFromCloud() {
  render(<AppShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Add cluster" }));
  const dialog = screen.getByRole("dialog", { name: "Add cluster" });
  fireEvent.click(within(dialog).getByRole("tab", { name: "From cloud" }));
  return dialog;
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => void clipboard.push(text)) },
  });
});
afterEach(() => {
  resetClustersStore();
  backend.restore();
});

describe("Add cluster → From cloud", () => {
  it("shows the CLIs found, finds EKS clusters in the chosen regions and adds the checked ones", async () => {
    const found: CloudSearch = { clusters: [eks("prod"), eks("staging")], problems: [{ ...SIGNED_OUT, scope: null }] };
    setup({
      cloud_find: () => found,
      cloud_import: (args) => {
        const chosen = args.clusters as CloudCluster[];
        clusters = chosen.map((c, i) => ({
          id: `cloud-${i}`,
          context: c.context,
          clusterName: c.context,
          server: c.endpoint ?? "",
          user: c.context,
          namespace: null,
          sourceId: "src-cloud",
        }));
        return { sources: [], contexts: chosen.map((c) => c.context), problems: [] };
      },
    });
    const dialog = await openFromCloud();

    expect(await within(dialog).findByText("aws 2.15.30")).toBeInTheDocument();
    expect(within(dialog).getByText("gcloud is not installed")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Google GKE/ })).toBeDisabled();
    // az is there, its kubelogin is not: the install command is offered.
    expect(within(dialog).getByText("az aks install-cli")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Installation guide" }));
    expect(backend.openedUrls).toEqual(["https://cloud.google.com/sdk/docs/install"]);

    // The current profile with its region is chosen; another region is added.
    const profile = await within(dialog).findByRole("combobox", { name: "Profile" });
    expect(profile).toHaveValue("dev");
    expect(commands("cloud_accounts")[0]?.args).toEqual({ provider: "aws" });
    expect(within(dialog).getByRole("checkbox", { name: "eu-west-1" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "us-east-1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Find clusters" }));

    const list = await within(dialog).findByRole("list", { name: "Clusters found" });
    expect(commands("cloud_find")[0]?.args).toEqual({
      query: { provider: "aws", account: "dev", regions: ["eu-west-1", "us-east-1"] },
    });
    // A signed-out region: the sign-in command, copied with one click, never run by Sextant.
    const signIn = within(dialog)
      .getAllByRole("note")
      .find((note) => note.dataset.kind === "notLoggedIn")!;
    expect(signIn).toHaveTextContent("aws is not signed in, or the sign-in expired");
    expect(within(signIn).getByText("aws sso login --profile dev")).toBeInTheDocument();
    fireEvent.click(within(signIn).getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(clipboard).toEqual(["aws sso login --profile dev"]));

    fireEvent.click(within(list).getByRole("checkbox", { name: /staging/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 cluster" }));
    expect(await within(dialog).findByText("Added 1 cluster. It is in the cluster list.")).toBeInTheDocument();
    expect(commands("cloud_import")[0]?.args).toEqual({ clusters: [eks("prod")] });
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    expect(await within(rail).findByRole("button", { name: eks("prod").context })).toBeInTheDocument();
  });

  it("a signed-out CLI shows how to sign in instead of the accounts", async () => {
    setup({
      cloud_status: () => [{ ...STATUS[1]!, available: true, version: "470.0.0", path: "/usr/bin/gcloud" }],
      cloud_accounts: () => ({
        provider: "gcp",
        accounts: [],
        regions: [],
        problem: {
          provider: "gcp",
          kind: "notLoggedIn",
          scope: null,
          message: "You do not currently have an active account selected.",
          command: "gcloud auth login",
          url: null,
        },
      }),
    });
    const dialog = await openFromCloud();
    expect(await within(dialog).findByText("gcloud auth login")).toBeInTheDocument();
    expect(within(dialog).getByText("gcloud is not signed in, or the sign-in expired")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Find clusters" })).not.toBeInTheDocument();
    expect(commands("cloud_find")).toHaveLength(0);
  });

  it("a cloud cluster whose sign-in failed shows the command to sign in again", async () => {
    const cluster: ClusterInfo = {
      id: "eks1",
      context: "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
      clusterName: "prod",
      server: "https://prod.eks.example",
      user: "prod",
      namespace: null,
      sourceId: "src-cloud",
    };
    setup({
      cluster_connect: () => {
        throw { code: "authPlugin", message: "exec plugin failed (exit status 255)" };
      },
      cloud_login_hint: () => ({ ...SIGNED_OUT, scope: cluster.context }),
    });
    clusters = [cluster];
    render(<AppShell />);
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    fireEvent.click(await within(rail).findByRole("button", { name: cluster.context }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-code", "authPlugin");
    expect(await within(alert).findByText("aws sso login --profile dev")).toBeInTheDocument();
    expect(commands("cloud_login_hint")[0]?.args).toEqual({ clusterId: "eks1" });
  });
});
