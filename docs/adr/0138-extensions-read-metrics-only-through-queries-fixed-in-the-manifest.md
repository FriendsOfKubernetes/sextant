# ADR-0138: Extensions read metrics only through queries fixed in the manifest

## Context

An extension for an operator (Rook Ceph, #319) needs the operator's metrics: capacity, write rates, health over time.
Its frames reach clusters only through the extension API, and a backend reaches the network only at declared HTTPS
hosts on 443 (ADR-0131), so the cluster's Prometheus or VictoriaMetrics — found by Sextant and reached through the API
server's service proxy (ADR-0102) — is out of reach. Giving extensions PromQL would let any extension read any series
of any namespace, and the user could not tell from the consent what it reads (#318).

## Decision

- **Queries are part of the manifest.** `contributes.metricQueries` (`sextantApi` 2, like problem rules — both come
  with 0.28) lists at most 20 queries, each an `id`, a `title`, a PromQL `query` template of at most 2000 characters,
  up to 5 typed `params` and an optional `range: {maxHours}` (1–168). They are signed with the package and shown word
  for word in the consent. The frame (or the backend, through `host.call`) calls `metrics.query {clusterId, id,
  params, range?}`; it never sends PromQL, a metric name, a label or a path.
- **Parameters are typed and put in by Rust.** `namespace` (DNS-1123 label), `name` (DNS-1123 subdomain),
  `labelValue` (≤ 256 characters, no control characters) and `duration` (one of a fixed list, `1m` … `7d`). A
  placeholder is `{{name}}`; the manifest check (`check_metric_queries`, mirrored by the SDK's `checkMetricQueries`)
  tokenizes the template and refuses a text parameter outside a `"…"` string, a duration inside one, a placeholder in
  a `'…'` or `` `…` `` string, an undeclared or unused parameter and `#` comments. `fill` escapes a text value as a
  string literal and, after `=~`/`!~`, as a literal regular expression first (as right-sizing does, ADR-0070); a
  duration goes in as written, since it is from the list. Every parameter needs a value and nothing else is accepted.
- **Ranges are bounded.** A range is `{minutes, step}` ending now: allowed only when the manifest says so, at most
  `maxHours`, a step from `15s` … `1h`, at most 1500 points. An instant query runs at now.
- **The grant is the queries, word for word.** `InstalledExtension.grantedMetricQueries` keeps the queries the user
  agreed to; only a query found there by id runs, as stored. An update that adds or changes a query asks again
  (`asks_within` → `metric_queries_within`), like a new backend host or a newly judged kind (ADR-0137). A query runs in
  the clusters the grant's `clusters` covers. This replaces the issue's separate `metrics` field of
  `ExtensionPermissions`: the queries are what the user agrees to, and keeping them beside the permissions (like
  `grantedBackend` and `grantedProblems`) leaves the strict permissions format of settings unchanged.
- **The consent says what Read does not cover.** Prometheus may answer with series of namespaces the extension may not
  read: the consent block says so plainly, and the call needs no Read rule.
- **The source is the cluster's own.** `required_prometheus` with the cluster's `prometheus` setting: the configured
  target, else the detected one (every Prometheus before VictoriaMetrics), through the service proxy; off or none found
  is `notFound`. GET only through the proxy; a POST retry on 414/431 only for a directly reached URL (ADR-0096). The
  answer is read up to 8 MiB, at most 500 series are returned (`truncated` says so), values that are not finite numbers
  are `null`, and a string result is refused.
- **Journaled without results.** Each call is in `extensions-audit.jsonl` as `metrics.query` with the target
  `<id>(<name>=<value>, …)` and the range; never the PromQL answer.
- **Window only, per extension.** Agents never get it (no MCP tool); one extension's queries are never offered to
  another, and a backend's `host.call` runs under its own extension's grant.

## Consequences

- An operator extension can draw charts and status from the operator's metrics without a PromQL path out of the frame.
- What an extension reads from Prometheus is visible in the consent and the activity log; it can still read any series
  its fixed queries select, of any namespace, which the consent states.
- A query language feature outside the checked shapes (comments, parameters in other string kinds) is refused rather
  than escaped by guesswork; extending it is a change of both checks and the shared manifest cases.
- Alertmanager and Loki stay out of reach of extensions.
