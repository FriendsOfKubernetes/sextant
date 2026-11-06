//! Session tokens of an extension's service requests (ADR-0158): a token Sextant took from an answer (`capture`) and
//! adds to later requests (`auth: "session"`), so the extension never holds it. Kept in memory only, per extension,
//! cluster, namespace and service, and tied to the internal forward it was taken through: once that forward is gone
//! (a disconnect, the extension disabled or granted anything else, the app closing) the token is gone too.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// One token, with the forward it belongs to.
struct Session {
    forward: String,
    token: String,
}

/// The tokens, by `extension|cluster|namespace|service`, and the sign-in values the user typed in Sextant's own dialog
/// (`ui.signIn`, ADR-0160) for this run.
#[derive(Default)]
pub struct ServiceSessions {
    map: Mutex<HashMap<String, Session>>,
    sign_ins: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl fmt::Debug for ServiceSessions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ServiceSessions {{ <hidden> }}")
    }
}

/// The key of a session (and of the internal forward it goes through).
pub fn session_key(extension: &str, cluster: &str, namespace: &str, service: &str) -> String {
    format!("{extension}|{cluster}|{namespace}|{service}")
}

impl ServiceSessions {
    /// The token of `key`, while it belongs to `forward`; one of another forward is dropped.
    pub fn token(&self, key: &str, forward: &str) -> Option<String> {
        let mut map = lock(&self.map);
        match map.get(key) {
            Some(s) if s.forward == forward => Some(s.token.clone()),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    pub fn set(&self, key: String, forward: &str, token: String) {
        lock(&self.map).insert(
            key,
            Session {
                forward: forward.to_owned(),
                token,
            },
        );
    }

    /// Drops the token of `key`; whether there was one.
    pub fn forget(&self, key: &str) -> bool {
        lock(&self.map).remove(key).is_some()
    }

    /// Drops every token and sign-in of `extension`.
    pub fn forget_extension(&self, extension: &str) {
        let prefix = format!("{extension}|");
        lock(&self.map).retain(|key, _| !key.starts_with(&prefix));
        lock(&self.sign_ins).retain(|key, _| !key.starts_with(&prefix));
    }

    /// The sign-in values typed for `key` in this run.
    pub fn sign_in(&self, key: &str) -> Option<HashMap<String, String>> {
        lock(&self.sign_ins).get(key).cloned()
    }

    pub fn set_sign_in(&self, key: String, values: HashMap<String, String>) {
        lock(&self.sign_ins).insert(key, values);
    }

    pub fn forget_sign_in(&self, key: &str) {
        lock(&self.sign_ins).remove(key);
    }
}

/// The keyring entry (`extension:<id>:<this>`) of a remembered sign-in: per service, cluster and namespace.
pub fn sign_in_credential(service: &str, cluster: &str, namespace: &str) -> String {
    format!("service-sign-in:{service}@{cluster}/{namespace}")
}

/// What a remembered sign-in holds: the values and the API server they were typed for (ADR-0029's binding).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct RememberedSignIn {
    pub values: HashMap<String, String>,
    pub server: String,
    #[serde(default)]
    pub ca_sha256: Option<String>,
}

impl fmt::Debug for RememberedSignIn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RememberedSignIn {{ <hidden> }}")
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_lives_as_long_as_its_forward() {
        let sessions = ServiceSessions::default();
        let key = session_key("argo", "c1", "argocd", "api");
        sessions.set(key.clone(), "pf-1", "t0k".into());
        assert_eq!(sessions.token(&key, "pf-1").as_deref(), Some("t0k"));
        // Another forward (the cluster reconnected): the token is gone for good.
        assert_eq!(sessions.token(&key, "pf-2"), None);
        assert_eq!(sessions.token(&key, "pf-1"), None);
        sessions.set(key.clone(), "pf-2", "t1".into());
        sessions.forget_extension("argo");
        assert_eq!(sessions.token(&key, "pf-2"), None);
        assert!(!format!("{sessions:?}").contains("t1"));
    }
}
