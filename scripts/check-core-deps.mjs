// sextant-core must build without Tauri and without OS-process dependencies (mobile readiness, story G01).
// Fails if `cargo tree -p sextant-core --no-default-features` lists tauri or portable-pty,
// or if the crate does not compile that way.
import { execFileSync } from "node:child_process";

const forbidden = [/^tauri(-|$)/, /^portable-pty$/];

const tree = execFileSync(
  "cargo",
  ["tree", "-p", "sextant-core", "--no-default-features", "--edges", "normal,build", "--prefix", "none", "--format", "{p}"],
  { encoding: "utf8" },
);
const crates = new Set(tree.split("\n").map((l) => l.trim().split(" ")[0]).filter(Boolean));
const hits = [...crates].filter((name) => forbidden.some((re) => re.test(name)));
if (hits.length > 0) {
  console.error(`sextant-core --no-default-features depends on: ${hits.join(", ")}`);
  process.exit(1);
}

execFileSync("cargo", ["check", "-p", "sextant-core", "--no-default-features", "--quiet"], { stdio: "inherit" });
console.log(`sextant-core builds without default features (${crates.size} crates, no tauri/portable-pty)`);
