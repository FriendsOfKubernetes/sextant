// The shared manifest cases (fixtures/manifest-cases.json) and how a case is built from its base.
import cases from "./fixtures/manifest-cases.json";

export interface ManifestCase {
  name: string;
  base: string;
  set?: Record<string, unknown>;
  remove?: string[];
}

export interface RefusedCase extends ManifestCase {
  path: string;
  message: string;
}

export const CASES = cases as unknown as {
  bases: Record<string, unknown>;
  valid: ManifestCase[];
  invalid: RefusedCase[];
};

/** `/a/b/0` → its parent pointer's segments and the last segment (JSON pointer escapes `~1` and `~0` undone). */
function split(pointer: string): { parents: string[]; last: string } {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  return { parents: parts.slice(0, -1), last: parts.at(-1)! };
}

function parentOf(root: unknown, parents: string[]): Record<string, unknown> | unknown[] {
  let node = root;
  for (const part of parents) node = (node as Record<string, unknown>)[part];
  return node as Record<string, unknown> | unknown[];
}

/** The manifest of a case: its base with `set` and `remove` applied. */
export function applyCase(testCase: ManifestCase): unknown {
  const value: unknown = structuredClone(CASES.bases[testCase.base]);
  for (const [pointer, field] of Object.entries(testCase.set ?? {})) {
    const { parents, last } = split(pointer);
    const parent = parentOf(value, parents);
    if (Array.isArray(parent)) {
      const index = Number(last);
      if (index === parent.length) parent.push(structuredClone(field));
      else parent[index] = structuredClone(field);
    } else {
      parent[last] = structuredClone(field);
    }
  }
  for (const pointer of testCase.remove ?? []) {
    const { parents, last } = split(pointer);
    delete (parentOf(value, parents) as Record<string, unknown>)[last];
  }
  return value;
}
