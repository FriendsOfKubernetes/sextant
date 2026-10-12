import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "codemirror";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartHit, HelmRelease, HelmReleaseDetail, HelmRepo, HelmStatus, KubeObject } from "../../api";
import { resetAppStore } from "../../app/store";
import { getPage, getPages } from "../../layout/pages";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import { HELM_INSTALL_URL, resetHelmStatus } from "./index";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const HELM_OK: HelmStatus = { available: true, version: "v4.3.0", path: "/usr/local/bin/helm" };
const HELM_MISSING: HelmStatus = { available: false, version: null, path: null };

function release(name: string, over: Partial<HelmRelease> = {}): HelmRelease {
  return {
    name,
    namespace: "apps",
    revision: 1,
    chart: "nginx",
    chartVersion: "15.1.0",
    appVersion: "1.25.3",
    status: "deployed",
    updated: "2026-10-11T18:00:00.123456789+03:00",
    unreadableRevision: null,
    unreadable: false,
    ...over,
  };
}

const web = release("web", { revision: 2 });
const db = release("db", { chart: "postgresql", chartVersion: "12.0.0", appVersion: "16.1", status: "failed" });

const webDetail: HelmReleaseDetail = {
  release: web,
  valuesYaml: "replicaCount: 3\n",
  manifest: "---\n# Source: nginx/templates/svc.yaml\nkind: Service\n",
  notes: "Open http://web.apps.svc to see nginx.",
};

const webHistory: HelmRelease[] = [
  release("web", { revision: 1, status: "superseded", appVersion: "1.25.2" }),
  web,
];

/** A release Secret as the watch delivers it. */
function secret(name: string, revision: number): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "helm.sh/release.v1",
    metadata: {
      name: `sh.helm.release.v1.${name}.v${revision}`,
      namespace: "apps",
      uid: `uid-${name}-${revision}`,
      resourceVersion: `${revision}`,
      labels: { owner: "helm", name, version: `${revision}` },
    },
  };
}

let wb: WatchBackend;
let releases: HelmRelease[];

function helmBackend(status = HELM_OK) {
  wb.backend.on("helm_status", () => status);
  wb.backend.on("helm_releases", () => structuredClone(releases));
  wb.backend.on("helm_release_detail", () => structuredClone(webDetail));
  wb.backend.on("helm_release_history", () => structuredClone(webHistory));
  wb.backend.on("helm_search", () => [] as ChartHit[]);
}

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd);

beforeEach(async () => {
  resetAppStore();
  resetNamespaceRestore();
  resetHelmStatus();
  wb = watchBackend();
  releases = [web, db];
  await selectNamespaces("c1", ["apps"]);
});

afterEach(() => wb.backend.restore());

function renderPage(id: string) {
  const Page = getPage(id)!.Component;
  return render(<Page clusterId="c1" />);
}

function rows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole("row").slice(1);
}

function editorView(label: string): EditorView {
  const content = document.querySelector(`[aria-label="${label}"]`);
  if (!content) throw new Error(`no editor ${label}`);
  const view = EditorView.findFromDOM(content as HTMLElement);
  if (!view) throw new Error("no EditorView");
  return view;
}

