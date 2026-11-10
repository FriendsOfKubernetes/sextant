# Changes of Karpenter

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: the Karpenter part of Sextant's former built-in autoscaling
view (ADR-0080) as an extension.

- **A sidebar section "Karpenter"** after KEDA's, with Node Pools, Node Claims, EC2 Node Classes and AKS Node Classes in
  Sextant's table, the built-in columns (node class, nodes, usage against limits, consolidation, the claims' pool,
  instance, capacity, zone, node and launch state, Ready, the classes' role) in their widths, the usage in cores,
  millicores and binary units as the built-in column wrote it, and "Only problems" with limits compared as Kubernetes
  quantities.
- **Details** without headings of their own, their blocks remembered in Sextant's memory of details sections: a
  NodePool's limits against what it launched, disruption settings and budgets, and the recent disruptions of its
  NodeClaims; a NodeClaim's launch, node, pool, why Karpenter disrupts it and when it expires, and its disruption
  events when it has some — or, when they cannot be read, the error titled by its kind with the cluster's details, as
  the built-in block said it. The tables' columns resize and Sextant remembers their widths, as the built-in tables'.
- Installing asks for consent to read Karpenter's kinds and Events.
