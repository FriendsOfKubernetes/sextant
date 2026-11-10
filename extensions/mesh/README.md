# Service mesh

Read-only views of the [Istio](https://istio.io) and [Linkerd](https://linkerd.io) service meshes, in every language
Sextant has: their kinds in two sidebar sections of their own with Sextant's tables and columns, details in plain words
(a VirtualService's routes as "when … then …" lines, a DestinationRule's subsets and TLS mode, what a PeerAuthentication
or AuthorizationPolicy means for the workloads it selects, a Linkerd Server's authorizations), the "Request routing"
page ("Where does this request go?"), a "Service mesh" block on Pods and workloads (membership, Istio mTLS mode, who may
call) and Istio configuration mistakes as problems. It replaces Sextant's former built-in service mesh views
(ADR-0089); the places where the extension API cannot say exactly the same are in "Requirements and limits". Its id is
`sextant.mesh`. Why it is built this way: ADR-0089 (answers from objects only, "unknown" over "allowed", never a guess;
the cluster domain and root namespace are Istio's defaults), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0144 (rules across objects: `missing`), ADR-0146 (agents get its problems only by the user's
consent), ADR-0152 (kinds in sections of their own), ADR-0153 (computed columns), ADR-0160 (the sections' icons and
places, the UI kit) and ADR-0167 (the counter's own label, column widths, counts in conditions and placeholders,
untitled and hidden details sections, details blocks in Sextant's own memory) and ADR-0168 (its WebAssembly backend
judges the Istio problems no rule condition can say).

One extension holds both meshes, as the built-in views did: the "Service mesh" block of a Pod or workload has an Istio
and a Linkerd part in one section (one place, one read of the namespace, the blocks in the built-in order), and the
built-in problem category "Service mesh" was the Istio configuration's. This extension ports the built-in engines into
its frame code and the built-in problem checks into its backend, unchanged; Sextant keeps no copy of them. Sextant's AI
agents get the mesh problems (`get_problems`) from this extension's rules and judges, only where the user lets them; its
`diagnose_service` and `check_connectivity` never used the mesh engines.

## At a glance

| | |
|---|---|
| Id | `sextant.mesh` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `mesh-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Service mesh |
| Checked against | Istio's API (`networking.istio.io/v1`, `security.istio.io/v1`, `telemetry.istio.io/v1`; their documented host, `exportTo`, DestinationRule lookup, PeerAuthentication precedence and AuthorizationPolicy evaluation rules, `istioctl analyze`'s messages) and Linkerd's (`linkerd.io/v1alpha2`, `policy.linkerd.io`) |

## What it adds

**Two sidebar sections, "Istio" (`istio`) and "Linkerd" (`linkerd`)**, with the built-in sections' icons and places
(after Volume Snapshots), each shown while the cluster serves any of its kinds, each kind with Sextant's own table,
filters, selection bar and details, and Edit and Delete as on every kind:
- Istio: Virtual Services, Destination Rules, Gateways, Service Entries, Sidecars, Workload Entries, Peer
  Authentications, Request Authentications, Authorization Policies, Telemetry, and the page **Request routing**
  (`request-check`). The section's counter shows how many problems of the rules below the Istio objects have, as the built-in counted
  its findings.
- Linkerd: Service Profiles, Servers, HTTP Routes, Authorization Policies, Server Authorizations, Mesh TLS
  Authentications, Network Authentications.

**"Only problems"** on Virtual Services and Destination Rules: those with a problem of the rules below.

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), after Namespace, in the
built-in widths and order:
- Virtual Services: **Hosts** (`vs-hosts`: the first host and how many more, every host on a line of its own in its hover), **Gateways**
  (`vs-gateways`: `namespace/name` of each, `mesh` where none is set), **Routes** (`vs-routes`: HTTP, TCP and TLS
  routes).
- Destination Rules: **Host** (`dr-host`), **Subsets** (`dr-subsets`), **TLS mode** (`dr-tls`).
- Gateways: **Servers** (`gw-servers`: port/protocol of each), **Hosts** (`gw-hosts`: without their `namespace/` part, in lower case, each once,
  the first and how many more).
- Service Entries: **Hosts** (`se-hosts`: in lower case, a short name completed in the entry's namespace,
  `<name>.<namespace>.svc.cluster.local`), **Location** (`se-location`), **Resolution** (`se-resolution`).
- Sidecars: **Applies to** (`sc-applies`: the workload selector's labels, else every workload of the namespace — of the
  mesh in `istio-system`), **Egress hosts** (`sc-egress`: how many).
- Workload Entries: **Address** (`we-address`), **Service account** (`we-sa`).
- Peer Authentications: **Applies to** (`pa-applies`), **mTLS mode** (`pa-mtls`: `UNSET` where none is set).
- Request Authentications: **Applies to** (`ra-applies`), **Issuers** (`ra-issuers`).
- Authorization Policies (Istio): **Action** (`ap-action`: `ALLOW` where none is set, `INVALID` for an action Istio does
  not accept), **Applies to** (`ap-applies`: "A Gateway or waypoint (targetRef)" for a policy attached by
  `targetRef(s)`), **Rules** (`ap-rules`).
- Telemetry: **Applies to** (`tm-applies`).
- Service Profiles: **Routes** (`sp-routes`).
- Servers: **Port** (`srv-port`), **Protocol** (`srv-protocol`), **Pod selector** (`srv-selector`).
- HTTP Routes (Linkerd): **Parents** (`hr-parents`: kind and name of each), **Hosts** (`hr-hosts`).
- Authorization Policies (Linkerd): **Target** (`lap-target`), **Authentications** (`lap-auth`).
- Server Authorizations: **Server** (`sa-server`: its name, else its selector's labels).
- Mesh TLS Authentications: **Identities** (`mtls-ids`: identities and identity references).
- Network Authentications: **Networks** (`na-networks`).

**Details** (`mesh`) of every Istio and Linkerd kind, untitled, in the built-in section's place (in place of the
generic fields, before the conditions), drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- Virtual Service: its mesh problems (every problem the built-in found, below) as warning lines; hosts, gateways,
  export and **Check a request…** (closes the details and opens Request routing prefilled with its first host, its namespace or its gateway,
  and checked); **HTTP routes** as cards ("Route 2 (default)": when — each match block's conditions in words — then —
  the weighted destinations and subsets, a delegate, a direct response or a redirect — and timeouts, retries, faults,
  mirroring and rewrites); **TCP and TLS routes** as a table.
- Destination Rule: its mesh problems; host, TLS mode in words, load balancer, export, workload selector; **Port TLS**;
  **Subsets** with their labels and TLS modes.
- Gateway: its selector; **Servers** (port, protocol, hosts, TLS mode); **Bound virtual services**, each a link.
- Service Entry, Sidecar (with what it means), Workload Entry, Telemetry (its providers).
- Peer Authentication (where it applies, its mode in words, the precedence), **Port mTLS**; Request Authentication (its
  JWT rules); Authorization Policy (where it applies, what its action does, what empty rules mean, the evaluation
  order) and one block per **rule** with its sources, operations and conditions in words.
- Service Profile (its retry budget and **Routes**); Server (pods, port, protocol, access policy) and the **Server
  authorizations** and Authorization Policies of its namespace that target it, each a link; Server Authorization,
  Linkerd Authorization Policy, Mesh TLS Authentication, Network Authentication and HTTP Route, as who is let in.

**"Service mesh"** (`membership`) on Pods, Deployments, StatefulSets, DaemonSets and ReplicaSets, untitled, after the
kind's own fields (shown where the cluster serves Istio or Linkerd kinds, or the pod carries a proxy):
- **Istio membership**: sidecar, native sidecar, ambient or not in the mesh (a workload: what its pods will get), the
  revision, where injection is turned on, the proxy image, an opt-out, and "restart to join" where injection is on but
  the pod has no proxy.
- **mTLS**: the mode by PeerAuthentication precedence, what it means, the policy that sets it (a link) and its ports.
- **Who may call this workload?**: a caller (namespace, service account, method, path, port, IP, remote IP) judged
  against the AuthorizationPolicies that apply — allowed, denied, up to the external authorizer, or "Cannot tell" with
  why — each policy's verdict and what it could not evaluate, and the policies attached by `targetRef` that are not.
- **Linkerd membership**: proxy, native proxy or not, `linkerd.io/inject` and where it is set, the control plane, the
  proxy version, "restart to join", and that linkerd-viz is installed with **Show request metrics**, which opens Sextant's Requests section of the
  same details.

**Request routing** (`request-check`, Istio section): a URL, method and headers sent from a workload in the mesh (its
namespace and labels) or into an Istio Gateway, and the result in steps — the gateway and its server, the
VirtualService and the host that matched, the route that took the request with its conditions and the routes skipped
before it (and why), the weighted destinations with their DestinationRule, subset, TLS mode and ready pods (the
destinations' Services and pods watched only while shown), or what the proxy answers itself — with notes on what is not
evaluated (Sidecar scope, TCP/TLS routes, RE2 as JavaScript regular expressions, a gateway's port, source labels at a
gateway) and every VirtualService that did not apply with the reason.

The Istio configuration the details, the blocks and the page judge with is watched as the built-in store held it: one
list per Istio kind the cluster serves (VirtualServices, DestinationRules, Gateways, ServiceEntries, Sidecars,
PeerAuthentications, AuthorizationPolicies) in every namespace, and the Services of the namespaces they name, metadata
only (at most 40 namespaces; beyond it no host is judged missing) — always for a VirtualService's or DestinationRule's
details, and for the other views only while the block or page that needs it is open. Kinds the cluster does not serve
are never watched. The blocks open and close as the built-in ones (open at first, remembered in Sextant's own memory of
details sections, with the panel's "Expand all" and "Collapse all"); a closed block draws and watches nothing.

## Permissions

- **Read** the Istio and Linkerd kinds, Services, Pods and Namespaces in every namespace of every cluster: the details
  read the shown object and the Istio configuration; Request routing reads the destinations' Services and pods; the
  "Service mesh" block reads the object's Namespace (one by name) and whether `linkerd-viz` exists. Services are read
  as metadata only for the configuration.
- **Read** Deployments, StatefulSets, DaemonSets and ReplicaSets: the "Service mesh" block reads the shown workload.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge VirtualServices and DestinationRules; to judge them its **backend** gets, of
  VirtualServices, DestinationRules, ServiceEntries and PeerAuthentications their `spec`, and of Gateways and
  Services their names only (each with its name, namespace, uid and creation time). The backend's code runs for them in
  Sextant's sandbox with no way to the cluster or the network (ADR-0168); Sextant asks for that separately at install,
  listing the kinds and fields.
- The extension keeps the Request routing form per cluster in its session storage: in memory for this run only, never
  written to disk (the headers too, which may carry credentials), as the built-in kept it.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category "Service mesh": the extension's own category **Service mesh** (`ext:sextant.mesh`), on by
default, counted on the Istio section. Agents get it only where the user lets them (Settings → AI agents (MCP),
ADR-0146), and a problem only where they may read what its finding rests on (its `needs`: the lists it was judged
against and the objects its message names), as the built-in agents' view kept a mesh finding. Every rule notifies at once (no
grace), with the built-in reason and message (`{{fact:…}}` fills in the host, subset, rule, gateway, mode, policy or
other VirtualService).

The checks are the built-in view's (`meshProblems`, unchanged), run by the extension's backend as problem judges
(ADR-0168): Sextant sends each judge the objects it reads, it answers which objects have which finding, and each rule
below turns every finding of its reason into a problem of its own (`each`), in the built-in order. Where the cluster
serves no DestinationRules, ServiceEntries or PeerAuthentications, a judge gets none of them (an optional read), as the
built-in took such a kind as empty; without Gateways no gateway is judged missing, as the built-in did.

Every read is partial: Sextant sends what it could read and says in which namespaces it could not (the user's
accessible namespaces, the extension's grant, lists the API server refused). A namespace whose Services could not be
read is unknown, as the built-in store took a refused namespace's Services, and a finding is told only when everything
it rests on was read — the built-in agents' rule. Where everything was read, the findings are the built-in's.

| Judge | Reads | Tells |
|---|---|---|
| `hosts` | VirtualService (`.spec`, partial), DestinationRule (`.spec`, optional, partial), ServiceEntry (`.spec`, optional, partial), Service (`.metadata.name`, partial) | MissingDestinationRule, MissingSubset, UnknownHost |
| `gateways` | VirtualService (`.spec`, partial), Gateway (`.metadata.name`, partial) | MissingGateway |
| `virtual-services` | VirtualService (`.spec`, partial) | ConflictingVirtualService, InvalidVirtualService |
| `tls` | DestinationRule (`.spec`, partial), PeerAuthentication (`.spec`, optional, partial) | TlsConflict |

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `unknown-host` | VirtualService | `UnknownHost`: a destination (HTTP, TCP or TLS route, or mirror) names a Service that does not exist (judged only where the objects name at most 40 namespaces) or a host no ServiceEntry covers; every finding; judge `hosts` | none | no |
| `missing-destination-rule` | VirtualService | `MissingDestinationRule`: a destination names a subset, and no DestinationRule covers its host where a client of the VirtualService's namespace looks (its namespace, the Service's, `istio-system`; `exportTo`, wildcards, the most specific first); every finding; judge `hosts` | none | no |
| `missing-subset` | VirtualService | `MissingSubset`: the DestinationRule of the host has no subset of that name; every finding; judge `hosts` | none | no |
| `missing-gateway` | VirtualService | `MissingGateway`: the VirtualService is bound to an Istio Gateway (`name` or `namespace/name`) that does not exist; every finding; judge `gateways` | none | no |
| `invalid-virtual-service` | VirtualService | `InvalidVirtualService`: the host `*` (blanks around it too) while bound to the sidecars (`mesh`, or no gateways): Istio rejects it, so none of its routes are used; every finding; judge `virtual-services` | none | no |
| `conflicting-virtual-service` | VirtualService | `ConflictingVirtualService`: an older VirtualService has the same host on the sidecars (Istio uses only the oldest), or on the same Gateway with a catch-all route, and their exports overlap; every finding; judge `virtual-services` | none | no |
| `tls-conflict` | DestinationRule | `TlsConflict`: a DestinationRule without a workload selector sets a TLS mode other than `ISTIO_MUTUAL` toward a Service whose namespace's (else the mesh's) PeerAuthentication is `STRICT`; every finding; judge `tls` | none | no |

While a judge cannot tell — one of the lists it reads is loading, failed, capped or not served (and not optional),
holds more than 5000 objects or 8 MiB, its call failed, or it answered more than 10 000 facts — its rules give no
problem: "cannot tell", never a problem.

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0089).

## What it does not do

- It never talks to istiod, a proxy, Linkerd's control plane or linkerd-viz: every answer comes from the objects.
- It does not send the request it checks anywhere.
- It does not read Istio's mesh config: the cluster domain is taken to be `cluster.local`, the root namespace
  `istio-system`, and the trust domain `cluster.local` (Istio's defaults).
- It gives agents nothing but its problems, by the user's consent: no agent tool of its own.

## Requirements and limits

- Istio's CRDs (`networking.istio.io`, `security.istio.io`, `telemetry.istio.io`) and Linkerd's (`linkerd.io`,
  `policy.linkerd.io`); each section shows only where the cluster serves its kinds. Istio's choices where it leaves
  them open (a regular expression read as JavaScript's, a header condition needing the header, a dry-run policy never
  deciding, an action Istio rejects being "unknown") are the built-in engines', ported unchanged, and say so where they
  matter.
- Where it differs from the former built-in views, because the extension API cannot say it yet:
  - **A finding resting on an unreadable list is not told**, also on the screen: the built-in screen judged a list the
    API server refused in some namespaces as if it were whole (a gateway there could be called missing) and kept that
    only from agents. Deliberate (ADR-0089, "unknown" over a guess); where every list was read, nothing differs.
  - **Caps**: more than 5000 objects of a kind, 8 MiB in all or 10 000 findings make a judge unable to tell, where the
    built-in watched without a cap (accepted limits of ADR-0168).
  - **Hosts of a Gateway** drop the part up to the last `/` (`|after:/`), the built-in up to the first; an Istio
    gateway host has one `/` at most, so they differ only on a host Istio refuses. Closed by `|after:` taking the
    first place with a flag, if ever needed.
  - The details' tables are the SDK's: their columns cannot be resized and remembered, and do not keep from wrapping,
    as Sextant's details tables do; the blocks' memory is kept per section, so a block closed in the built-in view
    opens once again here (#417).
- Checked by tests on the built-in view's fixtures (Bookinfo) and variants against the built-in engines, columns and
  views, whose tests were ported too; not yet tried on a live cluster.

## Troubleshooting

- **No "Istio" or "Linkerd" section:** the cluster serves none of that mesh's CRDs, or the extension is disabled.
- **No "Service mesh" block on a pod:** the cluster serves no Istio or Linkerd kind and the pod has no proxy.
- **"Loading…" that stays:** a list of the Istio configuration could not be read with your credentials, or discovery
  failed; reopen the details.
- **"This cluster serves no Istio VirtualServices or DestinationRules."** on Request routing: Istio's traffic API is
  not installed.
- **A problem the details of a VirtualService or DestinationRule show is not on the Problems page:** its judge cannot
  tell (see "Problems"); the backend's log (Settings → Extensions → Service mesh) says why a call failed.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Service mesh.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/mesh        # → extensions/mesh/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/mesh
```

- `src/main.ts` starts the view the context names: `details.ts` (the `mesh` section of every kind), `membership.ts`
  (the `membership` section of Pods and workloads) or `requestCheck.ts` (the page, its form in `checkState.ts`);
  `store.ts` holds the shared Istio configuration's lists and builds the configuration; `dom.ts` keeps the blocks in
  Sextant's memory (`BlockMemory`).
- `src/engine/` is the former built-in views' model, ported unchanged: `istio.ts` (hosts, VirtualServices,
  DestinationRules, Gateways, ServiceEntries), `routing.ts` (the request check), `authz.ts` (who may call), `mtls.ts`,
  `membership.ts`, `phrases.ts` (the plain words) and `problems.ts` (`meshProblems`), with the built-in tests
  (`routing.test.ts`, `policy.test.ts`).
- `backend/main.ts` is the backend (built by componentize-js into `backend.wasm`): only the problem judges of
  `src/judges.ts`, which run `meshProblems` over the objects Sextant sends (each judge over its reasons' kinds) and
  answer each finding as a fact `<reason>-<n>` with the built-in message's values.
- `src/manifest.test.ts` judges the manifest's columns and problem rules with Sextant's own window engine
  (`src/extensions/columns.tsx`, `src/extensions/problemRules.ts`) and compares them with the built-in columns and
  `meshProblems` over the whole configuration (and the built-in agents' rule where namespaces are unreadable), run through
  the backend's own `handle`, on the fixtures in `fixtures/` and variants of them (every reason,
  the cases the built-in store's 40 namespaces left unjudged, every finding of a reason, kinds not served), pinning
  each difference
  above; `fixtures/judge-calls.json` holds judge calls on the fixtures (with lists refused in a namespace too) and the answers the built component gave in
  Sextant's runtime (`cargo run -p sextant-ext-runtime --example run -- dist/backend.wasm problemJudge:<id> <params>`),
  which the tests check the judges still give; `views.test.ts`
  drives the details, the block and the page through the SDK's test host, as the built-in view's tests did.
- The texts are in `src/locales/<lang>.json` (English is the source; they are the built-in view's `mesh` texts, its
  problem messages and the list separator, word for word) and in the manifest's `translations` (from the same
  catalogs), which leaves out what a language writes as English does. `src/locales.test.ts` keeps both complete in
  every language of Sextant's `src/locales/`, the rule titles unique and within 80 characters, and the manifest within
  the SDK's 512 KiB.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `mesh` and the
     commit (add `mesh` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
