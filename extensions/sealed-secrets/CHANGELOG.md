# Changes of Sealed Secrets

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Sealed Secrets view (ADR-0109) as an
extension.

- **A sidebar section "Sealed Secrets"** in its built-in place, with SealedSecrets in Sextant's table, the built-in
  columns (Status, Scope, Keys, Message) with their widths, sort orders and filters, and "Only problems".
- **Details:** the Synced state with the controller's error in plain words, the scope, the target Secret and how it
  stands (metadata only), the template, the sealed keys by name and size, and the controller with its sealing keys
  (metadata only; the certificate is never read). Their blocks open and close as Sextant remembers them, and a closed
  block watches nothing; the tables' columns resize, and Sextant remembers their widths, as the built-in tables did.
- **Problems:** failed unseals (after 5 minutes) and synced SealedSecrets whose Secret is missing (after 2 minutes,
  told only where the Secrets are listed in full, metadata only), both notified, in the opt-in category "Sealed
  Secrets", counted on the section while it is on.
- Installing asks for consent to read SealedSecrets, Secrets (watched as metadata only) and Deployments, to judge
  SealedSecrets in problem rules and to list Secrets' names for them.
- The rules' Secrets are listed only in the namespaces of the synced SealedSecrets (`narrowLookups`), as the
  built-in listed them, up to 40 namespaces, then wherever the extension may read.
