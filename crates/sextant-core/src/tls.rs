//! Certificates of TLS Secrets (#138): what the certificate in a Secret's `tls.crt` (and `ca.crt`) says — subject,
//! names, issuer, serial, validity, key, chain length and fingerprint — parsed here, in the core, so the frontend
//! never gets a Secret value.
//!
//! ```ignore
//! let info = tls::secret_certificates(&mgr, &cluster, "shop", "shop-tls").await?;   // one Secret, the details panel
//! let scan = tls::expiry_scan(&mgr, &cluster, Some(&["shop".into()])).await?;       // `kubernetes.io/tls` Secrets
//! ```
//!
//! Rules: only `tls.crt` and `ca.crt` are read. The API server sends the whole Secret, `tls.key` included (there is no
//! field projection for Secret data). As soon as the Secret is in hand, every other data value and every annotation
//! (`last-applied-configuration` may hold the values) is overwritten and dropped; `tls.crt` and `ca.crt` are
//! overwritten once parsed, and so is the decoded content of any non-certificate PEM block in them (a private key put
//! into `tls.crt`). Best effort: the HTTP body and the JSON the client decoded it from are freed by the client
//! without being overwritten. Nothing of a key is returned, logged or kept. Names are checked before any request,
//! every request has a time limit (`STEP_TIMEOUT`), input is capped (`MAX_PEM_BYTES`, `MAX_CERTIFICATES`), and a value
//! that does not parse is `invalid` with a fixed message that never echoes the content. Nothing is verified (no
//! signature, no trust store): the fields are what the certificate claims.

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::jiff::Timestamp;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::GeneralName;
use x509_parser::pem::Pem;
use x509_parser::prelude::FromDer;
use x509_parser::public_key::PublicKey;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;
#[cfg(not(test))]
use crate::resources::STEP_TIMEOUT;

/// The time limit of one request: `STEP_TIMEOUT`, shorter in tests so a stalled server is tested on the real clock
/// (a paused clock can jump past the connect timeout while a new connection is being made).
#[cfg(not(test))]
const REQUEST_TIMEOUT: std::time::Duration = STEP_TIMEOUT;
#[cfg(test)]
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// The certificate chain of a TLS Secret.
pub const TLS_CERT_KEY: &str = "tls.crt";
/// The private key: never read, returned, logged or kept.
pub const TLS_KEY_KEY: &str = "tls.key";
/// The CA bundle cert-manager (and others) put next to the chain.
pub const CA_CERT_KEY: &str = "ca.crt";
/// `type` of a TLS Secret.
pub const TLS_SECRET_TYPE: &str = "kubernetes.io/tls";

/// A `tls.crt` or `ca.crt` larger than this is not parsed.
pub const MAX_PEM_BYTES: usize = 256 * 1024;
/// At most this many certificates of one value are parsed (a longer bundle is cut, `truncated`).
pub const MAX_CERTIFICATES: usize = 16;
/// The scan reads at most this many Secrets (`TlsExpiryScan::truncated` past it).
pub const SCAN_MAX_SECRETS: usize = 1000;
/// Page size of the scan's lists: small, so a page of large Secrets stays small in memory.
const SCAN_PAGE: u32 = 50;
/// The scan lists at most this many namespaces (`TlsExpiryScan::namespaces_truncated` past it).
pub const SCAN_MAX_NAMESPACES: usize = 200;
/// Names of one certificate kept in a scan row.
const SCAN_MAX_NAMES: usize = 10;

/// One parsed certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CertificateInfo {
    /// The subject's distinguished name (`CN=…, O=…`).
    pub subject: String,
    /// The subject's common name, if it has one.
    pub common_name: Option<String>,
    /// The issuer's distinguished name.
    pub issuer: String,
    /// The issuer's common name, if it has one.
    pub issuer_common_name: Option<String>,
    /// Upper-case hex bytes separated by `:`.
    pub serial: String,
    /// Subject alternative names by type.
    pub dns_names: Vec<String>,
    pub ip_addresses: Vec<String>,
    pub emails: Vec<String>,
    pub uris: Vec<String>,
    /// RFC 3339, UTC.
    pub not_before: String,
    pub not_after: String,
    /// `RSA`, `ECDSA`, `Ed25519`, `Ed448`, `DSA`, or the algorithm's OID.
    pub key_algorithm: String,
    /// Bits of the public key, when known.
    pub key_size: Option<u32>,
    /// The signature algorithm's name (`sha256WithRSAEncryption`, …) or OID.
    pub signature_algorithm: String,
    /// A CA certificate (basic constraints `cA`).
    pub is_ca: bool,
    /// Subject and issuer are the same name.
    pub self_signed: bool,
    /// SHA-256 of the DER, upper-case hex bytes separated by `:`.
    pub fingerprint_sha256: String,
}

