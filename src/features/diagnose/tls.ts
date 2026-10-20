// TLS of an Ingress: each `spec.tls` entry's Secret exists and holds a certificate (read by the core through
// `tls_certificate_info`, #138 — only the certificate's fields reach the window, never a value), the certificate is
// valid now, and it covers every host the entry names.
import type { CertificateInfo, KubeObject } from "../../api";
import { status } from "../../resources";
import { phrase, type ClusterView, type Finding, type LinkRef } from "./model";
import { namespaceOf, SECRET } from "./objects";

const { arr, get, str } = status;

/** Whether a certificate name (`*.example.com` covers one label) covers `host`. */
export function nameCovers(name: string, host: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, "");
  const h = host.toLowerCase().replace(/\.$/, "");
  if (n === h) return true;
  if (!n.startsWith("*.") || h.startsWith("*.")) return false;
  const dot = h.indexOf(".");
  return dot > 0 && h.slice(dot + 1) === n.slice(2);
}

/** The names a certificate is valid for: its DNS names, or its common name when it has none (legacy). */
export function certificateNames(cert: CertificateInfo): string[] {
  if (cert.dnsNames.length > 0) return cert.dnsNames;
  return cert.commonName ? [cert.commonName] : [];
}

export function hostCovered(cert: CertificateInfo, host: string): boolean {
  return certificateNames(cert).some((n) => nameCovers(n, host));
}

export interface TlsEntry {
  index: number;
  hosts: string[];
  secretName: string | undefined;
}

export function tlsEntries(ingress: KubeObject): TlsEntry[] {
  return arr(get(ingress, "spec", "tls")).map((entry, index) => ({
    index,
    hosts: arr(get(entry, "hosts")).filter((h): h is string => typeof h === "string" && h !== ""),
    secretName: str(get(entry, "secretName")) || undefined,
  }));
}

/** One finding per TLS entry of the Ingress. */
export function tlsFindings(ingress: KubeObject, view: ClusterView): Finding[] {
  const namespace = namespaceOf(ingress);
  return tlsEntries(ingress).map((entry): Finding => {
    const id = `ingress.tls.${entry.index}`;
    const hosts = entry.hosts;
    if (!entry.secretName) return { id, status: "warn", text: phrase("ingress.tlsNoSecret", { hosts }) };
    const name = entry.secretName;
    const links: LinkRef[] = [{ kind: SECRET, namespace, name }];
    const state = view.certificates(namespace, name);
    if (!state) return { id, status: "unknown", text: phrase("ingress.tlsUnknown", { name }), links };
    if (state.state === "notFound") return { id, status: "broken", text: phrase("ingress.tlsSecretMissing", { name, namespace }) };
    if (state.state === "error") {
      const key = state.code === "invalid" ? "ingress.tlsInvalid" : state.code === "forbidden" ? "ingress.tlsForbidden" : "ingress.tlsUnknown";
      return { id, status: state.code === "invalid" ? "broken" : "unknown", text: phrase(key, { name }), links };
    }
    const leaf = state.info.chain[0];
    if (!leaf) return { id, status: "broken", text: phrase("ingress.tlsInvalid", { name }), links };
    const notAfter = Date.parse(leaf.notAfter);
    const notBefore = Date.parse(leaf.notBefore);
    if (Number.isFinite(notAfter) && notAfter < view.now) return { id, status: "broken", text: phrase("ingress.tlsExpired", { name }), links };
    if (Number.isFinite(notBefore) && notBefore > view.now) return { id, status: "broken", text: phrase("ingress.tlsNotYetValid", { name }), links };
    const names = certificateNames(leaf);
    const notes = leaf.dnsNames.length === 0 && leaf.commonName ? [phrase("ingress.tlsCommonNameOnly")] : undefined;
    if (hosts.length === 0) return { id, status: "warn", text: phrase("ingress.tlsNoHosts", { name }), links, notes };
    const uncovered = hosts.filter((h) => !hostCovered(leaf, h));
    if (uncovered.length > 0) {
      return { id, status: "broken", text: phrase("ingress.tlsHostNotCovered", { name, hosts: uncovered, names }), links, notes };
    }
    return { id, status: "ok", text: phrase("ingress.tlsOk", { name, hosts }), links, notes };
  });
}