function setEditorText(label: string, text: string) {
  const view = editorView(label);
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

async function openRelease(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Open release ${name}` }));
  return await screen.findByRole("region", { name: `Release ${name}` });
}

describe("Helm pages", () => {
  it("are the Charts and Releases entries of the Helm section", () => {
    expect(getPages("helm").map((p) => [p.id, p.labelKey])).toEqual([
      ["helm-charts", "helm:sidebar.charts"],
      ["helm-releases", "helm:sidebar.releases"],
    ]);
  });
});

describe("Releases", () => {
  it("while the releases load shows what loads, the seconds and after 5 s that the cluster is slow", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helmBackend();
      wb.backend.on("helm_releases", () => new Promise<HelmRelease[]>(() => undefined));
      renderPage("helm-releases");
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/^Loading releases…/);
      expect(screen.queryByText("The cluster is slow to respond")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(6_000));
      expect(status).toHaveTextContent(/^Loading releases…\s*[67] s/);
      expect(screen.getByText("The cluster is slow to respond")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists the releases of the selected namespaces and refreshes when their Secrets change", async () => {
    helmBackend();
    renderPage("helm-releases");
    const id = await watchOf(wb, "Secret");
    expect(wb.specs.get(id)).toEqual({
      kind: { group: "", version: "v1", kind: "Secret" },
      namespaces: ["apps"],
      labelSelector: "owner=helm",
      fieldSelector: "type=helm.sh/release.v1",
    });
    const table = await screen.findByRole("table", { name: "Releases" });
    await waitFor(() => expect(rows(table)).toHaveLength(2));
    expect(calls("helm_releases")[0]!.args).toEqual({ clusterId: "c1", namespaces: ["apps"] });
    expect(rows(table).map((r) => [...r.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent))).toEqual([
      ["db", "apps", "postgresql", "12.0.0", "16.1", "failed"],
      ["web", "apps", "nginx", "15.1.0", "1.25.3", "deployed"],
    ]);

    // `helm install cache` elsewhere: a new release Secret arrives through the watch.
    releases = [...releases, release("cache", { chart: "redis" })];
    emitSnapshot(wb, id, [secret("web", 2), secret("db", 1), secret("cache", 1)]);
    await waitFor(() => expect(rows(table)).toHaveLength(3));
    expect(within(table).getByText("redis")).toBeInTheDocument();
  });

  it("shows the release's values, manifest, notes and history", async () => {
    helmBackend();
    renderPage("helm-releases");
    const details = await openRelease("web");
    expect(calls("helm_release_detail")[0]!.args).toEqual({ clusterId: "c1", namespace: "apps", name: "web", revision: null });
    await waitFor(() => expect(editorView("User values of web").state.doc.toString()).toBe("replicaCount: 3\n"));

    fireEvent.click(within(details).getByRole("tab", { name: "Manifest" }));
    expect(editorView("Manifest of web").state.doc.toString()).toContain("kind: Service");

    fireEvent.click(within(details).getByRole("tab", { name: "Notes" }));
    expect(within(details).getByText("Open http://web.apps.svc to see nginx.")).toBeInTheDocument();

    fireEvent.click(within(details).getByRole("tab", { name: "History" }));
    const history = await within(details).findByRole("table", { name: "History" });
    expect(rows(history).map((r) => r.getAttribute("data-revision"))).toEqual(["2", "1"]);
    expect(rows(history)[0]).toHaveTextContent("(current)");
    expect(within(history).getByRole("button", { name: "Roll back to revision 1" })).toBeEnabled();
    expect(within(history).queryByRole("button", { name: "Roll back to revision 2" })).toBeNull();
  });

  it("edits values and upgrades with the same chart; Helm's error is shown in its own words", async () => {
    helmBackend();
    wb.backend.on("helm_search", () => [
      { name: "bitnami/nginx", version: "18.0.0", appVersion: "1.27", description: "NGINX" },
      { name: "other/nginx-ingress", version: "1.0.0", appVersion: "1", description: "" },
    ]);
    const stderr =
      "Error: UPGRADE FAILED: values don't meet the specifications of the schema(s) in the following chart(s):\nnginx:\n- at '/replicaCount': got string, want integer";
    let fail = true;
    wb.backend.on("helm_upgrade", () => {
      if (fail) throw { code: "other", message: stderr };
      return null;
    });
    renderPage("helm-releases");
    const details = await openRelease("web");
    await waitFor(() => expect(within(details).getByRole("button", { name: "Edit values" })).toBeEnabled());
    fireEvent.click(within(details).getByRole("button", { name: "Edit values" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit values of web" });
    expect(editorView("Values of web").state.doc.toString()).toBe("replicaCount: 3\n");
    await waitFor(() => expect(within(dialog).getByLabelText("Chart reference")).toHaveValue("bitnami/nginx"));
    expect(calls("helm_upgrade")).toHaveLength(0);

    setEditorText("Values of web", "replicaCount: many\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Helm could not upgrade the release");
    expect(alert).toHaveTextContent("got string, want integer");
    expect(screen.getByRole("dialog", { name: "Edit values of web" })).toBeInTheDocument();

    fail = false;
    setEditorText("Values of web", "replicaCount: 5\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
    expect(await within(dialog).findByText("Release web upgraded. A new revision was created.")).toBeInTheDocument();
    expect(calls("helm_upgrade").at(-1)!.args).toEqual({
      clusterId: "c1",
      namespace: "apps",
      release: "web",
      chartRef: "bitnami/nginx",
      valuesYaml: "replicaCount: 5\n",
    });
  });

  it("uninstalls only after the release name is typed, and the release leaves the list", async () => {
    helmBackend();
    wb.backend.on("helm_uninstall", () => {
      releases = releases.filter((r) => r.name !== "web");
      return null;
    });
    renderPage("helm-releases");
    const details = await openRelease("web");
    fireEvent.click(within(details).getByRole("button", { name: "Uninstall" }));

    const dialog = await screen.findByRole("dialog", { name: "Uninstall web?" });
    expect(dialog).toHaveTextContent("Release web in namespace apps and every resource it created will be deleted");
    const confirm = within(dialog).getByRole("button", { name: "Uninstall" });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText("Type the release name (web) to confirm");
    fireEvent.change(input, { target: { value: "db" } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls("helm_uninstall")).toHaveLength(0);

    fireEvent.change(input, { target: { value: "web" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("helm_uninstall")).toEqual([
      { cmd: "helm_uninstall", args: { clusterId: "c1", namespace: "apps", release: "web" } },
    ]);
    const table = screen.getByRole("table", { name: "Releases" });
    await waitFor(() => expect(rows(table)).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Release web" })).toBeNull();
  });

  it("rolls back to a chosen revision after the name is typed", async () => {
    helmBackend();
    wb.backend.on("helm_rollback", () => null);
    renderPage("helm-releases");
    const details = await openRelease("web");
    fireEvent.click(within(details).getByRole("tab", { name: "History" }));
    fireEvent.click(await within(details).findByRole("button", { name: "Roll back to revision 1" }));

    const dialog = await screen.findByRole("dialog", { name: "Roll back web?" });
    expect(dialog).toHaveTextContent("chart and values of revision 1");
    const confirm = within(dialog).getByRole("button", { name: "Roll back" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type the release name (web) to confirm"), { target: { value: "web" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(calls("helm_rollback")).toHaveLength(1));
    expect(calls("helm_rollback")[0]!.args).toEqual({ clusterId: "c1", namespace: "apps", release: "web", revision: 1 });
  });

  it("without helm still lists releases and shows them, but the actions are disabled with an install hint", async () => {
    helmBackend(HELM_MISSING);
    renderPage("helm-releases");
    const table = await screen.findByRole("table", { name: "Releases" });
    await waitFor(() => expect(rows(table)).toHaveLength(2));
    const hint = await screen.findByRole("note");
    expect(hint).toHaveTextContent("Helm is not installed");
    const link = within(hint).getByRole("link", { name: HELM_INSTALL_URL });
    expect(link).toHaveAttribute("href", HELM_INSTALL_URL);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    // The click is handled by the app (system browser), not by the webview following the link.
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(wb.backend.openedUrls).toEqual([HELM_INSTALL_URL]));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();

    const details = await openRelease("web");
    await waitFor(() => expect(editorView("User values of web").state.doc.toString()).toBe("replicaCount: 3\n"));
    for (const name of ["Edit values", "Uninstall"]) {
      const button = within(details).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Needs Helm — see the hint at the top of the page");
    }
    fireEvent.click(within(details).getByRole("tab", { name: "History" }));
    expect(await within(details).findByRole("button", { name: "Roll back to revision 1" })).toBeDisabled();
  });
});

describe("Unreadable revisions", () => {
  /** A revision whose Secret the backend cannot decode. */
  const broken = (name: string, revision: number, over: Partial<HelmRelease> = {}): HelmRelease =>
    release(name, {
      revision,
      chart: "",
      chartVersion: "",
      appVersion: "",
      status: "",
      updated: "",
      unreadable: true,
      ...over,
    });

  it("keep the release listed with its last readable revision and mark broken history rows", async () => {
    helmBackend();
    releases = [
      release("web", { revision: 1, status: "superseded", unreadableRevision: 2 }),
      broken("ghost", 3, { unreadableRevision: 3 }),
    ];
    wb.backend.on("helm_release_detail", () => ({ ...structuredClone(webDetail), release: releases[0]! }));
    wb.backend.on("helm_release_history", () => [
      release("web", { revision: 1, status: "superseded" }),
      broken("web", 2),
    ]);
    wb.backend.on("helm_rollback", () => null);
    renderPage("helm-releases");
    const table = await screen.findByRole("table", { name: "Releases" });
    await waitFor(() => expect(rows(table)).toHaveLength(2));
    const [ghost, web] = rows(table);
    expect(web).toHaveTextContent("superseded");
    expect(web).toHaveTextContent("Unreadable revision 2");
    expect(ghost).toHaveTextContent("Unreadable revision 3");

    const details = await openRelease("web");
    fireEvent.click(within(details).getByRole("tab", { name: "History" }));
    const history = await within(details).findByRole("table", { name: "History" });
    expect(rows(history).map((r) => r.getAttribute("data-revision"))).toEqual(["2", "1"]);
    expect(rows(history)[0]).toHaveTextContent("Unreadable");
    expect(rows(history)[0]).not.toHaveTextContent("-");
    expect(within(history).queryByRole("button", { name: "Roll back to revision 2" })).toBeNull();
    expect(rows(history)[1]).toHaveTextContent("(current)");
  });
});

describe("Helm status", () => {
  it("is checked again when a Helm page opens and when the window gets focus", async () => {
    helmBackend();
    let status = HELM_MISSING;
    wb.backend.on("helm_status", () => status);
    wb.backend.on("helm_repos", () => [] as HelmRepo[]);
    const releasesPage = renderPage("helm-releases");
    expect(await screen.findByRole("note")).toHaveTextContent("Helm is not installed");
    expect(calls("helm_status")).toHaveLength(1);
    releasesPage.unmount();

    // Helm was installed meanwhile: the next Helm page sees it without a restart.
    status = HELM_OK;
    renderPage("helm-charts");
    await waitFor(() => expect(calls("helm_status")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    expect(screen.getByRole("button", { name: "Add repository" })).toBeDisabled(); // nothing typed yet
    expect(screen.getByLabelText("Name")).toBeEnabled();

    // …and so does a page that stays open, when the window comes back into focus.
    status = HELM_MISSING;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("note")).toHaveTextContent("Helm is not installed");
    expect(calls("helm_status")).toHaveLength(3);
  });
});

describe("Charts", () => {
  let repos: HelmRepo[];
  const hit: ChartHit = { name: "bitnami/nginx", version: "15.1.0", appVersion: "1.25.3", description: "NGINX Open Source" };
  const defaults = "# Default values\nreplicaCount: 1\nimage:\n  tag: 1.25.3\n";

  function chartsBackend() {
    helmBackend();
    repos = [];
    wb.backend.on("helm_repos", () => structuredClone(repos));
    wb.backend.on("helm_repo_add", (args) => {
      repos.push({ name: args.name as string, url: args.url as string });
      return null;
    });
    wb.backend.on("helm_repo_remove", (args) => {
      repos = repos.filter((r) => r.name !== args.name);
      return null;
    });
    wb.backend.on("helm_repo_update", () => null);
    wb.backend.on("helm_search", (args) => (repos.length > 0 && "nginx".includes(String(args.query)) ? [hit] : []));
    wb.backend.on("helm_show_values", () => defaults);
    wb.backend.on("helm_install", () => null);
  }

  it("adds a repository, finds its chart, shows the default values and installs it into a namespace", async () => {
    chartsBackend();
    renderPage("helm-charts");
    expect(await screen.findByText("No chart repositories yet. Add one to search its charts.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bitnami" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://charts.bitnami.com/bitnami" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const repoTable = await screen.findByRole("table", { name: "Repositories" });
    expect(rows(repoTable)[0]).toHaveTextContent("bitnamihttps://charts.bitnami.com/bitnami");
    expect(calls("helm_repo_add")[0]!.args).toEqual({ name: "bitnami", url: "https://charts.bitnami.com/bitnami" });

    fireEvent.click(screen.getByRole("button", { name: "Update repositories" }));
    expect(await screen.findByText("Repositories updated.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search charts" }), { target: { value: "nginx" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findByRole("table", { name: "Search charts" });
    expect(calls("helm_search").at(-1)!.args).toEqual({ query: "nginx" });
    expect(rows(results)[0]).toHaveTextContent("bitnami/nginx15.1.01.25.3NGINX Open Source");

    fireEvent.click(within(results).getByRole("button", { name: "Show chart bitnami/nginx" }));
    await waitFor(() =>
      expect(editorView("Default values of bitnami/nginx 15.1.0").state.doc.toString()).toBe(defaults),
    );
    expect(calls("helm_show_values")[0]!.args).toEqual({ chart: "bitnami/nginx", version: "15.1.0" });

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("dialog", { name: "Install bitnami/nginx 15.1.0" });
    expect(within(dialog).getByLabelText("Release name")).toHaveValue("nginx");
    expect(within(dialog).getByLabelText("Namespace")).toHaveValue("apps");
    expect(editorView("Values for bitnami/nginx").state.doc.toString()).toBe(defaults);
    fireEvent.change(within(dialog).getByLabelText("Release name"), { target: { value: "Web!" } });
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Release name"), { target: { value: "web2" } });
    setEditorText("Values for bitnami/nginx", "replicaCount: 2\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));

    expect(
      await within(dialog).findByText("Release web2 installed in namespace apps. It is listed under Releases."),
    ).toBeInTheDocument();
    expect(calls("helm_install")[0]!.args).toEqual({
      clusterId: "c1",
      namespace: "apps",
      release: "web2",
      chart: "bitnami/nginx",
      version: "15.1.0",
      valuesYaml: "replicaCount: 2\n",
    });
  });

  it("adds a repository with a login; a URL with a login inside is refused with a hint", async () => {
    chartsBackend();
    renderPage("helm-charts");
    await screen.findByText("No chart repositories yet. Add one to search its charts.");
    const password = screen.getByLabelText("Password (optional)");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "off");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "private" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://robot:hunter2@charts.example.test/stable" } });
    expect(screen.getByText("Enter the user name and password in the Username and Password fields, not in the URL.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://charts.example.test/stable" } });
    fireEvent.change(screen.getByLabelText("Username (optional)"), { target: { value: "robot" } });
    fireEvent.change(password, { target: { value: "s3cret pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const repoTable = await screen.findByRole("table", { name: "Repositories" });
    expect(calls("helm_repo_add")[0]!.args).toEqual({
      name: "private",
      url: "https://charts.example.test/stable",
      username: "robot",
      password: "s3cret pass",
    });
    expect(rows(repoTable)[0]).toHaveTextContent("privatehttps://charts.example.test/stable");
    expect(screen.getByLabelText("Password (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Username (optional)")).toHaveValue("");
  });

  it("removes a repository after confirmation", async () => {
    chartsBackend();
    repos = [{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }];
    renderPage("helm-charts");
    fireEvent.click(await screen.findByRole("button", { name: "Remove repository bitnami" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove repository bitnami?" });
    expect(calls("helm_repo_remove")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Repositories" })).toBeNull());
    expect(calls("helm_repo_remove")[0]!.args).toEqual({ name: "bitnami" });
  });

  it("shows Helm's own text when a command fails", async () => {
    chartsBackend();
    const stderr = 'Error: looks like "https://example.invalid" is not a valid chart repository or cannot be reached';
    wb.backend.on("helm_repo_add", () => {
      throw { code: "other", message: stderr };
    });
    renderPage("helm-charts");
    await screen.findByText("No chart repositories yet. Add one to search its charts.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "broken" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(stderr);
  });

  it("without helm explains how to install it and disables everything", async () => {
    chartsBackend();
    wb.backend.on("helm_status", () => HELM_MISSING);
    renderPage("helm-charts");
    const hint = await screen.findByRole("note");
    expect(within(hint).getByRole("link")).toHaveAttribute("href", "https://helm.sh/docs/intro/install/");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("URL")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Search charts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(calls("helm_repos")).toHaveLength(0);
  });
});
