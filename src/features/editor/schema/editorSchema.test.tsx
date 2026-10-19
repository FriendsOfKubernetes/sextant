import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { runScopeHandlers } from "@codemirror/view";
import { act, render, waitFor } from "@testing-library/react";
import { EditorView } from "codemirror";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../../api";
import { YamlEditor } from "../YamlEditor";
import { resetClusterKinds } from "../../../resources/useKinds";
import { deploymentSchema } from "./fixtures";
import { resetSchemaSources } from "./source";

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

let backend: MockBackend;
let asked: unknown[];

beforeEach(() => {
  asked = [];
  backend = mockBackend({
    cluster_kinds: () => [
      { kindRef: { group: "apps", version: "v1", kind: "Deployment" }, plural: "deployments", namespaced: true, verbs: [], printerColumns: [] },
    ],
    openapi_kind_schema: (args) => {
      asked.push(args);
      const { group, kind } = args as { group: string; kind: string };
      return group === "apps" && kind === "Deployment" ? deploymentSchema : null;
    },
  });
});
afterEach(() => {
  backend.restore();
  resetSchemaSources();
  resetClusterKinds();
});

function view(container: HTMLElement): EditorView {
  const content = container.querySelector(".cm-content");
  const found = content && EditorView.findFromDOM(content as HTMLElement);
  if (!found) throw new Error("no editor");
  return found;
}

const TEXT = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replica: 2\n  strategy:\n    type: Sometimes\n";

function diagnostics(v: EditorView): string[] {
  const out: string[] = [];
  forEachDiagnostic(v.state, (d) => out.push(`${d.severity}: ${d.message}`));
  return out;
}

describe("YamlEditor with the cluster's schema", () => {
  it("underlines problems of the document's kind, in the interface's language", async () => {
    const { container } = render(<YamlEditor value={TEXT} onChange={() => undefined} label="Editor" schemaCluster="c1" />);
    const v = view(container);
    await waitFor(() => expect(diagnostics(v).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(diagnostics(v)).toEqual([
      "error: Missing required field: selector",
      "error: Missing required field: template",
      "warning: Unknown field: replica",
      "error: Value not allowed: Sometimes. Allowed values: Recreate, RollingUpdate",
    ]);
    expect(asked).toEqual([{ clusterId: "c1", group: "apps", version: "v1", kind: "Deployment" }]);
  });

  it("completes fields at the cursor and explains the field under it (F1)", async () => {
    const { container } = render(<YamlEditor value={"apiVersion: apps/v1\nkind: Deployment\nspec:\n  re"} onChange={() => undefined} label="Editor" schemaCluster="c1" />);
    const v = view(container);
    act(() => {
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      startCompletion(v);
    });
    await waitFor(() => expect(currentCompletions(v.state).map((c) => c.label)).toContain("replicas"), { timeout: 3000 });
    const replicas = currentCompletions(v.state).find((c) => c.label === "replicas");
    expect(replicas?.detail).toBe("integer (int32)");
    act(() => {
      v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("spec") + 1 } });
      runScopeHandlers(v, new KeyboardEvent("keydown", { key: "F1" }), "editor");
    });
    await waitFor(() => expect(container.querySelector(".schema-explain")).not.toBeNull());
    const panel = container.querySelector(".schema-explain");
    expect(panel?.querySelector(".schema-doc__path")?.textContent).toBe("spec");
    expect(panel?.querySelector(".schema-doc__type")?.textContent).toBe("DeploymentSpec");
    const names = [...(panel?.querySelectorAll(".schema-explain__name") ?? [])].map((b) => b.textContent);
    expect(names).toEqual(["selector", "template", "paused", "replicas", "strategy"]);
  });

  it("knows nothing about the text without a cluster (Helm values)", async () => {
    const { container } = render(<YamlEditor value={TEXT} onChange={() => undefined} label="Values" />);
    const v = view(container);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(diagnostics(v)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
