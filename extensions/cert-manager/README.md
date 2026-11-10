# cert-manager

Read-only views of [cert-manager](https://cert-manager.io/) (`cert-manager.io` and `acme.cert-manager.io`), in every
language Sextant has. It lists Certificates, CertificateRequests, Issuers, ClusterIssuers, Orders and Challenges in a
sidebar section of their own with Sextant's tables; tells in plain words why a Certificate is not ready or failed to
renew, why a request waits or was denied, why an issuer is not ready and what an ACME Order or Challenge saw; shows the
issuance chain Certificate → CertificateRequest → Order → Challenge; and reports Certificates that are not ready, whose
issuance failed, that expire within your warning days or that have expired. It replaces the cert-manager views of Sextant's former built-in module (ADR-0069)
with the same behaviour; the TLS certificate of a Secret (parsed by Sextant's core) and the "TLS certificates" page
stay in Sextant. Its id is `sextant.cert-manager`. Why it is built this way: ADR-0069 (the readings, the chain and the
problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0146 (its problems for agents only by
the user's choice), ADR-0152 (kinds in a section of its own, `not` in rules), ADR-0153 (computed columns), ADR-0160
(the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification
groups), ADR-0163 (field values in texts, a problem's reason from the object), ADR-0165 (a kind's own "Only
problems") and ADR-0167 (the counter's own label, column widths and sort values, a rule's literal reason, details
sections without a heading, blocks in Sextant's memory, `expiring`, `|daysLeft`, the warning days in a frame's
context and the main category's own title).

## At a glance

| | |
|---|---|
| Id | `sextant.cert-manager` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `cert-manager-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → cert-manager |
| Checked against | cert-manager's objects as cert-manager writes them (`cert-manager.io/v1`, `acme.cert-manager.io/v1`: `pkg/apis/certmanager/v1`, `pkg/apis/acme/v1`, the certificates and ACME controllers) |

## What it adds

**A sidebar section "cert-manager"** (`certManager`), shown while the cluster serves cert-manager's kinds, with the
built-in section's icon, right after Access Control: Certificates, Certificate Requests, Issuers, Cluster Issuers,
Orders and Challenges, each with its own icon, Sextant's own table, filters, selection bar and details, and Edit and
Delete as on every kind. The section's counter shows how many Certificates need attention (the problems below). Orders
and Challenges are listed only where the cluster serves the ACME kinds.

**"Only problems"**, as the built-in tables had it: Certificates not ready for a failure (not while being issued:
`DoesNotExist`, `Issuing`, `InProgress`, `Pending`, `MissingData`) or whose issuance failed (`Issuing` False with
`Failed`); CertificateRequests denied, invalid or failed; Issuers and ClusterIssuers not ready; Orders and Challenges
`invalid`, `errored` or `expired`.

**Columns**, after Name (and Namespace), in place of the CRDs' own printer columns (left out, as the built-in view did),
in the built-in columns' widths:
- Certificate: **Ready** (`cert-ready`: the Ready condition's status, green, red or yellow), **Secret**
  (`cert-secret`), **Issuer** (`cert-issuer`: `Kind/name`, an empty kind as `Issuer`), **Expires** (`cert-expires`:
  "Expired" in red from `notAfter` on, else the whole days left, yellow within your warning days
  (`notifications.certExpiryDays`, Settings → Notifications) and green beyond; sorted and filtered by `notAfter`,
  `notAfter` on hover),
  **Status** (`cert-status`: the Ready condition's message, whole on hover).
- CertificateRequest: **Approval** (`cr-approved`: Denied, Approved or Waiting, coloured, sorted and filtered by the
  state's name), **Ready** (`cr-ready`), **Reason** (`cr-reason`), **Certificate** (`cr-certificate`: the owner,
  else cert-manager's `cert-manager.io/certificate-name` annotation), **Issuer** (`cr-issuer`), **Status**
  (`cr-status`).
- Issuer and ClusterIssuer: **Ready** (`issuer-ready`, `ci-ready`), **Type** (`issuer-type`, `ci-type`: `acme`, `ca`,
  `selfSigned`, `vault` or `venafi`, nothing for an external issuer), **Reason** (`issuer-reason`, `ci-reason`),
  **Status** (`issuer-status`, `ci-status`).
- Order: **State** (`order-state`: the ACME state, green when `valid`, red when failed, else yellow), **Request**
  (`order-request`), **Reason** (`order-reason`, whole on hover).
- Challenge: **State** (`ch-state`), **Domain** (`ch-domain`), **Type** (`ch-type`), **Reason** (`ch-reason`).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, without headings of their own
as the built-in sections had none; their blocks open and close as the built-in panel's did, remembered in Sextant's
own memory of details sections (Settings → Appearance, "Expand all", "Collapse all"):
- a section **cert-manager** (`certmanager`, in place of the generic fields) on the six kinds, one block titled with
  the kind:
  - Certificate: what it is doing or why it is not ready in plain words (issuing revision N, the Secret missing or not
    matching, issuing failed, …); Ready with its reason, the Secret and the issuer (links; an external issuer as
    `Kind/name (group)`), the common name, DNS names, IP addresses, URIs and email addresses, not before, not after
    with the days left (yellow within your warning days, red once expired, yellow while not yet valid; coloured again
    when you change the setting), the renewal time,
    duration, renew before, private key, key rotation, CA certificate and revision; and a block **Last failure** with
    when the last issuance failed, how many attempts, and cert-manager's message;
  - CertificateRequest: approval and readiness in plain words, its Certificate and issuer (links), the revision and
    when it failed;
  - Issuer and ClusterIssuer: readiness in plain words (the ACME account not registered, the CA Secret unreadable,
    …), its type, the ACME server, email and account, the solvers (HTTP-01, DNS-01), the CA Secret (a link for an
    Issuer; a ClusterIssuer's is in cert-manager's cluster resource namespace, which Sextant does not know) and Vault's
    server and path;
  - Order and Challenge: the ACME state and reason in plain words (for a Challenge, what the HTTP-01 or DNS-01 check
    saw: the HTTP status, a name that does not resolve, an unreachable solver, the TXT record not there yet), the
    request or Order (links), the issuer, names, the order URL, type, wildcard and presented;
- a section **Issuance chain** (`chain`) on Certificates, CertificateRequests, Orders and Challenges, one block: the
  Certificate, its newest 3 CertificateRequests (and the one the opened object belongs to; "N older requests are not
  shown"), their Orders and Challenges, each with its state and reason, the opened object marked; requests of the
  same revision and creation time in the order the watch gave them, as the built-in chain. It watches the
  CertificateRequests, Orders and Challenges of the object's namespace — the kinds the cluster serves only — while the
  block is open, as the built-in one did.

Every object named is a link to its details in Sextant's panel.

## Permissions

- **Read** the six cert-manager kinds, in every namespace of every cluster: each section reads the object it shows, and
  the chain lists the CertificateRequests, Orders and Challenges of that object's namespace.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge Certificates; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

The rules are the extension's main category, **"Certificates"** (`ext:sextant.cert-manager`, titled by
`problemsTitle`), on by default, as the built-in category `certificates` was; Sextant moves your setting for that
category to it. AI agents get these problems only when you choose so in Settings → AI agents
(MCP) (ADR-0146). Every rule may notify; the two rules of a failure form one notification group. A failure's reason is
the Ready condition's own (`Failed`, `InvalidKeyPair`, … "NotReady" when it gives none) or `IssuanceFailed`; an
expiring certificate's is `Expiring` with "Expires at" and its `notAfter`, an expired one's `Expired` with "Expired at",
as the built-in problems wrote them. "Expiring" follows your warning days (`notifications.certExpiryDays`, 14 by
default), and a change of the setting moves the problems already found. A grace
counts from the condition's `lastTransitionTime` (from when Sextant first saw it without one). The rules watch at most
20 000 Certificates per cluster.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `certificate-not-ready` | Certificate | Ready False for a reason other than being issued (`DoesNotExist`, `Issuing`, `InProgress`, `Pending`, `MissingData`), with the condition's reason and message | 2 min | No |
| `certificate-issuance-failed` | Certificate | Otherwise, `Issuing` False with `Failed` (a first issuance or a renewal that keeps failing), with the condition's message | 2 min | No |
| `certificate-expiring` | Certificate | `status.notAfter` is no more than your warning days away and not yet past | None | No |
| `certificate-expired` | Certificate | `status.notAfter` has passed | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own. As in the built-in view there is no "renew": cert-manager's
renew (`cmctl renew`) sets the Issuing condition through the status subresource, and deleting the Secret takes the
certificate away until a new one is issued (ADR-0069).

## What it does not do

- It does not issue, renew, approve or deny anything, and does not read the Secrets it names: a Secret's certificate is
  shown by Sextant itself (the "Certificate" section of TLS Secrets and the "TLS certificates" page, ADR-0069).
- It does not recompute what cert-manager decides: every state shown is cert-manager's own from the objects.
- It does not ask the ACME server or check DNS; what a Challenge saw is cert-manager's `status.reason`.

## Requirements and limits

- cert-manager's CRDs (`cert-manager.io/v1`; Orders and Challenges `acme.cert-manager.io/v1`); the section shows only
  where the cluster serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - A Ready condition with an empty reason gives the reason "NotReady"; the built-in problem kept the empty text
    (cert-manager writes no such condition).
  - A `status.notAfter` that is no time (cert-manager writes none) shows nothing in Expires, as the built-in did, but
    has no sort or filter value and no hover there; the built-in sorted and filtered by the text and hovered it.
- Checked by tests on fixtures of cert-manager's objects (copied from the built-in view) against the built-in readings
  and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "cert-manager" section:** the cluster does not serve cert-manager's kinds, or the extension is disabled.
- **No Orders or Challenges:** the cluster does not serve `acme.cert-manager.io`; cert-manager installs it with its
  CRDs.
- **"This object does not belong to a known Certificate." in the chain:** the Order's CertificateRequest (or the
  Challenge's Order) is gone, or the extension may not list them in that namespace.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → cert-manager.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/cert-manager        # → extensions/cert-manager/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/cert-manager
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds the chain's
  watches.
- `model.ts` reads cert-manager's fields; it is the former built-in view's model, ported, with the built-in problem
  detector of the `certificates` category (`certificateProblems`) and the tables' filter (`isProblem`) kept as the
  reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, its kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `certmanager`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `cert-manager` and
     the commit (add `cert-manager` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
