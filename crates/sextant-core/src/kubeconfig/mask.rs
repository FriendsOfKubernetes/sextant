//! The one masking of kubeconfig credentials (#150, #228): what of a cluster or user entry may be shown, and
//! [`HIDDEN`] for everything else. Used by the edit preview ([`super::edit`]) and the kubeconfig viewer
//! ([`super::view`]), so both hide the same things.
//!
//! The rules are allow-lists: a field Sextant does not know is hidden.
//! - Cluster: where it points (`server`, `proxy-url`, both without a user name or password), `tls-server-name`,
//!   `insecure-skip-tls-verify`, `disable-compression` and the certificate authority (`certificate-authority` path,
//!   `certificate-authority-data`: a CA certificate is public). Everything else (`extensions`, …) is hidden.
//! - User: `username`, file references (`client-certificate`, `client-key`, `tokenFile` — paths, never read here),
//!   impersonation (`as`, `as-uid`, `as-groups`, `as-user-extra`) and the `exec` block as written (it holds a command,
//!   not a secret) except the values of its `env` entries whose name looks secret; `auth-provider` with its name
//!   and the `config` keys that do not look secret (`access-token`, `refresh-token`, `client-secret`, `id-token`, any
//!   key naming a token, secret, password, key or credential are hidden). `token`, `password`,
//!   `client-certificate-data`, `client-key-data`, `extensions` and anything unknown are hidden.

use serde_yaml::{Mapping, Value};

/// What is shown instead of a credential (or any value that is not shown).
pub const HIDDEN: &str = "<hidden>";

/// Masks the `cluster` of every `clusters` entry and the `user` of every `users` entry of a kubeconfig document.
pub(crate) fn mask_document(doc: &mut Value) {
    for (list, inner, mask) in [
        ("clusters", "cluster", mask_cluster as fn(&mut Mapping)),
        ("users", "user", mask_user),
    ] {
        let Some(items) = doc.get_mut(list).and_then(Value::as_sequence_mut) else {
            continue;
        };
        for entry in items.iter_mut().filter_map(Value::as_mapping_mut) {
            match entry.get_mut(inner) {
                Some(Value::Mapping(map)) => mask(map),
                Some(Value::Null) | None => {}
                Some(other) => *other = hidden(),
            }
            // Only `name` and the inner entry are kept at this level.
            for (key, value) in entry.iter_mut() {
                if key.as_str() != Some("name") && key.as_str() != Some(inner) {
                    *value = hidden();
                }
            }
        }
    }
}

/// A cluster entry's fields, masked in place.
pub(crate) fn mask_cluster(map: &mut Mapping) {
    for (key, value) in map.iter_mut() {
        match key.as_str().unwrap_or("") {
            "server" | "proxy-url" => match value.as_str() {
                Some(url) => *value = Value::String(without_userinfo(url)),
                None => *value = hidden(),
            },
            "tls-server-name"
            | "insecure-skip-tls-verify"
            | "disable-compression"
            | "certificate-authority"
            | "certificate-authority-data" => keep_scalar(value),
            _ => *value = hidden(),
        }
    }
}

/// A user entry's fields, masked in place.
pub(crate) fn mask_user(map: &mut Mapping) {
    for (key, value) in map.iter_mut() {
        match key.as_str().unwrap_or("") {
            "username" | "client-certificate" | "client-key" | "tokenFile" | "as" | "as-uid" => {
                keep_scalar(value);
            }
            "as-groups" | "as-user-extra" => {
                if !plain(value) {
                    *value = hidden();
                }
            }
            "exec" => mask_exec(value),
            "auth-provider" => mask_auth_provider(value),
            _ => *value = hidden(),
        }
    }
}

/// Whether a field name looks like it holds a secret (an auth-provider `config` key, an exec `env` name).
pub(crate) fn looks_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["token", "secret", "password", "passwd", "key", "credential"]
        .iter()
        .any(|word| name.contains(word))
}

/// The `exec` block as written, but the values of `env` entries with a secret-looking name.
fn mask_exec(value: &mut Value) {
    let Some(exec) = value.as_mapping_mut() else {
        *value = hidden();
        return;
    };
    if let Some(env) = exec.get_mut("env").and_then(Value::as_sequence_mut) {
        for entry in env.iter_mut() {
            let Some(pair) = entry.as_mapping_mut() else {
                *entry = hidden();
                continue;
            };
            let secret = pair
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(looks_secret);
            if let Some(v) = pair.get_mut("value")
                && (secret || !v.is_string())
            {
                *v = hidden();
            }
        }
    }
}

/// `auth-provider`: its `name`, and of its `config` the keys that do not look secret.
fn mask_auth_provider(value: &mut Value) {
    let Some(provider) = value.as_mapping_mut() else {
        *value = hidden();
        return;
    };
    for (key, field) in provider.iter_mut() {
        match key.as_str().unwrap_or("") {
            "name" => keep_scalar(field),
            "config" => match field.as_mapping_mut() {
                Some(config) => {
                    for (k, v) in config.iter_mut() {
                        if k.as_str().is_none_or(looks_secret) {
                            *v = hidden();
                        } else {
                            keep_scalar(v);
                        }
                    }
                }
                None => *field = hidden(),
            },
            _ => *field = hidden(),
        }
    }
}

/// A URL without the user name and password it may carry (`http://user:pass@proxy:3128` → `http://proxy:3128`).
pub(crate) fn without_userinfo(url: &str) -> String {
    let (scheme, rest) = match url.find("://") {
        Some(i) => url.split_at(i + 3),
        None => ("", url),
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

fn hidden() -> Value {
    Value::String(HIDDEN.to_owned())
}

/// Keeps a text, boolean or number; anything else is hidden.
fn keep_scalar(value: &mut Value) {
    if !matches!(value, Value::String(_) | Value::Bool(_) | Value::Number(_)) {
        *value = hidden();
    }
}

/// Whether `value` holds only texts (in lists and mappings), as impersonation fields do.
fn plain(value: &Value) -> bool {
    match value {
        Value::String(_) => true,
        Value::Sequence(items) => items.iter().all(plain),
        Value::Mapping(map) => map.iter().all(|(k, v)| k.is_string() && plain(v)),
        _ => false,
    }
}
