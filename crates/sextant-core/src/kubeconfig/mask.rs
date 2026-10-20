//! The one masking of kubeconfig credentials (#150, #228): what of a cluster or user entry may be shown, and
//! [`HIDDEN`] for everything else. Used by the edit preview ([`super::edit`]) and the kubeconfig viewer
//! ([`super::view`]), so both hide the same things.
//!
//! The rules are allow-lists: a field Sextant does not know is hidden.
//! - Cluster: where it points (`server`, `proxy-url`, both without a user name or password), `tls-server-name`,
//!   `insecure-skip-tls-verify`, `disable-compression` and the certificate authority (`certificate-authority` path,
//!   `certificate-authority-data`: a CA certificate is public). Everything else (`extensions`, …) is hidden.
//! - User: `username`, file references (`client-certificate`, `client-key`, `tokenFile` — paths, never read here),
//!   impersonation (`as`, `as-uid`, `as-groups`, `as-user-extra`), the `exec` block (below) and `auth-provider` with
//!   its name and the `config` keys that do not look secret (`access-token`, `refresh-token`, `client-secret`,
//!   `id-token`, any key naming a token, secret, password, key, credential, auth, bearer or refresh are hidden).
//!   `token`, `password`, `client-certificate-data`, `client-key-data`, `extensions` and anything unknown are hidden.
//! - `exec`: only `apiVersion`, `command`, `installHint`, `interactiveMode`, `provideClusterInfo`, `args` and `env`
//!   (anything else — kube-rs keeps unknown fields — is hidden). `env` entries keep `name`, and `value` unless the
//!   name looks secret. `args` are shown, but the value of every secret-looking flag is hidden, in both forms:
//!   `--token=abc` → `--token=<hidden>`, and `--password abc` → `--password <hidden>` (the argument after such a
//!   flag is hidden whatever it is: a flag cannot be told from a value). A flag is an argument starting with `-`,
//!   its name the text before `=` without the dashes; a plain `name=value` argument with a secret-looking name is
//!   masked the same way. Masking only values keeps the command readable (`eks get-token --cluster-name prod`);
//!   a value passed without a flag name (positional) cannot be recognised and is shown.
//! - Context: `cluster`, `user` and `namespace`; `extensions` and anything else are hidden.

use serde_yaml::{Mapping, Value};

/// What is shown instead of a credential (or any value that is not shown).
pub const HIDDEN: &str = "<hidden>";

/// Masks the `cluster` of every `clusters` entry, the `user` of every `users` entry and the `context` of every
/// `contexts` entry of a kubeconfig document.
pub(crate) fn mask_document(doc: &mut Value) {
    for (list, inner, mask) in [
        ("clusters", "cluster", mask_cluster as fn(&mut Mapping)),
        ("users", "user", mask_user),
        ("contexts", "context", mask_context),
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

/// A context entry's fields, masked in place: names only.
pub(crate) fn mask_context(map: &mut Mapping) {
    for (key, value) in map.iter_mut() {
        match key.as_str().unwrap_or("") {
            "cluster" | "user" | "namespace" => keep_scalar(value),
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

/// Whether a field name looks like it holds a secret (an auth-provider `config` key, an exec `env` name, an exec
/// flag name): it contains one of [`SECRET_WORDS`], in any case.
pub(crate) fn looks_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|word| name.contains(word))
}

/// Parts of a name that make it look secret (`client-secret` and `refresh-token` are covered by `secret`/`refresh`).
const SECRET_WORDS: [&str; 9] = [
    "token",
    "secret",
    "password",
    "passwd",
    "key",
    "credential",
    "auth",
    "bearer",
    "refresh",
];

/// The `exec` block: its allowed fields, `env` values and flag values that look secret hidden.
fn mask_exec(value: &mut Value) {
    let Some(exec) = value.as_mapping_mut() else {
        *value = hidden();
        return;
    };
    for (key, field) in exec.iter_mut() {
        match key.as_str().unwrap_or("") {
            "apiVersion" | "command" | "installHint" | "interactiveMode" | "provideClusterInfo" => {
                keep_scalar(field);
            }
            "args" => mask_args(field),
            "env" => mask_env(field),
            _ => *field = hidden(),
        }
    }
}

/// Exec `env`: each entry's `name`, and its `value` unless the name looks secret (or is missing).
fn mask_env(value: &mut Value) {
    let Some(env) = value.as_sequence_mut() else {
        *value = hidden();
        return;
    };
    for entry in env.iter_mut() {
        let Some(pair) = entry.as_mapping_mut() else {
            *entry = hidden();
            continue;
        };
        let secret = pair
            .get("name")
            .and_then(Value::as_str)
            .is_none_or(looks_secret);
        for (k, v) in pair.iter_mut() {
            match k.as_str().unwrap_or("") {
                "name" => keep_scalar(v),
                "value" if !secret && v.is_string() => {}
                _ => *v = hidden(),
            }
        }
    }
}

/// Exec `args`: the value of every secret-looking flag hidden (`--token=x`, `--token x`, `token=x`).
fn mask_args(value: &mut Value) {
    let Some(args) = value.as_sequence_mut() else {
        *value = hidden();
        return;
    };
    let mut hide_next = false;
    for arg in args.iter_mut() {
        let Some(text) = arg.as_str() else {
            *arg = hidden();
            hide_next = false;
            continue;
        };
        if hide_next {
            *arg = hidden();
            hide_next = false;
            continue;
        }
        let is_flag = text.starts_with('-');
        match text.split_once('=') {
            Some((name, _)) if looks_secret(name.trim_start_matches('-')) => {
                *arg = Value::String(format!("{name}={HIDDEN}"));
            }
            Some(_) => {}
            None => hide_next = is_flag && looks_secret(text.trim_start_matches('-')),
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
