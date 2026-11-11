# Traefik

Read-only views of [Traefik](https://traefik.io)'s Kubernetes CRDs — IngressRoutes (HTTP, TCP, UDP), Middlewares
(HTTP, TCP), TraefikServices, TLSOptions, TLSStores and ServersTransports (HTTP, TCP) — of `traefik.io` and, where a
cluster still serves it, of the older `traefik.containo.us`, in every language Sextant has. Traefik writes no status on
any of these kinds, so what it tells is what can be judged from the objects themselves: whether every object a
reference names exists. It lists the kinds in a sidebar section of their own with Sextant's table; shows routes with
their match rules, entry points, middlewares, services and TLS, a TraefikService's strategy and children, a Middleware's
type and chain, and the settings of TLS options, stores and transports; and checks every reference, saying why one
breaks its object or cannot be judged. Broken references and routes Traefik skips are problems of an opt-in category.
It replaces Sextant's former built-in Traefik view (ADR-0108); the places where the extension API cannot say exactly the
same are in "Requirements and limits". The route diagnosis ("Diagnose" on an IngressRoute) stays in Sextant. Its id is
`sextant.traefik`. Why it is built this way: ADR-0108 (references only, since Traefik writes no status; another
namespace stays unknown; Secrets only in the open details), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0144 (rules across objects: `missing`, over lists and in other namespaces), ADR-0152 (kinds in a section of their own, `not`),
ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out,
`same`, lists counted), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counter's own label, problem
categories of the extension's own, column widths, sort keys and blank cells, offsets, counts in conditions, text
conditions, `*` paths and `joinPaths`, `|keys`, untitled details sections, details blocks in Sextant's own memory,
capped watches) and ADR-0169 (extension API 5: the References column's `problem` cases, `|positions`, trimmed match
steps, `alsoKinds`, lists three deep with the holding object's namespace, 100 rules, `{{missing}}` of a single
reference).

## At a glance

