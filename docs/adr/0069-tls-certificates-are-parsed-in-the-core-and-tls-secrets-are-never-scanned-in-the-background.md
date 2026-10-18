# ADR-0069: TLS certificates are parsed in the core, and TLS Secrets are never scanned in the background

## Context

"When does this certificate expire and whom is it for?" is asked of every TLS Secret, with or without cert-manager (#138). The answer is in the Secret's `tls.crt`, but Secret values never reach the window (they are stripped in the core, `resources::get::to_json`), and the API server has no field projection for Secret data: reading `tls.crt` means receiving the whole Secret, `tls.key` included. cert-manager Certificates carry `status.notAfter` themselves, so they need no Secret to judge; a plain TLS Secret does. The problems screen and the notifications (ADR-0066) already watch cert-manager Certificates and warn a fixed 14 days ahead.

## Decision

- **Parsed in Rust, only the certificates come out.** `sextant_core::tls` reads one Secret (`tls_certificate_info`) or lists `kubernetes.io/tls` Secrets (`tls_expiry_scan`) with the user's own credentials and returns only what the certificates claim: subject, names, issuer, serial, validity, key type and size, signature algorithm, CA flag, chain order, SHA-256 fingerprint (`SecretCertificates`, `TlsExpiry`). Only `tls.crt` and `ca.crt` are parsed (`x509-parser`); nothing is verified (no signature check, no trust store).
- **Everything else is wiped as soon as the Secret is in hand.** The other data values (the key first) and every annotation (`last-applied-configuration` may hold the values) are overwritten and dropped; `tls.crt` and `ca.crt` are overwritten after parsing, and so is the decoded content of a non-certificate PEM block found in them (a key pasted into `tls.crt`). Best effort: the HTTP body and the JSON the client decoded are freed by the client without being overwritten. Nothing of a key is returned, logged or kept.
- **Bounded and validated.** The namespace and name are checked against the DNS-1123 rules before any request; every request runs under `STEP_TIMEOUT`; a value over `MAX_PEM_BYTES` (256 KiB) is not parsed, at most `MAX_CERTIFICATES` (16) per value are read (`truncated`); a scan reads at most `SCAN_MAX_SECRETS` (1000) Secrets in pages of 50 from at most `SCAN_MAX_NAMESPACES` (200) namespaces and names the namespaces it may not list. A value that does not parse is `invalid` with a fixed message that never echoes the content.
- **On demand only.** The certificate of a TLS Secret (or any Secret with a `tls.crt` key) is read when its details show the "Certificate" section; the "TLS certificates" page (Config section) scans the namespaces in view when it opens, when the filter changes and on Refresh. TLS Secrets are **not** a source of the problems screen or the notifications; only cert-manager Certificates are, by their `status.notAfter`.
- **The warning is a setting.** "Expiring" means within `notifications.certExpiryDays` (default 14, 1–365, frontend-written), shared by the problems rules, the notifications, the Certificate tables and details, the TLS Secret section and the TLS page; this replaces the fixed 14 days of ADR-0066.
- **Window only.** Neither the MCP server nor the extension API offers these commands (a test in `src-tauri/src/commands/tls.rs` asserts it).
- The cert-manager section itself (Certificates, CertificateRequests, Issuers, ClusterIssuers, Orders, Challenges, the issuance chain, plain-language explanations of the common failures) is read-only and frontend-only, like the Gateway API views (ADR-0063). It offers no "renew": `cmctl renew` sets the Issuing condition through the status subresource, which Sextant's patch does not reach, and deleting the Secret would take the certificate away until a new one is issued.

## Why

- Sending `tls.crt` to the frontend was rejected: it is a Secret value, and the rule that Secret values reach the window only on an explicit request (`secret_value`, `resource_get_full`) has no exception for "harmless" keys; a frontend parser would also need the value to cross the boundary first.
- A background expiry check of TLS Secrets (for the problems screen and notifications) was rejected: a watch never carries the values, so judging them would re-read every TLS Secret of every connected cluster, private keys included, on a timer. cert-manager Certificates do not have this problem, and the TLS page answers the question when the user asks it.
- A trust or signature check was rejected: Sextant does not know the trust store of the clients that will connect, and a "valid" verdict from it would claim more than it knows. The fields are shown as the certificate claims them.

## Consequences

- An expiring certificate that cert-manager does not manage is seen only when someone opens its Secret or the TLS page; there is no notification for it.
- Each scan reads whole Secrets from the API server; the page says so and never refreshes by itself.
- The wiping is best effort: copies made by the HTTP client and the JSON decoder are freed but not overwritten.
- Tests: `crates/sextant-core/src/tls/tests.rs` (parsing, caps, wiping, validation; fixtures in `tls/testdata/`), `crates/sextant-core/tests/tls.rs` against the test cluster, `src/features/cert-manager/certmanager.test.tsx`.
