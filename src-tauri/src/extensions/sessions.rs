//! Session tokens of an extension's service requests (ADR-0158): a token Sextant took from an answer (`capture`) and
//! adds to later requests (`auth: "session"`), so the extension never holds it. Kept in memory only, per extension,
//! cluster, namespace and service, and tied to the internal forward it was taken through: once that forward is gone
//! (a disconnect, the extension disabled or granted anything else, the app closing) the token is gone too.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

/// One token, with the forward it belongs to.
struct Session {
    forward: String,
    token: String,
}

/// The tokens, by `extension|cluster|namespace|service`, and the sign-in values the user typed in Sextant's own dialog
/// (`ui.signIn`, ADR-0160) for this run.
///
/// Also the credentials a service refused in this run (#372), as salted digests: a request carrying the same ones again
/// is answered without sending them, so a wrong password read from a Secret is not tried from every window until the
/// service locks the account.
#[derive(Default)]
pub struct ServiceSessions {
    map: Mutex<HashMap<String, Session>>,
    sign_ins: Mutex<HashMap<String, HashMap<String, String>>>,
    refused: Mutex<HashMap<String, HashSet<[u8; 32]>>>,
}

/// A digest of the credentials a request carries (each placeholder with its value, in order), salted per run so it
/// says nothing outside this process. `None` when the request carries none.
pub fn credentials_digest(parts: &[(String, String)]) -> Option<[u8; 32]> {
    static SALT: OnceLock<[u8; 16]> = OnceLock::new();
    if parts.is_empty() {
        return None;
    }
    let salt = SALT.get_or_init(|| {
        let mut salt = [0u8; 16];
        // Without randomness the salt is fixed: the digest still never leaves memory.
        let _ = getrandom::fill(&mut salt);
        salt
    });
    let mut hash = Sha256::new();
    hash.update(salt);
    for (name, value) in parts {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    Some(hash.finalize().into())
}

impl fmt::Debug for ServiceSessions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ServiceSessions {{ <hidden> }}")
    }
}

/// Refused credentials remembered per service; more start the list again.
const MAX_REFUSED: usize = 16;

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

    /// Drops every token, sign-in and remembered refusal of `extension`.
    pub fn forget_extension(&self, extension: &str) {
        let prefix = format!("{extension}|");
        lock(&self.map).retain(|key, _| !key.starts_with(&prefix));
        lock(&self.sign_ins).retain(|key, _| !key.starts_with(&prefix));
        lock(&self.refused).retain(|key, _| !key.starts_with(&prefix));
    }

    /// Whether the service of `key` refused these credentials earlier in this run.
    pub fn was_refused(&self, key: &str, digest: &[u8; 32]) -> bool {
        lock(&self.refused)
            .get(key)
            .is_some_and(|set| set.contains(digest))
    }

    /// Remembers that the service of `key` refused these credentials (at most a few per service).
    pub fn remember_refused(&self, key: &str, digest: [u8; 32]) {
        let mut refused = lock(&self.refused);
        let set = refused.entry(key.to_owned()).or_default();
        if set.len() >= MAX_REFUSED {
            set.clear();
        }
        set.insert(digest);
    }

    /// Forgets the refusals of `key`: the user signed in again or forgot the session.
    pub fn forget_refused(&self, key: &str) {
        lock(&self.refused).remove(key);
    }

    /// The sign-in values typed for `key` in this run.
    pub fn sign_in(&self, key: &str) -> Option<HashMap<String, String>> {
        lock(&self.sign_ins).get(key).cloned()
    }

    /// Keeps what the user typed; a refusal remembered for the service is forgotten, since the user asked to try.
    pub fn set_sign_in(&self, key: String, values: HashMap<String, String>) {
        self.forget_refused(&key);
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

    #[test]
    fn refused_credentials_are_remembered_until_the_user_signs_in() {
        let sessions = ServiceSessions::default();
        let key = session_key("argo", "c1", "argocd", "api");
        let wrong = credentials_digest(&[("secret:admin/password".into(), "old".into())]).unwrap();
        let right = credentials_digest(&[("secret:admin/password".into(), "new".into())]).unwrap();
        assert_ne!(wrong, right);
        assert_eq!(credentials_digest(&[]), None);
        sessions.remember_refused(&key, wrong);
        assert!(sessions.was_refused(&key, &wrong));
        assert!(!sessions.was_refused(&key, &right));
        assert!(!sessions.was_refused(&session_key("argo", "c2", "argocd", "api"), &wrong));
        sessions.set_sign_in(key.clone(), HashMap::new());
        assert!(!sessions.was_refused(&key, &wrong));
        sessions.remember_refused(&key, wrong);
        sessions.forget_extension("argo");
        assert!(!sessions.was_refused(&key, &wrong));
    }
}
