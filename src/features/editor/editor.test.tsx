import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "codemirror";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ObjectRef } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { Dock } from "../../layout/dock/Dock";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { openEditTab } from "./index";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const ref: ObjectRef = { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespace: "demo", name: "app-config" };

function configMap(resourceVersion: string, mode: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "app-config", namespace: "demo", resourceVersion, labels: { app: "web" } },
    data: { mode, enabled: "true" },
  };
}

let backend: MockBackend;
let current: KubeObject;

beforeEach(() => {
  resetAppStore();
  current = configMap("1", "a");
  backend = mockBackend({ resource_get: () => structuredClone(current) });
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

const editorText = () => editorView().state.doc.toString();

function typeText(text: string) {
  const view = editorView();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

async function openEditor() {
  render(<Shell />);
  act(() => {
    openEditTab("c1", ref);
  });
  await waitFor(() => expect(editorText()).toContain("mode: a"));
}

describe("Edit tab", () => {
  it("shows the object as YAML and saves the edited text with PUT", async () => {
    await openEditor();
    expect(screen.getByRole("tab", { name: /ConfigMap app-config/ })).toBeInTheDocument();
    expect(editorText()).toContain("resourceVersion: \"1\"");
    expect(editorText()).toContain('enabled: "true"');
    expect(backend.calls.find((c) => c.cmd === "resource_get")?.args).toEqual({ clusterId: "c1", ref });

    let sent = "";
    backend.on("resource_replace", (args) => {
      sent = args.yaml as string;
      return { ...configMap("2", "b"), metadata: { ...configMap("2", "b").metadata, labels: { app: "web", edited: "yes" } } };
    });
    typeText(editorText().replace("mode: a", "mode: b").replace("app: web", "app: web\n    edited: \"yes\""));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(sent).toContain("mode: b");
    expect(sent).toContain('edited: "yes"');
    expect(backend.calls.find((c) => c.cmd === "resource_replace")?.args.clusterId).toBe("c1");
    // The editor now holds what the server stored (new resourceVersion), ready for the next save.
    expect(editorText()).toContain('resourceVersion: "2"');
  });

  it("shows a YAML or validation error above the editor and keeps the text", async () => {
    await openEditor();
    backend.on("resource_replace", () => {
      throw { code: "invalid", message: "mapping values are not allowed in this context at line 3 column 9" };
    });
    const broken = "apiVersion: v1\nkind: ConfigMap\nmetadata: name: x\n";
    typeText(broken);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request is not valid.");
    expect(alert).toHaveTextContent("line 3 column 9");
    expect(editorText()).toBe(broken);
    // The error sits above the editor.
    const editor = document.querySelector(".cm-editor")!;
    expect(alert.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("explains a missing permission (403)", async () => {
    await openEditor();
    backend.on("resource_replace", () => {
      throw { code: "forbidden", message: 'configmaps "app-config" is forbidden: User "limited" cannot update' };
    });
    typeText(editorText().replace("mode: a", "mode: b"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have permission to do this (403).");
    expect(editorText()).toContain("mode: b");
  });

  it("reports a conflict, never overwrites, and reloads only after confirming that edits are dropped", async () => {
    await openEditor();
    backend.on("resource_replace", () => {
      throw { code: "conflict", message: "the object has been modified; please apply your changes to the latest version" };
    });
    typeText(editorText().replace("mode: a", "mode: mine"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ConfigMap app-config was changed in the cluster after you opened it");
    expect(editorText()).toContain("mode: mine");
    expect(backend.calls.filter((c) => c.cmd === "resource_replace")).toHaveLength(1);

    // Someone else's version is in the cluster now.
    current = configMap("7", "theirs");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard your changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editorText()).toContain("mode: mine");

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Reload" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Discard your changes?" })).getByRole("button", {
        name: "Discard and reload",
      }),
    );
    await waitFor(() => expect(editorText()).toContain("mode: theirs"));
    expect(editorText()).toContain('resourceVersion: "7"');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opening the same object again reuses its tab", async () => {
    await openEditor();
    act(() => {
      openEditTab("c1", ref);
    });
    expect(useAppStore.getState().dock.tabs).toHaveLength(1);
  });
});

describe("Edit tab of a Secret", () => {
  const secretRef: ObjectRef = { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "demo", name: "creds" };
  const MARKER = "sextant.dev/values-hidden";

  /** The Secret as `resource_get_full` returns it: values included. */
  function fullSecret(resourceVersion: string): KubeObject {
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "creds", namespace: "demo", resourceVersion },
      type: "Opaque",
      data: { token: "bWFkZS11cC10b2tlbg==" },
    };
  }

  /** The Secret as the watch, `resource_get` and `resource_replace` return it: keys only, marker set. */
  function hiddenSecret(resourceVersion: string): KubeObject {
    const obj = fullSecret(resourceVersion);
    return { ...obj, metadata: { ...obj.metadata, annotations: { [MARKER]: "true" } }, data: { token: "" } };
  }

  let full: KubeObject;

  beforeEach(() => {
    full = fullSecret("1");
    backend.on("resource_get", () => hiddenSecret("1"));
    backend.on("resource_get_full", () => structuredClone(full));
  });

  async function openSecretEditor() {
    render(<Shell />);
    act(() => {
      openEditTab("c1", secretRef);
    });
    await waitFor(() => expect(editorText()).toContain("token: bWFkZS11cC10b2tlbg=="));
  }

  it("loads the whole object with resource_get_full", async () => {
    await openSecretEditor();
    expect(backend.calls.find((c) => c.cmd === "resource_get_full")?.args).toEqual({ clusterId: "c1", ref: secretRef });
    expect(backend.calls.some((c) => c.cmd === "resource_get")).toBe(false);
    expect(editorText()).not.toContain(MARKER);
  });

  it("refuses to save text whose values were hidden and asks to reload", async () => {
    await openSecretEditor();
    backend.on("resource_replace", () => hiddenSecret("2"));
    typeText(editorText().replace("  namespace: demo", `  namespace: demo\n  annotations:\n    ${MARKER}: "true"`));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/reload/i);
    expect(backend.calls.some((c) => c.cmd === "resource_replace")).toBe(false);
    expect(editorText()).toContain(MARKER);
  });

  it("after saving shows the stored Secret with its values again, ready for the next save", async () => {
    await openSecretEditor();
    backend.on("resource_replace", () => {
      full = fullSecret("2");
      return hiddenSecret("2");
    });
    typeText(editorText().replace("type: Opaque", "type: Opaque\n"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(editorText()).toContain('resourceVersion: "2"');
    expect(editorText()).toContain("token: bWFkZS11cC10b2tlbg==");
    expect(editorText()).not.toContain(MARKER);
  });
});

describe("Create resource tab", () => {
  it("opens from the dock's + button and applies several documents", async () => {
    useAppStore.setState({ activeClusterId: "c1" });
    let sent = "";
    backend.on("resource_apply", (args) => {
      sent = args.yaml as string;
      return [
        { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespace: "demo", name: "settings" },
        { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "demo", name: "web" },
      ];
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Create resource" }));
    expect(await screen.findByRole("tab", { name: "Create resource" })).toBeInTheDocument();

    const text = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: settings, namespace: demo }\n---\napiVersion: apps/v1\nkind: Deployment\n";
    typeText(text);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Applied 2 objects:");
    expect(result).toHaveTextContent("ConfigMap demo/settings");
    expect(result).toHaveTextContent("Deployment demo/web");
    expect(sent).toBe(text);
    expect(backend.calls.find((c) => c.cmd === "resource_apply")?.args.clusterId).toBe("c1");
  });

  it("shows the failing document and keeps the text", async () => {
    useAppStore.setState({ activeClusterId: "c1" });
    backend.on("resource_apply", () => {
      throw { code: "invalid", message: "document 2 (Deployment web): spec.selector: Required value" };
    });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Create resource" }));
    await screen.findByRole("tab", { name: "Create resource" });
    typeText("apiVersion: v1\nkind: ConfigMap\n");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("document 2 (Deployment web)");
    expect(editorText()).toBe("apiVersion: v1\nkind: ConfigMap\n");
  });

  it("refuses text copied from a Secret whose values were hidden", async () => {
    useAppStore.setState({ activeClusterId: "c1" });
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Create resource" }));
    await screen.findByRole("tab", { name: "Create resource" });
    typeText('apiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\n  annotations:\n    sextant.dev/values-hidden: "true"\ndata:\n  token: ""\n');
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/reload/i);
    expect(backend.calls.some((c) => c.cmd === "resource_apply")).toBe(false);
  });

  it("is offered only with an active cluster", () => {
    render(<Shell />);
    expect(screen.queryByRole("button", { name: "Create resource" })).not.toBeInTheDocument();
  });
});
