//! Registry credentials: `WWW-Authenticate` challenges, token answers, Docker configs (`config.json`, pull Secrets of
//! type `kubernetes.io/dockerconfigjson` and `kubernetes.io/dockercfg`) and which entry applies to a registry.
//!
//! A [`Credential`] stays in the backend: no `Serialize`, a `Debug` that prints `<hidden>`, no error names it.

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine;
use serde_json::Value;

use super::reference::DOCKER_HUB;
use super::{invalid, limits};
use crate::CoreResult;

/// A user name and password (or token used as one), or an identity token (an OAuth2 refresh token).
#[derive(Clone, PartialEq, Eq)]
pub enum Credential {
    Basic { username: String, password: String },
    IdentityToken(String),
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<hidden>")
    }
}

impl Credential {
    /// The value of an `Authorization: Basic …` header.
    pub fn basic_header(&self) -> Option<String> {
        match self {
            Credential::Basic { username, password } => Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
            )),
            Credential::IdentityToken(_) => None,
        }
    }

    pub fn identity_token(&self) -> Option<&str> {
        match self {
            Credential::IdentityToken(token) => Some(token),
            Credential::Basic { .. } => None,
        }
    }
}

/// How a registry asks to be authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Challenge {
    Bearer {
        realm: String,
        service: Option<String>,
    },
    Basic,
}

/// Reads a `WWW-Authenticate` header (`Bearer realm="…",service="…",scope="…"` or `Basic realm="…"`). The scope is
/// ignored: Sextant asks for `repository:<repo>:pull` itself.
pub fn parse_challenge(header: &str) -> Option<Challenge> {
    let header = header.trim();
    let (scheme, params) = header.split_once(' ').unwrap_or((header, ""));
    if scheme.eq_ignore_ascii_case("basic") {
        return Some(Challenge::Basic);
    }
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let params = parse_params(params);
    let realm = params.get("realm")?.clone();
    Some(Challenge::Bearer {
        realm,
        service: params.get("service").cloned(),
    })
}

fn parse_params(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let Some((key, after)) = rest.split_once('=') else {
            break;
        };
        let key = key
            .trim()
            .trim_start_matches(',')
            .trim()
            .to_ascii_lowercase();
        let after = after.trim_start();
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            let mut value = String::new();
            let mut chars = quoted.char_indices();
            let mut end = quoted.len();
            while let Some((i, c)) = chars.next() {
                match c {
                    '\\' => {
                        if let Some((_, escaped)) = chars.next() {
                            value.push(escaped);
                        }
                    }
                    '"' => {
                        end = i + 1;
                        break;
                    }
                    c => value.push(c),
                }
            }
            (value, &quoted[end.min(quoted.len())..])
        } else {
            let end = after.find(',').unwrap_or(after.len());
            (after[..end].trim().to_owned(), &after[end..])
        };
        out.entry(key).or_insert(value);
        rest = next.trim_start().trim_start_matches(',').trim_start();
    }
    out
}

/// The token in a realm's answer (`token`, else `access_token`): printable ASCII, at most 16 KiB.
pub fn parse_token(body: &[u8]) -> CoreResult<String> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| invalid("the registry's token answer is not JSON"))?;
    let token = value
        .get("token")
        .or_else(|| value.get("access_token"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| invalid("the registry's token answer has no token"))?;
    if token.len() > 16 * 1024 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid("the registry's token is not a valid header value"));
    }
    Ok(token.to_owned())
}

/// The registry key of a Docker config entry or a reference as compared: `host[:port]` in lowercase, without a scheme
/// or a path; Docker Hub's names become `docker.io`.
pub fn registry_key(text: &str) -> String {
    let text = text.trim();
    let text = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(text);
    let host = text.split('/').next().unwrap_or("").to_ascii_lowercase();
    match host.as_str() {
        "index.docker.io" | "registry-1.docker.io" | "registry.hub.docker.com" => {
            DOCKER_HUB.to_owned()
        }
        _ => host,
    }
}

/// Whether a config key names `registry` (a [`registry_key`]): equal, or a `*.` wildcard for exactly one label.
pub fn key_matches(key: &str, registry: &str) -> bool {
    let key = registry_key(key);
    if key == registry {
        return true;
    }
    match key.strip_prefix("*.") {
        Some(domain) => registry
            .split_once('.')
            .is_some_and(|(label, rest)| !label.is_empty() && rest == domain),
        None => false,
    }
}

