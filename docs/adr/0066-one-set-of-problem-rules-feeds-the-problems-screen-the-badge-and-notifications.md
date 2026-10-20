# ADR-0066: One set of problem rules feeds the problems screen, the section badge and the notifications

## Context

"What is broken in this cluster?" had no single answer: the overview counted some states, the Gateway API, Flux and Argo CD sections had their own problem markers, and a pod's details explained its own containers. The problems screen (#136) lists everything that is red, the Cluster section header shows a count, and desktop notifications (#135, ADR-0067) tell the user when something starts to fail. If each of these decided on its own what a problem is, they would disagree: a badge saying 3 with a screen listing 5, or a notification about something the screen does not show.

## Decision

- **One pure rule set**, `src/features/problems/model.ts`, with no React: `detect(kind, object)` returns what is wrong with one object, `resolve` turns it into problems with a stable `key` (`uid|reason`) and a `notifyKey`, and `isActive(problem, now)` says whether it counts now. The categories are nodes (NotReady, pressure), pods (CrashLoopBackOff, image pulls, OOM kills, recent restarts, pending with the scheduler's reason, not ready), workloads (unavailable replicas outside a rollout, a rollout without progress for 10 minutes), Jobs, volume claims (pending, lost), cert-manager Certificates (not ready, expiring within 14 days, expired), Flux, Argo CD and Gateway API objects (judged by those sections' own helpers, not by a copy of them) and Warning events.
- **Time is part of the rule, not of the caller.** A rule says when a state began (`since`, or first seen), its grace (2 or 5 minutes for states that often heal by themselves), `activeFrom` (a certificate counts 14 days before expiry) and `until` (a restart stops counting after 15 minutes), so a problem appears or goes away as time passes without a new watch update; the users re-evaluate every 30 seconds.
- **Notifications follow the owner.** `notifyKey` is the owner's identity where runs and replicas come and go (a CronJob for its Jobs, the Deployment, StatefulSet, DaemonSet or Job of a pod) plus a reason group, so a crash-looping Deployment is one state, not one per pod or per restart. Each detection says whether it is worth a notification at all (`notify`); the badge counts only those, so a pending pod, a single restart or a Warning event shows on the screen but neither in the badge nor as a notification.
- **Shared watches, problems only.** `store.ts` opens one watch per (cluster, kind) for every user (`acquireSource`, refcounted, closed 5 s after the last release so a remount reuses it), reduces each update to the problems of the objects in it and drops the objects; at most 2000 objects with problems are kept per kind (the screen says when it truncated). Kinds of installed tools are watched only once discovery serves them, at the served version.
- **A connection change drops the cluster's sources.** On connect and disconnect the cluster's sources go and its `epochOf` moves on; users acquire again. The backend closes a cluster's watches on disconnect without an event, so a source kept across it would never update again.
- **Entirely in the frontend**, like ADR-0063: no Rust command, nothing written to the cluster.

## Why

- Detection in Rust (`sextant-core`) was rejected: every input is an object the window already watches, the Flux, Argo CD and Gateway API judgements are frontend helpers, and the results are only displayed and notified by the window; a second implementation across the ts-rs boundary would drift.
- Keeping objects in the store was rejected: a big cluster's pods, events and nodes are tens of megabytes, while the problems are a few hundred entries.
- Counting every problem in the badge was rejected: a busy cluster always has a pending pod or a Warning event, and a badge that never goes to zero is ignored.
- Each view with its own watches was rejected: the badge, the screen and the notifications look at the same kinds of the same cluster, often at once.

## Consequences

- A new kind of problem is added in one place and appears on the screen, in the badge (if `notify`) and in notifications together; tests in `model.test.ts` cover the rules.
- On a large cluster the shared watches of pods, events and nodes stay open while the screen, the badge or notifications need them; notifications keep them open in the background for connected clusters (ADR-0067).
- The judgement is Sextant's: thresholds such as the 10 minute rollout stall, the 14 day certificate warning and the graces are constants in `model.ts`, not settings.

Amended (v0.16.0): AI agents get the screen's findings through the read-only MCP tool `get_problems` (#210, ADR-0094): the backend checks the agent's Read rules, the window computes from these same shared sources and rules (no second detector), and the backend filters the answer again; opt-in categories only while they are on, `credentials` never.
