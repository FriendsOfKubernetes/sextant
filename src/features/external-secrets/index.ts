// External Secrets Operator (#213): the discovered sidebar section "External Secrets" — ExternalSecrets,
// ClusterExternalSecrets, SecretStores, ClusterSecretStores and PushSecrets with their Ready state, the store and its
// validation, the target Secret, refresh interval and last sync, and the remote keys by name. Failed syncs and invalid
// stores feed the problems screen (category `externalSecrets`) and the section counter. Read-only, and never a Secret
// value: the target Secret is a link, its data is never read (ADR-0100).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./external-secrets.css";
import { useExternalSecretsProblemCount } from "./problems";
import "./register";

registerSectionBadge("externalSecrets", useExternalSecretsProblemCount, {
  tone: "danger",
  labelKey: "externalsecrets:badge",
});

export * from "./model";
