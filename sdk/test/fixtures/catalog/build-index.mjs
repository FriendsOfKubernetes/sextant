// Writes index.json next to this file: the index the catalog workflow would write for the fixture package, with a
// fixed time. The app's tests read it (crates/sextant-core/src/extensions/catalog/tests.rs), and
// sdk/test/catalog.test.ts checks that it is still what the SDK writes.
//
//   node sdk/test/fixtures/catalog/build-index.mjs
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { buildIndex, checkEntry, checkRelease } from "../../../scripts/catalog.mjs";

export function fixtureIndex() {
  const file = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
  const publisherKey = file("publisher.pub").toString().trim().split("\n")[1];
  const entry = checkEntry(
    {
      id: "demo.catalog",
      name: "Catalog demo",
      author: "Sextant tests",
      description: "A package of the catalog tests",
      categories: ["developer", "workloads"],
      repository: "FriendsOfKubernetes/demo",
      publisherKey,
    },
    "demo.catalog.json",
  );
  const withdrawn = checkEntry(
    {
      id: "demo.withdrawn",
      name: "Withdrawn demo",
      author: "Sextant tests",
      description: "An entry withdrawn from the catalog",
      categories: ["other"],
      repository: "FriendsOfKubernetes/demo-withdrawn",
      publisherKey,
      withdrawn: { reason: "A known-bad release" },
    },
    "demo.withdrawn.json",
  );
  const asset = "demo.catalog-1.0.0.sextant-ext";
  const latest = checkRelease(
    entry,
    { tag: "v1.0.0", asset, version: "1.0.0", publishedAt: "2026-10-28T00:00:00Z" },
    file(asset),
    file(`${asset}.minisig`).toString(),
  );
  return buildIndex({
    entries: [entry, withdrawn],
    results: new Map([[entry.id, { latest }]]),
    previous: null,
    now: new Date("2026-10-28T12:00:00Z"),
  }).index;
}

export const indexText = () => `${JSON.stringify(fixtureIndex(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL("./index.json", import.meta.url), indexText());
}
