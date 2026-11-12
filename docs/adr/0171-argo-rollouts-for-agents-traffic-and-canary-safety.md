# ADR-0171: Argo Rollouts for agents — one diagnosis tool, traffic judged in context, canary safety opt-in

## Status

Accepted (Argo Rollouts extension 1.5.0, Sextant 0.30.1)

## Context

Discussion #341 reports that an agent analysing a canary through Sextant's MCP server reaches wrong conclusions:
- a Deployment that a Rollout takes its template from (`spec.workloadRef`) reads as "switched off" at 0 replicas;
- the Rollout's problems are not in the agent's list;
- a "false green" canary — the DestinationRule's canary and stable subsets on the same pods — looks healthy;
- the weak spots of an analysis template (passing without data or on NaN, unable to fail) are invisible;
- understanding one Rollout takes many calls to stitch together.

The reporter asks for findings that know their context. The same hash for stable and canary is normal after a
promotion and suspicious only while a canary has weight. An empty answer must not read as "all clear".

Argo Rollouts is Sextant's own extension since 0.30.0 (ADR-0162), so the work belongs there, on the public extension
API (agent tools, ADR-0159; problem judges, ADR-0168; problem categories), with one change to the core's MCP
`get_problems`.

## Decision

### Read as the controller reads, from its source

Every reading cites the controller of Argo Rollouts v1.10.2:

- **VirtualService references.** `GetVirtualServiceNamespaceName` cuts `.cluster.local`; the last dot-separated part
  is then the namespace.
- **Routes the controller edits.** It edits the routes named in `virtualService.routes`. With none named, it edits the
  only HTTP route, else the first route without a name (`getHttpRouteIndexesToPatch`). It refuses several unmanaged
  routes with none named (`ValidateHTTPRoutes`) and a route without both destinations (`validateDestinationRule`). It
  compares a destination's host up to its first dot (`getHost`).
- **Template hashes.** The controller sets the hashes of the DestinationRule's subsets and of the canary and stable
  Services' selectors itself (`UpdateHash`). It waits for the new ReplicaSet to be available before switching them
  (`shouldDelayDestinationRuleUpdate`), and sets no weight before that.
- **Measurements** (`EvaluateResult`):
  - with no condition, a measurement succeeds;
  - with only a `failureCondition`, NaN succeeds, since a comparison with NaN is false;
  - `result[0]` of an empty result is an Error.
- **Metric limits.** `assessMetricFailureInconclusiveOrError` fails a metric when `failed > failureLimit`. A negative
  limit never fails it. With a `consecutiveSuccessLimit` the metric can still fail.
- **Dry runs.** A `dryRun` rule's `metricName` is a regular expression (`GetDryRunMetrics`).
- **Workload scale-down.** `workloadRef.scaleDown` `onsuccess` and `progressively` scale the Deployment down only
  while the Rollout's first revision rolls out (`revision == 1`, a one-time migration); `never` (the default) leaves it
  alone (rollout/sync.go, rollout/replicaset.go). Pods of the Deployment's own under a later revision stay until
  someone scales it down: the tool warns of them, since both get the Service's traffic unless the selectors differ.

### One read-only agent tool, through the extension's backend

`diagnose-rollout` (`agentTools`, `readOnly: true`) takes a cluster, a namespace and either a Rollout's name or a
Deployment's. With a Deployment's name it finds the Rollout whose `workloadRef` names it, or says there is none. Its
reads go through `host` and are decided for the extension and the agent both (ADR-0159). They cover:
- the Rollout and the Deployment;
- the namespace's ReplicaSets, picked by owner uid;
- the VirtualServices, DestinationRule and Services the strategy names;
- the analysis templates it names;
- the namespace's AnalysisRuns, by owner uid, the newest 5;
- the Rollout's Events (`involvedObject.uid`).