/// What a TLS Secret's certificates say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretCertificates {
    /// `tls.crt` in file order: the leaf first, then the intermediates it was given.
    pub chain: Vec<CertificateInfo>,
    /// `tls.crt` had more than `MAX_CERTIFICATES` certificates; the rest were not parsed.
    pub chain_truncated: bool,
    /// `ca.crt`, when the Secret has one that parses.
    pub ca: Vec<CertificateInfo>,
    /// The Secret has a `ca.crt` that is not a certificate (or too large).
    pub ca_invalid: bool,
}

/// One TLS Secret of a scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TlsExpiry {
    pub namespace: String,
    pub name: String,
    /// The earliest `notAfter` of `tls.crt` (RFC 3339): the leaf's, or an intermediate's that expires first.
    /// `None` with `invalid`.
    pub not_after: Option<String>,
    /// The leaf's common name and DNS names (at most a few).
    pub common_name: Option<String>,
    pub dns_names: Vec<String>,
    /// The leaf's issuer common name.
    pub issuer_common_name: Option<String>,
    /// `tls.crt` is missing, empty, too large or not a certificate.
    pub invalid: bool,
}

/// The `kubernetes.io/tls` Secrets of some namespaces, with when they expire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TlsExpiryScan {
    pub items: Vec<TlsExpiry>,
    /// More than `SCAN_MAX_SECRETS` Secrets: the rest were not read.
    pub truncated: bool,
    /// Namespaces whose Secrets the user may not list.
    pub forbidden: Vec<String>,
    /// More than `SCAN_MAX_NAMESPACES` namespaces were asked for: the rest (by name) were not read.
    pub namespaces_truncated: bool,
}

fn invalid(what: &str) -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        format!("{what} is not a PEM or DER X.509 certificate"),
    )
}

/// The certificates of one PEM bundle (or one DER certificate); at most `MAX_CERTIFICATES` (the flag says if more
/// were cut). `what` names the value in errors (`tls.crt`); the content is never echoed.
pub fn parse_certificates(bytes: &[u8], what: &str) -> CoreResult<(Vec<CertificateInfo>, bool)> {
    if bytes.len() > MAX_PEM_BYTES {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "{what} is larger than {} KiB and was not read",
                MAX_PEM_BYTES / 1024
            ),
        ));
    }
    let looks_pem = bytes
        .windows(b"-----BEGIN".len())
        .any(|w| w == b"-----BEGIN");
    if !looks_pem {
        // A single DER certificate (rare in Secrets, but valid).
        let (_, cert) = X509Certificate::from_der(bytes).map_err(|_| invalid(what))?;
        return Ok((vec![describe(&cert, bytes)], false));
    }
    let mut out = Vec::new();
    let mut truncated = false;
    for block in Pem::iter_from_buffer(bytes) {
        let mut block = block.map_err(|_| invalid(what))?;
        // Keys, parameters and other blocks next to the certificates are skipped unread (and their decoded bytes
        // overwritten).
        if block.label != "CERTIFICATE" {
            wipe_bytes(&mut block.contents);
            continue;
        }
        if out.len() == MAX_CERTIFICATES {
            truncated = true;
            break;
        }
        let (_, cert) = X509Certificate::from_der(&block.contents).map_err(|_| invalid(what))?;
        out.push(describe(&cert, &block.contents));
    }
    if out.is_empty() {
        return Err(invalid(what));
    }
    Ok((out, truncated))
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn rfc3339(seconds: i64) -> String {
    Timestamp::from_second(seconds)
        .map(|t| t.to_string())
        .unwrap_or_default()
}

