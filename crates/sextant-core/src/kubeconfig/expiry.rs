//! When the credentials of each kubeconfig context stop working, where the kubeconfig alone tells (#150): a client
//! certificate's `notAfter`, a bearer token's `exp` (when it is a JWT), an OIDC `id-token`'s `exp`. An exec plugin
//! or another auth provider gets a token only when it runs, so for those only the command (or provider) is named.
//!
//! Rules: read-only and offline — nothing is run (exec plugins are never started to look), nothing is sent, no
//! signature is checked. Only the expiry and the kind come back: never a token, a key, a certificate or a claim
//! other than `exp`. Files the kubeconfig names (`client-certificate`, `tokenFile`) are read with a size cap.

use std::path::Path;

use base64::Engine as _;
use k8s_openapi::jiff::Timestamp;
use kube::config::{AuthInfo, Kubeconfig};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ClusterId, KubeconfigRegistry};

/// A certificate or token file larger than this is not read (here and in the checks of a kubeconfig being added).
pub(crate) const MAX_CREDENTIAL_FILE: u64 = 256 * 1024;

/// How a context's user signs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CredentialKind {
    /// A client certificate (`client-certificate-data` or `client-certificate`).
    ClientCertificate,
    /// A bearer token (`token` or `tokenFile`).
    Token,
    /// The `oidc` auth provider's `id-token`.
    OidcToken,
    /// An exec plugin (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`…): the token exists only once it runs.
    Exec,
    /// Another (legacy) auth provider.
    AuthProvider,
    /// User name and password.
    Basic,
    /// No credentials in the kubeconfig (or the user entry is missing).
    None,
}

/// Why a credential's expiry could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CredentialProblem {
    /// The file the kubeconfig names is missing or cannot be read.
    FileUnreadable,
    /// The certificate data is not a PEM or DER certificate.
    NotACertificate,
}

/// What is known about one cluster's credentials. Never carries a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CredentialExpiry {
    pub cluster_id: ClusterId,
    pub kind: CredentialKind,
    /// When the credential stops working (RFC 3339, UTC), when the kubeconfig tells.
    pub expires_at: Option<String>,
    /// The exec plugin's file name (`aws`), or the auth provider's name (`oidc`); never its arguments or environment.
    pub command: Option<String>,
    /// The OIDC provider has a refresh token: kubectl gets a new id-token by itself.
    pub refreshable: bool,
    pub problem: Option<CredentialProblem>,
}

impl KubeconfigRegistry {
    /// The credentials of every context, in the order of [`KubeconfigRegistry::clusters`].
    pub fn credential_expiry(&self) -> Vec<CredentialExpiry> {
        self.resolved_contexts()
            .into_iter()
            .map(|(id, _, config)| expiry_of(id, &config))
            .collect()
    }
}

/// The credentials of the (only) context of `config` — a [`super::single_context`] result.
pub fn expiry_of(cluster_id: ClusterId, config: &Kubeconfig) -> CredentialExpiry {
    let mut out = CredentialExpiry {
        cluster_id,
        kind: CredentialKind::None,
        expires_at: None,
        command: None,
        refreshable: false,
        problem: None,
    };
    let Some(user) = config.auth_infos.first().and_then(|u| u.auth_info.as_ref()) else {
        return out;
    };
    // Every credential the user has, each with what is known; the one that runs out first (or the first) is shown.
    let mut found: Vec<CredentialExpiry> = Vec::new();
    let base = out.clone();
    let with = |kind: CredentialKind| CredentialExpiry {
        kind,
        ..base.clone()
    };
    if user.client_certificate_data.is_some() || user.client_certificate.is_some() {
        let mut item = with(CredentialKind::ClientCertificate);
        match certificate_not_after(user) {
            Ok(at) => item.expires_at = at,
            Err(problem) => item.problem = Some(problem),
        }
        found.push(item);
    }
    if user.token.is_some() || user.token_file.is_some() {
        let mut item = with(CredentialKind::Token);
        match token_text(user) {
            Ok(token) => item.expires_at = token.as_deref().and_then(jwt_expiry),
            Err(problem) => item.problem = Some(problem),
        }
        found.push(item);
    }
    if let Some(provider) = &user.auth_provider {
        let oidc = provider.name == "oidc";
        let mut item = with(if oidc {
            CredentialKind::OidcToken
        } else {
            CredentialKind::AuthProvider
        });
        item.command = Some(provider.name.clone());
        if oidc {
            item.expires_at = provider.config.get("id-token").and_then(|t| jwt_expiry(t));
            item.refreshable = provider
                .config
                .get("refresh-token")
                .is_some_and(|t| !t.is_empty());
        }
        found.push(item);
    }
    if let Some(exec) = &user.exec {
        let mut item = with(CredentialKind::Exec);
        item.command = exec.command.as_deref().map(|cmd| {
            Path::new(cmd)
                .file_name()
                .map_or_else(|| cmd.to_owned(), |n| n.to_string_lossy().into_owned())
        });
        found.push(item);
    }
    if user.username.is_some() && user.password.is_some() {
        found.push(with(CredentialKind::Basic));
    }
    let soonest = found
        .iter()
        .filter(|c| c.expires_at.is_some())
        .min_by(|a, b| a.expires_at.cmp(&b.expires_at))
        .cloned();
    if let Some(item) = soonest.or_else(|| found.into_iter().next()) {
        out = item;
    }
    out
}

