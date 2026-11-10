# Contour

Read-only views of [Contour](https://projectcontour.io)'s own kinds (`projectcontour.io`), in every language Sextant
has. It lists HTTPProxies, TLSCertificateDelegations and ExtensionServices in a sidebar section of their own with
Sextant's tables; tells each proxy's state as Contour writes it (valid, invalid, orphaned, or waiting for Contour) with
its first error, explains a failure in plain words from Contour's own errors and warnings, and shows the virtual host
and its TLS (a Secret of another namespace with the TLSCertificateDelegation that allows it), the routes with their
match conditions and each service's share of the requests, the includes with the state of each included proxy, and
the delegation tree. Invalid and orphaned proxies are problems. It replaces Sextant's former built-in Contour view
(ADR-0107) with the same behaviour where the extension API can say it; the few places where it cannot are in
"Requirements and limits". Its id is `sextant.contour`. Why it is built this way: ADR-0107 (Contour's own status, the
includes followed through one HTTPProxy list, the problems), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of their own, `not` in rules, a kind's "Only problems"), ADR-0153
(computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths
picking an item), ADR-0163 (a problem's reason from the object), ADR-0164 (a case's own value) and ADR-0167 (the
counter's own label, column widths and sort keys, counts in paths and conditions, `items` and `joinPaths` lists,
placeholder fallbacks, two lists in a path, added counts, text conditions on the object's own texts, problems told
through a referrer, untitled details sections, details blocks in Sextant's own memory, capped watches).

## At a glance

| | |
|---|---|
| Id | `sextant.contour` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `contour-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Contour |
| Checked against | Contour's HTTPProxy, TLSCertificateDelegation and ExtensionService types and the status Contour writes, and its processor (`internal/dag/httpproxy_processor.go`, `internal/dag/conditions.go`) for roots, includes, orphans and joined prefixes (ADR-0107) |

## What it adds

**A sidebar section "Contour"** (`contour`), shown while the cluster serves Contour's kinds, with the built-in
section's icon and place (after Traefik): HTTP Proxies, TLS Certificate Delegations and Extension Services, each with
its own icon, Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind. The
section's counter shows how many HTTPProxies need attention (the problems below).

**"Only problems"** on HTTPProxies, as the built-in table had it: invalid or orphaned proxies, at once (the problems'
grace does not apply to the filter).

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), after Namespace, in the
built-in order and widths:
- HTTPProxies:
  - **Status** (`proxy-status`): Contour's `status.currentStatus` — Valid in green, Invalid and Orphaned in red,
    Waiting for Contour in amber (`NotReconciled`, or no status yet); where `currentStatus` is something else, the
    Valid condition decides, an `Orphaned` error making it Orphaned. Sorted and filtered by the state's name (`valid`,
    `invalid`, `orphaned`, `pending`) in every language.
  - **Host** (`proxy-fqdn`): `spec.virtualhost.fqdn`.
  - **TLS Secret** (`proxy-tls`): the Secret of `spec.virtualhost.tls.secretName` — its name, `namespace/name` for one
    of another namespace (delegated) — or `passthrough`.
  - **Includes** (`proxy-includes`): how many proxies it includes, the HTTP includes that name one and a TCP proxy's
    include (`tcpproxy.include`, else the older `tcpproxy.includes`); blank without any.
  - **Routes** (`proxy-routes`): how many routes it has; blank without any.
  - **Reason** (`proxy-reason`): the first error's reason Contour reports (`DuplicateVhost`, `IncludeNotFound`,
    `SecretNotValid`…), or `Orphaned`.
- TLSCertificateDelegations:
  - **Secrets** (`delegation-secrets`): the delegated Secrets' names.
  - **Target namespaces** (`delegation-targets`): the namespaces every delegation that names a Secret lets use it,
    each once in the order first named (`*`: all).
- ExtensionServices:
  - **Status** (`extension-status`): the Valid condition as Ready in green, Failed in red, Progressing in amber, else
    Unknown; sorted and filtered by `ready`, `failed`, `progressing` or `unknown`.
  - **Services** (`extension-services`): the Services behind it as `name:port`.
  - **Protocol** (`extension-protocol`): `spec.protocol` (`h2`, `h2c`).
  - **Reason** (`extension-reason`): the first error's reason.

**Details**, untitled, in the built-in section's place (in place of the generic fields, before the conditions), one per
kind — `http-proxy`, `tls-delegation` and `extension-service` — each a block titled with the kind, drawn with the
SDK's UI kit in the classes of Sextant's own details panel:
- an **HTTPProxy**: its state in plain words (accepted and serving the host; included by a root; orphaned and how to
  fix it; not processed by any Contour, or none of its ingress class; rejected, served in part, a duplicate host, a
  root namespace Contour refuses, an include cycle, a TLS Secret of another namespace without a delegation, a missing
  or invalid Secret, a root without a host, nothing defined), with Contour's own description when it says more; the
  fields Status, Host, Ingress class, Addresses (Envoy's load balancer), TLS Secret (a link), TLS delegation (the
  TLSCertificateDelegation in the Secret's namespace that lets this namespace use it, a link, or why there is none),
  TLS passthrough, TLS versions, Fallback certificate, Client certificates checked, Host policies and Authorization
  service (the ExtensionService, a link); then the blocks **Contour's errors and warnings** (those of the Valid
  condition), **Routes** (each route's match conditions in Contour's field syntax, its Services as links with
  their share of the requests or the percent mirrored, its policies, and what it does: redirect, direct response,
  no service, WebSockets), **TCP proxy services**, **Includes** (each included proxy, a link, its conditions and
  its state, or "Does not exist") and **Delegation tree** (a root's every include, or for an included proxy the roots
  that reach it with only their branches to it, prefixes joined as Contour joins them, cycles, missing proxies and
  included roots marked; at most 200 nodes);
- a **TLSCertificateDelegation**: what it allows, and each delegated Secret (a link) with the namespaces that may use
  it ("All namespaces" for `*`);
- an **ExtensionService**: why Contour does not accept it, the fields Status, Protocol, Response and Idle timeout,
  Load balancing and Upstream TLS checked, its errors and warnings, and **Services** (each a link, with its port and
  weight).

The blocks open and close as the built-in ones (open at first, remembered in Sextant's own memory of details sections,
with the panel's "Expand all" and "Collapse all"). The includes' states and the delegation tree read every HTTPProxy of
the cluster (at most 5000) only while their block is open, and a delegated TLS Secret's TLSCertificateDelegations are
read in the Secret's namespace while the proxy's block is open.

## Permissions

- **Read** HTTPProxies, TLSCertificateDelegations and ExtensionServices in every namespace of every cluster: the
  details read the shown object, the includes and the delegation tree list the cluster's HTTPProxies, and a delegated
  Secret's TLSCertificateDelegations are listed in its namespace. Secrets and Services are only linked, never read.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge HTTPProxies; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `contour`: the extension's category **Contour**, on by default. The built-in one was never
given to agents; this one is given only where Settings → AI agents (MCP) lets them (ADR-0146). Each problem is
notified and counted on the section.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `proxy-invalid` | HTTPProxy | Contour marks it invalid (`currentStatus: invalid`, or the Valid condition False without an `Orphaned` error); reason the first error's reason (else `Invalid`), message its message (else Contour's description), since the Valid condition changed | 2 minutes (a proxy and the include that names it are often applied a moment apart) | No |
| `proxy-orphaned` | HTTPProxy | Contour marks it orphaned: no root includes it (`currentStatus: orphaned`, or the Valid condition False with an `Orphaned` error); reason `Orphaned`, message as above | 2 minutes | Yes: not told while a proxy that includes it (`spec.includes`, or a TCP proxy's `spec.tcpproxy.include`, else `spec.tcpproxy.includes`), directly or through other proxies including each other, is invalid — that proxy's problem tells it, so one broken root with 20 includes is one problem (`toldThroughReferrer`). Judged only while every HTTPProxy of the cluster is read: while they load, or beyond 5000, it cannot tell and is not told |

A proxy Contour has not processed yet (`NotReconciled`) is no problem: no Contour may be meant to serve it.

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0107).

## What it does not do

- It does not ask Contour or Envoy anything: everything comes from the objects and the status Contour writes.
  Contour's own flags (`--root-namespaces`, whether ExternalName Services are allowed) are invisible to it, and the
  texts say so where they matter.
- The traffic diagnosis of an HTTPProxy (the "Diagnose" action and the "Diagnosis" tab, which follow a proxy through
  its includes to Services and pods) is Sextant's own diagnosis, not this extension's.
- It does not install, configure or upgrade Contour, and never reads a Secret.

## Requirements and limits

- Contour's CRDs (`projectcontour.io/v1` HTTPProxy and TLSCertificateDelegation, `projectcontour.io/v1alpha1`
  ExtensionService); the section shows only where the cluster serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - A proxy that sets both `spec.tcpproxy.include` and the older `spec.tcpproxy.includes` (Contour reads only the
    first) tells the orphans both name; the built-in followed only the first. `toldThroughReferrer` reads every path it
    names; it would need a path tried only when the one before it is absent.
  - Where the cluster has more than 5000 HTTPProxies, orphans are not told at all (the rows are not read in full, so
    the rule cannot tell); the built-in judged them on the 5000 it kept.
  - The table's search finds Status by the words shown (Waiting for Contour); the built-in matched the state's names
    (`pending`). Filters still go by the names.
  - The details' tables are the SDK's: their columns cannot be resized and remembered, and do not keep from wrapping,
    as Sextant's details tables do (#417).
  - The blocks' memory is kept per section, so a block closed in the built-in view opens once again here (#417).
- Checked by tests on fixtures of Contour objects (copied from the built-in view) against the built-in readings, rules
  and columns; not yet tried on a live cluster.

## Troubleshooting

- **No "Contour" section:** the cluster does not serve Contour's kinds, or the extension is disabled.
- **"Waiting for Contour" on every proxy:** no Contour is running, or the proxies belong to another Contour (another
  ingress class).
- **"The HTTPProxies of the cluster cannot be read":** your credentials may not list HTTPProxies in every namespace;
  the includes' states and the delegation tree need that list.
- **"The cluster has more HTTPProxies than Sextant reads at once":** the cluster has more than 5000; the tree may lack
  some.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Contour.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/contour        # → extensions/contour/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/contour
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds its watches (the
  cluster's HTTPProxies while the includes or the tree are open, a delegated Secret's TLSCertificateDelegations);
  `dom.ts` has the small drawing helpers and formats numbers as Sextant does.
- `model.ts` reads Contour's fields; it is the former built-in view's model, ported, with its problem detector
  (`contourProblems`), its judgement across proxies (`toldThroughInvalid`) and its explanations kept as the reference
  the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, the HTTPProxy kind's "Only problems" and the columns with
  Sextant's own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with
  the model on the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's
  test host, blocks included.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `contour`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `contour` and the
     commit (add `contour` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
