# Prometheus Operator

Read-only views of [Prometheus Operator](https://prometheus-operator.dev) objects (`monitoring.coreos.com`), in every
language Sextant has. It lists ServiceMonitors, PodMonitors, Probes, PrometheusRules, Prometheuses and Alertmanagers in
a sidebar section of their own with Sextant's tables; shows for a monitor the namespaces it looks in, its selector, the
Services (Pods) it selects right now and whether its endpoints' port names exist on them; tells which Prometheus (or
PrometheusAgent) picks a monitor, probe or rule up by its selectors; lists a rule's groups; and tells Prometheus and
Alertmanager readiness from the operator's conditions. Monitors that select nothing and Prometheuses and Alertmanagers
not available are problems of an opt-in category. It replaces Sextant's former built-in Prometheus Operator view (ADR-0100) with the same behaviour; the
places where the extension API cannot say exactly the same are in "Requirements and limits". Its id is
`sextant.prometheus-operator`. Why it is built this way: ADR-0100 (the readings and problems), ADR-0139 (Sextant's own
extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of their own, `not`), ADR-0153 (computed columns),
ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an item,
notification groups), ADR-0163 (field values in texts, a problem's reason), ADR-0165 (a kind's own "Only problems") and
ADR-0167 (the counter's own label, problem categories of the extension's own, a rule's `selectsNone`, column widths,
sort keys and filters by value, counts, map entries and lists of items, placeholder fallbacks and filters — `|selector`,
`|countAll` and `|product` among them —, untitled details sections, unreadable times, details blocks in Sextant's own
memory).

## At a glance

