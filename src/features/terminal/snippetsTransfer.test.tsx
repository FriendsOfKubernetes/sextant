// Terminal snippets in the export file of views and workspaces (#149, #154): version 2 carries them; a version 1 file
// (without them) still imports; each version is read strictly.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../api";
import { ImportPreview } from "../views/Manager";
import {
  applyImport,
  buildExport,
  countChanges,
  EXPORT_VERSION,
  exportText,
  ImportError,
  parseImport,
  planImport,
} from "../views/transfer";

const SNIPPETS = [
  { id: "logs", name: "Logs", command: "kubectl logs {{pod}}" },
  { id: "top", name: "Top", command: "kubectl top pod -n {{namespace}}" },
];

function withSnippets(snippets = SNIPPETS): AppSettings {
  return { ...defaultAppSettings(), snippets };
}

const exported = (settings = withSnippets()) =>
  JSON.parse(exportText(buildExport(settings, [], [], { includeAgentAccess: false }))) as Record<string, unknown>;

function problems(text: string): string[] {
  try {
    parseImport(text);
  } catch (err) {
    if (err instanceof ImportError) return err.problems;
    throw err;
  }
  return [];
}

describe("snippets in the export file", () => {
  it("are written since version 2", () => {
    const file = exported();
    expect(EXPORT_VERSION).toBe(3);
    expect(file.version).toBe(3);
    expect(file.snippets).toEqual(SNIPPETS);
    expect(parseImport(JSON.stringify(file)).snippets).toEqual(SNIPPETS);
  });

  it("a version 1 file without them still imports, with no snippets", () => {
    const v1: Record<string, unknown> = { ...exported(), version: 1 };
    delete v1.snippets;
    delete v1.customColumns;
    const file = parseImport(JSON.stringify(v1));
    expect(file.snippets).toEqual([]);
    const plan = planImport(file, withSnippets(), [], []);
    expect(plan.snippets).toEqual([]);
    expect(applyImport(withSnippets(), plan, { overwrite: true, agentAccess: false }).snippets).toEqual(SNIPPETS);
  });

  it("each version is strict: snippets in version 1, none in version 2, unknown fields and bad values are errors", () => {
    expect(problems(JSON.stringify({ ...exported(), version: 1 }))).toContain("$.snippets: unknown field");
    const v2 = exported();
    delete v2.snippets;
    expect(problems(JSON.stringify(v2))).toContain("$.snippets: missing");
    const bad = exported();
    bad.snippets = [{ id: "../x", name: "", command: 1, extra: true }];
    expect(problems(JSON.stringify(bad))).toEqual(
      expect.arrayContaining([
        "$.snippets[0].extra: unknown field",
        "$.snippets[0].id: not a valid id",
        "$.snippets[0].name: empty",
        "$.snippets[0].command: not a string",
      ]),
    );
    expect(problems(JSON.stringify({ ...exported(), version: 4 }))).toEqual(["$.version: 4 is not supported"]);
  });

  it("are previewed as added, changed or kept and replace a local one only when overwriting is allowed", () => {
    const local = withSnippets([{ id: "logs", name: "Logs", command: "kubectl logs -f {{pod}}" }]);
    const plan = planImport(parseImport(JSON.stringify(exported())), local, [], []);
    expect(plan.snippets.map((s) => [s.label, s.status])).toEqual([
      ["Logs", "changed"],
      ["Top", "added"],
    ]);
    expect(countChanges(plan, { overwrite: false, agentAccess: false })).toBe(1);
    expect(countChanges(plan, { overwrite: true, agentAccess: false })).toBe(2);
    const kept = applyImport(local, plan, { overwrite: false, agentAccess: false });
    expect(kept.snippets.map((s) => s.command)).toEqual(["kubectl logs -f {{pod}}", "kubectl top pod -n {{namespace}}"]);
    const replaced = applyImport(local, plan, { overwrite: true, agentAccess: false });
    expect(replaced.snippets).toEqual(SNIPPETS);
    const same = planImport(parseImport(JSON.stringify(exported())), withSnippets(), [], []);
    expect(same.snippets.map((s) => s.status)).toEqual(["kept", "kept"]);
  });

  it("are listed in the import preview like the other sections", () => {
    const plan = planImport(parseImport(JSON.stringify(exported())), defaultAppSettings(), [], []);
    const onApply = vi.fn();
    render(<ImportPreview plan={plan} onApply={onApply} onCancel={() => undefined} />);
    const section = screen.getByRole("region", { name: "Snippets" });
    expect(within(section).getByText("Logs")).toBeInTheDocument();
    expect(within(section).getByText("Top")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onApply).toHaveBeenCalledWith({ overwrite: false, agentAccess: false, observabilityLinks: false });
  });

  it("can be left out of an export", () => {
    const file = JSON.parse(exportText(buildExport(withSnippets(), [], [], { includeAgentAccess: false, includeSnippets: false })));
    expect(file.snippets).toEqual([]);
  });

  it("are refused with control, invisible or text-direction characters", () => {
    const bad = exported();
    bad.snippets = [
      { id: "a", name: "A", command: "ls‮" },
      { id: "b", name: "B​", command: "ls" },
    ];
    expect(problems(JSON.stringify(bad))).toEqual([
      "$.snippets[0].command: contains control, invisible or text-direction characters",
      "$.snippets[1].name: contains control, invisible or text-direction characters",
    ]);
  });

  it("show the full command of added and changed snippets in the preview, a changed one highlighted", () => {
    const local = withSnippets([{ id: "logs", name: "Logs", command: "kubectl logs -f {{pod}}" }]);
    const plan = planImport(parseImport(JSON.stringify(exported())), local, [], []);
    render(<ImportPreview plan={plan} onApply={() => undefined} onCancel={() => undefined} />);
    const section = screen.getByRole("region", { name: "Snippets" });
    expect(within(section).getByText("kubectl·logs·-f·{{pod}}")).toBeInTheDocument();
    const changed = within(section).getByText("kubectl·logs·{{pod}}");
    expect(changed).toHaveClass("views-preview__changed");
    expect(within(section).getByText("Here now:")).toBeInTheDocument();
    const added = within(section).getByText("kubectl·top·pod·-n·{{namespace}}");
    expect(added).not.toHaveClass("views-preview__changed");
  });
});
