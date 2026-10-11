// Fails if `git ls-files` has paths that collide on case-insensitive file systems (macOS, Windows).
// Two kinds of collision:
//  1. paths equal ignoring case (Foo.ts / foo.ts);
//  2. module files whose names differ only in case before the extension (LogsTab.tsx / logsTab.ts):
//     `import "./LogsTab"` then resolves to the wrong file there, though both names are distinct on Linux.
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter(Boolean);

const moduleExt = /\.(?:[cm]?[jt]sx?)$/;
const groups = new Map();
const add = (key, file) => {
  const list = groups.get(key) ?? [];
  list.push(file);
  groups.set(key, list);
};
for (const file of files) {
  if (moduleExt.test(file)) add(`module ${file.replace(moduleExt, "").toLowerCase()}`, file);
  else add(`path ${file.toLowerCase()}`, file);
}

const clashes = [...groups.values()]
  .map((list) => [...new Set(list)].sort())
  .filter((list) => list.length > 1)
  .filter((list) => list.some((a) => list.some((b) => a.replace(moduleExt, "") !== b.replace(moduleExt, ""))));
const unique = clashes.map((list) => list.join("\0"));

if (unique.length > 0) {
  console.error("git ls-files has paths that collide on case-insensitive file systems (macOS, Windows):");
  for (const entry of unique) console.error(`  ${entry.split("\0").join("  <->  ")}`);
  process.exit(1);
}
console.log(`no case-insensitive path collisions (${files.length} tracked files)`);
