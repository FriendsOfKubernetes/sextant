// Sealed Secrets (#240): the discovered sidebar section "Sealed Secrets" — SealedSecrets (bitnami.com) with the
// controller's Synced condition and its error in words, the scope they were sealed for, the target Secret (a link and
// how it stands, from its metadata only), the sealed keys by name and size, and the controller found in the cluster
// with its sealing keys (metadata only; the certificate is not read). Failed unseals and synced SealedSecrets whose
// Secret is missing feed the problems screen (category `sealedSecrets`) and the section counter. Read-only, and never
// a value, sealed or decrypted (ADR-0109).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useSealedSecretsProblemCount } from "./badge";
import "./provider";
import "./register";
import "./sealed-secrets.css";

registerSectionBadge("sealedSecrets", useSealedSecretsProblemCount, { tone: "danger", labelKey: "sealedsecrets:badge" });

export * from "./model";
