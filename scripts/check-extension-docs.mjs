#!/usr/bin/env node
// Keeps the documents of Sextant's own extensions (extensions/<name>/README.md and CHANGELOG.md) in step with their
// manifests, by the structure extensions/README.md lays down: the sections in order, every manifest id in backticks,
// a changelog section for the manifest's version, and a row in the index. Run by `npm run check`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The sections of an extension's README.md, in order (extensions/README.md). */
export const SECTIONS = [
  "At a glance",
  "What it adds",
  "Permissions",
  "Problems",
  "Metrics",
  "Commands",
  "Changes it makes",
  "What it does not do",
  "Requirements and limits",
  "Troubleshooting",
  "Development",
];

/** The manifest ids a README must name, by where they are in the manifest. */
export function manifestIds(manifest) {
  const c = manifest.contributes ?? {};
  const ids = (list) => (Array.isArray(list) ? list.map((item) => item.id).filter((id) => typeof id === "string") : []);
  const sections = (c.pages ?? []).filter((p) => typeof p.sectionTitle === "string").map((p) => p.section);
  return [
    ...ids(c.pages),
    ...sections,
    ...ids(c.detailsSections),
    ...ids(c.actions),
    ...ids(c.columns),
    ...ids(c.dockActions),
    ...ids(c.problems),
    ...ids(c.metricQueries),
    ...ids(c.commands),
    ...ids(c.agentTools),
  ];
}

/** What is wrong with one extension's documents; `[]` when nothing is. */
export function checkDocs({ name, manifest, readme, changelog, index }) {
  const errors = [];
  const at = (file) => `extensions/${name}/${file}`;
  if (readme === null) errors.push(`${at("README.md")} is missing`);
  if (changelog === null) errors.push(`${at("CHANGELOG.md")} is missing`);
  if (readme !== null) {
    if (!/^# \S/.test(readme)) errors.push(`${at("README.md")} does not start with "# <Name>"`);
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    const found = headings.filter((h) => SECTIONS.includes(h));
    const missing = SECTIONS.filter((s) => !headings.includes(s));
    for (const section of missing) errors.push(`${at("README.md")} has no section "## ${section}"`);
    if (!missing.length && found.join("\n") !== SECTIONS.join("\n")) {
      errors.push(`${at("README.md")} has its sections out of order: ${SECTIONS.join(", ")}`);
    }
    for (const id of new Set(manifestIds(manifest))) {
      if (!readme.includes(`\`${id}\``)) errors.push(`${at("README.md")} does not name \`${id}\` of the manifest`);
    }
  }
  if (changelog !== null) {
    const version = String(manifest.version ?? "").replace(/[.+]/g, "\\$&");
    if (!new RegExp(`^## ${version}(\\s|$)`, "m").test(changelog)) {
      errors.push(`${at("CHANGELOG.md")} has no section "## ${manifest.version}"`);
    }
  }
  const row = index.split("\n").find((line) => line.startsWith("|") && line.includes(`\`${manifest.id}\``));
  if (!row) errors.push(`extensions/README.md does not list \`${manifest.id}\``);
  else if (!row.includes(`| ${manifest.version} |`)) errors.push(`extensions/README.md lists \`${manifest.id}\` without its version ${manifest.version}`);
  return errors;
}

/** Every extension folder of `root` (one with a manifest), checked. */
export function checkAll(root) {
  const dir = join(root, "extensions");
  const index = readFileSync(join(dir, "README.md"), "utf8");
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "sextant-extension.json")))
    .flatMap((e) =>
      checkDocs({
        name: e.name,
        manifest: JSON.parse(readFileSync(join(dir, e.name, "sextant-extension.json"), "utf8")),
        readme: read(join(dir, e.name, "README.md")),
        changelog: read(join(dir, e.name, "CHANGELOG.md")),
        index,
      }),
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkAll(resolve(fileURLToPath(import.meta.url), "../.."));
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length) process.exit(1);
  process.stdout.write("The extensions' documents match their manifests.\n");
}