fn read_small(path: &str) -> Result<Vec<u8>, CredentialProblem> {
    read_capped(Path::new(path), MAX_CREDENTIAL_FILE).ok_or(CredentialProblem::FileUnreadable)
}

/// The content of the regular file at `path` when it has at most `cap` bytes; `None` for anything else (missing,
/// unreadable, a folder, a FIFO or a device, or larger). Never reads more than `cap + 1` bytes, even when the file
/// grows after its size was looked at.
pub(crate) fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    // A FIFO or a device is refused before it is opened: opening a FIFO blocks until a writer comes.
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}

/// The earliest `notAfter` of the client certificate chain (RFC 3339).
fn certificate_not_after(user: &AuthInfo) -> Result<Option<String>, CredentialProblem> {
    let bytes = match (&user.client_certificate_data, &user.client_certificate) {
        (Some(data), _) => base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|_| CredentialProblem::NotACertificate)?,
        (None, Some(file)) => read_small(file)?,
        (None, None) => return Ok(None),
    };
    let (certificates, _) = crate::tls::parse_certificates(&bytes, "the client certificate")
        .map_err(|_| CredentialProblem::NotACertificate)?;
    Ok(certificates.into_iter().map(|c| c.not_after).min())
}

/// The bearer token (from `token`, else `tokenFile`).
fn token_text(user: &AuthInfo) -> Result<Option<String>, CredentialProblem> {
    if let Some(token) = &user.token {
        return Ok(Some(token.expose_secret().to_owned()));
    }
    match &user.token_file {
        Some(file) => {
            let bytes = read_small(file)?;
            Ok(Some(String::from_utf8_lossy(&bytes).trim().to_owned()))
        }
        None => Ok(None),
    }
}

