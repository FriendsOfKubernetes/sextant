# Sextant's own extensions

These are extensions that Sextant's authors write, in this repository. They are installed from the extension catalog
like anyone else's (ADR-0130) and use only the public extension API (ADR-0139), so each one is also a worked example
for other authors. The guide to writing one is the wiki page
[Writing extensions](https://github.com/FriendsOfKubernetes/sextant/wiki/Writing-extensions).

| Extension | Folder | Version | Needs | What it is |
|---|---|---|---|---|
| Rook Ceph (`sextant.rook-ceph`) | [`rook-ceph/`](rook-ceph/README.md) | 1.2.0 | Sextant 0.29 (`sextantApi` 3) | A view and control panel of Rook Ceph clusters |

## The documents of an extension

Each extension's folder holds two documents, both in English (ADR-0046). They are written for its users first, then
for whoever changes it.

**`README.md`** has these sections, in this order. A section with nothing to say still stands, with one line saying
so ("None.").

| Section | What goes in it |
|---|---|
| `# <Name>` | One paragraph: what it is for, its id, and the ADRs that decide how it is built. |
| `## At a glance` | A table: id, version, `sextantApi` and the oldest Sextant that runs it, where it is released, the catalog. |
| `## What it adds` | Every page, details section, action, column and dock action, by place in Sextant's window, each with its manifest id in backticks. |
| `## Permissions` | What it reads, changes and deletes, each with why; what Sextant confirms; when an update asks for consent again. |
| `## Problems` | A table of every problem rule: id, kind, when it holds, grace, and whether another object tells it. |
| `## Metrics` | A table of every metric query: id and what it reads. |
| `## Commands` | A table of every command: id, its words, where it runs, and whether it changes something. |
| `## Changes it makes` | What it changes in a cluster, and how each change is shown and confirmed before it is sent. |
| `## What it does not do` | What it leaves to other tools, on purpose. |
| `## Requirements and limits` | What must be installed or running for it to work (operators, toolboxes, metrics), the versions it was checked against, and what it was not tried on. |
| `## Troubleshooting` | What a user sees when something it needs is missing, and what to do. |
| `## Development` | How to build, test and check it, and how it is released. |

**`CHANGELOG.md`** has one `## <version> — <date>` section per release, newest first, saying what changed for
users. It also says what an update asks for again.

`npm run check` runs `scripts/check-extension-docs.mjs`, which keeps the documents in step with the manifest. It
checks that:
- both files exist and the sections are there, in order;
- every manifest id listed above appears in `README.md` in backticks;
- `CHANGELOG.md` has a section for the manifest's version.

## Adding an extension

1. Make a folder here, with its own `package.json` like `rook-ceph/package.json`, a manifest whose id starts with
   `sextant.`, and `src/`.
2. Add its texts in every language Sextant has (ADR-0140).
3. Write its `README.md` and `CHANGELOG.md` as above, and add its row to the table at the top.
4. `npm run sdk:check` type-checks, tests and builds every folder here. A test in
   `crates/sextant-core/src/extensions/` checks that Sextant accepts its manifest.
5. It is released from
   [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions) with that
   repository's key. Its workflow "Release a Sextant extension" builds the package from a commit or tag of this
   repository; add the folder's name to that workflow's `extension` choices.