| | |
|---|---|
| Id | `sextant.prometheus-operator` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `prometheus-operator-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Prometheus Operator |
| Checked against | Prometheus Operator's own API (`monitoring.coreos.com/v1`, PrometheusAgent `v1alpha1`): the selectors' null and empty meanings, `ignoreNamespaceSelectors` (`getNamespacesFromNamespaceSelector`, `pkg/prometheus/promcfg.go`), the `Available`/`Reconciled` conditions |

## What it adds

**A sidebar section "Prometheus Operator"** (`prometheusOperator`), shown while the cluster serves any of its kinds,
with the built-in section's icon and place (after Sealed Secrets): Service Monitors, Pod Monitors, Probes, Prometheus
Rules, Prometheuses and Alertmanagers, with Sextant's own table, filters, selection bar and details, and Edit and Delete
as on every kind. The section's counter shows how many objects need attention (monitors that select nothing,
Prometheuses and Alertmanagers not available), only while the opt-in category below is on.

**"Only problems"** on Prometheuses and Alertmanagers, as the built-in tables had it: not available (`Available`
False, else `Reconciled` False) or degraded (`Available` Degraded); on ServiceMonitors and PodMonitors, those that
select nothing, from the problem rules below while their category is on.

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), after Namespace, each with
the built-in column's width:
- ServiceMonitors and PodMonitors: **Namespaces** (`sm-namespaces`, `pm-namespaces`: "Every namespace", or the names of
  `namespaceSelector.matchNames`, each once and sorted, else its own namespace), **Selector** (`sm-selector`,
  `pm-selector`: the selector as the API server writes a label selector, "Everything" for an empty or missing one
  (sorted first), "Nothing" for an operator Kubernetes does not know (sorted last)) and **Ports** (`sm-ports`,
  `pm-ports`: each endpoint's port name, else its target port, else its number).
- Probes: **Prober** (`probe-prober`), **Module** (`probe-module`) and **Interval** (`probe-interval`).
- PrometheusRules: **Groups** (`rule-groups`) and **Rules** (`rule-rules`: over every group), numbers.
- Prometheuses and Alertmanagers: **Status** (`prom-status`, `am-status`: Available, Degraded, Failed or Pending,
  coloured, the deciding condition's reason and message on hover; sorted and filtered by the state's name, `ready`,
  `degraded`, `failed` or `pending`, in every language), **Replicas** (`prom-replicas`, `am-replicas`: available of
  replicas × shards), **Version** (`prom-version`, `am-version`: `spec.version`, else `status.version`) and **Reason**
  (`prom-reason`, `am-reason`: the deciding condition's reason).

**Details** (`prometheus-operator`, no heading of its own, as the built-in section had none), drawn with the SDK's UI
kit in the classes of Sextant's own details panel; its blocks open and close as the built-in ones (open at first,
remembered in Sextant's own memory of details sections, with the panel's "Expand all" and "Collapse all"), and a closed
block draws and watches nothing:
- a ServiceMonitor or PodMonitor: the namespaces it looks in (its own only when every Prometheus that picks it up has
  `ignoreNamespaceSelectors`, with a note saying so; its own too when some have), its selector and job label; a block
  **Selects now** with the Services (Pods) its selector selects — the selector sent to the API server as a label
  selector, in its namespaces (at most 20; a monitor of every namespace cluster-wide by its selector, unless the
  selector is empty: then "not listed") — at most 30 listed by name, each a link, "Selects no Service: Prometheus
  scrapes nothing for it." in red when none, and a table of its endpoints (port, path, interval, and on how many of the
  selected objects the port name exists, red on none, amber on some); a block **Picked up by** with each Prometheus or
  PrometheusAgent whose selectors pick it up, a link, or why none does;
- a Probe: prober, module, interval, static targets and Ingress selector, and **Picked up by**;
- a PrometheusRule: a block **Rule groups** (group, interval, alerting and recording rules) and **Picked up by**;
- a Prometheus or Alertmanager: why it is not available (the operator's message, in red), its state, reason,
  available replicas of desired, shards, version, retention and whether it is paused; for a Prometheus a block **What it
  picks up** with its selectors of ServiceMonitors, PodMonitors, Probes and PrometheusRules and their namespaces.

The Prometheus and PrometheusAgent lists (every namespace, of the kinds the cluster serves) are watched while a monitor
is shown or a "Picked up by" block is open; the Namespaces' labels (metadata only) only when one of them selects
namespaces by labels; a monitor's targets while "Selects now" is open.

The details' tables keep the built-in ones' columns on one line (the rest wrap between words); their columns resize,
and Sextant remembers their widths, as the built-in tables did.

## Permissions

- **Read** ServiceMonitors, PodMonitors, Probes, PrometheusRules, Prometheuses, Alertmanagers and PrometheusAgents in
  every namespace of every cluster: the details read the shown object and tell which Prometheus picks it up.
- **Read** Services and Pods: "Selects now" lists those a monitor selects, with their ports. **Read** Namespaces: their
  labels, when a Prometheus selects namespaces by labels.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge ServiceMonitors, PodMonitors, Prometheuses and Alertmanagers, and look up Services and Pods
  by their labels for the monitors; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `prometheusOperator`: the extension's own category **Prometheus Operator**
(`prometheus-operator`), opt-in — off until turned on on the Problems page. A Prometheus or Alertmanager (not being
deleted) that is not available, not reconciled or degraded is a problem 5 minutes after the deciding condition changed
(5 minutes after it was first seen when the condition has no time), with the operator's reason (else `NotAvailable` or
`Degraded`) and message; the three are one notification group (`not-ready`). A ServiceMonitor (PodMonitor) whose
selector (none selects every one) picks no Service (Pod) in the namespaces it looks in —
`namespaceSelector.matchNames`, else its own — is a problem `SelectsNothing` at once, "Selects no Service in the
namespaces: default"; it is judged on the cluster's Services (Pods) and only when their list is read in full and covers
those namespaces, and, as the built-in provider did, never for a monitor of every namespace.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `prometheus-not-available` | Prometheus | `Available` False | 5 minutes | No |
| `prometheus-not-reconciled` | Prometheus | `Reconciled` False, `Available` not False | 5 minutes | No |
| `prometheus-degraded` | Prometheus | `Available` Degraded, `Reconciled` not False | 5 minutes | No |
| `alertmanager-not-available` | Alertmanager | `Available` False | 5 minutes | No |
| `alertmanager-not-reconciled` | Alertmanager | `Reconciled` False, `Available` not False | 5 minutes | No |
| `alertmanager-degraded` | Alertmanager | `Available` Degraded, `Reconciled` not False | 5 minutes | No |
| `service-monitor-selects-nothing` | ServiceMonitor | Its selector picks no Service in its namespaces | None | No |
| `pod-monitor-selects-nothing` | PodMonitor | Its selector picks no Pod in its namespaces | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0100).

## What it does not do

- It does not ask Prometheus, Alertmanager or the operator anything: every value comes from the objects' own fields.
  It does not read ServiceMonitors' `status.bindings`, so a Prometheus that rejected a monitor still counts as picking
  it up.
- It does not install or upgrade Prometheus Operator, and does not show PrometheusAgents, ScrapeConfigs or
  AlertmanagerConfigs in its section.

## Requirements and limits

- Prometheus Operator's CRDs (`monitoring.coreos.com/v1`); the section shows only where the cluster serves them.
  PrometheusAgents (`v1alpha1`) are read where served.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - **Not picked up.** The built-in category also had a monitor that no Prometheus picks up (`NotPickedUp`, a warning
    listed only): a rule cannot ask whether any object of another kind (a Prometheus, in any namespace) has a label
    selector matching the judged object's labels and a namespace selector matching its namespace; `relatedBy` joins
    equal field texts in the judged object's namespace only. The details still say it.
  - **Selects nothing** is judged on the namespaces the monitor names, also when every Prometheus that picks it up has
    `ignoreNamespaceSelectors` (then the built-in judged its own namespace only). The Services' and Pods' metadata is
    listed cluster-wide, at most 5000 of each, for the rules (the built-in listed it only in the at most 40 namespaces
    the monitors named): beyond 5000 it cannot tell, but it judges monitors of any number of namespaces.
  - **Rules** counts every rule of every group; the built-in counted those with an `alert` or `record` name, which every
    rule the operator accepts has.
  - **Namespaces** sorts by the shown list; the built-in sorted by the names joined with commas (the same order but for
    the separators). An endpoint with neither a port name, a target port nor a number leaves nothing in **Ports**.
- Checked by tests on fixtures of Prometheus Operator's objects (copied from the built-in view) against the built-in
  readings and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Prometheus Operator" section:** the cluster does not serve its kinds, or the extension is disabled.
- **The counter shows nothing:** the category "Prometheus Operator" is off; turn it on on the Problems page.
- **"Not known: the labels of the namespaces could not be read." in "Picked up by":** a Prometheus selects namespaces
  by labels and the Namespaces could not be listed with your credentials.
- **"The list could not be read." in "Selects now":** the Services (Pods) could not be listed in the monitor's
  namespaces with your credentials.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Prometheus Operator.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/prometheus-operator        # → extensions/prometheus-operator/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/prometheus-operator
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds its watches;
  `dom.ts` keeps the blocks in Sextant's memory (`BlockMemory`).
- `model.ts` reads Prometheus Operator's fields; it is the former built-in view's model, ported, with its problem
  detector (`prometheusOperatorProblems`), "Only problems" (`isServerProblem`) and its monitors' judgement across
  objects (`judgeMonitors`) kept as the reference the manifest is tested against (`selectsNone` through Sextant's
  `judgeAcross`).
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's
  `prometheusoperator` texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every
  language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with
     `prometheus-operator` and the commit (add `prometheus-operator` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
