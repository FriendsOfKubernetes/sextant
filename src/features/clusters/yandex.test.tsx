import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type CloudAccount, type CloudAccounts, type CloudCluster, type CloudQuery, type MockBackend } from "../../api";
import { CloudClusters } from "./CloudClusters";
import { resetClustersStore } from "./clustersStore";
import { axeViolations } from "../../test/axe";

const item = (id: string, name = id, isDefault = false): CloudAccount => ({ id, name, isDefault, region: null });
function discovery(profile = "work", cloudId = "cloud-a"): CloudAccounts {
  return {
    provider: "yandex", accounts: [item(`folder-${profile}`, `Folder ${profile}`, true)], regions: [], problem: null,
    yandex: { profiles: [item("work", "Work", true), item("personal", "Personal")], profile,
      clouds: [item("cloud-a", "Cloud A", true), item("cloud-b", "Cloud B")], cloudId, problems: [] },
  };
}
function cluster(endpoint: string | null = "https://192.0.2.10:6443"): CloudCluster {
  return { provider: "yandex", name: endpoint ? "Demo" : "Private only", account: "folder-work", location: "ru-central1-a",
    resourceGroup: null, cloudId: endpoint ? "demo" : "private", endpoint, certificateAuthority: "Y2E=", version: "1.32", status: "RUNNING",
    context: endpoint ? "yc-demo" : "yc-private", yandex: { profile: "work", endpoint: "external" } };
}
let backend: MockBackend;
function setup(handlers: Parameters<typeof mockBackend>[0] = {}) {
  backend = mockBackend({ cloud_status: () => [{ provider: "yandex", available: true, version: "1.18.0", path: "/usr/bin/yc",
    installUrl: "https://yandex.cloud/en/docs/cli/operations/install-cli", plugin: null }],
    cloud_accounts: (args) => discovery(args.profile as string | undefined, args.cloudId as string | undefined),
    cloud_find: () => ({ clusters: [cluster(), cluster(null)], problems: [] }),
    cloud_import: () => ({ sources: [], contexts: ["yc-demo"], problems: [] }),
    ...handlers });
}
const calls = (cmd: string) => backend.calls.filter(c => c.cmd === cmd);
async function refresh() {
  const button = screen.getByRole("button", { name: "Refresh list" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
beforeEach(() => resetClustersStore());
afterEach(() => { backend.restore(); resetClustersStore(); });

describe("Yandex Cloud discovery", () => {
  it("switches to AWS profiles without displaying a late automatic Yandex response", async () => {
    let finishYandex!: (value: { clusters: CloudCluster[]; problems: [] }) => void;
    setup({
      cloud_status: () => [
        { provider: "yandex", available: true, version: "1.18.0", path: "/bin/yc", installUrl: "https://yandex.cloud/", plugin: null },
        { provider: "aws", available: true, version: "2.15", path: "/bin/aws", installUrl: "https://aws.amazon.com/", plugin: null },
      ],
      cloud_accounts: args => args.provider === "yandex" ? discovery() : { provider: "aws", regions: ["eu-west-1", "us-east-1"], problem: null,
        accounts: [{ ...item("dev", "Development", true), region: "eu-west-1" }, { ...item("", "Environment"), region: "us-east-1" }] },
      cloud_find: args => (args.query as CloudQuery).provider === "yandex" ? new Promise(resolve => { finishYandex = resolve; })
        : { clusters: [{ ...cluster(), provider: "aws", name: "AWS cluster", context: "aws-demo", yandex: undefined }], problems: [] },
    });
    render(<CloudClusters />);
    await waitFor(() => expect(calls("cloud_find")).toHaveLength(1));
    fireEvent.click(screen.getByRole("radio", { name: /Amazon EKS/ }));
    const profile = await screen.findByRole("combobox", { name: "Profile" });
    fireEvent.change(profile, { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "us-east-1" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Find clusters" }));
    await screen.findByRole("checkbox", { name: /AWS cluster/ });
    await act(async () => finishYandex({ clusters: [cluster()], problems: [] }));
    expect(screen.queryByRole("checkbox", { name: /Demo/ })).not.toBeInTheDocument();
    expect(calls("cloud_find").at(-1)?.args.query).toEqual({ provider: "aws", account: "", regions: ["us-east-1"] });
  });

  it("counts only interactive selections and does not search again when selections change", async () => {
    setup({ cloud_find: () => ({ clusters: [cluster(), { ...cluster(), name: "Second", context: "yc-second" }], problems: [] }) });
    render(<CloudClusters />);
    const second = await screen.findByRole("checkbox", { name: /Second/ });
    const first = screen.getByRole("checkbox", { name: /Demo/ });
    fireEvent.click(second);
    expect(screen.getByRole("button", { name: "Add 1 cluster" })).toBeEnabled();
    fireEvent.click(first);
    expect(screen.getByRole("button", { name: "Add 0 clusters" })).toBeDisabled();
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 cluster" }));
    await screen.findByText("Already added");
    fireEvent.click(first);
    expect(screen.queryByRole("button", { name: "Add 1 cluster" })).not.toBeInTheDocument();
    fireEvent.click(second);
    expect(screen.getByRole("button", { name: "Add 1 cluster" })).toBeEnabled();
    expect(calls("cloud_import")[0]?.args.clusters).toEqual([cluster()]);
    expect(calls("cloud_find")).toHaveLength(1);
  });

  it("finds clusters automatically and debounces manual IDs while refresh keeps the chosen folder", async () => {
    setup(); render(<CloudClusters />);
    await screen.findByRole("list", { name: "Clusters found" });
    expect(screen.queryByRole("button", { name: "Find clusters" })).not.toBeInTheDocument();
    expect(calls("cloud_find")).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), { target: { value: "__manual" } });
    const folder = screen.getByRole("textbox", { name: "Folder ID" });
    fireEvent.change(folder, { target: { value: "f" } });
    fireEvent.change(folder, { target: { value: "folder-known" } });
    fireEvent.change(screen.getByRole("combobox", { name: "API address" }), { target: { value: "internal" } });
    expect(calls("cloud_find")).toHaveLength(1);
    await waitFor(() => expect(calls("cloud_find")).toHaveLength(2));
    expect(calls("cloud_find")[1]?.args.query).toEqual({ provider: "yandex", account: "folder-known", regions: [], yandex: { profile: "work", endpoint: "internal" } });
    await refresh();
    await waitFor(() => expect(calls("cloud_find")).toHaveLength(3));
    expect(screen.getByRole("textbox", { name: "Folder ID" })).toHaveValue("folder-known");
  });

  it("marks only successful imports as added and keeps failed rows available for retry", async () => {
    let imports = 0;
    setup({
      cloud_find: () => ({ clusters: [cluster(), { ...cluster(), name: "Second", context: "yc-second", cloudId: "second" }], problems: [] }),
      cloud_import: () => ++imports === 1
        ? { sources: [], contexts: ["yc-demo"], problems: [{ provider: "yandex", kind: "failed", scope: "Second", message: "Could not add Second", command: null, url: null }] }
        : { sources: [], contexts: ["yc-second"], problems: [] },
    });
    render(<CloudClusters />);
    await screen.findByRole("combobox", { name: "Folder" });
    fireEvent.click(await screen.findByRole("button", { name: "Add 2 clusters" }));
    await screen.findByText("Already added");
    const first = screen.getByRole("checkbox", { name: /Demo/ });
    expect(first).toBeChecked();
    expect(first).toBeDisabled();
    expect(first).toHaveClass("cloud-clusters__check-added");
    expect(screen.getByRole("checkbox", { name: /Second/ })).toBeChecked();
    expect(screen.getByText("Already added")).toHaveClass("cloud-clusters__added");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 cluster" }));
    await waitFor(() => expect(screen.getAllByText("Already added")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Add 0 clusters" })).not.toBeInTheDocument();
    expect(calls("cloud_import")[1]?.args.clusters).toEqual([{ ...cluster(), name: "Second", context: "yc-second", cloudId: "second" }]);
    await refresh();
    await waitFor(() => expect(calls("cloud_find")).toHaveLength(2));
    expect(screen.getByRole("checkbox", { name: /Demo/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add 0 clusters" })).not.toBeInTheDocument();
  });

  it("uses the short provider name and highlights unavailable cluster details", async () => {
    setup(); render(<CloudClusters />);
    expect(await screen.findByText("Yandex Cloud", { exact: true })).toBeInTheDocument();
    await screen.findByRole("combobox", { name: "Folder" });
    const unavailable = (await screen.findByRole("checkbox", { name: /Private only/ })).closest("li")!;
    expect(unavailable).toHaveClass("cloud-clusters__item--unavailable");
    expect(unavailable).toHaveTextContent("The selected API address or cluster certificate is not available.");
  });

  it("shows accessible status circles without the repeated raw status text", async () => {
    const states = ["RUNNING", "PROVISIONING", "STOPPED", "ERROR", "FUTURE_STATE", null];
    setup({ cloud_find: () => ({ clusters: states.map((status, i) => ({ ...cluster(), status, name: `Cluster ${i}`, context: `yc-${i}` })), problems: [] }) });
    const rendered = render(<CloudClusters />);
    await screen.findByRole("combobox", { name: "Folder" });
    const running = await screen.findByRole("img", { name: "Status: RUNNING" });
    expect(running).toHaveAttribute("title", "Status: RUNNING");
    expect(running).toHaveAttribute("data-tone", "success");
    expect(screen.getByRole("img", { name: "Status: PROVISIONING" })).toHaveAttribute("data-tone", "warning");
    expect(screen.getByRole("img", { name: "Status: STOPPED" })).toHaveAttribute("data-tone", "muted");
    expect(screen.getByRole("img", { name: "Status: ERROR" })).toHaveAttribute("data-tone", "danger");
    expect(screen.getByRole("img", { name: "Status: FUTURE_STATE" })).toHaveAttribute("data-tone", "muted");
    expect(screen.getAllByRole("img")).toHaveLength(5);
    expect(screen.queryByText("RUNNING", { exact: true })).not.toBeInTheDocument();
    expect(await axeViolations(rendered.container)).toEqual([]);
  });

  it("keeps the query and selection usable after search and import failures", async () => {
    let searches = 0;
    let imports = 0;
    setup({
      cloud_find: () => { if (++searches === 1) throw new Error("search failed"); return { clusters: [cluster()], problems: [] }; },
      cloud_import: () => { if (++imports === 1) throw new Error("import failed"); return { sources: [], contexts: ["yc-demo"], problems: [] }; },
    });
    render(<CloudClusters />);
    await screen.findByRole("combobox", { name: "Folder" });
    expect(await screen.findByRole("alert")).toHaveTextContent("search failed");
    await refresh();
    fireEvent.click(await screen.findByRole("button", { name: "Add 1 cluster" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("import failed");
    expect(screen.getByRole("checkbox", { name: /Demo/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 cluster" }));
    await screen.findByText("Added 1 cluster. It is in the cluster list.");
  });
  it("can retry discovery after a failed request without leaving stale controls enabled", async () => {
    let attempts = 0;
    setup({ cloud_accounts: () => { if (++attempts === 1) throw new Error("temporary failure"); return discovery(); } });
    render(<CloudClusters />);
    expect(await screen.findByRole("alert")).toHaveTextContent("temporary failure");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("combobox", { name: "Folder" })).toHaveValue("folder-work");
    expect(await screen.findByRole("button", { name: "Add 1 cluster" })).toBeEnabled();
  });

  it("requires a configured profile and recovers when one is chosen after it disappeared", async () => {
    setup({ cloud_accounts: args => {
      const found = discovery();
      if (!args.profile) {
        found.accounts = [];
        found.yandex!.profile = null;
        found.yandex!.clouds = [];
        found.yandex!.cloudId = null;
        found.problem = { provider: "yandex", kind: "failed", scope: null, message: "Profile no longer exists", command: null, url: null };
      }
      return found;
    } });
    render(<CloudClusters />);
    const profile = await screen.findByRole("combobox", { name: "Profile" });
    expect(calls("cloud_find")).toHaveLength(0);
    expect(profile).toHaveValue("");
    fireEvent.change(profile, { target: { value: "work" } });
    await screen.findByRole("button", { name: "Add 1 cluster" });
    await refresh();
    await waitFor(() => expect(calls("cloud_accounts")).toHaveLength(3));
    expect(await screen.findByRole("combobox", { name: "Folder" })).toHaveValue("folder-work");
  });

  it("has labelled accessible controls and exposes the installer when yc is absent", async () => {
    setup();
    const rendered = render(<CloudClusters />);
    await screen.findByRole("list", { name: "Clusters found" });
    expect(await axeViolations(rendered.container)).toEqual([]);
    rendered.unmount();
    backend.restore();
    setup({ cloud_status: () => [{ provider: "yandex", available: false, version: null, path: null,
      installUrl: "https://yandex.cloud/en/docs/cli/operations/install-cli", plugin: null }] });
    render(<CloudClusters />);
    expect(await screen.findByRole("radio", { name: /Yandex Cloud/ })).toBeDisabled();
    expect(screen.getByText("yc is not installed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Installation guide" }));
    expect(backend.openedUrls).toEqual(["https://yandex.cloud/en/docs/cli/operations/install-cli"]);
  });
  it("chooses a profile, cloud and folder and imports only usable selected clusters", async () => {
    setup(); render(<CloudClusters />);
    expect(await screen.findByText("yc 1.18.0")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Profile" })).toHaveValue("work");
    expect(screen.getByRole("combobox", { name: "Cloud" })).toHaveValue("cloud-a");
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveValue("folder-work");
    const found = await screen.findByRole("list", { name: "Clusters found" });
    expect(within(found).getByRole("checkbox", { name: /Private only/ })).toBeDisabled();
    expect(within(found).getByRole("checkbox", { name: /Demo/ })).toBeChecked();
    expect(calls("cloud_find")[0]?.args).toEqual({ query: { provider: "yandex", account: "folder-work", regions: [], yandex: { profile: "work", endpoint: "external" } } });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 cluster" }));
    await screen.findByText("Added 1 cluster. It is in the cluster list.");
    expect(calls("cloud_import")[0]?.args).toEqual({ clusters: [cluster()] });
  });

  it("uses the selected profile without activating it and lets a restricted user enter a folder ID", async () => {
    setup({ cloud_accounts: args => {
      const value = discovery(args.profile as string | undefined);
      if (args.profile === "personal") {
        value.accounts = []; value.yandex!.clouds = []; value.yandex!.cloudId = null;
        value.yandex!.problems = [{ provider: "yandex", kind: "failed", scope: "cloud-a", message: "PermissionDenied", command: null, url: null }];
      }
      return value;
    } });
    render(<CloudClusters />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Profile" }), { target: { value: "personal" } });
    const folder = await screen.findByRole("textbox", { name: "Folder ID" });
    fireEvent.change(folder, { target: { value: "folder-known" } });
    fireEvent.change(screen.getByRole("combobox", { name: "API address" }), { target: { value: "internal" } });
    expect(screen.getByText(/PermissionDenied/)).toBeInTheDocument();
    await waitFor(() => expect((calls("cloud_find").at(-1)?.args.query as CloudQuery | undefined)?.account).toBe("folder-known"));
    expect(calls("cloud_find").at(-1)?.args).toEqual({ query: { provider: "yandex", account: "folder-known", regions: [], yandex: { profile: "personal", endpoint: "internal" } } });
    expect(calls("cloud_accounts").at(-1)?.args).toEqual({ provider: "yandex", profile: "personal" });
  });

  it("ignores a delayed cloud response from a profile that is no longer selected", async () => {
    let resolveOld!: (value: CloudAccounts) => void;
    setup({ cloud_accounts: args => args.cloudId === "cloud-b" ? new Promise<CloudAccounts>(resolve => { resolveOld = resolve; }) : discovery(args.profile as string | undefined) });
    render(<CloudClusters />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Cloud" }), { target: { value: "cloud-b" } });
    await waitFor(() => expect(calls("cloud_accounts").at(-1)?.args.cloudId).toBe("cloud-b"));
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "personal" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Folder" })).toHaveValue("folder-personal"));
    resolveOld(discovery("work", "cloud-b"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue("personal"));
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveValue("folder-personal");
  });

  it("ignores old search results while a changed query automatically loads new ones", async () => {
    let resolveSearch!: (value: { clusters: CloudCluster[]; problems: [] }) => void;
    setup({ cloud_find: args => (args.query as CloudQuery).account === "folder-work"
      ? new Promise(resolve => { resolveSearch = resolve; })
      : { clusters: [{ ...cluster(), name: "New scope" }], problems: [] } });
    render(<CloudClusters />);
    const folders = await screen.findByRole("combobox", { name: "Folder" });
    await waitFor(() => expect(calls("cloud_find")).toHaveLength(1));
    fireEvent.change(folders, { target: { value: "__manual" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Folder ID" }), { target: { value: "other-folder" } });
    resolveSearch({ clusters: [cluster()], problems: [] });
    expect(await screen.findByRole("checkbox", { name: /New scope/ })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Demo/ })).not.toBeInTheDocument();
    expect(calls("cloud_find")).toHaveLength(2);
  });

  it("does not attach an old import message to a newly chosen folder", async () => {
    let finishImport!: (value: { sources: []; contexts: string[]; problems: [] }) => void;
    setup({ cloud_import: () => new Promise(resolve => { finishImport = resolve; }) });
    render(<CloudClusters />);
    const folder = await screen.findByRole("combobox", { name: "Folder" });
    fireEvent.click(await screen.findByRole("button", { name: "Add 1 cluster" }));
    await waitFor(() => expect(calls("cloud_import")).toHaveLength(1));
    fireEvent.change(folder, { target: { value: "__manual" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Folder ID" }), { target: { value: "new-folder" } });
    finishImport({ sources: [], contexts: ["yc-demo"], problems: [] });
    await screen.findByRole("button", { name: "Add 1 cluster" });
    expect(screen.queryByText("Added 1 cluster. It is in the cluster list.")).not.toBeInTheDocument();
    expect(screen.queryByText("Already added")).not.toBeInTheDocument();
    expect(calls("clusters_list").length).toBeGreaterThan(0);
  });
});
