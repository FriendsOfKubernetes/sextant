# Changes of Trivy

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: the Trivy part of Sextant's former built-in security view
(ADR-0076) as an extension.

- **A sidebar section "Trivy"** in its built-in place, with the twelve Trivy Operator report kinds in Sextant's table
  and the built-in columns (Resource, Container, Image, the severity counts; Title, Passed and Failed of compliance
  reports; Components of SBOMs) with their widths, tones, sort orders and filters.
- **Details of a report:** the scanned object as a link, its container and image, the counts by severity and the 50
  most severe vulnerabilities, failed checks, exposed secrets (never the matched text) or failing controls, or an
  SBOM's component count. The tables' columns resize, and Sextant remembers their widths, as the built-in view's did.
- **Image scans of every Pod and workload**, right after Sextant's "Security" section: its VulnerabilityReports and
  ConfigAuditReport with their 10 most severe rows and a link to each, watched only while the block is open. The
  block follows the cluster's kinds while shown, as the built-in one followed discovery: it comes as soon as Trivy
  Operator is installed and goes when it is removed.
- Read-only, and never a problem source. Installing asks for consent to read the report kinds, Pods and workloads.
