# Changes of KubeRay

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in KubeRay view (ADR-0115) as an
extension.

- **A sidebar section "KubeRay"** with Ray Clusters, Ray Jobs and Ray Services in Sextant's tables, and the built-in
  columns and "Only problems".
- **Details:** a RayCluster's state and why, head pod and Service, worker groups and pods, with head and worker logs;
  a RayJob's statuses, message, masked entrypoint, RayCluster and submitter Job with its logs; a RayService's
  readiness, Serve applications of the active and pending clusters, and masked serve configuration.
- **Problems:** failed RayClusters or ones whose head pod is not ready, RayJobs failed in the last day, and
  RayServices not ready or with a failed Serve application, counted on the section.
- Installing asks for consent to read KubeRay's kinds and Pods, to open Pods' logs, and to judge RayClusters, RayJobs
  and RayServices in problem rules.
