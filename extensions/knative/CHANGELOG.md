# Changes of Knative

## 1.1.0 — 2026-11-13

Needs Sextant 0.30 (`sextantApi` 4).

- **Filter** of a Trigger with one older filter attribute of another name and an empty value shows `name=*` again, as
  the built-in view wrote it, through a placeholder's literal fallback (ADR-0167, #417). It showed `name=`.
- No new permission or problem kind: updating asks for no consent again.

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Knative Serving and Knative Eventing
views (ADR-0101, ADR-0106) as an extension.

- **Two sidebar sections, "Knative Serving" and "Knative Eventing",** with Services, Configurations, Revisions, Routes
  and Domain Mappings, and Brokers, Triggers, Channels, In-Memory Channels, Subscriptions, Sequences, Parallels and
  the sources in Sextant's tables, with the built-in columns (their widths, the states sorted and filtered by name and
  Unknown muted, the first failing condition's reason, every target of the traffic split and each filter of a Trigger, their whole text on hover)
  and "Only problems".
- **Details:** why an object is not ready in plain words; a Service's revisions and traffic split (its columns
  resizing, their widths remembered by Sextant, as the built-in table's); a Revision's
  replicas and images; where an Eventing object sends its events, a Trigger's filter in words, and the event path from
  the sources through a Broker or Channel to the subscribers — in the built-in section's blocks, kept open or closed in
  Sextant's own memory of details sections, the event path read only while its block is open.
- **Problems:** Services, Configurations and Eventing objects not ready for two minutes, with the reason, message and
  time of the first failing condition other than `Ready` (else `Ready`'s own, "NotReady" without one), each told once,
  through the object that made it or the Broker that caused it, counted on each section.
- Installing asks for consent to read the seventeen Knative kinds and to judge fourteen of them in problem rules.
