# Dynamic Resource Allocation

Read-only views of Kubernetes [Dynamic Resource Allocation](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
(`resource.k8s.io`), in every language Sextant has. It lists ResourceClaims, ResourceClaimTemplates, DeviceClasses
and ResourceSlices in a sidebar section of their own with Sextant's tables, in whichever version the cluster serves
(v1, v1beta2, v1beta1, v1alpha3, each object read by the fields it has); tells a claim's state, requests (CEL
selectors shown as text, never evaluated), allocated devices, node and consumers; lists every device the slices
publish on a "Devices" page; adds the devices of a Pod and of a Node to their details; and reports Pods that wait for
devices. It replaces Sextant's former built-in Dynamic Resource Allocation view (ADR-0116) with the
same behaviour where the extension API can say it (see "Requirements and limits"). Its id is `sextant.dra`. Why it
is built this way: ADR-0116 (the readings, CEL as text, the problems), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0144 (`missing`), ADR-0152 (kinds in a section of its own), ADR-0153 (computed columns), ADR-0160
(the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification
groups, hiding a section), ADR-0163 (field values in texts, a problem's reason from the object), ADR-0164 (case
tooltips, deeper conditions) and ADR-0167 (the counter's own label, a details section's condition, text conditions,
`related`, a rule's field selector and cap, lists in columns, untitled sections, blocks in Sextant's memory, capped
watches).

## At a glance

