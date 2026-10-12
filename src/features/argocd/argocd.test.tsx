import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import "../../resources";
import { findResourceDef, getResourceDef, resetClusterKinds, type ColumnDef } from "../../resources";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import applicationJson from "./fixtures/application.json";
import applicationManualJson from "./fixtures/application-manual.json";
import jobJson from "./fixtures/job.json";
import jobPodJson from "./fixtures/job-pod.json";
import argocdServerJson from "./fixtures/argocd-server.json";
import podJson from "./fixtures/pod.json";
import replicaSetJson from "./fixtures/replicaset.json";
import applicationRunningJson from "./fixtures/application-running.json";
import applicationSetJson from "./fixtures/applicationset.json";
import appProjectJson from "./fixtures/appproject.json";
import appProjectDefaultJson from "./fixtures/appproject-default.json";
import { argocdNamespace } from "./index";

// Objects as `kubectl get -o json` returned them on the kind cluster of `scripts/test-cluster.sh up --gitops`.
const application = applicationJson as KubeObject;
const applicationRunning = applicationRunningJson as KubeObject;
const applicationManual = applicationManualJson as KubeObject;
const replicaSet = replicaSetJson as KubeObject;
const pod = podJson as KubeObject;
const job = jobJson as KubeObject;
const jobPod = jobPodJson as KubeObject;
const argocdServer = argocdServerJson as KubeObject;
const applicationSet = applicationSetJson as KubeObject;
const appProject = appProjectJson as KubeObject;
const appProjectDefault = appProjectDefaultJson as KubeObject;

const APPLICATION: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "Application" };
const APPLICATION_SET: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "ApplicationSet" };
const APP_PROJECT: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "AppProject" };

/** What a table cell of `column` shows for `obj`. */
function cell(kind: KindRef, column: string, obj: KubeObject): string {
  const col = getResourceDef(kind).columns.find((c: ColumnDef) => c.id === column);
  if (!col) throw new Error(`no column ${column}`);
  const content = col.render ? col.render(obj, { clusterId: "c1", kind, now: Date.now() }) : String(col.value(obj) ?? "");
  const { container, unmount } = render(<>{content}</>);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

function headers(kind: KindRef): string[] {
  return getResourceDef(kind).columns.map((c) => (c.titleKey ? i18n.t(c.titleKey) : (c.title ?? c.id)));
}

describe("Argo CD kinds", () => {
  it("are listed in the Argo CD section of the sidebar", () => {
    const entries = [APPLICATION, APPLICATION_SET, APP_PROJECT].map((k) => findResourceDef(k)?.sidebar);
    expect(entries.map((e) => e?.section)).toEqual(["argocd", "argocd", "argocd"]);
    expect(entries.map((e) => i18n.t(e!.labelKey))).toEqual(["Applications", "ApplicationSets", "AppProjects"]);
  });

  it("Applications show Project, Sync, Health, Revision, Destination and Age", () => {
    expect(headers(APPLICATION)).toEqual([
      "Name",
      "Namespace",
      "Project",
      "Sync",
      "Health",
      "Revision",
      "Destination",
      "Age",
    ]);
    expect(cell(APPLICATION, "project", application)).toBe("default");
    expect(cell(APPLICATION, "sync", application)).toBe("Synced");
    expect(cell(APPLICATION, "health", application)).toBe("Healthy");
    expect(cell(APPLICATION, "revision", application)).toBe("8088f4c");
    expect(cell(APPLICATION, "destination", application)).toBe("in-cluster/sextant-argo");
  });

  it("an Application with a sync under way says so next to its sync status", () => {
    expect(cell(APPLICATION, "sync", applicationRunning)).toBe("SyncedSyncing");
    expect(cell(APPLICATION, "sync", application)).not.toContain("Syncing");
  });

  it("ApplicationSets show how many Applications they generated", () => {
    expect(headers(APPLICATION_SET)).toEqual(["Name", "Namespace", "Applications", "Age"]);
    expect(cell(APPLICATION_SET, "applications", applicationSet)).toBe("2");
  });

  it("AppProjects show their destinations and source repositories", () => {
    expect(headers(APP_PROJECT)).toEqual(["Name", "Namespace", "Destinations", "Sources", "Age"]);
    expect(cell(APP_PROJECT, "destinations", appProject)).toBe("in-cluster/sextant-team-*, in-cluster/sextant-shared");
    expect(cell(APP_PROJECT, "sources", appProject)).toBe(
      "https://github.com/argoproj/argocd-example-apps, https://github.com/stefanprodan/podinfo",
    );
    expect(cell(APP_PROJECT, "destinations", appProjectDefault)).toBe("*/*");
    expect(cell(APP_PROJECT, "sources", appProjectDefault)).toBe("*");
  });
});

// ---------- Details ----------

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  wb = watchBackend();
});

