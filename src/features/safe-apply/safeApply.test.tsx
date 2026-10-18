import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "codemirror";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type ClusterInfo,
  type DryRunObject,
  type DryRunResult,
  type HelmManifestDiff,
  type HelmRelease,
  type KubeObject,
  type MockBackend,
  type ObjectRef,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { openCreateTab, openEditTab } from "../editor";
import { UpgradeDialog } from "../helm/dialogs";
import { previewByDefault } from "./policy";
import "./index";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const ref: ObjectRef = { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespace: "demo", name: "app-config" };

const live: KubeObject = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "app-config", namespace: "demo", resourceVersion: "1" },
  data: { mode: "a" },
};

function dryRun(mode: string): DryRunResult {
  return {
    objects: [
      {
        object: ref,
        label: "",
        before: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app-config", namespace: "demo" }, data: { mode: "a" } },
        after: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "app-config", namespace: "demo", labels: { defaulted: "by-webhook" } },
          data: { mode },
        },
        change: "update",
      },
    ],
  };
}

let backend: MockBackend;

/** Replaces the backend of `beforeEach` with one whose cluster `c1` has `previewChanges`. */
function start(previewChanges: boolean | null = null) {
  backend.restore();
  backend = mockBackend(
    { resource_get: () => structuredClone(live) },
    { settings: { clusters: { c1: { ...defaultClusterSettings(), previewChanges } } } },
  );
}

beforeEach(() => {
  resetAppStore();
  useClustersStore.setState({ clusters: [] });
  backend = mockBackend();
});
afterEach(() => backend.restore());

function Shell() {
  return (
    <>
      <Dock />
      <ActionDialogHost />
    </>
  );
}

function editorView(): EditorView {
  const content = document.querySelector(".cm-content");
  if (!content) throw new Error("no editor on the page");
  const view = EditorView.findFromDOM(content as HTMLElement);
  if (!view) throw new Error("no EditorView");
  return view;
}

function typeText(text: string) {
  const view = editorView();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

async function openEditor() {
  render(<Shell />);
  act(() => {
    openEditTab("c1", ref);
  });
  await waitFor(() => expect(editorView().state.doc.toString()).toContain("mode: a"));
}

describe("the production rule", () => {
  it("matches prod or production as a word of its own", () => {
    for (const name of ["prod", "rees46-prod", "eks_production", "prod1", "gke_acme_europe-west1_prod-eu", "PROD"]) {
      expect(previewByDefault([name]), name).toBe(true);
    }
    for (const name of ["products", "preprod", "kind-sextant-test", "reproduce", ""]) {
      expect(previewByDefault([name]), name).toBe(false);
    }
    expect(previewByDefault([null, undefined, "staging", "prod-eu"])).toBe(true);
  });
});

describe("the editor's preview", () => {
  it("shows the server's dry run on demand, sends nothing else, and saves exactly the previewed text", async () => {
    start();
    backend.on("resource_dry_run", (args) => dryRun(String(args.yaml).includes("mode: b") ? "b" : "a"));
    let saved = "";
    backend.on("resource_replace", (args) => {
      saved = String(args.yaml);
      return { ...live, data: { mode: "b" } };
    });
    await openEditor();
    typeText(editorView().state.doc.toString().replace("mode: a", "mode: b"));

    // Off for this cluster: Save saves at once, and the preview is one button away.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const region = await screen.findByRole("region", { name: "Change preview" });
    expect(calls("resource_dry_run")[0]!.args).toMatchObject({ clusterId: "c1", mode: "replace" });
    expect(calls("resource_replace")).toHaveLength(0);
    expect(screen.getByText("Nothing has been changed yet.")).toBeInTheDocument();
    expect(within(region).getByLabelText("After the change").textContent).toContain("by-webhook");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("resource_replace")).toHaveLength(1));
    expect(saved).toContain("mode: b");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Change preview" })).not.toBeInTheDocument());
    expect(screen.getByText("Saved.")).toBeInTheDocument();
  });

  it("on a cluster that asks for it, Save previews first; a refusal is shown and nothing is saved", async () => {
    start(true);
    let refuse = true;
    backend.on("resource_dry_run", () => {
      if (refuse) throw { code: "forbidden", message: 'admission webhook "policy.example.com" denied the request' };
      return dryRun("b");
    });
    backend.on("resource_replace", () => live);
    await openEditor();
    typeText(editorView().state.doc.toString().replace("mode: a", "mode: b"));

    expect(screen.queryByRole("button", { name: "Preview changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview and save…" }));
    expect(await screen.findByText(/denied the request/)).toBeInTheDocument();
    expect(calls("resource_replace")).toHaveLength(0);
    expect(editorView().state.doc.toString()).toContain("mode: b");

    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Preview and save…" }));
    await screen.findByRole("region", { name: "Change preview" });
    expect(calls("resource_replace")).toHaveLength(0);
    // Back to editing keeps the text; the preview is gone.
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    expect(screen.queryByRole("region", { name: "Change preview" })).not.toBeInTheDocument();
    expect(editorView().state.doc.toString()).toContain("mode: b");
    expect(calls("resource_replace")).toHaveLength(0);
  });

  it("follows the cluster's name until the user chooses", async () => {
    start();
    const prod: ClusterInfo = {
      id: "c1",
      context: "rees46-prod",
      clusterName: "rees46",
      server: "https://example",
      user: "u",
      namespace: null,
      sourceId: "s",
    };
    useClustersStore.setState({ clusters: [prod] });
    await openEditor();
    expect(screen.getByRole("button", { name: "Preview and save…" })).toBeInTheDocument();
  });
});