/// The `exp` of a JWT (RFC 3339), read from its payload alone: the signature is not checked, and nothing else of
/// the token is kept. `None` for an opaque token or a JWT without `exp`.
pub fn jwt_expiry(token: &str) -> Option<String> {
    let mut parts = token.trim().split('.');
    let (_, payload, _) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || payload.len() > 64 * 1024 {
        return None;
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let exp = claims.get("exp")?;
    let seconds = exp.as_i64().or_else(|| exp.as_f64().map(|f| f as i64))?;
    Timestamp::from_second(seconds).ok().map(|t| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &str) -> String {
        let b64 = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.c2lnbmF0dXJl", b64(r#"{"alg":"RS256"}"#), b64(claims))
    }

    fn config(user_yaml: &str) -> Kubeconfig {
        Kubeconfig::from_yaml(&format!(
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: {{ server: https://c:6443 }}\nusers:\n  - name: u\n    user:\n{user_yaml}\ncontexts:\n  - name: x\n    context: {{ cluster: c, user: u }}\ncurrent-context: x\n"
        ))
        .unwrap()
    }

    #[test]
    fn credential_files_are_read_only_when_regular_and_small() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("ca.crt");
        std::fs::write(&small, b"abc").unwrap();
        assert_eq!(read_capped(&small, 3).as_deref(), Some(&b"abc"[..]));
        assert_eq!(read_capped(&small, 2), None, "over the cap");
        assert_eq!(read_capped(dir.path(), 1024), None, "a folder");
        assert_eq!(read_capped(&dir.path().join("missing"), 1024), None);
        #[cfg(unix)]
        {
            // A FIFO is never opened (opening one would block).
            let fifo = dir.path().join("fifo");
            let made = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .is_ok_and(|s| s.success());
            if made {
                assert_eq!(read_capped(&fifo, 1024), None);
            }
        }
    }

    #[test]
    fn a_jwt_gives_its_exp_and_an_opaque_token_nothing() {
        assert_eq!(
            jwt_expiry(&jwt(r#"{"sub":"me","exp":1893456000}"#)).as_deref(),
            Some("2030-01-01T00:00:00Z")
        );
        assert_eq!(jwt_expiry(&jwt(r#"{"sub":"me"}"#)), None);
        assert_eq!(jwt_expiry("abcdef.0123456789abcdef"), None);
        assert_eq!(jwt_expiry("not-a-token"), None);
        assert_eq!(jwt_expiry("a.!!!.c"), None);
    }

    #[test]
    fn a_token_user_reports_the_tokens_expiry_and_never_the_token() {
        let token = jwt(r#"{"exp":1893456000}"#);
        let cfg = config(&format!("      token: {token}"));
        let expiry = expiry_of(ClusterId::from("a"), &cfg);
        assert_eq!(expiry.kind, CredentialKind::Token);
        assert_eq!(expiry.expires_at.as_deref(), Some("2030-01-01T00:00:00Z"));
        let json = serde_json::to_string(&expiry).unwrap();
        assert!(!json.contains(&token), "{json}");
    }

    #[test]
    fn a_client_certificate_reports_its_not_after() {
        let pem = include_bytes!("../tls/testdata/expired.pem");
        let data = base64::engine::general_purpose::STANDARD.encode(pem);
        let cfg = config(&format!(
            "      client-certificate-data: {data}\n      client-key-data: a2V5"
        ));
        let expiry = expiry_of(ClusterId::from("a"), &cfg);
        assert_eq!(expiry.kind, CredentialKind::ClientCertificate);
        assert!(expiry.expires_at.is_some(), "{expiry:?}");
        assert_eq!(expiry.problem, None);

        let broken = config("      client-certificate-data: Y2VydA==\n      client-key-data: a2V5");
        let expiry = expiry_of(ClusterId::from("a"), &broken);
        assert_eq!(expiry.problem, Some(CredentialProblem::NotACertificate));
        let missing =
            config("      client-certificate: /nowhere/client.crt\n      client-key: /nowhere/k");
        assert_eq!(
            expiry_of(ClusterId::from("a"), &missing).problem,
            Some(CredentialProblem::FileUnreadable)
        );
    }

    #[test]
    fn exec_and_oidc_users_name_the_command_without_running_it() {
        let cfg = config(
            "      exec:\n        apiVersion: client.authentication.k8s.io/v1beta1\n        command: /usr/local/bin/aws\n        args: [eks, get-token, --token, s3cret]\n        env:\n          - name: AWS_SECRET\n            value: hush",
        );
        let expiry = expiry_of(ClusterId::from("a"), &cfg);
        assert_eq!(expiry.kind, CredentialKind::Exec);
        assert_eq!(expiry.command.as_deref(), Some("aws"));
        assert_eq!(expiry.expires_at, None);
        let json = serde_json::to_string(&expiry).unwrap();
        assert!(!json.contains("s3cret") && !json.contains("hush"), "{json}");

        let id_token = jwt(r#"{"exp":1893456000}"#);
        let cfg = config(&format!(
            "      auth-provider:\n        name: oidc\n        config:\n          id-token: {id_token}\n          refresh-token: r3fresh\n          client-secret: cl1ent"
        ));
        let expiry = expiry_of(ClusterId::from("a"), &cfg);
        assert_eq!(expiry.kind, CredentialKind::OidcToken);
        assert!(expiry.refreshable);
        assert_eq!(expiry.expires_at.as_deref(), Some("2030-01-01T00:00:00Z"));
        let json = serde_json::to_string(&expiry).unwrap();
        assert!(
            !json.contains("r3fresh") && !json.contains("cl1ent") && !json.contains(&id_token),
            "{json}"
        );
    }
}