afterEach(() => wb.backend.restore());

const refOf = (obj: KubeObject): ObjectRef => ({
  kind: APPLICATION,
  namespace: obj.metadata?.namespace ?? null,
  name: obj.metadata?.name ?? "",
});

/** Opens the details of an Application and delivers it through the panel's own watch. */
async function openApplication(obj: KubeObject): Promise<void> {
  const ref = refOf(obj);
  useAppStore.getState().openDetails(ref);
  render(
    <>
      <DetailsPanel clusterId="c1" objectRef={ref} />
      <ActionDialogHost />
    </>,
  );
  const id = await watchOf(wb, "Application", (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

/** Rows of the resource tree as "level kind name …cells". */
function treeRows(): string[] {
  return within(section("argocdResources"))
    .getAllByRole("row")
    .slice(1)
    .map((r) => [r.getAttribute("aria-level"), ...within(r).getAllByRole("cell").map((c) => c.textContent)].join(" "));
}

describe("details of an Application", () => {
  it("show sync and health, the source, the destination and the sync policy", async () => {
    await openApplication(copy(application));
    const fields = section("fields");
    expect(within(fields).getByRole("button", { name: "Open AppProject default" })).toBeInTheDocument();
    expect(within(fields).getByText("Synced")).toBeInTheDocument();
    expect(within(fields).getByText("Healthy")).toBeInTheDocument();
    expect(within(fields).getByText("8088f4c0d970abb09e250248cc97e35623447cb5")).toBeInTheDocument();
    expect(within(fields).getByText("https://github.com/argoproj/argocd-example-apps")).toBeInTheDocument();
    expect(within(fields).getByText("guestbook")).toBeInTheDocument();
    expect(within(fields).getByText("HEAD")).toBeInTheDocument();
    expect(within(fields).getByText("in-cluster")).toBeInTheDocument();
    expect(within(fields).getByRole("button", { name: "Open Namespace sextant-argo" })).toBeInTheDocument();
    expect(within(fields).getByText("Automated")).toBeInTheDocument();
    expect(within(fields).getByText("prune")).toBeInTheDocument();
    expect(within(fields).queryByText("self-heal")).toBeNull();
    expect(within(fields).getByText("CreateNamespace=true")).toBeInTheDocument();
    expect(within(fields).getByText("successfully synced (all tasks run)")).toBeInTheDocument();
  });

  it("the resource tree lists the managed resources and their descendants by owner, as links", async () => {
    await openApplication(copy(application));
    const rsWatch = await watchOf(wb, "ReplicaSet");
    const podWatch = await watchOf(wb, "Pod");
    expect(wb.specs.get(rsWatch)?.namespaces).toEqual(["sextant-argo"]);
    expect(wb.specs.get(podWatch)?.namespaces).toEqual(["sextant-argo"]);
    emitSnapshot(wb, rsWatch, [copy(replicaSet)]);
    emitSnapshot(wb, podWatch, [copy(pod)]);

    expect(treeRows()).toEqual([
      "1 Service guestbook-ui sextant-argo Synced ",
      "1 Deployment guestbook-ui sextant-argo Synced ",
      "2 ReplicaSet guestbook-ui-6d476cf4df sextant-argo  1/1",
      "3 Pod guestbook-ui-6d476cf4df-sfw78 sextant-argo  Running",
    ]);
    fireEvent.click(within(section("argocdResources")).getByRole("button", { name: "Open Pod guestbook-ui-6d476cf4df-sfw78" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespace: "sextant-argo",
      name: "guestbook-ui-6d476cf4df-sfw78",
    });
  });

  it("the resource tree says it is loading until the lists of descendants come", async () => {
    await openApplication(copy(application));
    const tree = within(section("argocdResources"));
    expect(tree.getByRole("status")).toHaveTextContent("Loading");
    emitSnapshot(wb, await watchOf(wb, "ReplicaSet"), [copy(replicaSet)]);
    expect(tree.getByRole("status")).toBeInTheDocument();

    emitSnapshot(wb, await watchOf(wb, "Pod"), [copy(pod)]);

    expect(tree.queryByRole("status")).toBeNull();
  });

  it("a Job of the app shows its Pods", async () => {
    const app = copy(applicationManual);
    (app.status as { resources: unknown[] }).resources.push({
      group: "batch",
      version: "v1",
      kind: "Job",
      namespace: "sextant-exp-dest",
      name: "migrate",
      status: "Synced",
      health: { status: "Healthy" },
    });
    await openApplication(app);
    const podWatch = await watchOf(wb, "Pod");
    emitSnapshot(wb, podWatch, [copy(jobPod)]);
    emitSnapshot(wb, await watchOf(wb, "ReplicaSet"), []);

    const rows = treeRows();
    expect(rows).toContain("1 Job migrate sextant-exp-dest Synced Healthy");
    expect(rows[rows.indexOf("1 Job migrate sextant-exp-dest Synced Healthy") + 1]).toBe(
      `2 Pod ${jobPod.metadata!.name} sextant-exp-dest  Completed`,
    );
    expect(job.metadata?.name).toBe("migrate");
  });

  it("resources of another cluster are listed without links or descendants", async () => {
    const app = copy(application);
    (app.spec as { destination: unknown }).destination = { server: "https://prod.example:6443", namespace: "shop" };
    await openApplication(app);
    const tree = section("argocdResources");
    expect(within(tree).getByText("Deployment")).toBeInTheDocument();
    expect(within(tree).queryAllByRole("button")).toHaveLength(0);
    expect(within(tree).getByText(/another cluster/)).toBeInTheDocument();
    expect([...wb.specs.values()].map((s) => s.kind.kind)).not.toContain("Pod");
  });

  it("the sync history shows revision, time and who started each sync, newest first", async () => {
    await openApplication(copy(applicationManual));
    const history = section("argocdHistory");
    const [, row] = within(history).getAllByRole("row");
    expect(within(row!).getByText("8088f4c")).toBeInTheDocument();
    expect(within(row!).getByText("2026-10-12T17:08:00Z")).toBeInTheDocument();
    expect(within(row!).getByText("sextant")).toBeInTheDocument();
    cleanupPanel();

    await openApplication(copy(application));
    expect(within(section("argocdHistory")).getByText("Automated")).toBeInTheDocument();
  });

  it("the sync history is newest first", async () => {
    const app = copy(applicationManual);
    const history = (app.status as { history: Record<string, unknown>[] }).history;
    history.push({ ...history[0], id: 1, revision: "0123456789abcdef0123456789abcdef01234567", deployedAt: "2026-10-12T17:20:00Z" });
    await openApplication(app);
    const rows = within(section("argocdHistory")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]!.textContent)).toEqual(["0123456", "8088f4c"]);
  });
});

function cleanupPanel(): void {
  document.body.innerHTML = "";
}

// ---------- Actions ----------

/** Labels of the action buttons at the top of the details panel. */
function actionButtons(): string[] {
  return within(screen.getByRole("toolbar")).getAllByRole("button").map((b) => b.textContent ?? "");
}

/** The `resource_patch` calls so far. */
function patches(): Record<string, unknown>[] {
  return wb.backend.calls.filter((c) => c.cmd === "resource_patch").map((c) => c.args);
}

describe("Argo CD actions", () => {
  beforeEach(() => {
    wb.backend.on("resource_patch", (args) => ({ ...application, metadata: { ...application.metadata, patched: args } }));
  });

  it("an idle Application offers Sync, Refresh, Hard refresh and the web UI; a syncing one Terminate instead of Sync", async () => {
    await openApplication(copy(application));
    expect(actionButtons().map((b) => b.replace(/^\W+/, ""))).toEqual([
      "Sync…",
      "Refresh",
      "Hard refresh",
      "Open Argo CD UI",
      "Edit",
      "Delete",
    ]);
    cleanupPanel();
    await openApplication(copy(applicationRunning));
    const running = actionButtons().map((b) => b.replace(/^\W+/, ""));
    expect(running).toContain("Terminate…");
    expect(running).not.toContain("Sync…");
  });

  it("Sync asks for revision, prune and dry run, then patches the operation with the app's sync options", async () => {
    await openApplication(copy(application));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Sync/ }));
    const dialog = await screen.findByRole("dialog");
    const revision = within(dialog).getByLabelText("Revision");
    expect(revision).toHaveValue("HEAD");
    expect(within(dialog).getByLabelText("Prune")).not.toBeChecked();
    expect(within(dialog).getByLabelText("Dry run")).not.toBeChecked();
    fireEvent.change(revision, { target: { value: "main" } });
    fireEvent.click(within(dialog).getByLabelText("Prune"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({
      clusterId: "c1",
      ref: refOf(application),
      patchType: "merge",
      patch: {
        operation: {
          initiatedBy: { username: "sextant" },
          sync: { revision: "main", prune: true, dryRun: false, syncOptions: ["CreateNamespace=true"] },
        },
      },
    });
    expect(await within(dialog).findByText(/Sync of guestbook started/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a dry run is a sync with dryRun set", async () => {
    await openApplication(copy(application));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Sync/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Dry run"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    const sync = (patches()[0]!.patch as { operation: { sync: Record<string, unknown> } }).operation.sync;
    expect(sync).toMatchObject({ revision: "HEAD", prune: false, dryRun: true });
    await within(dialog).findByText(/Dry run of guestbook started/);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Refresh and Hard refresh set the refresh annotation", async () => {
    await openApplication(copy(application));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^\W*Refresh$/ }));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Hard refresh/ }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches().map((p) => [p.patchType, p.patch])).toEqual([
      ["merge", { metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } } }],
      ["merge", { metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } }],
    ]);
  });

  it("Terminate asks first, then sets the operation phase to Terminating", async () => {
    await openApplication(copy(applicationRunning));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Terminate/ }));
    const dialog = await screen.findByRole("dialog");
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({
      ref: refOf(applicationRunning),
      patchType: "merge",
      patch: { status: { operationState: { phase: "Terminating" } } },
    });
  });
});