fn ip_text(bytes: &[u8]) -> String {
    match bytes.len() {
        4 => std::net::Ipv4Addr::from(<[u8; 4]>::try_from(bytes).unwrap_or_default()).to_string(),
        16 => std::net::Ipv6Addr::from(<[u8; 16]>::try_from(bytes).unwrap_or_default()).to_string(),
        _ => hex_bytes(bytes),
    }
}

fn common_name(name: &x509_parser::x509::X509Name<'_>) -> Option<String> {
    name.iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_owned)
}

fn key_of(cert: &X509Certificate<'_>) -> (String, Option<u32>) {
    let spki = cert.public_key();
    let oid = spki.algorithm.algorithm.to_id_string();
    let named = match oid.as_str() {
        "1.2.840.113549.1.1.1" | "1.2.840.113549.1.1.10" => Some("RSA"),
        "1.2.840.10045.2.1" => Some("ECDSA"),
        "1.3.101.112" => Some("Ed25519"),
        "1.3.101.113" => Some("Ed448"),
        "1.2.840.10040.4.1" => Some("DSA"),
        _ => None,
    };
    let size = match oid.as_str() {
        "1.3.101.112" => Some(256),
        "1.3.101.113" => Some(456),
        _ => match spki.parsed() {
            Ok(PublicKey::RSA(rsa)) => Some(rsa.key_size()),
            // The EC point's size is that of the curve.
            Ok(PublicKey::EC(_)) => curve_bits(spki),
            Ok(key) => Some(key.key_size()),
            Err(_) => None,
        },
    }
    .filter(|bits| *bits > 0)
    .and_then(|bits| u32::try_from(bits).ok());
    (named.map_or(oid, str::to_owned), size)
}

/// Bits of a named curve (the EC algorithm's parameter).
fn curve_bits(spki: &x509_parser::x509::SubjectPublicKeyInfo<'_>) -> Option<usize> {
    let curve = spki
        .algorithm
        .parameters
        .as_ref()?
        .as_oid()
        .ok()?
        .to_id_string();
    match curve.as_str() {
        "1.2.840.10045.3.1.7" => Some(256),
        "1.3.132.0.34" => Some(384),
        "1.3.132.0.35" => Some(521),
        "1.3.132.0.10" => Some(256),
        _ => None,
    }
}

fn signature_name(cert: &X509Certificate<'_>) -> String {
    let oid = &cert.signature_algorithm.algorithm;
    x509_parser::objects::oid2sn(oid, x509_parser::objects::oid_registry())
        .map_or_else(|_| oid.to_id_string(), str::to_owned)
}

fn describe(cert: &X509Certificate<'_>, der: &[u8]) -> CertificateInfo {
    let mut dns_names = Vec::new();
    let mut ip_addresses = Vec::new();
    let mut emails = Vec::new();
    let mut uris = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(v) => dns_names.push((*v).to_owned()),
                GeneralName::IPAddress(v) => ip_addresses.push(ip_text(v)),
                GeneralName::RFC822Name(v) => emails.push((*v).to_owned()),
                GeneralName::URI(v) => uris.push((*v).to_owned()),
                _ => {}
            }
        }
    }
    let (key_algorithm, key_size) = key_of(cert);
    let validity = cert.validity();
    CertificateInfo {
        subject: cert.subject().to_string(),
        common_name: common_name(cert.subject()),
        issuer: cert.issuer().to_string(),
        issuer_common_name: common_name(cert.issuer()),
        serial: hex_bytes(cert.raw_serial()),
        dns_names,
        ip_addresses,
        emails,
        uris,
        not_before: rfc3339(validity.not_before.timestamp()),
        not_after: rfc3339(validity.not_after.timestamp()),
        key_algorithm,
        key_size,
        signature_algorithm: signature_name(cert),
        is_ca: cert.is_ca(),
        self_signed: cert.subject().as_raw() == cert.issuer().as_raw(),
        fingerprint_sha256: hex_bytes(&Sha256::digest(der)),
    }
}

