// #209: two revisions of a release compared, and newer chart versions in the release list.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "codemirror";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChartUpdate,
  ChartUpdates,
  HelmRelease,
  HelmReleaseDetail,
  HelmRevisionDiff,
  KubeObject,
  RevisionObject,
  WatchSpec,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { useClustersStore } from "../clusters/clustersStore";
import { getPage } from "../../layout/pages";
import { axeViolations } from "../../test/axe";
import { watchBackend, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import { resetHelmStatus } from "./index";
import { lastUpgradePair, revisionObjectState } from "./revisionModel";
import { resetChartUpdates } from "./updates";

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

function release(name: string, over: Partial<HelmRelease> = {}): HelmRelease {
  return {
    name,
    namespace: "apps",
    revision: 1,
    chart: "nginx",
    chartVersion: "15.1.0",
    appVersion: "1.25.3",
    status: "deployed",
    updated: "2026-10-11T18:00:00Z",
    unreadableRevision: null,
    unreadable: false,
    ...over,
  };
}

const web = release("web", { revision: 3 });
const db = release("db", { chart: "postgresql", chartVersion: "12.0.0" });
const history: HelmRelease[] = [
  release("web", { revision: 1, status: "superseded", chartVersion: "15.0.0" }),
  release("web", { revision: 2, status: "superseded" }),
  web,
];
const webDetail: HelmReleaseDetail = { release: web, valuesYaml: "replicaCount: 3\n", manifest: "", notes: "" };

const CONFIG_MAP = { group: "", version: "v1", kind: "ConfigMap" };
const SECRET = { group: "", version: "v1", kind: "Secret" };
const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment" };

function object(kind: typeof CONFIG_MAP, name: string, left: unknown, right: unknown, over: Partial<RevisionObject> = {}): RevisionObject {
  return {
    object: { kind, namespace: null, name },
    left: left as RevisionObject["left"],
    right: right as RevisionObject["right"],
    ...over,
  };
}

const cm = (mode: string) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web" }, data: { mode } });
const deployment = (replicas: number) => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { replicas } });
const hiddenSecret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "web-auth", annotations: { "sextant.dev/values-hidden": "true" } },
  data: { password: "" },
};

function revisionDiff(left: number, right: number): HelmRevisionDiff {
  return {
    release: "web",
    namespace: "apps",
    left: history[left - 1]!,
    right: history[right - 1]!,
    leftValues: "replicaCount: 1\n",
    rightValues: "replicaCount: 3\n",
    leftNotes: "Old notes.\n",
    rightNotes: "New notes.\n",
    objects: [
      object(CONFIG_MAP, "web", cm("same"), cm("same")),
      object(SECRET, "web-auth", hiddenSecret, hiddenSecret, {
        secretKeys: [{ key: "password", onLeft: true, onRight: true, equal: false }],
      }),
      object(CONFIG_MAP, "extra", null, cm("new")),
      object(DEPLOYMENT, "web", deployment(1), deployment(3)),
    ],
    unreadable: 0,
    truncated: 0,
  };
}

function update(chart: string, version: string, over: Partial<ChartUpdate> = {}): ChartUpdate {
  return {
    chart,
    version,
    chartRef: `bitnami/${chart}`,
    latest: version,
    latestAppVersion: null,
    step: null,
    upToDate: true,
    otherRepos: [],
    error: null,
    ...over,
  };
}

let wb: WatchBackend;
let releases: HelmRelease[];
let report: ChartUpdates;

function secret(name: string, revision: number): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: `sh.helm.release.v1.${name}.v${revision}`, namespace: "apps", uid: `uid-${name}`, resourceVersion: `${revision}` },
  };
}

function helmBackend(available = true) {
  wb.backend.on("watch_start", (args) => {
    const id = args.streamId as string;
    const spec = args.spec as WatchSpec;
    wb.specs.set(id, spec);
    if (spec.kind.kind === "Secret") {
      const items = [secret("web", 3), secret("db", 1)];
      act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
    }
    return id;
  });
  wb.backend.on("helm_status", () =>
    available ? { available: true, version: "v4.3.0", path: "/usr/bin/helm" } : { available: false, version: null, path: null },
  );
  wb.backend.on("helm_releases", () => structuredClone(releases));
  wb.backend.on("helm_release_detail", () => structuredClone(webDetail));
  wb.backend.on("helm_release_history", () => structuredClone(history));
  wb.backend.on("helm_revision_diff", (args) => revisionDiff(args.left as number, args.right as number));
  wb.backend.on("helm_chart_updates", () => structuredClone(report));
  wb.backend.on("helm_repo_update", () => null);
  wb.backend.on("helm_search", () => []);
}

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd);