/** What `argocd_status` answers for an Argo CD installed in `namespace` (not signed in). */
const argoStatus = (namespace: string) => ({
  namespace,
  signedIn: false,
  source: null,
  user: null,
  localUsers: true,
  sso: false,
  expired: false,
});

describe("Open Argo CD UI", () => {
  const forward = (localPort: number, extra: Record<string, unknown> = {}) => ({
    id: "pf-1",
    cluster: "c1",
    target: { type: "service", namespace: "argocd", name: "argocd-server" },
    remotePort: 443,
    localPort,
    status: { state: "active" },
    ...extra,
  });
  let started: Record<string, unknown>[];
  let insecure: string | null;
  let installedIn: string;

  beforeEach(() => {
    started = [];
    insecure = null;
    installedIn = "argocd";
    wb.backend.on("argocd_status", () => argoStatus(installedIn));
    wb.backend.on("portforward_list", () => []);
    wb.backend.on("portforward_start", (args) => {
      started.push(args);
      return forward(54321);
    });
    wb.backend.on("resource_get", (args) => {
      const ref = args.ref as ObjectRef;
      if (ref.kind.kind === "ConfigMap" && ref.name === "argocd-cmd-params-cm" && insecure !== null) {
        return { apiVersion: "v1", kind: "ConfigMap", metadata: ref, data: { "server.insecure": insecure } };
      }
      throw { code: "notFound", message: `${ref.name} not found` };
    });
  });

  async function openUi(services: KubeObject[] = [copy(argocdServer)]): Promise<void> {
    await openApplication(copy(application));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Open Argo CD UI/ }));
    const id = await watchOf(wb, "Service", (s) => s.labelSelector === "app.kubernetes.io/name=argocd-server");
    expect(wb.specs.get(id)?.namespaces).toEqual([installedIn]);
    emitSnapshot(wb, id, services);
  }

  it("opens the server of the namespace Argo CD is installed in, not a labelled Service elsewhere", async () => {
    installedIn = "gitops";
    const inGitops = (name: string, namespace: string) => {
      const svc = copy(argocdServer);
      svc.metadata = { ...svc.metadata, name, namespace };
      return svc;
    };
    await openUi([inGitops("evil", "aaa"), inGitops("argocd-server", "gitops")]);
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.target).toEqual({ type: "service", namespace: "gitops", name: "argocd-server" });
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Service" && s.namespaces === null)).toBe(false);
  });

  it("does not open any server when several namespaces look like Argo CD, and says why", async () => {
    wb.backend.on("argocd_status", () => {
      throw {
        code: "notFound",
        message: "ambiguous Argo CD installation: several namespaces look like it (aaa, gitops), and nothing tells the real one",
      };
    });
    await openApplication(copy(application));
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Open Argo CD UI/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Several namespaces of this cluster look like an Argo CD installation");
    expect(alert).toHaveTextContent("aaa, gitops");
    expect(started).toHaveLength(0);
    expect(wb.backend.openedUrls).toEqual([]);
  });

  it("forwards a local port to argocd-server and opens the app over https", async () => {
    await openUi();
    await waitFor(() => expect(wb.backend.openedUrls).toEqual(["https://localhost:54321/applications/argocd/guestbook"]));
    expect(started).toEqual([
      { clusterId: "c1", target: { type: "service", namespace: "argocd", name: "argocd-server" }, remotePort: 443, localPort: null },
    ]);
  });

  it("uses http for a server without TLS (server.insecure)", async () => {
    insecure = "true";
    await openUi();
    await waitFor(() => expect(wb.backend.openedUrls).toEqual(["http://localhost:54321/applications/argocd/guestbook"]));
  });

  it("reuses a running forward to argocd-server", async () => {
    wb.backend.on("portforward_list", () => [forward(40000, { id: "pf-7" })]);
    await openUi();
    await waitFor(() => expect(wb.backend.openedUrls).toEqual(["https://localhost:40000/applications/argocd/guestbook"]));
    expect(started).toHaveLength(0);
  });
});