Its answer has the Rollout's state and findings. Each finding is a `problem`, `warning`, `info` or `normal`. Problems
come first, and each finding's English text names its context: 0 replicas of a Deployment the controller scales
down are `normal`. The answer also has a timeline and `notChecked`:
- the timeline orders conditions, pauses, analysis runs, failing measurements and events;
- `notChecked` lists every refused or failed read and every traffic router other than Istio.

A refused read is never taken for "not there", and the Rollout's own read failing fails the call. Texts are clipped
to 300 characters, lists are bounded, and the answer carries `dataNotice`. It changes nothing and runs nothing. An
agent never gets more through it than its own Read allows.

### Problems: traffic in the main category, safety opt-in

The same pure readings (`traffic.ts`, `safety.ts`) feed the agent tool and two problem judges of the backend
(ADR-0168), so the window, the notifications and the agent tell the same.

- **`traffic` (main category, on by default).** It reads:
  - the Rollouts' `.spec.strategy` and `.status`;
  - the VirtualServices' `.spec.http`, optional and partial;
  - the DestinationRules' `.spec.subsets`, optional and partial;
  - the Services' `.spec.selector`, partial.

  It answers only problems: a missing VirtualService, route, DestinationRule or subset; a route the controller cannot
  choose, or one lacking the canary or the stable destination; and `same-hash`. `same-hash` holds only while an
  update runs (`currentPodHash` is not `stableRS`) and the canary has weight: the router's reported weight, else the
  route's, else the step's.

  A list not read in a namespace is "cannot tell". Each fact's `needs` names what it rests on. Every rule waits 5
  minutes, longer than the controller's wait for the new ReplicaSet.
- **`safety` (a new opt-in category `canary-safety`, never for agents).** It reads the templates' `.spec.metrics` and
  `.spec.dryRun` and the Rollouts' `.spec.strategy` and `.spec.replicas`. These are hints about intent, not breakage:
  - a metric that always passes, passes on NaN or without data, cannot fail, or runs dry;
  - a Rollout promoted on time alone, or shifting to a higher weight without a check;
  - a first step that sends all traffic;
  - a canary that lets every pod be unavailable.

  Whether a threshold suits an environment is not judged: nothing in the objects says which environment a cluster
  is. The agent tool tells the same as warnings.
- **Declarative rules.** Three more rules use the existing rule engine: `paused-long` (the first pause condition
  started over a day ago, not aborted), `analysis-inconclusive` (the controller's Inconclusive pause reasons) and
  `workload-missing` (`missing` on Deployments).

### A Deployment section

`managed-by-rollout` (`startHidden`) shows on a Deployment only when a Rollout of its namespace names it in
`workloadRef`. It names the Rollout, its phase, its `scaleDown`, and what the replica count means then. This is the
human side of the agent tool's finding.

### `get_problems` names what it did not look at

When asked for every category, it lists in `notShared` the enabled extensions that judge problems
(`grantedProblems`) and whose problems the user keeps from agents (`mcp.extensionProblems`, ADR-0146). It names the
ids only. An `ext:` category asked for whose extension is not installed, or is turned off, goes to `notInstalled`,
not `off`.

Each list comes with a note, and the tool's description says that every category not looked at is named (`off`,
`notShared`, `notInstalled`, `notChecked`, `notJudged`, `failed`). Nothing the user keeps from agents is told: only
that it exists.

## Consequences

- Argo Rollouts 1.5.0 reads Deployments, Services, Events, VirtualServices and DestinationRules, has a backend and an
  agent tool, and its rules judge and look up new kinds. Updating asks for consent once. It stays at `sextantApi` 4,
  so Sextant 0.30.0 runs it too.
- Traffic is judged for Istio's HTTP routes and the canary and stable Services only. TLS and TCP routes and the other
  routers are named, not judged.
- The safety checks recognise common forms of a condition that passes without data. A condition written otherwise is
  missed, which is why the category is opt-in.
- The extension queries no metric provider: the agent tool tells what the AnalysisRuns recorded.
