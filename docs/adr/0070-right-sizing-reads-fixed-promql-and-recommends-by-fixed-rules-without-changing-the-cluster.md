# ADR-0070: Right-sizing reads fixed PromQL and recommends by fixed rules, without changing the cluster

## Context

Requests and limits are guessed when a workload is written and rarely revisited: some containers reserve ten times what they use, others are throttled or OOM-killed (#137). Sextant already shows current usage (metrics-server or Prometheus) next to requests and limits, but a single point says nothing about a container's peak. A recommendation needs history, which only Prometheus has, and it must be about a workload's pod template, not about one pod that a rollout will replace.

## Decision

- **History from Prometheus, through one fixed command.** `metrics_usage_history` (`sextant_core::metrics::history`, PromQL in `metrics/prometheus/rightsizing.rs`) returns per namespace, pod and container: the 95th percentile of the 5-minute CPU rate, the peak working set (each 5-minute step takes the peak of its own raw samples, so no spike is missed), the share of CFS periods throttled, since when there are samples and whether there is one now, over the last day or 7 days (default). The PromQL is built in the core, never taken from the caller: the scope is namespaces (≤ 200), a workload or a pod; every name is checked against the Kubernetes naming rules first and escaped anyway; each query is bounded by Prometheus (`timeout=18s`) and by the client (20 s); the answer is capped at `MAX_HISTORY_CONTAINERS` (5000).
- **A workload's pods by the names its controller gives them.** A Deployment's pods are matched as `<name>-<hash>-<5>`, a StatefulSet's as `<name>-<ordinal>`, a DaemonSet's as `<name>-<5>`, the generated parts in Kubernetes' safe alphabet, with an anchored regular expression: pods replaced inside the window still count, pods of `web-api` are not taken for pods of `web`. On the frontend (`group.ts`) a live pod's history counts only for the workload that owns it; a gone pod is matched by the same name patterns.
- **The rules are fixed constants in the frontend** (`src/features/rightsizing/recommend.ts`): CPU request = p95 × 1.15, memory request = peak × 1.15, memory limit = peak × 1.3 (after an OOM kill in the last 7 days at least the current limit × 1.25, since the peak was cut off by the limit), a CPU limit only when one is set now (p95 × 2, at least the request; when ≥ 25 % of periods were throttled at least the current limit × 1.5); rounded up to 10m and 16Mi. Flags: missing requests or limits, over-provisioned (request ≥ 2 × the recommendation and at least 50m / 64Mi more), under-requested, memory ≥ 90 % of the limit, recent OOM kill, throttled. Waste is the request above the recommendation.
- **No recommendation without enough history.** Less than 6 hours of samples gives none; less than 90 % of the window is marked "based on N of history"; when Prometheus cannot say since when it has samples, the coverage is "unknown" and said so. A metrics-server snapshot is one point: it shows current usage and flags missing requests and limits, never a recommendation.
- **Bounded by the namespace filter.** The page (Workloads section) works on the namespaces chosen in the filter, at most 10 (with "All namespaces" it asks for a choice), watches pods only there and only while open, draws at most 1000 rows, and refreshes history every 5 minutes. The details section of a Deployment, StatefulSet, DaemonSet or pod shows the same rows for that one workload.
- **Read-only.** The result is a `resources:` snippet copied to the clipboard; nothing is patched. Neither agents nor extensions get the command (a test in `src-tauri/src/commands/metrics.rs`).

## Why

- Accepting PromQL from the frontend was rejected: a free query is a free read of whatever that Prometheus holds (often through the API server's service proxy, with the user's credentials); a fixed query over validated names keeps the command what its name says.
- Matching a workload's pods by labels was rejected: pods that are gone have no labels in a watch, and the history must survive the rollout that replaced them. Owner names are what the cAdvisor series carry.
- Recommending from a metrics-server snapshot, or from the average, was rejected: one point or an average hides the peaks that cause throttling and OOM kills.
- Applying the recommendation (a patch, or a VPA object) was rejected: the pod template usually lives in Git, Helm values or a GitOps source, and a patch in the cluster would be reverted or would drift from it.
- Rules in Rust were rejected: the inputs (pod specs, owners, OOM kills) are what the window already watches, and the rules are judgement constants that the views display and explain.

## Consequences

- Without Prometheus (or with Prometheus that has no cAdvisor series) the page checks only requests and limits.
- Rows group pods by their controlling workload (a ReplicaSet of a Deployment counts as the Deployment); a Job's pods group under the Job and a bare pod is its own workload, but a gone pod is recovered only for Deployments, StatefulSets and DaemonSets, whose pod names are predictable.
- The thresholds are Sextant's judgement, constants in `recommend.ts`, not settings; tests in `recommend.test.ts`, `group.test.ts`, `rightsizing.test.tsx` and `crates/sextant-core/tests/rightsizing.rs`.