/// Overwrites bytes before they are dropped (best effort: copies made while they were decoded are not reached).
fn wipe_bytes(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

/// `tls.crt` and `ca.crt` of a Secret, overwritten when dropped (after parsing).
struct CertificateValues {
    crt: Option<ByteString>,
    ca: Option<ByteString>,
}

impl CertificateValues {
    fn crt(&self) -> Option<&[u8]> {
        self.crt
            .as_ref()
            .map(|v| v.0.as_slice())
            .filter(|v| !v.is_empty())
    }

    fn ca(&self) -> Option<&[u8]> {
        self.ca
            .as_ref()
            .map(|v| v.0.as_slice())
            .filter(|v| !v.is_empty())
    }
}

impl Drop for CertificateValues {
    fn drop(&mut self) {
        for value in [&mut self.crt, &mut self.ca].into_iter().flatten() {
            wipe_bytes(&mut value.0);
        }
    }
}

/// Takes `tls.crt` and `ca.crt` out of a Secret; everything else that may hold a value — the other data (the key
/// first) and the annotations (`last-applied-configuration`) — is overwritten and dropped with the Secret.
fn certificate_values(mut secret: Secret) -> CertificateValues {
    let mut data = secret.data.take().unwrap_or_default();
    let values = CertificateValues {
        crt: data.remove(TLS_CERT_KEY),
        ca: data.remove(CA_CERT_KEY),
    };
    for value in data.values_mut() {
        wipe_bytes(&mut value.0);
    }
    for map in [
        secret.metadata.annotations.as_mut(),
        secret.string_data.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        for value in map.values_mut() {
            let mut bytes = std::mem::take(value).into_bytes();
            wipe_bytes(&mut bytes);
        }
    }
    values
}

/// A DNS-1123 label (a namespace): at most 63 lowercase letters, digits and `-`, starting and ending alphanumeric.
fn is_dns_label(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
}

/// A DNS-1123 subdomain (a Secret's name): at most 253 characters, dot-separated labels.
fn is_dns_subdomain(s: &str) -> bool {
    s.len() <= 253 && s.split('.').all(is_dns_label)
}

fn check_namespace(namespace: &str) -> CoreResult<()> {
    if is_dns_label(namespace) {
        return Ok(());
    }
    Err(CoreError::new(
        ErrorCode::Invalid,
        "a namespace is a DNS-1123 label (lowercase letters, digits and '-')",
    ))
}

/// The certificates of one Secret (any type with a `tls.crt`). A Secret without `tls.crt` is `notFound`; a value that
/// does not parse is `invalid`. The user's own credentials read it: no permission is `forbidden`.
pub async fn secret_certificates(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    name: &str,
) -> CoreResult<SecretCertificates> {
    check_namespace(namespace)?;
    if !is_dns_subdomain(name) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a Secret's name is a DNS-1123 subdomain (lowercase letters, digits, '-' and '.')",
        ));
    }
    let client = mgr.client(cluster)?;
    let secret = with_timeout(REQUEST_TIMEOUT, "reading the Secret", async {
        Api::<Secret>::namespaced(client, namespace)
            .get(name)
            .await
            .map_err(CoreError::from)
    })
    .await?;
    let values = certificate_values(secret);
    let Some(crt) = values.crt() else {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("secret {namespace}/{name} has no {TLS_CERT_KEY}"),
        ));
    };
    let (chain, chain_truncated) = parse_certificates(crt, TLS_CERT_KEY)?;
    let (ca, ca_invalid) = match values.ca() {
        None => (Vec::new(), false),
        Some(ca) => match parse_certificates(ca, CA_CERT_KEY) {
            Ok((list, _)) => (list, false),
            Err(_) => (Vec::new(), true),
        },
    };
    Ok(SecretCertificates {
        chain,
        chain_truncated,
        ca,
        ca_invalid,
    })
}

