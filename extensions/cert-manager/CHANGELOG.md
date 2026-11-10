# Changes of cert-manager

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: the cert-manager views of Sextant's former built-in module
(ADR-0069) as an extension. The TLS certificate of a Secret and the "TLS certificates" page stay in Sextant.

- **A sidebar section "cert-manager"** after Access Control, with Certificates, Certificate Requests, Issuers, Cluster
  Issuers, Orders and Challenges in Sextant's table, the built-in columns in their widths (a Certificate's days left
  coloured by your warning days), and "Only problems".
- **Details** without headings of their own, their blocks remembered in Sextant's memory of details sections: a block
  titled with the kind (a Certificate's state in plain words, Secret and issuer, names, validity, key and its last
  failure; a request's approval; an issuer's type and ACME account; an Order's or Challenge's ACME state in plain
  words), and the **Issuance chain** Certificate → CertificateRequest → Order → Challenge, read only while it is open.
- **Problems:** Certificates that are not ready, whose issuance failed, that expire within your warning days
  (`notifications.certExpiryDays`) or that have expired, in the extension's main category "Certificates" (the
  built-in category's title), counted on the section. Agents get them only when you choose so in Settings → AI agents (MCP).
- Installing asks for consent to read the six cert-manager kinds and to judge Certificates in problem rules.
