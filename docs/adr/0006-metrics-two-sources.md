# ADR-0006: Metrics — two sources with auto-detection and manual configuration, Prometheus through the API server proxy

## Context

To the question "metrics-server or Prometheus" the user answered: "Do both, there must be a way to auto-detect and to configure manually".

## Decision

Current CPU and memory values come from metrics-server, and charts for the last hour come from Prometheus. Both sources are detected automatically and configured manually per cluster: the Prometheus mode (auto, manual, off) and the current values source (auto, metrics-server, Prometheus, off). In auto mode, when both sources are present, values come from metrics-server and charts from Prometheus. Prometheus is queried through the API server's service proxy, with no direct network access to the cluster.

## Why

- Only metrics-server was rejected: it keeps no history, so charts cannot be built from it.
- Only Prometheus was rejected: it is absent on a bare cluster, and current values would then be unavailable.
- Direct access to the Prometheus address was rejected: the app has no network path into the cluster, while the API server proxy uses the credentials already at hand.
- Auto-detection goes through a list of known services in typical namespaces. A manual address is needed precisely because the list cannot cover everything.

## Consequences

- A Prometheus deployed in a non-standard way will not be found by auto-detection. It will have to be set manually in the cluster settings.
- The auto-detection result is cached for 60 seconds. After Prometheus is installed, the interface may show "Metrics are unavailable" for a few seconds.
- Proxying requires permissions on `services/proxy`. On a refusal the user will see the absence of a source, not the reason.
- Current values are polled every 30 seconds rather than arriving through a watch, so they lag behind tables that update on their own. The chart window is fixed at one hour.

Amended (v0.18.1, #226): auto-detection also finds VictoriaMetrics (single-node and a cluster's vmselect under `/select/0/prometheus`) and searches the namespaces `victoria-metrics` and `vm`; every Prometheus comes first, so a cluster with both keeps its Prometheus. "Prometheus" in this ADR means any Prometheus-compatible source. See ADR-0102.