fn scan_row(secret: Secret) -> TlsExpiry {
    let namespace = secret.metadata.namespace.clone().unwrap_or_default();
    let name = secret.metadata.name.clone().unwrap_or_default();
    let values = certificate_values(secret);
    let parsed = values
        .crt()
        .and_then(|crt| parse_certificates(crt, TLS_CERT_KEY).ok());
    let Some((chain, _)) = parsed else {
        return TlsExpiry {
            namespace,
            name,
            not_after: None,
            common_name: None,
            dns_names: Vec::new(),
            issuer_common_name: None,
            invalid: true,
        };
    };
    // RFC 3339 in UTC sorts as text.
    let not_after = chain.iter().map(|c| c.not_after.clone()).min();
    let leaf = chain.into_iter().next();
    TlsExpiry {
        namespace,
        name,
        not_after,
        common_name: leaf.as_ref().and_then(|l| l.common_name.clone()),
        dns_names: leaf
            .as_ref()
            .map(|l| l.dns_names.iter().take(SCAN_MAX_NAMES).cloned().collect())
            .unwrap_or_default(),
        issuer_common_name: leaf.and_then(|l| l.issuer_common_name),
        invalid: false,
    }
}

/// Lists `kubernetes.io/tls` Secrets of `api` page by page into `scan`, until `SCAN_MAX_SECRETS`.
async fn scan_list(api: Api<Secret>, scan: &mut TlsExpiryScan) -> CoreResult<()> {
    let mut token: Option<String> = None;
    loop {
        let room = SCAN_MAX_SECRETS - scan.items.len();
        if room == 0 {
            // Full before this list (another namespace filled it): whatever is here is left unread.
            scan.truncated = true;
            return Ok(());
        }
        let mut params = ListParams::default()
            .fields(&format!("type={TLS_SECRET_TYPE}"))
            .limit(SCAN_PAGE.min(u32::try_from(room).unwrap_or(SCAN_PAGE)));
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        let list = with_timeout(REQUEST_TIMEOUT, "listing TLS Secrets", async {
            api.list(&params).await.map_err(CoreError::from)
        })
        .await?;
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        for secret in list.items {
            if scan.items.len() == SCAN_MAX_SECRETS {
                scan.truncated = true;
                return Ok(());
            }
            scan.items.push(scan_row(secret));
        }
        match next {
            None => return Ok(()),
            Some(_) if scan.items.len() == SCAN_MAX_SECRETS => {
                scan.truncated = true;
                return Ok(());
            }
            Some(t) => token = Some(t),
        }
    }
}

/// The `kubernetes.io/tls` Secrets of `namespaces` (all namespaces for `None`) with the earliest `notAfter` of each
/// chain; at most `SCAN_MAX_SECRETS` Secrets of the first `SCAN_MAX_NAMESPACES` namespaces (by name). A namespace that
/// is not a DNS-1123 label is `invalid` before any request; one the user may not list is named in `forbidden`; with
/// `None`, no permission to list Secrets cluster-wide is `forbidden`. A request that takes longer than `STEP_TIMEOUT`
/// ends the scan with `timeout`.
pub async fn expiry_scan(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespaces: Option<&[String]>,
) -> CoreResult<TlsExpiryScan> {
    let client = mgr.client(cluster)?;
    let mut scan = TlsExpiryScan {
        items: Vec::new(),
        truncated: false,
        forbidden: Vec::new(),
        namespaces_truncated: false,
    };
    match namespaces {
        None => scan_list(Api::all(client), &mut scan).await?,
        Some(list) => {
            let mut unique: Vec<&String> = list.iter().filter(|n| !n.is_empty()).collect();
            unique.sort();
            unique.dedup();
            for ns in &unique {
                check_namespace(ns)?;
            }
            if unique.len() > SCAN_MAX_NAMESPACES {
                unique.truncate(SCAN_MAX_NAMESPACES);
                scan.namespaces_truncated = true;
            }
            for ns in unique {
                if scan.truncated {
                    break;
                }
                match scan_list(Api::namespaced(client.clone(), ns), &mut scan).await {
                    Ok(()) => {}
                    Err(err) if err.code == ErrorCode::Forbidden => scan.forbidden.push(ns.clone()),
                    Err(err) => return Err(err),
                }
            }
        }
    }
    scan.items.sort_by(|a, b| {
        // Unreadable first, then the soonest to expire.
        (!a.invalid, &a.not_after, &a.namespace, &a.name).cmp(&(
            !b.invalid,
            &b.not_after,
            &b.namespace,
            &b.name,
        ))
    });
    Ok(scan)
}

#[cfg(test)]
mod tests;
