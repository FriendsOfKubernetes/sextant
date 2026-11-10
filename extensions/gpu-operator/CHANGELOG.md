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
- **Columns** in the built-in widths; State sorted and filtered by the state's name, Ignored, Disabled and No state yet
  muted, the hover as the built-in one's; Node selector as `key=value, …`.
- **Details** without a heading of their own, their blocks (Components, DaemonSets, GPU) opened and closed in Sextant's
  memory of details sections; the operand namespace's DaemonSets watched only while their block is open, at most 1000
  (500 GPU nodes on the page) kept by the core with a note when more match.
- **Tables** on the page and in the details whose columns resize and are remembered, as the built-in tables'.
- **Problems:** ClusterPolicies and NVIDIADrivers not ready, component DaemonSets not rolled out (a problem about their
  ClusterPolicy or NVIDIADriver, not of one ignored, disabled or being deleted, the driver's only while the policy
  deploys it, never the retired Kata manager's; its grace starting again while the rollout moves) and nodes whose MIG
  configuration failed, counted on the section.
- Installing asks for consent to read ClusterPolicies, NVIDIADrivers, DaemonSets and Nodes, and to judge them in
  problem rules.
