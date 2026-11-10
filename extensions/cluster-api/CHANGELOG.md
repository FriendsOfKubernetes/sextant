# Changes of Cluster API

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Cluster API view (ADR-0113) as an
extension.

- **A sidebar section "Cluster API"** after Prometheus Operator's, with Clusters, Cluster Classes, Kubeadm Control
  Planes, Machine Deployments, Machine Sets, Machines, Machine Health Checks and Cluster Resource Sets in Sextant's
  table, the built-in columns in their widths, each object's state from its own phase and conditions in both status
  shapes, and "Only problems".
- **Details** without a heading of their own, their blocks remembered in Sextant's memory of details sections: a
  Cluster's control plane and infrastructure objects, Machine counts and chain of MachineDeployments, MachineSets and
  Machines (watched only while open, at most 5000 each); a Machine's bootstrap and infrastructure objects, its Node and
  whether its Cluster is paused; the counts, templates and Machines of MachineDeployments, MachineSets and
  KubeadmControlPlanes; what a MachineHealthCheck checks and why remediation is blocked. A workload cluster Sextant has
  opens on a click, in Sextant's own dialog. The Machines and condition tables' columns resize and are remembered, as
  the built-in ones were (#417), with the same columns on one line; widths set in the built-in view carry over.
- **Problems:** failed or unavailable Clusters and control planes, Machines failed or stuck provisioning, and blocked
  remediation, in the category "Cluster API", on by default and never given to agents; counted on the section. A
  paused Cluster's Machines and control planes have none, by their own Paused condition or, with only old
  conditions, by the Cluster.
- **The state columns' hover** names the phase and the first failing condition, as the built-in one did.
- Installing asks for consent to read Cluster API's kinds and every kind of the groups under `cluster.x-k8s.io` (the
  provider objects of any provider, `readGroups`), and to judge Clusters,
  KubeadmControlPlanes, Machines and MachineHealthChecks in problem rules.
