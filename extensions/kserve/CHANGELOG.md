# Changes of KServe

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in KServe view (ADR-0115) as an
extension.

- **A sidebar section "KServe"** with Inference Services, Serving Runtimes, Cluster Serving Runtimes, Inference Graphs
  and Trained Models in Sextant's tables, and the built-in columns with their widths, sort orders and hovers (an
  InferenceService's state muted when stopped, why on hover in KServe's order; every model format and protocol of a
  runtime; an InferenceGraph's nodes), their filters (states by name, node counts as numbers), and "Only problems".
- **Details:** an InferenceService's state and why, URL, deployment mode, components with their revisions, traffic
  split and what KServe made for them, the model status and the serving runtime KServe chooses; a runtime's model
  formats; an InferenceGraph's nodes and steps; a TrainedModel's InferenceService and storage. The tables' columns
  resize and Sextant remembers their widths, as the built-in ones'. URIs never show their
  credentials or query. Untitled sections as the built-in one, their blocks remembered in Sextant's own memory of
  details sections with "Expand all" and "Collapse all"; the runtimes and what KServe made watched only while their
  blocks are open, kept to the built-in caps by Sextant.
- **Problems:** models that failed to load, specs KServe cannot serve and InferenceServices not ready for ten minutes,
  with the built-in reasons (`<type>False` where a condition gives none, a condition outside KServe's list told too),
  counted on the section.
- Installing asks for consent to read KServe's kinds, Knative Services, Deployments and Services, and to judge
  InferenceServices in problem rules.
