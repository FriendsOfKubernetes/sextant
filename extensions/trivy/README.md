# Trivy

Read-only views of [Trivy Operator](https://github.com/aquasecurity/trivy-operator)'s reports
(`aquasecurity.github.io`), in every language Sextant has. It lists the twelve report kinds in a sidebar section of
their own with Sextant's tables — the scanned object, container and image, and the operator's own summary counts by
severity (a compliance report's passed and failed controls, an SBOM's component count) — shows each report's most
severe findings in its details, and the image scans of every Pod and workload. Reports can hold thousands of
vulnerabilities: everything reads the operator's `summary` for counts and lists only the most severe rows. Trivy
reports are never a problem source. It replaces the Trivy part of Sextant's former built-in security view (ADR-0076)
with the same behaviour; the Pod Security Standards, the Security page and the `security` problem category stay in
Sextant. The few places where the extension API cannot say exactly the same are in "Requirements and limits". Its id
is `sextant.trivy`. Why it is built this way: ADR-0076 (Trivy reports read-only, counts from the summary, the most
severe rows only, never a problem source), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152
(kinds in a section of their own), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit),
ADR-0161 (printer columns left out), ADR-0164 (a case's own value) and ADR-0167 (column widths and sort keys, literal
placeholder fallbacks, untitled details sections hidden until shown, details blocks in Sextant's own memory, the shown
object's uid).

## At a glance

| | |
|---|---|
| Id | `sextant.trivy` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `trivy-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Trivy |
| Checked against | Trivy Operator's report types (`pkg/apis/aquasecurity/v1alpha1`) and its labels (`trivy-operator.resource.kind/name/namespace`, `trivy-operator.container.name`), on the fixtures of the former built-in view |

## What it adds

**A sidebar section "Trivy"** (`trivy`), shown while the cluster serves any of the report kinds (only the kinds it
serves are listed), with the built-in section's icon and place (after cert-manager): Vulnerability Reports, Cluster
Vulnerability Reports, Config Audit Reports, Cluster Config Audit Reports, Exposed Secret Reports, RBAC Assessment
Reports, Cluster RBAC Assessment Reports, Infra Assessment Reports, Cluster Infra Assessment Reports, Cluster Compliance
Reports, SBOM Reports and Cluster SBOM Reports, with Sextant's own table, filters, selection bar and details, and Edit
and Delete as on every kind (the operator writes and rescans them). No "Only problems": the reports are no problems.

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), after Name or Namespace,
each with the built-in column's width, sort order and filter. Each kind's ids start with its prefix: `vr-` Vulnerability,
`cvr-` Cluster Vulnerability, `car-` Config Audit, `ccar-` Cluster Config Audit, `esr-` Exposed Secret, `rar-` RBAC
Assessment, `crar-` Cluster RBAC Assessment, `iar-` Infra Assessment, `ciar-` Cluster Infra Assessment, `ccr-` Cluster
Compliance, `sbom-` SBOM and `csbom-` Cluster SBOM Reports.
- **Resource**: the scanned object as `Kind/name`, from the operator's labels (blank without both) —
  `vr-resource`, `cvr-resource`, `car-resource`, `ccar-resource`, `esr-resource`, `rar-resource`, `crar-resource`,
  `iar-resource`, `ciar-resource`, `sbom-resource`, `csbom-resource`.
- **Container**: the scanned container of an image report — `vr-container`, `cvr-container`, `esr-container`,
  `sbom-container`, `csbom-container`.
- **Image**: `registry/repository:tag` (or `@digest` without a tag), the whole reference on hover — `vr-image`,
  `cvr-image`, `esr-image`, `sbom-image`, `csbom-image`.
- **Critical**, **High** (red when any), **Medium** (amber when any) and **Low** (muted): the operator's summary
  counts, 0 when it leaves one out, muted at 0; sorted and filtered as numbers — `vr-critical`, `vr-high`, `vr-medium`,
  `vr-low`, `cvr-critical`, `cvr-high`, `cvr-medium`, `cvr-low`, `car-critical`, `car-high`, `car-medium`, `car-low`,
  `ccar-critical`, `ccar-high`, `ccar-medium`, `ccar-low`, `esr-critical`, `esr-high`, `esr-medium`, `esr-low`,
  `rar-critical`, `rar-high`, `rar-medium`, `rar-low`, `crar-critical`, `crar-high`, `crar-medium`, `crar-low`,
  `iar-critical`, `iar-high`, `iar-medium`, `iar-low`, `ciar-critical`, `ciar-high`, `ciar-medium`, `ciar-low`.
- Cluster Compliance Reports: **Title** (the compliance title, else its id, `ccr-title`), **Passed** (`ccr-pass`) and
  **Failed** (red when any, green at 0, `ccr-fail`).
- SBOM Reports: **Components** (`sbom-components`, `csbom-components`).

**Details of a report** (`report`), untitled in the built-in section's place (before the conditions), drawn with the
SDK's UI kit in the built-in view's classes: one block **Report** with the scanned object (a link to its details for
the kinds the operator scans), its container and image; then by kind —
- vulnerability reports: the counts by severity, how many vulnerabilities have a fixed version, and the 50 most severe
  (fixable ones first within a severity) with their id (the title on hover), package, installed and fixed version;
- configuration audit, RBAC and infrastructure reports: the counts and the 50 most severe failed checks, each with its
  id, title, messages and remediation, or "All checks passed.";
- exposed secret reports: the counts and the 50 most severe findings by rule, title and file — never the matched text,
  which holds part of the secret;
- compliance reports: passed and failed, and the 50 most severe failing controls with how many checks failed;
- SBOM reports: the component count.
A note says "Listed: the 50 most severe of N." when there are more. The tables' columns resize, and Sextant remembers
their widths, as the built-in view's tables did.

**Image scans of a workload** (`scans`), on Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and CronJobs,
right after Sextant's own "Security" section: one block **Image scans (Trivy)** with the object's VulnerabilityReports
(each with its container and image, counts, how many are fixable, its 10 most severe vulnerabilities and "Open the
report") and its ConfigAuditReport (counts, its 10 most severe failed checks and "Open the report"), or "Trivy Operator
has no reports for this object yet." The reports are found as the operator files them: a Deployment's under its
ReplicaSets with pods (else its newest), a Pod's under its controller, a CronJob's Job's under the CronJob. It is hidden
where the cluster serves neither VulnerabilityReports nor ConfigAuditReports.

The blocks open and close as the built-in ones (open at first, remembered in Sextant's own memory of details sections,
with the panel's "Expand all" and "Collapse all"); a closed block draws and watches nothing: a workload's reports — and
a Deployment's ReplicaSets, by its selector — are watched by label in its namespace only while "Image scans (Trivy)" is
open.

## Permissions

- **Read** the twelve Trivy report kinds in every namespace of every cluster: the tables, and the details read the shown
  report and, for a workload, its VulnerabilityReports and ConfigAuditReports by label.
- **Read** Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and CronJobs: the image scans read the shown
  object (its owner, uid and selector) to find the reports filed for it, and a Deployment's ReplicaSets.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- An update asks for consent again when it needs a new kind or action.

## Problems

None: Trivy reports are never a problem source (ADR-0076). Watching every report of every connected cluster in the
background would move whole vulnerability lists for a count. Sextant's own `security` category (Pod Security
Standards) is not part of this extension.

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0076).

## What it does not do

- It does not install, configure or upgrade Trivy Operator, start a scan or rescan, or run `trivy`.
- It never shows an exposed secret's matched text, and lists at most 50 rows of a report (10 in a workload's scans).
- It does not judge the Pod Security Standards: Sextant's own "Security" section and page do that, and the page still
  shows each workload's Trivy counts and filters by severity where the cluster serves the reports.

## Requirements and limits

- Trivy Operator's CRDs (`aquasecurity.github.io/v1alpha1`); the section and each kind show only where the cluster
  serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - "Image scans (Trivy)" was the last block inside Sextant's "Security" section, and closing "Security" hid it; it is
    a section of its own now, right after "Security", whose block is a top-level one. A details section that adds a
    block inside another section would close it.
  - The image scans read the shown workload themselves, so the extension asks to read Pods and workloads; the built-in
    block used the panel's object.
  - The image column treats a blank registry, tag or digest (only spaces) as missing; the built-in did so only for an
    empty one (#417, an `exists` that refuses only `""`). The counts read a count written as text too; the built-in
    took only JSON numbers. Trivy Operator writes neither.
  - Counts in sentences ("1,234 vulnerabilities have a fixed version.") are written with the UI language's digit
    grouping; the built-in wrote "1234".
- Checked by tests on fixtures of Trivy Operator reports (copied from the built-in view, and one of each other kind)
  against the built-in readings; not yet tried on a live cluster.

## Troubleshooting

- **No "Trivy" section:** the cluster does not serve the report kinds (Trivy Operator is not installed), or the
  extension is disabled.
- **No "Image scans (Trivy)" on a workload:** the cluster serves neither VulnerabilityReports nor ConfigAuditReports,
  or the details opened before Trivy Operator was installed: open them again.
- **"Trivy Operator has no reports for this object yet.":** the operator has not scanned it yet, or files its reports
  under another object (a Deployment's under its current ReplicaSet).
- **"Could not read the Trivy reports.":** the reports cannot be listed in that namespace with your credentials.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Trivy.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/trivy        # → extensions/trivy/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/trivy
```

- `src/main.ts` starts the details section the context names; `details.ts` draws both with the SDK's `ui` kit and holds
  the scans' watches; `dom.ts` has the built-in view's badges, notes and tables and keeps the blocks in Sextant's memory
  (`BlockMemory`); `style.css` is the built-in view's look.
- `model.ts` reads the reports; it is the former built-in view's model (`trivy.ts`), ported, with the readings of its
  columns (`builtInCell`) kept as the reference the manifest is tested against.
- `model.test.ts` draws the manifest's columns with Sextant's own window engine (`src/extensions/columns.tsx`) and
  compares them with the model on the fixtures in `fixtures/` and variants of them (missing labels, summaries, counts,
  registry, tag, digest and repository; compliance titles and counts); `views.test.ts` drives the details through the
  SDK's test host, blocks, watches and hiding included.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `security`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `trivy` and the
     commit (add `trivy` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