describe("argocdNamespace", () => {
  it("is the namespace the backend found Argo CD installed in, without listing Services everywhere", async () => {
    wb.backend.on("argocd_status", () => argoStatus("gitops"));
    expect(await argocdNamespace("c1")).toBe("gitops");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Service")).toBe(false);
  });

  it("is argocd when the backend cannot find Argo CD", async () => {
    wb.backend.on("argocd_status", () => {
      throw { code: "notFound", message: "Argo CD server not found" };
    });
    expect(await argocdNamespace("c1")).toBe("argocd");
  });
});

describe("the Argo CD section of the sidebar", () => {
  const served = (group: string, version: string, kind: string): ResourceKind => ({
    kindRef: { group, version, kind },
    plural: `${kind.toLowerCase()}s`,
    namespaced: true,
    verbs: ["list", "watch"],
    printerColumns: [],
  });
  const sectionTitles = () =>
    screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-expanded"))
      .map((b) => b.textContent?.replace(/[▸▾]/g, ""));

  beforeEach(() => resetClusterKinds());
  afterEach(() => resetClusterKinds());

  it("lists the Argo CD kinds the cluster serves", async () => {
    wb.backend.on("cluster_kinds", () => [
      served("", "v1", "Pod"),
      served("argoproj.io", "v1alpha1", "Application"),
      served("argoproj.io", "v1alpha1", "AppProject"),
    ]);
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionTitles()).toContain("Argo CD"));
    fireEvent.click(screen.getByRole("button", { name: /Argo CD/ }));
    const argo = screen.getByRole("button", { name: /Argo CD/ }).closest("li")!;
    expect(within(argo).getByRole("button", { name: "Applications" })).toBeInTheDocument();
    expect(within(argo).getByRole("button", { name: "AppProjects" })).toBeInTheDocument();
    expect(within(argo).queryByRole("button", { name: "ApplicationSets" })).toBeNull();
  });

  it("is not drawn on a cluster without Argo CD", async () => {
    wb.backend.on("cluster_kinds", () => [served("", "v1", "Pod"), served("demo.sextant.dev", "v1", "Widget")]);
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionTitles()).toContain("Custom Resources"));
    expect(sectionTitles()).not.toContain("Argo CD");
  });
});
