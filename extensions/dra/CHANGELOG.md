# Changes of Dynamic Resource Allocation

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Dynamic Resource Allocation view
(ADR-0116) as an extension.

- **A sidebar section "Dynamic Resource Allocation"** with Resource Claims, Claim Templates, Device Classes and
  Resource Slices in Sextant's tables, the built-in columns and the claims' "Only problems", and the page **Devices**:
  every device the ResourceSlices publish, by node, with the claim that holds it.
- **Details:** a claim's state, node, consumers, requests (CEL as text), allocated devices and the Pending Pods that
  wait for it; a template's requests; a class's CEL selectors and drivers' configuration; a slice's devices. Untitled
  sections with blocks remembered in Sextant's memory of details sections; lists watched only while their block is
  open, capped as the built-in view's (500 slices, 1000 claims of a namespace, 5000 claims, 500 Pending Pods).
- **On core kinds:** a Pod's **Devices** (its claims, their state and devices, and why it waits) and a Node's **DRA
  devices** (its slices' devices), each shown only where there is something to show.
- **Tables** on the page and in the details whose columns resize and are remembered, as the built-in tables'.
- **Problems:** one per Pod that waits for devices, as the built-in detector: a claim of its templates not made yet, a
  claim that does not exist, or one without devices while the scheduler names a DRA reason; only Pending Pods watched
  (at most 2000), counted on the section.
- **Pods with any number of claims, in any order** are told as the built-in detector told them, by five rules instead of
  29 (an `any` of `missing` and `related` lookups over every claim the Pod names or was made for), and the sentence
  without the scheduler's message names the claims without devices as well as those that do not exist.
- **Columns** with the built-in widths and sort orders, every pod, class and driver listed.
- Installing asks for consent to read the `resource.k8s.io` kinds and Pods, and to judge Pods (looking
  ResourceClaims up) in problem rules.