beforeEach(async () => {
  resetAppStore();
  resetNamespaceRestore();
  resetHelmStatus();
  resetChartUpdates();
  wb = watchBackend();
  releases = [web, db];
  report = {
    charts: [
      update("nginx", "15.1.0", { latest: "16.0.0", latestAppVersion: "1.27.0", step: "major", upToDate: false, otherRepos: ["mirror"] }),
      update("postgresql", "12.0.0"),
    ],
    repos: 2,
    repoProblems: [{ repo: "stale", message: "Repo \"stale\" is corrupt or missing. Try 'helm repo update'." }],
    skipped: 0,
  };
  await selectNamespaces("c1", ["apps"]);
});

afterEach(() => wb.backend.restore());

function renderPage() {
  const Page = getPage("helm-releases")!.Component;
  return render(<Page clusterId="c1" />);
}

function editorText(root: HTMLElement, label: string): string {
  const content = root.querySelector(`[aria-label="${label}"]`);
  if (!content) throw new Error(`no editor ${label}`);
  return EditorView.findFromDOM(content as HTMLElement)!.state.doc.toString();
}

async function openRelease(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Open release ${name}` }));
  return await screen.findByRole("region", { name: `Release ${name}` });
}

describe("Revision model", () => {
  it("tells added, removed, changed and unchanged objects; a Secret changes by its key hashes", () => {
    expect(revisionObjectState(object(CONFIG_MAP, "a", null, cm("x")))).toBe("added");
    expect(revisionObjectState(object(CONFIG_MAP, "a", cm("x"), null))).toBe("removed");
    expect(revisionObjectState(object(CONFIG_MAP, "a", cm("x"), cm("y")))).toBe("changed");
    expect(revisionObjectState(object(DEPLOYMENT, "a", deployment(2), deployment(2)))).toBe("same");
    const secretWith = (equal: boolean) =>
      object(SECRET, "s", hiddenSecret, hiddenSecret, { secretKeys: [{ key: "k", onLeft: true, onRight: true, equal }] });
    expect(revisionObjectState(secretWith(true))).toBe("same");
    expect(revisionObjectState(secretWith(false))).toBe("changed");
  });

  it("compares the last upgrade: the newest readable revision before the current one", () => {
    expect(lastUpgradePair(history, 3)).toEqual({ left: 2, right: 3 });
    const broken = [history[0]!, { ...history[1]!, unreadable: true }, web];
    expect(lastUpgradePair(broken, 3)).toEqual({ left: 1, right: 3 });
    expect(lastUpgradePair([web], 3)).toBeNull();
  });
});

describe("Compare revisions", () => {
  it("shows what changed in the last upgrade in one click: values and manifest only after Show, notes at once", async () => {
    helmBackend();
    renderPage();
    const details = await openRelease("web");
    const lastUpgrade = within(details).getByRole("button", { name: "What changed in the last upgrade" });
    await waitFor(() => expect(lastUpgrade).toBeEnabled());
    fireEvent.click(lastUpgrade);
    expect(within(details).getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(calls("helm_revision_diff")).toHaveLength(1));
    expect(calls("helm_revision_diff")[0]!.args).toEqual({ clusterId: "c1", namespace: "apps", name: "web", left: 2, right: 3 });

    const left = "Revision 2 · nginx 15.1.0";
    const right = "Revision 3 · nginx 15.1.0";
    const notes = await within(details).findByRole("region", { name: "Notes" });
    expect(editorText(notes, left)).toBe("Old notes.\n");
    expect(editorText(notes, right)).toBe("New notes.\n");

    const values = within(details).getByRole("region", { name: "User values" });
    expect(values.querySelector(`[aria-label="${left}"]`)).toBeNull();
    fireEvent.click(within(values).getByRole("button", { name: "Show values" }));
    expect(editorText(values, left)).toBe("replicaCount: 1\n");
    expect(editorText(values, right)).toBe("replicaCount: 3\n");

    // The list of what changed is there before Show; the objects themselves only after it.
    const manifest = within(details).getByRole("region", { name: "Manifest" });
    expect(within(manifest).getByRole("status")).toHaveTextContent("3 objects differ.");
    const table = within(manifest).getByRole("table", { name: "Objects of both revisions" });
    const rowsOf = () => within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rowsOf()).toEqual(["Secret · web-authChanged", "ConfigMap · extraAdded", "Deployment · webChanged"]);
    expect(within(table).queryByRole("button", { name: /Show changes/ })).toBeNull();
    fireEvent.click(within(manifest).getByRole("checkbox", { name: "Only changed objects" }));
    expect(rowsOf()).toContain("ConfigMap · webUnchanged");

    fireEvent.click(within(manifest).getByRole("button", { name: "Show manifest" }));
    fireEvent.click(within(table).getByRole("button", { name: "Show changes of Secret · web-auth" }));
    const keys = within(manifest).getByRole("table", { name: "Secret keys" });
    expect(keys).toHaveTextContent("password");
    expect(within(manifest).queryByRole("button", { name: /Show value/ })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Show changes of Deployment · web" }));
    expect(editorText(manifest, right)).toContain("replicas: 3");
    expect(editorText(manifest, left)).toContain("replicas: 1");

    expect(await axeViolations(details)).toEqual([]);
  });

  it("compares any two revisions picked; another pair hides what was shown", async () => {
    helmBackend();
    renderPage();
    const details = await openRelease("web");
    fireEvent.click(within(details).getByRole("tab", { name: "Compare" }));
    await waitFor(() => expect(calls("helm_revision_diff")).toHaveLength(1));
    const values = await within(details).findByRole("region", { name: "User values" });
    fireEvent.click(within(values).getByRole("button", { name: "Show values" }));
    fireEvent.change(within(details).getByLabelText("From"), { target: { value: "1" } });
    await waitFor(() => expect(calls("helm_revision_diff")).toHaveLength(2));
    expect(calls("helm_revision_diff")[1]!.args).toMatchObject({ left: 1, right: 3 });
    const again = await within(details).findByRole("region", { name: "User values" });
    expect(within(again).getByRole("button", { name: "Show values" })).toHaveAttribute("aria-pressed", "false");
    expect(within(details).getByText("Revision 1 · nginx 15.0.0", { exact: false, selector: "span" })).toBeInTheDocument();
  });

  it("says so when there is only one readable revision", async () => {
    helmBackend();
    wb.backend.on("helm_release_history", () => [web]);
    renderPage();
    const details = await openRelease("web");
    await waitFor(() => expect(calls("helm_release_history")).toHaveLength(1));
    expect(within(details).getByRole("button", { name: "What changed in the last upgrade" })).toBeDisabled();
    fireEvent.click(within(details).getByRole("tab", { name: "Compare" }));
    expect(await within(details).findByText(/only one readable revision/)).toBeInTheDocument();
    expect(calls("helm_revision_diff")).toHaveLength(0);
  });
});

describe("Newer chart versions", () => {
  async function table() {
    const found = await screen.findByRole("table", { name: "Releases" });
    await waitFor(() => expect(within(found).getAllByRole("row")).toHaveLength(3));
    return found;
  }

  const row = (t: HTMLElement, key: string) => t.querySelector<HTMLElement>(`[data-release="${key}"]`)!;

  it("are looked up once per chart while the page is open, kept for the cluster, and refreshed on demand", async () => {
    helmBackend();
    const view = renderPage();
    const releasesTable = await table();
    await waitFor(() => expect(row(releasesTable, "apps/web")).toHaveTextContent("16.0.0major"));
    expect(calls("helm_chart_updates")).toHaveLength(1);
    expect(calls("helm_chart_updates")[0]!.args).toEqual({
      charts: [
        { chart: "nginx", version: "15.1.0" },
        { chart: "postgresql", version: "12.0.0" },
      ],
    });
    expect(row(releasesTable, "apps/db")).toHaveTextContent("Up to date");
    expect(screen.getByText("Repository stale cannot be read: update the repositories.")).toBeInTheDocument();
    expect(calls("helm_repo_update")).toHaveLength(0);

    // "Has updates" keeps only the releases with a newer chart.
    fireEvent.click(screen.getByRole("checkbox", { name: "Has updates" }));
    await waitFor(() => expect(within(releasesTable).getAllByRole("row")).toHaveLength(2));
    expect(row(releasesTable, "apps/web")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has updates" }));

    // Leaving and coming back reuses the answer; Refresh asks again; updating the repositories asks after it.
    view.unmount();
    renderPage();
    await table();
    expect(calls("helm_chart_updates")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check for newer charts" }));
    await waitFor(() => expect(calls("helm_chart_updates")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Update repositories" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Update repositories" }));
    await waitFor(() => expect(calls("helm_chart_updates")).toHaveLength(3));
    expect(calls("helm_repo_update")).toHaveLength(1);

    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("are not looked up without helm", async () => {
    helmBackend(false);
    renderPage();
    await table();
    expect(screen.queryByRole("checkbox", { name: "Has updates" })).toBeNull();
    expect(calls("helm_chart_updates")).toHaveLength(0);
  });

  it("show a failed or unknown chart without failing the others", async () => {
    report.charts = [
      update("nginx", "15.1.0", { error: { code: "timeout", message: "searching took too long" } }),
      update("postgresql", "12.0.0", { chartRef: null, latest: null, upToDate: false }),
    ];
    report.repoProblems = [];
    helmBackend();
    renderPage();
    const releasesTable = await table();
    await waitFor(() => expect(row(releasesTable, "apps/web")).toHaveTextContent("Not checked"));
    expect(row(releasesTable, "apps/db")).toHaveTextContent("Unknown");
  });

  it("open the upgrade dialog at the newer version from the release list, with its preview", async () => {
    helmBackend();
    wb.backend.on("helm_upgrade", () => null);
    wb.backend.on("helm_upgrade_preview", () => ({ current: "", proposed: "", secretChanges: [], unreadable: 0, clientSide: false }));
    renderPage();
    const releasesTable = await table();
    const upgrade = await within(releasesTable).findByRole("button", { name: "Upgrade web to chart version 16.0.0…" });
    fireEvent.click(upgrade);
    const dialog = await screen.findByRole("dialog", { name: "Upgrade web to nginx 16.0.0" });
    expect(within(dialog).getByLabelText("Chart reference")).toHaveValue("bitnami/nginx");
    expect(within(dialog).getByLabelText("Chart version")).toHaveValue("16.0.0");
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(calls("helm_upgrade_preview")).toHaveLength(1));
    expect(calls("helm_upgrade_preview")[0]!.args).toMatchObject({ chartRef: "bitnami/nginx", version: "16.0.0" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(calls("helm_upgrade")).toHaveLength(1));
    expect(calls("helm_upgrade")[0]!.args).toEqual({
      clusterId: "c1",
      namespace: "apps",
      release: "web",
      chartRef: "bitnami/nginx",
      valuesYaml: "replicaCount: 3\n",
      version: "16.0.0",
    });
    expect(calls("helm_search")).toHaveLength(0);
  });
});

describe("Newer chart versions across connections", () => {
  it("are asked again after the cluster disconnects and connects, not kept from the old connection", async () => {
    useClustersStore.setState({ states: { c1: { state: "connected" } } } as never);
    helmBackend();
    const view = renderPage();
    const releasesTable = await screen.findByRole("table", { name: "Releases" });
    await waitFor(() => expect(releasesTable.querySelector('[data-release="apps/web"]')).toHaveTextContent("16.0.0major"));
    expect(calls("helm_chart_updates")).toHaveLength(1);
    view.unmount();

    // Reopened on the same connection: the kept answer.
    renderPage();
    await screen.findByRole("table", { name: "Releases" });
    expect(calls("helm_chart_updates")).toHaveLength(1);

    // Each change of the connection drops the kept answer; the open page asks again.
    act(() => useClustersStore.setState({ states: { c1: { state: "disconnected" } } } as never));
    await waitFor(() => expect(calls("helm_chart_updates")).toHaveLength(2));
    act(() => useClustersStore.setState({ states: { c1: { state: "connected" } } } as never));
    await waitFor(() => expect(calls("helm_chart_updates")).toHaveLength(3));
  });
});
