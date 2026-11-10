# Changes of KEDA

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: the KEDA part of Sextant's former built-in autoscaling view
(ADR-0080) as an extension.

- **A sidebar section "KEDA"** after Trivy's, with Scaled Objects, Scaled Jobs, Trigger Authentications and Cluster
  Trigger Authentications in Sextant's table, the built-in columns (target, replica range, triggers, Ready, the state
  in one word, sources) in their widths, and "Only problems".
- **Details** without headings of their own, their blocks remembered in Sextant's memory of details sections: a
  ScaledObject's state in plain words, target, range, intervals and fallback, its triggers with their health, and the
  HPA KEDA manages with its verdict, causes and metrics (watched only while its block is open); a ScaledJob's state,
  maximum, strategy, image and triggers; where a (Cluster)TriggerAuthentication takes its parameters from, names only.
  The tables' columns resize and Sextant remembers their widths, as the built-in tables'.
- Installing asks for consent to read KEDA's kinds and HorizontalPodAutoscalers.