/// The parts of a Docker config that name credentials.
#[derive(Default, Clone, PartialEq, Eq)]
pub struct DockerConfig {
    auths: Vec<(String, Credential)>,
    cred_helpers: Vec<(String, String)>,
    creds_store: Option<String>,
}

impl fmt::Debug for DockerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DockerConfig(<hidden>)")
    }
}

impl DockerConfig {
    /// Reads `config.json` / `.dockerconfigjson` (`{"auths": {…}}`) or the older `.dockercfg` (the map itself). An entry
    /// without usable credentials is left out.
    pub fn parse(bytes: &[u8]) -> CoreResult<Self> {
        if bytes.len() as u64 > limits::MAX_MANIFEST_BYTES {
            return Err(invalid("the Docker config is too large"));
        }
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| invalid("the Docker config is not JSON"))?;
        let Value::Object(root) = value else {
            return Err(invalid("the Docker config is not a JSON object"));
        };
        let mut config = DockerConfig::default();
        let auths = match root.get("auths") {
            Some(Value::Object(auths)) => auths.clone(),
            Some(_) => serde_json::Map::new(),
            None if !root.contains_key("credHelpers") && !root.contains_key("credsStore") => {
                root.clone()
            }
            None => serde_json::Map::new(),
        };
        for (key, entry) in &auths {
            if let Some(credential) = entry_credential(entry) {
                config.auths.push((key.clone(), credential));
            }
        }
        if let Some(Value::Object(helpers)) = root.get("credHelpers") {
            for (key, helper) in helpers {
                if let Some(helper) = helper.as_str().filter(|h| helper_name_ok(h)) {
                    config.cred_helpers.push((key.clone(), helper.to_owned()));
                }
            }
        }
        config.creds_store = root
            .get("credsStore")
            .and_then(Value::as_str)
            .filter(|h| helper_name_ok(h))
            .map(str::to_owned);
        Ok(config)
    }

    /// The `auths` entry for `registry` (a [`registry_key`]); an exact key wins over a wildcard.
    pub fn auth_for(&self, registry: &str) -> Option<Credential> {
        self.auths
            .iter()
            .find(|(key, _)| registry_key(key) == registry)
            .or_else(|| {
                self.auths
                    .iter()
                    .find(|(key, _)| key_matches(key, registry))
            })
            .map(|(_, c)| c.clone())
    }

    /// The credential helper named for `registry` in `credHelpers`.
    pub fn helper_for(&self, registry: &str) -> Option<&str> {
        self.cred_helpers
            .iter()
            .find(|(key, _)| key_matches(key, registry))
            .map(|(_, h)| h.as_str())
    }

    /// The default credential store (`credsStore`).
    pub fn store(&self) -> Option<&str> {
        self.creds_store.as_deref()
    }
}

/// A helper's name becomes part of a program name (`docker-credential-<name>`): letters, digits, `.`, `_`, `-`.
pub fn helper_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn entry_credential(entry: &Value) -> Option<Credential> {
    if let Some(token) = entry
        .get("identitytoken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        return Some(Credential::IdentityToken(token.to_owned()));
    }
    if let Some(auth) = entry
        .get("auth")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
    {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(auth.trim())
            .ok()?;
        let text = String::from_utf8(decoded).ok()?;
        let (username, password) = text.split_once(':')?;
        return Some(Credential::Basic {
            username: username.to_owned(),
            password: password.to_owned(),
        });
    }
    let username = entry.get("username").and_then(Value::as_str)?;
    let password = entry.get("password").and_then(Value::as_str)?;
    Some(Credential::Basic {
        username: username.to_owned(),
        password: password.to_owned(),
    })
}

/// What a credential helper printed for `get`: `{"Username": …, "Secret": …}`; the user name `<token>` means the
/// secret is an identity token.
pub fn parse_helper_output(bytes: &[u8]) -> Option<Credential> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let username = value.get("Username").and_then(Value::as_str).unwrap_or("");
    let secret = value.get("Secret").and_then(Value::as_str)?;
    if secret.is_empty() {
        return None;
    }
    if username == "<token>" {
        return Some(Credential::IdentityToken(secret.to_owned()));
    }
    Some(Credential::Basic {
        username: username.to_owned(),
        password: secret.to_owned(),
    })
}
