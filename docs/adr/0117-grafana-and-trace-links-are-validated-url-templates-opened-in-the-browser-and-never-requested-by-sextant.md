# ADR-0117: Grafana and trace links are validated URL templates, opened in the browser and never requested by Sextant

## Context

#266 asked for optional links from the details of workloads, pods and nodes and from the traffic graph's edges to Grafana dashboards (a base URL per cluster and URL templates with variables) and to traces in Tempo or Jaeger (by service name and time window). A link is a URL that the user's settings, a shared views file or a typo can shape, so the risk is a link that leads elsewhere than the user's own Grafana: another site, a `javascript:` or `data:` URL, a URL with credentials in it, or a value from the cluster that changes the URL's structure.

## Decision

- **Per-cluster settings** `clusters[id].observabilityLinks` (`ObservabilityLinks`: `grafanaUrl`, `dashboards` per target `workload`/`pod`/`node`/`namespace`/`edge`, `tracesUrl`, `traces`), frontend-written. Rust reads it leniently (`settings/observability.rs`: a wrong type, an unknown target, an empty, longer than 2048 characters or control/white-space string, a base URL that is not http(s) is left out, never failing the file) and leaves it out of the file when unset. It lives inside `ClusterSettings`, so a renamed context's links move and a deleted context's go with `move_cluster_settings` / `forget_cluster_settings` (ADR-0084) without new code.
- **Base URLs** (`checkBaseUrl`): https only; plain http only to a loopback host (`localhost`, `127.0.0.1`, `[::1]`), the usual `kubectl port-forward` to Grafana; no user name or password, no query or fragment; a path is kept (Grafana under a sub-path).
- **Templates** (`checkTemplate`): a path under the base URL (`/d/<uid>?…`) or an absolute URL whose origin equals the base URL's. Every `{…}` is a placeholder and must be one of the variables its target fills (`{namespace} {name} {kind} {pod} {container} {node} {service} {from} {to} {source} {destination}`, per target in `TARGET_VARIABLES`); a literal brace is written `%7B`/`%7D`; white space, control characters and backslashes are refused. The same check runs before saving, on import, and again before every link is built; the finished URL must still have the base URL's origin and no credentials.
- **Values** are URL-encoded and must look like what Kubernetes names, label values and decimal times are (`[A-Za-z0-9][A-Za-z0-9._:-]*`, ≤ 253); a missing or other value gives no link at all. `{kind}` is the lower-case kind (the mixin's `workload_type`), `{from}`/`{to}` the hour before the click in milliseconds, `{service}` the `app.kubernetes.io/name` or `app` label, else the name (an edge: the destination's name).
- **Presets** (`presets.ts`): the kube-prometheus-stack "Kubernetes / Compute Resources / Pod|Workload|Node (Pods)|Namespace (Pods)" dashboards by the Kubernetes mixin's fixed uids (`std.md5("k8s-resources-<name>.json")` in `config.libsonnet`, so the same in every installation) and its variables; Grafana Explore panes for Loki pod logs and Tempo TraceQL (data source uids `loki`/`tempo`, edited where an installation differs); Jaeger's search (`start`/`end` in microseconds: three zeros after the milliseconds).
- **Opening**: "Open in Grafana" and "Find traces" in a details section (order 51) of Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, Pods, Nodes and Namespaces (nodes and namespaces get no trace link) and in the traffic graph's edge panel; the URL is built at the click and opened through `api.shell.openUrl` (the system browser). **Sextant requests none of these URLs** — no fetch, no proxy, no probe — and adds no command, MCP tool or extension method.
- **Settings UI**: a tab "Dashboards and traces" of the cluster settings (`registerClusterSettingsTab`, between Metrics and Agent access), each field checked on Save.
- **Export of views** (ADR-0083) already carries a fixed list of shareable cluster settings, so the links go out only when "Include dashboard and trace links" is ticked, and an import reads them strictly (`readObservabilityLinks`: unknown fields and any template that fails its check are problems naming the path) before the usual preview.

## Why

- Free-form URLs per object were rejected: a template with a fixed variable list and an origin check keeps every link on the site the user named.
- Checking the Grafana API (dashboards, data source uids) was rejected: it would make Sextant send requests (and possibly credentials) to a URL from the settings; presets are documented instead.
- Plain http to any host was rejected; loopback-only http covers port forwards without letting a link downgrade to an unencrypted remote site.

## Consequences

- A data source with another uid, or a Grafana whose dashboards were imported under other uids, needs the template edited; the hint says how.
- The time window is fixed at one hour before the click.
- An export with links is still version 3; an older Sextant names `observabilityLinks` as an unknown field.

## Amendment: links are imported only onto the same cluster and only when ticked (review of #264–#266)

Links decide which addresses Sextant opens with the names of a cluster's objects in them, so an imported file is treated like agent access rules (ADR-0083): `GATED_FIELDS` in `src/features/views/transfer.ts` holds `agentAccess` and `observabilityLinks`. Both apply only to a cluster matched exactly (the same id, or the same kubeconfig path and context) — a cluster matched by the context name alone is listed with "not applied" (`linksSkipped`) — and only when the import preview's "Apply the dashboard and trace links from the file" is ticked (`ApplyOptions.observabilityLinks`, off by default), with a warning beside it. Without the tick nothing of the file's links is written, whatever "Replace entries" says.
