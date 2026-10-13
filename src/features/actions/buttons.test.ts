import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isIconName } from "../../components";
import "../../app/features";
import { getAction } from "./registry";

function sourceFiles(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, ext, out);
    else if (ext.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const SRC = join(process.cwd(), "src");

describe("button standard", () => {
  it("has no btn--small and no feature stylesheet resizing a .btn", () => {
    const small = sourceFiles(SRC, /\.(tsx?|css)$/).filter((f) => /(?<![-\w])btn--small/.test(readFileSync(f, "utf8")));
    expect(small).toEqual([]);
    // Sizes come from the tokens in global.css only: no height, padding or font-size on `.btn` anywhere else.
    const resized: string[] = [];
    for (const file of sourceFiles(SRC, /\.css$/).filter((f) => !f.endsWith("global.css"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (/(^|[\s,>+~])(\.btn\b|\.icon-btn\b)/.test(selector!) && /(^|;|\s)(height|padding|font-size)\s*:/.test(body!)) {
          resized.push(`${file}: ${selector!.trim()}`);
        }
      }
    }
    expect(resized).toEqual([]);
  });

  it("registers every resource action with an icon of the set, not a text glyph", () => {
    const ids = [
      "edit", "delete", "scale", "restart", "cordon", "drain", "trigger", "suspend", "logs", "exec", "portForward",
      "reconcile", "reconcileWithSource", "fluxSuspend", "fluxResume", "argoSync", "argoRefresh", "argoHardRefresh",
      "argoTerminate", "argoOpenUi", "argoDiff",
    ] as const;
    for (const id of ids) {
      const action = getAction(id as never);
      expect(action, id).toBeDefined();
      expect(isIconName(action!.icon), `${id}: ${action!.icon}`).toBe(true);
    }
  });
});
