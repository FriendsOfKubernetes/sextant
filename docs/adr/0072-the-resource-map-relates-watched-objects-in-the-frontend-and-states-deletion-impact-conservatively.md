# ADR-0072: The resource map relates watched objects in the frontend and states deletion impact conservatively

## Context

"What uses this ConfigMap?" and "what breaks if I delete this Secret?" have no answer in a table (#139): the links run both ways and through different mechanisms — owner references, label selectors with kind-specific meanings of an empty selector, volume and environment references, image pull secrets, Ingress and Gateway API backends and TLS references, claims and volumes, autoscaler targets, classes. Details already link an object to what it names, but not to what names it. A namespace's objects together form a picture nobody can hold in their head on a large cluster.

## Decision

- **Pure relation functions over watched objects** (`src/features/resource-map/relations.ts`, `selectors.ts`, `impact.ts`), no Rust command. An edge points from the object that names or selects to the one named or selected, so "what uses this" is the incoming edges. Selectors follow the API server's semantics per kind: a Service with a missing or empty selector selects nothing; a NetworkPolicy's empty `podSelector` selects every pod of the namespace; a PodDisruptionBudget (policy/v1) with an empty selector selects every pod, a missing one nothing; an unknown operator never matches. Gateway API routes are read through the Gateway API model (ADR-0063), so a backend means the same here as there.
- **Two views.** A **Related** tab on every object's details: the impact of a deletion in plain words, then the relations one hop both ways, grouped ("Mounted by", "Owns", "Selects", …), each object expandable hop by hop. A **Map** page (Cluster section): the objects of the chosen namespaces in fixed columns from the way in (Ingresses, Gateways, routes) to Services and policies, workloads, ReplicaSets and Jobs, pods, configuration and claims, cluster objects; coloured by the problems screen's rules (ADR-0066), so red means the same in both places.
- **Impact is stated conservatively.** Each consequence is one i18n sentence with a count (no glued fragments). The cascade follows owner references **by uid** only, and a dependent counts as deleted only when every owner it names is gone (Kubernetes keeps it while any owner exists; an unwatched owner counts as staying). "Will create it again" only for real recreation: a ReplicaSet, StatefulSet or DaemonSet its pods, a Job its pods while unfinished, a Deployment only its current ReplicaSet; a CronJob never recreates a deleted Job. References marked `optional` do not count. Protections are named (pvc-protection, pv-protection: the deletion waits).
- **Bounded watches.** A namespaced object watches its namespace's lists of the served kinds (`NAMESPACE_KINDS`); a cluster-scoped one only the lists that can name it (a Node: pods by `spec.nodeName`; a StorageClass: PersistentVolumes; an IngressClass or GatewayClass: their objects). The Related tab opens at most 4 namespaces at once, the map 3 (with "All namespaces" it asks for a choice); nothing is watched before discovery or for kinds the cluster does not serve. Watches are shared between the map and the tab (one per kind and namespace, released 5 s after the last user, updates flushed every 100 ms) and dropped on connect or disconnect (`epochOf`, as in ADR-0066). The map draws at most 400 nodes: the pods (ReplicaSets, Jobs) of one owner collapse above 5, a kind above 30 per namespace, an expanded group shows up to 100.
- **Read-only.** Nothing is deleted or changed from these views; Delete stays the generic action with its confirmation.

## Why

- Computing in Rust was rejected: the inputs are watched objects, the views are live, and the relations reuse frontend models (Gateway API, problem rules); a command would duplicate data across the ts-rs boundary for results that are only displayed.
- Watching the whole cluster for the graph was rejected: thousands of pods and every ConfigMap of a large cluster would be listed for one details tab. Per-namespace lists answer almost every question, and the tab says which lists it read.
- A graph layout library was rejected: the columns are known in advance, and a layered drawing with two ordering sweeps is enough without 100+ KB of dependency.
- Promising more ("will break", "safe to delete") was rejected: only watched objects are seen, controllers may recreate what they own, and an unwatched owner may keep a dependent. The text says what the visible objects imply.

## Consequences

- Relations from namespaces that are not open (except Gateway API routes reaching a Service through the section's reverse links) are not shown; "Nothing among the watched objects depends on it" is literally that.
- ConfigMaps and Secrets are not listed per namespace: they appear when something names them, so one that nothing names appears only in its own Related tab.
- Tests: `relations.test.ts`, `selectors.test.ts`, `layout.test.ts`, `related.test.tsx`, `map.test.tsx`.
