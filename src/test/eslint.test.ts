// @vitest-environment node
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function lint(code: string, filePath = "src/features/example/Example.tsx") {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe("eslint rules of the project", () => {
  it("rejects a string literal in JSX text", async () => {
    const rules = await lint(`export const Example = () => <div>Hello world</div>;\n`);
    expect(rules).toContain("i18next/no-literal-string");
  });

  it("rejects a literal in a user-visible attribute", async () => {
    const rules = await lint(`export const Example = () => <button aria-label="Close panel" />;\n`);
    expect(rules).toContain("i18next/no-literal-string");
  });

  it("accepts translated text and technical attributes", async () => {
    const code = [
      `import { useTranslation } from "react-i18next";`,
      `export const Example = () => {`,
      `  const { t } = useTranslation();`,
      `  return <div className="x" role="status" aria-label={t("common:layout.main")}>{t("common:app.name")} ×</div>;`,
      `};`,
      ``,
    ].join("\n");
    expect(await lint(code)).toEqual([]);
  });

  it("forbids importing Tauri outside src/api", async () => {
    const code = `import { invoke } from "@tauri-apps/api/core";\nexport const x = invoke;\n`;
    expect(await lint(code, "src/features/example/x.ts")).toContain("no-restricted-imports");
    expect(await lint(code, "src/api/x.ts")).not.toContain("no-restricted-imports");
  });
});
