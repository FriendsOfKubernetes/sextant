// An HTTPProxy's state in plain words, from what Contour wrote in its status (`currentStatus`, `description` and the
// `Valid` condition's errors). Pure; texts are keys under `contour:explain`.
import type { KubeObject } from "../../api";
import { fqdnOf, ingressClassOf, isRoot, proxyState, servedInPart, validCondition } from "./model";

export interface Phrase {
  /** Key under `contour:explain`. */
  key: string;
  params?: Record<string, string>;
}

/** Error reasons with an explanation of their own. */
const OWN_WORDS: Record<string, string> = {
  DuplicateVhost: "duplicateVhost",
  RootProxyNotAllowedInNamespace: "rootNamespace",
  IncludeCreatesCycle: "includeCycle",
  DelegationNotPermitted: "delegationNotPermitted",
  SecretNotValid: "secretNotValid",
  FQDNNotSpecified: "noFqdn",
  NothingDefined: "nothingDefined",
};

export function explain(obj: KubeObject): Phrase {
  const fqdn = fqdnOf(obj) ?? "";
  switch (proxyState(obj)) {
    case "valid": {
      const warnings = (validCondition(obj)?.warnings.length ?? 0) > 0;
      if (isRoot(obj)) return { key: warnings ? "validRootWarnings" : "validRoot", params: { fqdn } };
      return { key: warnings ? "validIncludedWarnings" : "validIncluded" };
    }
    case "orphaned":
      return { key: "orphaned" };
    case "pending": {
      const ingressClass = ingressClassOf(obj);
      return ingressClass ? { key: "pendingClass", params: { class: ingressClass } } : { key: "pending" };
    }
    case "invalid": {
      const error = validCondition(obj)?.errors[0];
      const reason = error?.reason ?? error?.type ?? "";
      const own = OWN_WORDS[reason];
      if (own) return { key: own, params: { fqdn, reason } };
      return { key: servedInPart(obj) ? "invalidInPart" : "invalid", params: { reason } };
    }
  }
}