describe("Apply YAML's preview", () => {
  const namespace: DryRunObject = {
    object: { kind: { group: "", version: "v1", kind: "Namespace" }, namespace: null, name: "demo" },
    label: "document 1",
    before: null,
    after: { apiVersion: "v1", kind: "Namespace", metadata: { name: "demo" } },
    change: "create",
  };
  const refused = (code: "invalid" | "notFound", message: string): DryRunObject => ({
    object: { ...ref, name: "bad" },
    label: "document 2",
    before: null,
    after: null,
    change: "failed",
    error: { code, message },
  });

  async function openPreview(result: DryRunResult) {
    backend.on("resource_dry_run", () => result);
    backend.on("resource_apply", () => [ref]);
    render(<Shell />);
    act(() => {
      openCreateTab("c1");
    });
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    typeText("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: app-config, namespace: demo}\n");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    return screen.findByRole("region", { name: "Change preview" });
  }

  it("previews every document and does not apply while one would be refused, even a single one", async () => {
    start();
    const region = await openPreview({ objects: [refused("invalid", "document 2 (ConfigMap bad): data: Invalid value")] });
    expect(calls("resource_dry_run")[0]!.args).toMatchObject({ mode: "apply" });
    expect(within(region).getByText(/^The API server would refuse 1 object\. Fix the text before applying/)).toHaveAttribute(
      "role",
      "alert",
    );
    expect(within(region).getByText(/Invalid value/)).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute("title", "Fix the refused documents before applying.");
    expect(calls("resource_apply")).toHaveLength(0);
  });

  it("applies the previewed text when a document only waits for a namespace an earlier one creates", async () => {
    start();
    const region = await openPreview({
      objects: [namespace, refused("notFound", 'document 2 (ConfigMap bad): namespaces "demo" not found')],
    });
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(region).getByText(
        "ConfigMap demo/bad could not be checked yet: its namespace demo is created by an earlier document. Applying creates the namespace first.",
      ),
    ).toBeInTheDocument();
    const list = within(region).getByRole("list", { name: "Objects" });
    fireEvent.click(within(list).getByRole("button", { name: /ConfigMap demo\/bad/ }));
    expect(await within(region).findByText(/not found/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls("resource_apply")).toHaveLength(1));
    expect(String(calls("resource_apply")[0]!.args.yaml)).toContain("name: app-config");
  });
});

describe("Helm upgrade preview", () => {
  const release: HelmRelease = {
    name: "web",
    namespace: "apps",
    revision: 2,
    chart: "nginx",
    chartVersion: "18.0.0",
    appVersion: "1.27",
    status: "deployed",
    updated: "",
    unreadableRevision: null,
    unreadable: false,
  };
  const diff: HelmManifestDiff = {
    current: "kind: Deployment\nspec:\n  replicas: 1\n",
    proposed: "kind: Deployment\nspec:\n  replicas: 3\n",
    secretChanges: [{ object: "Secret apps/web", keys: { added: [], changed: ["password"], removed: [] } }],
    unreadable: 0,
    clientSide: false,
  };

  it("needs a preview of the current values before upgrading when the cluster asks for it", async () => {
    start(true);
    backend.on("helm_search", () => []);
    backend.on("helm_upgrade_preview", () => diff);
    backend.on("helm_upgrade", () => null);
    render(<UpgradeDialog clusterId="c1" release={release} values={"replicaCount: 1\n"} close={() => {}} onDone={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(calls("helm_search")).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Upgrade" })).toBeDisabled();
    expect(within(dialog).getByText("This cluster asks for a preview before applying.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    const region = await within(dialog).findByRole("region", { name: "Change preview" });
    expect(calls("helm_upgrade_preview")[0]!.args).toMatchObject({
      clusterId: "c1",
      namespace: "apps",
      release: "web",
      chartRef: "",
      valuesYaml: "replicaCount: 1\n",
    });
    expect(within(region).getByText("Secret apps/web: values changed: password")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Upgrade" })).toBeEnabled();
    expect(calls("helm_upgrade")).toHaveLength(0);

    expect(typeof calls("helm_upgrade_preview")[0]!.args.previewId).toBe("string");

    // Another chart reference is another render: the preview no longer counts.
    fireEvent.change(within(dialog).getByLabelText("Chart reference"), { target: { value: "bitnami/nginx" } });
    expect(within(dialog).queryByRole("region", { name: "Change preview" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Upgrade" })).toBeDisabled();
  });

  it("stops a render still running when the dialog closes, and says when Helm rendered without the cluster", async () => {
    start();
    backend.on("helm_search", () => []);
    backend.on("helm_preview_stop", () => null);
    let answer: (diff: HelmManifestDiff) => void = () => {};
    backend.on("helm_upgrade_preview", () => new Promise<HelmManifestDiff>((resolve) => (answer = resolve)));
    const view = render(
      <UpgradeDialog clusterId="c1" release={release} values={"replicaCount: 1\n"} close={() => {}} onDone={() => {}} />,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(calls("helm_upgrade_preview")).toHaveLength(1));
    const first = calls("helm_upgrade_preview")[0]!.args.previewId;
    view.unmount();
    await waitFor(() => expect(calls("helm_preview_stop").map((c) => c.args.previewId)).toContain(first));

    render(<UpgradeDialog clusterId="c1" release={release} values={"replicaCount: 1\n"} close={() => {}} onDone={() => {}} />);
    const again = await screen.findByRole("dialog");
    fireEvent.click(within(again).getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(calls("helm_upgrade_preview")).toHaveLength(2));
    act(() => answer({ ...diff, clientSide: true }));
    expect(await within(again).findByText(/older than 3.13/)).toBeInTheDocument();
    expect(within(again).getByText("Helm hooks are not part of the comparison.")).toBeInTheDocument();
  });
});
