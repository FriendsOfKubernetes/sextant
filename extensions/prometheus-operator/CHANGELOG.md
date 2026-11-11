# Changes of Prometheus Operator

## 1.1.0 — 2026-11-12

Needs Sextant 0.30.1 (`sextantApi` 5, ADR-0169); Sextant 0.30.0 keeps 1.0.0 through the catalog. Closes what 1.0.0
listed as different from the built-in view.

- **Not picked up:** a ServiceMonitor or PodMonitor that no Prometheus or PrometheusAgent picks up by its selectors and
  namespace selectors (with the Namespaces' labels) is a problem `NotPickedUp` again, listed but not notified and not
  counted, as the built-in warning (`service-monitor-not-picked-up`, `pod-monitor-not-picked-up`, `selectedByNone`).
- **Selects nothing** is judged where the monitor's Prometheuses make it look: its own namespace only when every one
  that picks it up has `ignoreNamespaceSelectors`, its own too when some have, and a monitor of every namespace when
  every one makes it look in its own (`selectsNone.selectedBy`, `namedOnly`); the message names those namespaces
  (`{{selectsNone:namespaces}}`).
- **"Only problems"** of ServiceMonitors and PodMonitors and the section's counter leave the monitors not picked up out,
  as the built-in filter and counter (the kinds' `problemRules`, the counter's `rules`).
- **Rules** counts the rules with an `alert` or `record` name, a rule with both twice, as the built-in column.
- **Namespaces** sorts and filters by `*` or the names joined with `,`, as the built-in column (`|uniqueKey`).
- Installing or updating asks for consent to look up PrometheusAgents and Namespaces in problem rules too.

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
- The rules' Services and Pods are listed only in the namespaces the monitors name (`narrowLookups`), as the built-in
  listed them, up to 40 namespaces of each, then wherever the extension may read.
