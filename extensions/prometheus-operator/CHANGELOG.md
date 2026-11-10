# Changes of Prometheus Operator

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Prometheus Operator view (ADR-0100)
as an extension.

- **A sidebar section "Prometheus Operator"** in its built-in place, with Service Monitors, Pod Monitors, Probes,
  Prometheus Rules, Prometheuses and Alertmanagers in Sextant's table, the built-in columns (Namespaces, Selector,
  Ports; Prober, Module, Interval; Groups, Rules; Status, Replicas, Version, Reason) with their widths, and "Only
  problems" of monitors that select nothing, Prometheuses and Alertmanagers.
- **Details:** what a monitor selects right now, in which namespaces, and whether its endpoints' port names exist on
  the selected Services or Pods; which Prometheus picks a monitor, probe or rule up; a rule's groups; a Prometheus's or
  Alertmanager's readiness and a Prometheus's selectors. Their blocks open and close as Sextant remembers them, and a
  closed block watches nothing; the tables' columns resize, and Sextant remembers their widths, as the built-in tables
  did.
- **Problems:** ServiceMonitors and PodMonitors that select nothing in their namespaces, and Prometheuses and
  Alertmanagers not available, not reconciled or degraded after 5 minutes, with the operator's reason and message, in
  the opt-in category "Prometheus Operator", counted on the section while it is on. Monitors that no Prometheus picks
  up are told in their details only (see "Requirements and limits" in the README).
- Installing asks for consent to read Prometheus Operator's kinds, Services, Pods and Namespaces, and to judge
  monitors, Prometheuses and Alertmanagers in problem rules, looking up Services and Pods.