| | |
|---|---|
| Id | `sextant.traefik` |
| Version | 1.1.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 5: Sextant 0.30.1 or newer; Sextant 0.30.0 is offered 1.0.0 (`sextantApi` 4). Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `traefik-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Traefik |
| Checked against | Traefik's own types (`pkg/provider/kubernetes/crd/traefikio/v1alpha1`), its CRD provider's reference resolution (namespaces, `name@provider`, `@internal`, `allowCrossNamespace`) and its documentation (routing/providers/kubernetes-crd, middlewares, TLS) |

## What it adds

**A sidebar section "Traefik"** (`traefik`), shown while the cluster serves any of the kinds, with the built-in
section's icon and place (after Linkerd): IngressRoutes, IngressRoutes TCP, IngressRoutes UDP, Middlewares,
Middlewares TCP, Traefik Services, TLS Options, TLS Stores, Servers Transports and Servers Transports TCP of
`traefik.io`, then the same kinds of `traefik.containo.us` labelled as such (Servers Transports TCP came with Traefik v3
and never had the old group), each with Sextant's own table, filters, selection bar and details, and Edit and Delete as
on every kind. The section's counter shows how many Traefik objects have a broken reference or a skipped route, only
while the opt-in category below is on.

**"Only problems"**, on every kind but Middlewares TCP, as the built-in table had it: the objects with a problem of the
rules below (IngressRoutes, Traefik Services, Middlewares). TLS Options, TLS Stores and Servers Transports name only
Secrets, which were never judged for problems: their "Only problems" lists nothing, as the built-in's did.

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), after Namespace, in the
built-in widths and order. The ids of `traefik.containo.us`'s columns are the same with `l-` in front (`l-ir-refs`,
`l-ir-ep`, `l-ir-hosts`, `l-ir-svc`, `l-ir-tls`, `l-irt-refs`, `l-irt-ep`, `l-irt-hosts`, `l-irt-svc`, `l-irt-tls`,
`l-iru-refs`, `l-iru-ep`, `l-iru-svc`, `l-mw-refs`, `l-mw-type`, `l-mwt-type`, `l-ts-refs`, `l-ts-strat`, `l-ts-svc`,
`l-to-refs`, `l-to-min`, `l-to-auth`, `l-tst-refs`, `l-tst-def`, `l-tst-sec`, `l-st-refs`, `l-st-sni`, `l-st-insec`,
`l-st-sec`):
- Every kind but Middlewares TCP, first: **References** (`ir-refs`, `irt-refs`, `iru-refs`, `mw-refs`, `ts-refs`,
  `to-refs`, `tst-refs`, `st-refs`, `stt-refs`), as the built-in tables' first column: "Broken reference" in red where
  a problem rule below holds for the row (also while it waits out its 2 minutes), "Checking…" in grey while the lists
  the rules look up are being read, "Not all checked" in grey where they cannot tell (a list not read in full, not
  readable in the namespace it names, or the row's kind not judged there), else "References found" in green. It reads
  the rules' problems (the column's `problem` cases, `sextantApi` 5) and holds their lists while the table is shown,
  whether or not the opt-in category is on, as the built-in column held its store; it does not sort, as the built-in did
  not. TLS Options, TLS Stores and Servers Transports name only Secrets, which the built-in judged only in the open
  details: their column says "References found".
- IngressRoutes, IngressRoutes TCP and UDP: **Entry points** (`ir-ep`, `irt-ep`, `iru-ep`), **Hosts** (`ir-hosts`,
  `irt-hosts`, HTTP and TCP only: every exact `Host(…)`/`HostSNI(…)` name of the match rules once, lower case, not `*`,
  with the `ruleHosts` filter, as the built-in column), **Services** (`ir-svc`,
  `irt-svc`, `iru-svc`: the services of every route, each once, in order, `name@provider` as written) and, but on UDP,
  **TLS** (`ir-tls`, `irt-tls`: "TLS", or "Passthrough" for a TCP route passing TLS through; sorted by "TLS").
- Middlewares and Middlewares TCP: **Type** (`mw-type`, `mwt-type`: the middleware's field, `stripPrefix`,
  `basicAuth`, `chain`, …).
- Traefik Services: **Strategy** (`ts-strat`: `weighted`, `mirroring`, `highestRandomWeight` or `failover`, the field
  that is set) and **Services** (`ts-svc`: the weighted or highest-random-weight services, the mirroring service and
  its mirrors, the failover service and its fallback, each once).
- TLS Options: **Minimum TLS** (`to-min`) and **Client authentication** (`to-auth`, `clientAuth.clientAuthType`).
- TLS Stores: **Default certificate** (`tst-def`, its Secret) and **Secrets** (`tst-sec`: the default certificate's
  and the certificates' Secrets, each once).
- Servers Transports (HTTP and TCP): **Server name** (`st-sni`, `stt-sni`), **Verification** (`st-insec`,
  `stt-insec`: "Not verified" in amber where `insecureSkipVerify` is true — of `spec`, or of `spec.tls` on TCP —
  sorted by `true`/`false`) and **Secrets** (`st-sec`, `stt-sec`: root CA and client certificate Secrets, each once).

**Details** (`traefik`), untitled, in the built-in section's place (in place of the generic fields, before the
conditions), drawn with the SDK's UI kit in the classes of Sextant's own details panel, one block titled with the kind:
- **References**: "References found" in green, "Broken reference" in red, "Not all checked" or "Checking…" in grey,
  with what Traefik does without a status in plain words: how many references are broken, the routes Traefik skips
  (no match rule, a kind other than `Rule`), a missing route TLS Secret (Traefik still serves the routes, with another
  certificate), a reference into another namespace (followed only with the provider's `allowCrossNamespace`, which no
  object shows), another provider's object (`name@provider`, not visible; `@internal` always exists), a list that
  could not be read, and, where both groups are served, a target only in `traefik.containo.us` (Traefik v3 reads only
  `traefik.io`), a target in both, and the other group's object of the same name.
- Per kind: an IngressRoute's entry points ("All entry points" without any), ingress class (and that only a Traefik
  watching it serves it), parent routes, TLS Secret, options, store, certificate resolver (and that its certificate is
  kept by Traefik), certificate domains and passthrough, and **Routes**: number, match rule, priority, middlewares and
  services (with port and weight), each a link; a TraefikService's strategy, services (with weights), mirrors (with
  percentages) and fallback; a Middleware's type and chained middlewares; a TLSOption's minimum and maximum TLS
  versions, client authentication and strict SNI; a TLSStore's default certificate; a ServersTransport's server name
  and backend certificate verification.
- **Certificate** (`certificate`, order 21, on IngressRoutes and IngressRoutes TCP of both groups that name a TLS
  Secret at `spec.tls.secretName`): Sextant's own view of that Secret's certificate (subject, names, validity,
  issuer, key, chain and CA), as the built-in "Certificate" block showed it: Sextant reads and parses the Secret
  itself (`detailsSections[].certificate`, ADR-0069), and nothing of it reaches the extension. Its open or closed
  state carries over from the built-in block.
- **References** (the table): every reference — kind, name (a link; `namespace/name` in another namespace), where it
  is (route, middleware of a service, TLS, parent, service, mirror, fallback, chain, error pages, Secret, servers
  transport) and what it finds (found, does not exist, in another namespace, another provider's object, cannot tell,
  unknown service kind, only in `traefik.containo.us`).

The lists the references are judged with are watched only while the block is open, for the shown object alone, names
only: each Traefik kind its references name (in `traefik.io` where served, else in `traefik.containo.us`; both where
both are), Services, and the Secrets it names — in the namespaces the references name; the Traefik kinds capped at 5000
objects, as the built-in store kept them; and, where both groups are served, the other group's object of the same name.
The blocks open and close as the built-in ones (open at first, remembered in Sextant's own memory of details
sections, with the panel's "Expand all" and "Collapse all"); a closed block draws and watches nothing.
The Routes and References tables keep the built-in ones' columns: they resize, Sextant remembers their widths (the
widths set in the built-in view carry over), and the kind, the number and the priority keep to one line while the
others wrap between words.

## Permissions

- **Read** the ten Traefik kinds of both groups, Services and Secrets in every namespace of every cluster: the details
  read the shown object and watch the names of what its references name; Secrets are only ever watched as metadata.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge IngressRoutes (HTTP, TCP, UDP), TraefikServices and Middlewares of both groups and, to tell
  whether a reference's target exists, list Services, IngressRoutes, Middlewares, TraefikServices, TLSOptions and
  ServersTransports (HTTP and TCP) and MiddlewareTCPs of both groups by name, metadata only (a kind the cluster does not
  serve is not listed); Sextant asks for that separately at install, and 1.1.0 asks again for the old group's
  ServersTransportTCP name, which `l-it-x` looks up beside `traefik.io`'s. The References column reads these rules'
  problems.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `traefik`: the extension's own category **Traefik references** (`traefik`), opt-in — off until
turned on on the Problems page, because it lists every Traefik object of a cluster and the objects they name. Every
rule counts after 2 minutes (a reference applied in the wrong order is fixed by the next apply), notifies, and tells
reason `MissingReference` with the built-in message "Refers to objects that do not exist: … Traefik skips what depends
on them.", naming every missing one (`namespace/name` in another namespace; rules of one object notify once, group
`missing-reference`), or `SkippedRoute` with the built-in message naming the routes by number ("Traefik skips its
routes 1, 3: …", group `skipped-route`). Each reference is looked up in the namespace it names, else in its load
balancer's (a service's middlewares and servers transport), else in its object's own, as Traefik looks; another
provider's (`@` in the name) is left out, and so is the namespace another provider's service names. A Traefik target is
looked up in both groups (`alsoKinds`): found in either, it is there, as the built-in found an old-group target of a
`traefik.io` object ("only in `traefik.containo.us`", open, never broken); a group the cluster does not serve has no
objects, so a target kind neither serves is missing, as the built-in called it. A list loading, failed, capped or not
readable there is "cannot tell", never a problem. The ids are short (each is in
every language's keys twice): the kind (`ir` IngressRoute, `it` IngressRouteTCP, `iu` IngressRouteUDP, `ts` a
TraefikService's weighted or highest-random-weight services, `tm` its mirroring service, `tr` its mirrors, `tf` its
failover service and fallback, `th` its highest-random-weight services' middlewares, `mw` a Middleware's chain, `me`
its error pages' service), then what is missing (`k`
skipped routes, `o` TLSOption, `s` Service, `t` TraefikService, `x` servers transport, `m` middleware, `p` parent
route, `sm` a route service's middleware). The rules of `traefik.containo.us` are the same with `l-` in front
(`l-ir-k`, `l-ir-o`, `l-it-k`, `l-it-o`, `l-ir-s`, `l-ir-t`, `l-ir-x`, `l-ir-m`, `l-ir-sm`, `l-ir-p`, `l-it-s`, `l-it-m`,
`l-it-x`, `l-iu-s`, `l-ts-s`, `l-ts-t`, `l-ts-x`, `l-tm-s`, `l-tr-s`, `l-tf-s`, `l-tm-t`, `l-tm-x`, `l-tr-t`, `l-tr-x`,
`l-tf-t`, `l-tf-x`, `l-ts-m`, `l-th-m`, `l-tm-m`, `l-tr-m`, `l-tf-m`, `l-mw-m`, `l-me-s`, `l-me-t`, `l-me-x`, `l-me-m`):
72 rules in all (100 from `sextantApi` 5). `l-it-x` looks a ServersTransportTCP up in `traefik.io` too, as the built-in
did (the old group never had the kind).

| Id | Kind | When it holds |
|---|---|---|
| `ir-k` | IngressRoute | A route has no `match` (or one of blanks only), or a `kind` other than `Rule`; "Traefik skips its routes 2, 4: an empty match rule or a kind other than Rule." (`|positions`) |
| `it-k` | IngressRouteTCP | A route has no `match` (or one of blanks only) |
| `ir-o`, `it-o` | IngressRoute, IngressRouteTCP | `spec.tls.options` names a TLSOption that does not exist |
| `ir-s`, `it-s`, `iu-s` | IngressRoute, IngressRouteTCP, IngressRouteUDP | A route's service names a Service that does not exist (on HTTP routes: `kind` unset, empty or `Service`) |
| `ir-t` | IngressRoute | A route's service names a TraefikService (`kind: TraefikService`) that does not exist |
| `ir-x`, `it-x` | IngressRoute, IngressRouteTCP | A route's service names a ServersTransport (ServersTransportTCP on TCP; `serversTransport`, in the service's namespace) that does not exist |
| `ir-m`, `it-m` | IngressRoute, IngressRouteTCP | A route names a Middleware (MiddlewareTCP on TCP) that does not exist |
| `ir-sm` | IngressRoute | A route's service names a Middleware that does not exist (in the service's namespace when it names none) |
| `ir-p` | IngressRoute | `spec.parentRefs` names an IngressRoute that does not exist |
| `ts-s`, `ts-t`, `ts-x` | TraefikService | A weighted or highest-random-weight service names a Service, TraefikService or ServersTransport that does not exist |
| `ts-m`, `th-m` | TraefikService | A weighted or highest-random-weight service names a Middleware that does not exist (in the service's namespace when it names none) |
| `tm-m`, `tr-m`, `tf-m` | TraefikService | The mirroring service, a mirror, or the failover service or fallback names a Middleware that does not exist (as `ts-m`) |
| `tm-s`, `tm-t`, `tm-x` | TraefikService | The mirroring service names a Service, TraefikService or ServersTransport that does not exist |
| `tr-s`, `tr-t`, `tr-x` | TraefikService | The same of a mirror |
| `tf-s`, `tf-t`, `tf-x` | TraefikService | The same of the failover service or its fallback |
| `mw-m` | Middleware | A chain names a Middleware that does not exist |
| `me-s`, `me-t`, `me-x`, `me-m` | Middleware | The error pages' service names a Service, TraefikService, ServersTransport or Middleware that does not exist |

A route's TLS Secret and a TLSStore reference never break an object (Traefik builds the router anyway), and Secrets are
never judged for problems, as the built-in category did. Agents never get the category.

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0108).

## What it does not do

- It does not talk to Traefik (its API or dashboard) or read its static configuration: whether `allowCrossNamespace`
  is on, which ingress class or namespaces a Traefik watches, and which Traefik version runs are not visible.
- It never reads a Secret's data: Secrets are listed by name only.
- It does not diagnose traffic: "Diagnose" on an IngressRoute is Sextant's own.

## Requirements and limits

- Traefik's CRDs (`traefik.io/v1alpha1`, and `traefik.containo.us/v1alpha1` where still served); the section shows only
  where the cluster serves them.
- Where it differs from the former built-in view:
  - **One problem per kind of reference and place**, where the built-in had one per object naming every broken
    reference ("Service a and Middleware b"): the rules of one object notify once (`group`), but the Problems page
    lists each. A rule's message cannot name the kinds of what it did not find, so one rule per kind is kept.
  - **The References column** says "References found" for a reference found in another namespace or another provider's
    object (`name@provider`), and for a `traefik.io` object's target found only in `traefik.containo.us`, where the
    built-in said "Not all checked": the rules judge them found (they do not depend on Traefik's static
    configuration, which no object shows), and the column tells what the rules say. "Not all checked" is kept for what
    the rules cannot tell.
  - A service `kind` Traefik does not know is not a problem, where the built-in called it broken: Traefik's CRDs allow
    only `Service` and `TraefikService`, so the API server refuses such an object. An IngressRouteUDP's service names
    no servers transport in Traefik's CRD either; the built-in read one all the same.
  - A Middleware's **Type** names every key of its `spec` (`|keys`), where the built-in named the first; a Middleware
    has one.
  - A rule title of the old group says `(containo.us)`, so that every title keeps within 80 characters in every
    language; kind titles and columns say `traefik.containo.us` in full.
  - The extension's permission reads Secrets in every namespace; it only ever watches their metadata, as the built-in
    view did, but the grant itself does not say "metadata only" (a grant of metadata alone would be a new permission
    action, ADR-0049).
- Checked by tests on fixtures of Traefik objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Traefik" section:** the cluster serves none of Traefik's CRDs, or the extension is disabled.
- **The counter shows nothing:** the category "Traefik references" is off; turn it on on the Problems page.
- **The References column says "Not all checked" on every row:** the rules' kinds were not agreed to at install
  (Settings → Extensions → Traefik), or the lists they look up cannot be read with your credentials.
- **"In another namespace: depends on allowCrossNamespace":** Traefik's Kubernetes CRD provider follows such a
  reference only with `providers.kubernetesCRD.allowCrossNamespace` on, which no object shows.
- **"Cannot tell: the list could not be read":** that kind cannot be listed in that namespace with your credentials,
  or its list holds more than 5000 objects.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Traefik.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/traefik        # → extensions/traefik/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/traefik
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds its watches (the
  lists of what the references name, the other group's twin); `dom.ts` keeps the blocks in Sextant's memory
  (`BlockMemory`).
- `model.ts` reads Traefik's fields and judges references; it is the former built-in view's model and resolver,
  ported, with its problem detector (`builtInProblems`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them (every shape of a load balancer reference — name, kind, namespace,
  servers transport — at each place, TLS options and route shapes, in both groups), and pins each difference above;
  `views.test.ts` drives the details through the SDK's test host, blocks included.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `traefik`
  texts) and in the manifest's `translations`, which leaves out what a language writes as English does (kind names,
  Traefik's own words). `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`, the
  rule titles unique and within 80 characters, and the manifest within the SDK's 512 KiB.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `traefik` and the
     commit (add `traefik` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
