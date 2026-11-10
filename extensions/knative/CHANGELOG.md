# Changes of Knative

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Knative Serving and Knative Eventing
views (ADR-0101, ADR-0106) as an extension.

- **Two sidebar sections, "Knative Serving" and "Knative Eventing",** with Services, Configurations, Revisions, Routes
  and Domain Mappings, and Brokers, Triggers, Channels, In-Memory Channels, Subscriptions, Sequences, Parallels and
  the sources in Sextant's tables, with the built-in columns (their widths, the states sorted and Unknown muted, the
  first failing condition's reason) and "Only problems".
- **Details:** why an object is not ready in plain words; a Service's revisions and traffic split; a Revision's
  replicas and images; where an Eventing object sends its events, a Trigger's filter in words, and the event path from
  the sources through a Broker or Channel to the subscribers — in the built-in section's blocks, kept open or closed in
  Sextant's own memory of details sections, the event path read only while its block is open.
- **Problems:** Services, Configurations and Eventing objects not ready for two minutes, with the reason, message and
  time of the first failing condition other than `Ready` (else `Ready`'s own, "NotReady" without one), each told once,
  through the object that made it or the Broker that caused it, counted on each section.
- Installing asks for consent to read the seventeen Knative kinds and to judge fourteen of them in problem rules.
