# Changes of NVIDIA GPU Operator

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in NVIDIA GPU Operator view
(ADR-0116) as an extension.

- **A sidebar section "NVIDIA GPU Operator"** in its built-in place, with Cluster Policies and NVIDIA Drivers in
  Sextant's table, the built-in columns (State, Operand namespace, MIG strategy; Driver type, Version, Node selector)
  and "Only problems", and the page **GPU nodes**.
- **Details:** a ClusterPolicy's state with the operator's message and each component with its DaemonSet's rollout;
  an NVIDIADriver's type, version, node selector and DaemonSets; a **GPU** block on GPU nodes with the GPUs, the MIG
  configuration and its state, and the GPU and MIG resources.
- **Problems:** ClusterPolicies and NVIDIADrivers not ready, component DaemonSets not rolled out and nodes whose MIG
  configuration failed, counted on the section.
- Installing asks for consent to read ClusterPolicies, NVIDIADrivers, DaemonSets and Nodes, and to judge them in
  problem rules.
