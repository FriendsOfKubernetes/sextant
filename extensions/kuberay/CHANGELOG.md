# Changes of KubeRay

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in KubeRay view (ADR-0115) as an
extension.

- **A sidebar section "KubeRay"** with Ray Clusters, Ray Jobs and Ray Services in Sextant's tables, and the built-in
  columns (their widths, muted states, hovers with the built-in fallbacks, Status sorted and filtered by the state,
  Workers and Applications as "ready of desired" and "running of all") and "Only problems" (Ray Services' at once).
- **Details:** untitled sections as the built-in one, their blocks remembered in Sextant's memory of details sections
  with "Expand all" and "Collapse all": a RayCluster's state and why, head pod and Service, worker groups and pods
  (at most 2000 kept, saying so), with head and worker logs (titled `raycluster/<name>`) in the Pods block's head;
  a RayJob's statuses, message, masked entrypoint, RayCluster and submitter Job with its logs; a RayService's
  readiness, Serve applications of the active and pending clusters, and masked serve configuration. The tables'
  columns resize and Sextant remembers their widths, as the built-in tables'.
- **Problems:** failed RayClusters or ones whose head pod is not ready, RayJobs failed in the last day (counted from
  their end, else start, else creation; notified again when the reason changes), and RayServices not ready or with a
  failed Serve application (the first by name, an invalid one's too), counted on the section, with the built-in
  reasons and messages (a condition's reason where its message is empty or missing).
- Installing asks for consent to read KubeRay's kinds and Pods, to open Pods' logs, and to judge RayClusters, RayJobs
  and RayServices in problem rules.