| | |
|---|---|
| Id | `sextant.dra` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `dra-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Dynamic Resource Allocation |
| Checked against | `resource.k8s.io` as kubernetes/kubernetes `staging/src/k8s.io/api/resource/<version>/types.go` defines it in v1alpha3 (1.31), v1beta1 (1.32), v1beta2 (1.33) and v1 (1.34) |

## What it adds

**A sidebar section "Dynamic Resource Allocation"** (`dra`), shown while the cluster serves one of its kinds, with the
built-in section's icon, in the built-in section's place: Resource Claims, Claim Templates, Device Classes and
Resource Slices, each with Sextant's own table, filters, selection bar and details, and Edit and Delete as on every
kind. The section's counter shows how many pods wait for devices (the problems below).

**A page "Devices"** (`devices`) in the section: every device the cluster's ResourceSlices publish (at most 500
slices read, said when there are more), one row each, sorted by node, then driver and slice — its node (or where it is
reachable), driver, pool and name, the product or model the driver names, its capacities, and the claim that holds it
(or "Free"; "Cannot tell" when the claims cannot be read in full, at most 5000); the totals ("3 devices, 1
allocated"), at most 1000 rows drawn.

**"Only problems"** on Resource Claims, as the built-in table had it: the claims whose binding failed.

**Columns**, after Name (and Namespace), in place of the built-in ones, with their widths and sort orders:
- Resource Claims: **State** (`claim-state`: In use, Allocated, Pending, Binding failed or Deleting, coloured — Deleting
  muted —, sorted by the state), **Device classes** (`claim-classes`: every class its requests and their choices name,
  each once), **Devices** (`claim-devices`: how many are allocated; the device on hover), **Node** (`claim-node`: the
  node an allocation is bound to by name) and **Reserved for** (`claim-reserved-for`: every pod).
- Claim Templates: **Device classes** (`template-classes`) and **Requests** (`template-requests`).
- Device Classes: **Selectors** (`class-selectors`: how many CEL selectors; on hover each on a line), **Drivers**
  (`class-drivers`: every driver it configures, each once) and **Extended resource** (`class-extended-resource`).
- Resource Slices: **Node** (`slice-node`: the node, or All nodes, Nodes by selector — the selector on hover —, Set per
  device or Not stated, sorted as the built-in column), **Driver** (`slice-driver`), **Pool** (`slice-pool`) and
  **Devices** (`slice-devices`).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, in untitled sections as the
built-in ones; their blocks open and close with their titles and are remembered in Sextant's own memory of details
sections (with "Expand all" and "Collapse all"), and a list is watched only while the block that shows it is open:
- **ResourceClaim** (`resource-claim`): its state, the node its devices are bound to (or the node selector, as text),
  when they were allocated, the Pod it was made for, who reserved it, and what the state means; its requests (each
  request or `firstAvailable` choice with its device class, CEL selectors as written, and how many devices, with admin
  access); the allocated devices (request, driver, pool and device, admin access, binding conditions that failed or
  are awaited); and, while it is not allocated, the Pending Pods of its namespace that use it with the scheduler's
  message and its DRA reasons in plain words (watched by `status.phase=Pending` in its namespace, at most 500).
- **ResourceClaimTemplate** (`resource-claim-template`): the requests its claims will have.
- **DeviceClass** (`device-class`): the extended resource name, its CEL selectors as text (never evaluated), and each
  driver's opaque configuration.
- **ResourceSlice** (`resource-slice`): driver, pool, pool generation and slice count, where its devices are
  reachable, and its devices with the claim that holds each (every ResourceClaim watched, at most 5000).
- **Devices** (`pod-devices`) on a Pod that uses claims (`spec.resourceClaims`; a Pod without them shows no block):
  each claim it uses — its name in the Pod, the claim (or "From template …", "Not needed"), the claim's state ("Not
  created yet", "Does not exist", "Cannot tell"), its devices and the containers that use it — and, while the Pod
  waits for a node, the scheduler's message and its DRA reasons in plain words (the ResourceClaims of its namespace
  watched, at most 1000; nothing watched where the cluster serves no ResourceClaims, which it says).
- **DRA devices** (`node-devices`) on a Node: the devices of its ResourceSlices (watched by `spec.nodeName=<node>`, at
  most 500) with the claims that hold them, at most 200 rows. The section starts hidden and shows itself once the
  slices are read and there are some (or they cannot be told), so a node without any, or a cluster that serves no
  ResourceSlices, shows nothing; a closed block looks at the slices once and then watches nothing.

Every object named is a link to its details in Sextant's panel; a link to a DRA object keeps the version of the
object it comes from.

The tables' columns, on the page and in the details, resize (drag a header's right edge) and Sextant remembers their
widths, as the built-in view's did; the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** ResourceClaims, ResourceClaimTemplates, DeviceClasses and ResourceSlices (each section reads the object it
  shows; the claims, slices and devices views watch them), and Pods (a Pod's block reads it; a pending claim's
  details watch the Pending Pods of its namespace), in every namespace of every cluster. A Node's block reads only
  the slices of that node, not the Node.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge Pods and look ResourceClaims up; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `dra`, on by default: a Pod the scheduler has not placed (Pending, no node, `PodScheduled`
not True, not held by a scheduling gate, not being deleted) because of its claims — a claim of its templates is not
made yet, a claim it uses does not exist, or one exists without devices while the scheduler's message names a DRA
reason ("cannot allocate all claims", "device class … does not exist", "resourceclaim not available on the node", …)
— counted 5 minutes after its `PodScheduled` condition changed (else after it was created). As the built-in detector,
one problem per Pod (reason `DraWaiting`), whose text is the scheduler's message, else "Waits for devices of claims
that are not allocated or do not exist: …" with the claims; one notification per Pod's owner. The rules watch only the
Pending Pods (`status.phase=Pending` on the API server, at most 2000) and look the ResourceClaims up.

The rules hold on shapes of the Pod's claims that exclude each other, so that at most one stands: a claim it names
(`spec.resourceClaims[].resourceClaimName`) and a claim the resource claim controller made from a template
(`status.resourceClaimStatuses[].resourceClaimName`, a "made" claim). All of them are the one notification group
`claims-not-created` (a rule's id: the window's judge across objects finds the rule of a problem by its group).

| Id | When it holds | Text |
|---|---|---|
| `claims-not-created` | A claim of its templates is not made yet (fewer `status.resourceClaimStatuses` than template entries) | The scheduler's message |
| `named-claim-missing`, `made-claim-missing` | Its one claim (named, or made) does not exist | The scheduler's message |
| `named-claim-unallocated`, `made-claim-unallocated` | Its one claim exists without devices, and the message names a DRA reason | The scheduler's message |
| `named-made-first-missing`, `two-named-first-missing`, `two-made-first-missing` | Of a named and a made claim (two named, two made), the named (first) one does not exist | The scheduler's message |
| `named-made-second-missing`, `two-named-second-missing`, `two-made-second-missing` | The first exists, the made (second) one does not | The scheduler's message |
| `named-made-first-unallocated`, `two-named-first-unallocated`, `two-made-first-unallocated` | Both exist, the first without devices, and the message names a DRA reason | The scheduler's message |
| `named-made-second-unallocated`, `two-named-second-unallocated`, `two-made-second-unallocated` | The first has devices, the second exists without, and the message names a DRA reason | The scheduler's message |
| `claims-not-created-no-message` | As `claims-not-created`, without the scheduler's message | The sentence with every claim of the Pod |
| `named-claim-missing-no-message`, `made-claim-missing-no-message` | As `…-claim-missing`, without the message | The sentence with the claim |
| `named-made-both-missing-no-message`, `two-named-both-missing-no-message`, `two-made-both-missing-no-message` | Neither of its two claims exists, without the message | The sentence with both |
| `named-made-first-missing-no-message`, `two-named-first-missing-no-message`, `two-made-first-missing-no-message` | The first does not exist, the second does, without the message | The sentence with the first |
| `named-made-second-missing-no-message`, `two-named-second-missing-no-message`, `two-made-second-missing-no-message` | The first exists, the second does not, without the message | The sentence with the second |

A claim that cannot be looked up (the cluster's ResourceClaims not read in full, at most 5000, or not readable) is
"cannot tell", never a problem. The counter on the section counts the Pods.

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only. It has no action of its own.

## What it does not do

- It never evaluates a CEL expression: selectors are shown as written, so it cannot say which devices a request or a
  class would match.
- It does not create, allocate, reserve or delete claims, or change slices or classes.
- It does not talk to DRA drivers or the kubelet.

## Requirements and limits

- A cluster that serves `resource.k8s.io` (Kubernetes 1.31 or later; v1 is served by default from 1.34) and, for
  devices to show, a DRA driver that publishes ResourceSlices.
- Where it still differs from the former built-in view, because the extension API cannot say it yet:
  - **Claims that cannot be read.** Where the ResourceClaims are not read in full, the built-in detector still counted
    a Pod whose scheduler message names a DRA reason; a rule's looked-up claim is "cannot tell" then, so only a Pod
    whose template claims are not made yet is told. A rule condition (or a rule-level fallback) for "the looked-up
    list cannot tell" would close it.
  - **Pods with more than two claims**, or with two in an order the rules do not look at (a named claim not among the
    first two entries, a made one after a status entry without a name), are told only when a template claim is not
    made yet. A rule judges a looked-up claim only at one path, and `missing`/`related` cannot be inside `any` or
    `not`, so "any claim of the list is missing / exists without devices" takes a rule per shape of the list, and 29
    of the 30 rules are used for one and two claims. `missing`/`related` over a `[*]` path (any item), or allowed in
    `any`, would make it one rule.
  - **The sentence without the scheduler's message** names the claims that do not exist; the built-in one also named
    a second claim that exists without devices, and named them in the Pod's order (a named one and a made one: the
    named one first here). For a Pod with a template claim not made yet it names every claim of the Pod (the built-in
    one: those without devices). The same per-shape limit; a placeholder of the looked-up claims' names would close it.
  - **What the rules watch.** The built-in detector looked at the ResourceClaims of only the namespaces where a Pending
    Pod waits (at most 40) and nothing on a cluster without a DeviceClass; here every ResourceClaim of the cluster is
    looked up (at most 5000: beyond it, claims cannot be told), and the Pending Pods are watched on any cluster (a Pod
    using claims on a cluster without DeviceClasses can be told "not made yet"). A looked-up list narrowed to the
    namespaces of the judged objects, and a rule gate "where an object of a kind exists", would close it.
  - The scheduler's DRA reasons are lists of texts (`contains`, case-blind) for the built-in regular expressions; for
    `resourceclaim "…" not found`, `… is being deleted` and `device class … does not exist` the two parts are looked for
    anywhere in the message, not next to each other (no pattern language, by design: #405).
  - Notifications follow the Pod's owner as the built-in ones did, under the group's name; a Pod's problem passing from
    one rule to another (a second claim disappearing) is the same problem (`<uid>|DraWaiting`, its first sighting kept).
  - **Binding failed** (the State column and "Only problems") compares the first allocated device with the first entry
    of `status.devices`, its first two `bindingFailureConditions` with its first three conditions; the built-in view
    looked at every device. A condition that matches items of two lists to each other would close it.
  - **Hovers** hold at most five placeholders: the Devices hover shows one allocated device in full and, with more, the
    first followed by "…" (the built-in one listed all); the Selectors hover lists five selectors (past five, four and
    "…"); a slice's selector hover is exact for one term with one expression or field of up to two values, else its
    first expression and "…". A list item template for hovers (as a list column's `items`) would close it.
  - Device classes lists the classes of exact requests before those of `firstAvailable` choices (the built-in cell
    followed the requests' order), and the choices of the first six requests. Nested `[*]` paths that flatten (each
    request's choices) would close it.
  - List columns (Device classes, Reserved for, Drivers) hover their whole text, which the built-in cells did not.
- Checked by tests on fixtures of every `resource.k8s.io` version (copied from the built-in view) against the
  built-in readings, columns and problem detector — the rules through Sextant's own window engine and judge across
  objects, for every state of one and two claims with and without the scheduler's message —; not yet tried on a live
  cluster.

## Troubleshooting

- **No "Dynamic Resource Allocation" section:** the cluster serves none of the `resource.k8s.io` kinds, or the
  extension is disabled.
- **No "DRA devices" block on a Node:** the node has no ResourceSlices, or the cluster serves none; "Cannot tell"
  there means the extension, or your credentials, may not list ResourceSlices, or the node has more than 500.
- **"Cannot tell" in "Allocated to":** the cluster's ResourceClaims cannot be read in full (or there are more than
  5000).
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Dynamic Resource Allocation.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/dra        # → extensions/dra/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/dra
```

- `src/main.ts` starts the view the frame's context names: `page.ts` (the "Devices" page) or `details.ts` (the
  sections, their blocks in Sextant's memory, their capped watches in `live.ts`); `views.ts` draws them with the SDK's
  `ui` kit.
- `model.ts` reads `resource.k8s.io`'s fields; it is the former built-in view's model, ported, with its problem
  detector (`draProblem`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (with Sextant's own judge across objects,
  `src/extensions/problemsAcross.ts`), the claims' "Only problems", the Pod block's condition and the columns with
  Sextant's own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with
  the model on the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details and the page
  through the SDK's test host.
- The manifest's rules, columns and translations are long and repetitive: they were written by a generator script
  (not kept in the repository); the JSON is the source of truth. A text with no words (placeholders, numbers) is left
  out of the translations: Sextant shows the English one, which is the same, and the manifest stays under 256 KiB.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `dra` texts)
  and in the manifest's `translations` (the problems' texts from the built-in `problems` texts).
  `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `dra` and the
     commit (add `dra` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
