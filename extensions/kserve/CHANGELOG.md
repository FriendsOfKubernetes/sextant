# Changes of KServe

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in KServe view (ADR-0115) as an
extension.

- **A sidebar section "KServe"** with Inference Services, Serving Runtimes, Cluster Serving Runtimes, Inference Graphs
  and Trained Models in Sextant's tables, and the built-in columns and "Only problems".
- **Details:** an InferenceService's state and why, URL, deployment mode, components with their revisions, traffic
  split and what KServe made for them, the model status and the serving runtime KServe chooses; a runtime's model
  formats; an InferenceGraph's nodes and steps; a TrainedModel's InferenceService and storage. URIs never show their
  credentials or query.
- **Problems:** models that failed to load, specs KServe cannot serve and InferenceServices not ready for ten minutes,
  counted on the section.
- Installing asks for consent to read KServe's kinds, Knative Services, Deployments and Services, and to judge
  InferenceServices in problem rules.
