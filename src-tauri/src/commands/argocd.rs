//! Argo CD: sign-in to its API and the desired ↔ live diff of an Application.
//!
//! The API is reached through a port forward to `argocd-server` (a [`PortForwarder`] of its own, so it does not show
//! in the user's list of forwards; it closes with the cluster). A session token lives only in memory
//! ([`ArgoSessions`] in `AppState`). Without a session `argocd_diff` signs in by itself, in this order: the login typed
//! in earlier in this run, the login saved in the OS credential store, `admin` with `argocd-initial-admin-secret`
//! (unless `admin.enabled` is `"false"`), the `token` of a Secret labelled `app.kubernetes.io/part-of=argocd`;
//! otherwise it answers `unauthorized` and the frontend shows the sign-in window. A candidate Argo CD refused is not
//! tried by itself again in this run until its source changes (a new `resourceVersion` of the Secret, a new login
//! typed or saved), so a stale password does not pile up failed attempts. A saved login is a JSON
//! `{"username","password"}` or `{"token"}` in the OS credential store (service `sextant`, user
//! `argocd:<clusterId>:<namespace>`), never in `settings.json`. No password or token goes to the frontend, into an
//! error message or into a log.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sextant_core::argocd::{
    self, ArgoClient, ArgoServer, CredentialSource, Credentials, ManagedResource, SecretString,
    Session,
};
use sextant_core::error::with_timeout;
use sextant_core::portforward::{ForwardStatus, ForwardTarget, PortForwarder};
use sextant_core::{ClusterId, ClusterManager, CoreError, ErrorCode, ObjectRef};
use tauri::State;
use ts_rs::TS;

use crate::state::AppState;

/// Service name of saved logins in the OS credential store.
pub const KEYRING_SERVICE: &str = "sextant";
/// Signing in (finding the server, the forward, the requests) and reading a diff.
const ARGO_TIMEOUT: Duration = Duration::from_secs(60);

/// User name of the saved login of the Argo CD in `namespace` of `cluster` in the OS credential store.
pub fn keyring_user(cluster: &ClusterId, namespace: &str) -> String {
    format!("argocd:{cluster}:{namespace}")
}

/// Argo CD of a cluster as the sign-in window needs it. Never carries a password or token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArgoStatus {
    /// Where `argocd-server` runs.
    pub namespace: String,
    pub signed_in: bool,
    /// Where the credentials of the current session came from; `saved` also after signing in with "Remember".
    pub source: Option<CredentialSource>,
    pub user: Option<String>,
    /// A local user may sign in with a password (otherwise only an API token works).
    pub local_users: bool,
    /// SSO is configured (Sextant cannot sign in through it).
    pub sso: bool,
    /// The last session was refused by Argo CD (expired or revoked) and signing in again did not work.
    pub expired: bool,
}

/// What the sign-in window sends: a user name and password, or an API token.
#[derive(Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ArgoLogin {
    #[ts(optional)]
    pub username: Option<String>,
    #[ts(optional, as = "Option<String>")]
    pub password: Option<SecretString>,
    #[ts(optional, as = "Option<String>")]
    pub token: Option<SecretString>,
    /// Save the login in the OS credential store.
    pub remember: bool,
}

impl fmt::Debug for ArgoLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArgoLogin")
            .field("username", &self.username)
            .field("remember", &self.remember)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ArgoLogoutOptions {
    /// Also delete the saved login from the OS credential store.
    pub forget: bool,
}

/// Whether Argo CD is signed in for the cluster, and how. Does not sign in.
#[tauri::command]
pub async fn argocd_status(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<ArgoStatus, CoreError> {
    state.argocd.status(&state.clusters, &cluster_id).await
}

/// Signs in with what the user typed; `remember` saves it in the OS credential store.
#[tauri::command]
pub async fn argocd_login(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    login: ArgoLogin,
) -> Result<ArgoStatus, CoreError> {
    let call = state.argocd.login(&state.clusters, &cluster_id, login);
    with_timeout(ARGO_TIMEOUT, "signing in to Argo CD", call).await
}

/// Ends the session; the standard secrets are not used again until the next sign-in. `forget` also deletes the
/// saved login.
#[tauri::command]
pub async fn argocd_logout(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    options: ArgoLogoutOptions,
) -> Result<ArgoStatus, CoreError> {
    state
        .argocd
        .logout(&state.clusters, &cluster_id, options.forget)
        .await
}

/// The resources of an Application with their desired (Git) and live states; Secret values are `""`. Without a
/// session it signs in from the saved login or the standard secrets, otherwise answers `unauthorized`.
#[tauri::command]
pub async fn argocd_diff(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    app: ObjectRef,
) -> Result<Vec<ManagedResource>, CoreError> {
    let call = state.argocd.diff(&state.clusters, &cluster_id, &app);
    with_timeout(ARGO_TIMEOUT, "reading the Argo CD diff", call).await
}

/// Where saved logins live. Values are the JSON of [`Credentials`]; nothing here is logged.
pub trait CredentialStore: Send + Sync {
    fn load(&self, user: &str) -> Result<Option<String>, CoreError>;
    fn save(&self, user: &str, value: &str) -> Result<(), CoreError>;
    /// Deleting a login that is not there is not an error.
    fn forget(&self, user: &str) -> Result<(), CoreError>;
}

/// The OS credential store through `keyring` (Keychain, Credential Manager, Secret Service), or — for tests — any
/// other `keyring` backend.
pub struct KeyringStore {
    builder: Option<Box<keyring::credential::CredentialBuilder>>,
}

impl KeyringStore {
    /// The platform's own store.
    pub fn os() -> Self {
        Self { builder: None }
    }

    /// Entries come from `builder` (a mock backend in tests) instead of the platform's store.
    pub fn with_builder(builder: Box<keyring::credential::CredentialBuilder>) -> Self {
        Self {
            builder: Some(builder),
        }
    }

    fn entry(&self, user: &str) -> Result<keyring::Entry, CoreError> {
        match &self.builder {
            Some(builder) => builder
                .build(None, KEYRING_SERVICE, user)
                .map(keyring::Entry::new_with_credential),
            None => keyring::Entry::new(KEYRING_SERVICE, user),
        }
        .map_err(keyring_error)
    }
}

impl CredentialStore for KeyringStore {
    fn load(&self, user: &str) -> Result<Option<String>, CoreError> {
        match self.entry(user)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(keyring_error(err)),
        }
    }

    fn save(&self, user: &str, value: &str) -> Result<(), CoreError> {
        self.entry(user)?.set_password(value).map_err(keyring_error)
    }

    fn forget(&self, user: &str) -> Result<(), CoreError> {
        match self.entry(user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(keyring_error(err)),
        }
    }
}

/// A `keyring` error without the stored bytes (`BadEncoding` carries them).
fn keyring_error(err: keyring::Error) -> CoreError {
    use keyring::Error as E;
    let detail = match &err {
        E::PlatformFailure(cause) | E::NoStorageAccess(cause) => cause.to_string(),
        E::BadEncoding(_) => "the saved login is not text".to_string(),
        E::NoEntry => "no saved login".to_string(),
        E::TooLong(name, _) | E::Invalid(name, _) => format!("invalid {name}"),
        E::Ambiguous(_) => "more than one saved login".to_string(),
        _ => "unknown error".to_string(),
    };
    CoreError::new(
        ErrorCode::Other,
        format!("the system credential store: {detail}"),
    )
}

/// Runs a (blocking) credential store call off the async runtime.
async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(|err| CoreError::other(format!("the credential store call failed: {err}")))?
}

/// Argo CD sessions and port forwards of every cluster. In memory only.
pub struct ArgoSessions {
    forwarder: PortForwarder,
    store: RwLock<Arc<dyn CredentialStore>>,
    clusters: Mutex<HashMap<ClusterId, Arc<tokio::sync::Mutex<ArgoConn>>>>,
    /// Keys of the candidates Argo CD refused in this run of the application ([`Candidate::key`]); they are not tried
    /// again by themselves, so a stale password does not pile up failed attempts (Argo CD locks the account out).
    refused: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct ArgoConn {
    server: Option<ArgoServer>,
    /// Id of the forward to `argocd-server` and the client on its local port.
    forward: Option<(String, ArgoClient)>,
    session: Option<SignedIn>,
    /// The login typed in this run (without "Remember"), to sign in again when the session expires.
    typed: Option<Credentials>,
    /// Signed out by hand: the saved login and the standard secrets wait for the next sign-in.
    signed_out: bool,
    expired: bool,
}

struct SignedIn {
    session: Session,
    source: CredentialSource,
}

impl ArgoSessions {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            forwarder: PortForwarder::new(),
            store: RwLock::new(store),
            clusters: Mutex::new(HashMap::new()),
            refused: Mutex::new(HashSet::new()),
        }
    }

    /// Replaces the credential store (tests use a mock `keyring` backend).
    pub fn set_store(&self, store: Arc<dyn CredentialStore>) {
        *self.store.write().unwrap_or_else(|e| e.into_inner()) = store;
    }

    fn store(&self) -> Arc<dyn CredentialStore> {
        Arc::clone(&self.store.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Forwards to `argocd-server` that are open now.
    pub fn forwards(&self) -> usize {
        self.forwarder.list().len()
    }

    /// Ends the session and closes the forward of a cluster (it was disconnected).
    pub fn close_cluster(&self, cluster: &ClusterId) {
        lock(&self.clusters).remove(cluster);
        self.forwarder.stop_cluster(cluster);
    }

    /// Ends every session and forward (the application is closing).
    pub fn close_all(&self) {
        lock(&self.clusters).clear();
        self.forwarder.stop_all();
    }

    fn conn(&self, cluster: &ClusterId) -> Arc<tokio::sync::Mutex<ArgoConn>> {
        Arc::clone(lock(&self.clusters).entry(cluster.clone()).or_default())
    }

    pub async fn status(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<ArgoStatus, CoreError> {
        let conn = self.conn(cluster);
        let mut conn = conn.lock().await;
        let server = server(&mut conn, mgr, cluster).await?;
        let options = argocd::login_options(mgr, cluster, &server.namespace).await?;
        Ok(ArgoStatus {
            namespace: server.namespace,
            signed_in: conn.session.is_some(),
            source: conn.session.as_ref().map(|s| s.source),
            user: conn
                .session
                .as_ref()
                .and_then(|s| s.session.username.clone()),
            local_users: options.local_users,
            sso: options.sso,
            expired: conn.expired,
        })
    }

    pub async fn login(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        login: ArgoLogin,
    ) -> Result<ArgoStatus, CoreError> {
        let credentials = credentials_of(login.clone())?;
        {
            let conn = self.conn(cluster);
            let mut conn = conn.lock().await;
            let client = self.client(&mut conn, mgr, cluster).await?;
            let namespace = server(&mut conn, mgr, cluster).await?.namespace;
            let session = match client.login(&credentials).await {
                Ok(session) => session,
                Err(err) => {
                    return Err(explain_refusal(err, &credentials, mgr, cluster, &namespace).await);
                }
            };
            let source = if login.remember {
                CredentialSource::Saved
            } else {
                CredentialSource::Manual
            };
            conn.session = Some(SignedIn { session, source });
            conn.typed = Some(credentials.clone());
            conn.signed_out = false;
            conn.expired = false;
            // A new login: the typed one (and, saved, the saved one) may be tried again by itself.
            lock(&self.refused).remove(&typed_key(cluster));
            if login.remember {
                lock(&self.refused).remove(&saved_key(cluster, &namespace));
                let store = self.store();
                let user = keyring_user(cluster, &namespace);
                let value = serde_json::to_string(&credentials)?;
                blocking(move || store.save(&user, &value))
                    .await
                    .map_err(|err| {
                        CoreError::new(
                            err.code,
                            format!("signed in, but the login was not saved: {}", err.message),
                        )
                    })?;
            }
        }
        self.status(mgr, cluster).await
    }

    pub async fn logout(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        forget: bool,
    ) -> Result<ArgoStatus, CoreError> {
        {
            let conn = self.conn(cluster);
            let mut conn = conn.lock().await;
            let namespace = server(&mut conn, mgr, cluster).await?.namespace;
            conn.session = None;
            conn.typed = None;
            conn.signed_out = true;
            conn.expired = false;
            if forget {
                let store = self.store();
                let user = keyring_user(cluster, &namespace);
                blocking(move || store.forget(&user)).await?;
            }
        }
        self.status(mgr, cluster).await
    }

    pub async fn diff(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        app: &ObjectRef,
    ) -> Result<Vec<ManagedResource>, CoreError> {
        let conn = self.conn(cluster);
        let mut conn = conn.lock().await;
        let namespace = app.namespace.as_deref().filter(|ns| !ns.is_empty());
        let had_session = conn.session.is_some();
        let (client, session) = self.signed_in(&mut conn, mgr, cluster).await?;
        let first = client
            .managed_resources(&session, &app.name, namespace, None)
            .await;
        let retry = match &first {
            // The session expired or was revoked: sign in again once.
            Err(err) if err.code == ErrorCode::Unauthorized => {
                conn.session = None;
                true
            }
            // The forward broke (its pod was replaced): open it again once.
            Err(err) if err.code == ErrorCode::Unreachable => {
                if let Some((id, _)) = conn.forward.take() {
                    let _ = self.forwarder.stop(&id).await;
                }
                true
            }
            _ => false,
        };
        if !retry {
            return first;
        }
        let (client, session) = match self.signed_in(&mut conn, mgr, cluster).await {
            Ok(signed) => signed,
            Err(err) if err.code == ErrorCode::Unauthorized && had_session => {
                conn.expired = true;
                return Err(CoreError::new(
                    ErrorCode::Unauthorized,
                    "the Argo CD session has expired and signing in again did not work",
                ));
            }
            Err(err) => return Err(err),
        };
        client
            .managed_resources(&session, &app.name, namespace, None)
            .await
    }

    /// The client and session of the cluster, signing in from the typed, saved or standard credentials when there
    /// is no session.
    async fn signed_in(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<(ArgoClient, Session), CoreError> {
        let client = self.client(conn, mgr, cluster).await?;
        if let Some(signed) = &conn.session {
            return Ok((client, signed.session.clone()));
        }
        let namespace = server(conn, mgr, cluster).await?.namespace;
        let mut candidates = Vec::new();
        if let Some(typed) = &conn.typed {
            candidates.push(Candidate {
                key: typed_key(cluster),
                source: CredentialSource::Manual,
                credentials: typed.clone(),
            });
        }
        if !conn.signed_out {
            if let Some(saved) = self.saved(cluster, &namespace).await {
                candidates.push(Candidate {
                    key: saved_key(cluster, &namespace),
                    source: CredentialSource::Saved,
                    credentials: saved,
                });
            }
            let standard =
                argocd::standard_credentials_with_origin(mgr, cluster, &namespace).await?;
            candidates.extend(standard.into_iter().map(|(origin, credentials)| Candidate {
                key: format!("secret:{cluster}:{origin}"),
                source: CredentialSource::Secret,
                credentials,
            }));
        }
        let login = |credentials: Credentials| {
            let client = client.clone();
            async move { client.login(&credentials).await }
        };
        let (session, source) = first_accepted(candidates, &self.refused, login).await?;
        conn.session = Some(SignedIn {
            session: session.clone(),
            source,
        });
        conn.expired = false;
        Ok((client, session))
    }

    /// The saved login, if the store has a readable one (a store that cannot be reached counts as none).
    async fn saved(&self, cluster: &ClusterId, namespace: &str) -> Option<Credentials> {
        let store = self.store();
        let user = keyring_user(cluster, namespace);
        let text = blocking(move || store.load(&user)).await.ok().flatten()?;
        serde_json::from_str(&text).ok()
    }

    /// The client on the forward to `argocd-server`, opening the forward when there is none (or it broke).
    async fn client(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<ArgoClient, CoreError> {
        let server = server(conn, mgr, cluster).await?;
        if let Some((id, client)) = &conn.forward {
            let alive = self
                .forwarder
                .list()
                .iter()
                .any(|f| &f.id == id && f.status == ForwardStatus::Active);
            if alive {
                return Ok(client.clone());
            }
            let _ = self.forwarder.stop(id).await;
            conn.forward = None;
        }
        let target = ForwardTarget::Service {
            namespace: server.namespace.clone(),
            name: server.name.clone(),
        };
        let info = self
            .forwarder
            .start(mgr, cluster, target, server.port, None)
            .await
            .map_err(|err| match err.code {
                ErrorCode::NotFound | ErrorCode::Other => CoreError::new(
                    ErrorCode::Unreachable,
                    format!("Argo CD is not reachable: {}", err.message),
                ),
                _ => err,
            })?;
        let client = ArgoClient::new(info.local_port);
        conn.forward = Some((info.id, client.clone()));
        Ok(client)
    }
}

/// One way to sign in by itself. `key` names its source — the typed login, the saved login of a namespace, or a
/// Secret at one `resourceVersion` — so a changed source is a new candidate.
#[derive(Clone)]
struct Candidate {
    key: String,
    source: CredentialSource,
    credentials: Credentials,
}

fn typed_key(cluster: &ClusterId) -> String {
    format!("typed:{cluster}")
}

fn saved_key(cluster: &ClusterId, namespace: &str) -> String {
    format!("saved:{}", keyring_user(cluster, namespace))
}

/// Signs in (`login`) with the first candidate Argo CD accepts, skipping those whose key is in `refused` and adding
/// the key of every candidate it refuses. Only a refusal is remembered: an unreachable server ends the attempt and
/// counts against nobody. Nothing left to try is `unauthorized`.
async fn first_accepted<S, F, Fut>(
    candidates: Vec<Candidate>,
    refused: &Mutex<HashSet<String>>,
    mut login: F,
) -> Result<(S, CredentialSource), CoreError>
where
    F: FnMut(Credentials) -> Fut,
    Fut: Future<Output = Result<S, CoreError>>,
{
    let any = !candidates.is_empty();
    let fresh: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| !lock(refused).contains(&c.key))
        .collect();
    for candidate in fresh {
        match login(candidate.credentials).await {
            Ok(session) => return Ok((session, candidate.source)),
            Err(err) if argocd::is_refusal(&err) => {
                lock(refused).insert(candidate.key);
            }
            Err(err) => return Err(err),
        }
    }
    Err(CoreError::new(
        ErrorCode::Unauthorized,
        if any {
            "sign in to Argo CD: the saved login and the standard secrets were refused"
        } else {
            "sign in to Argo CD: there is no saved login and no standard secret with credentials"
        },
    ))
}

/// The server of the cluster, found once per connection.
async fn server(
    conn: &mut ArgoConn,
    mgr: &ClusterManager,
    cluster: &ClusterId,
) -> Result<ArgoServer, CoreError> {
    if let Some(server) = &conn.server {
        return Ok(server.clone());
    }
    let server = argocd::find_server(mgr, cluster).await?;
    conn.server = Some(server.clone());
    Ok(server)
}

/// The credentials of the sign-in window: a token, or a user name (default `admin`) with a password.
fn credentials_of(login: ArgoLogin) -> Result<Credentials, CoreError> {
    if let Some(token) = login.token.filter(|t| !t.is_empty()) {
        return Ok(Credentials::Token { token });
    }
    let username = login
        .username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "admin".into());
    match login.password.filter(|p| !p.expose().is_empty()) {
        Some(password) => Ok(Credentials::Password { username, password }),
        None => Err(CoreError::new(
            ErrorCode::Invalid,
            "enter a user name and password, or an API token",
        )),
    }
}

/// A refused password on an Argo CD without local users says so: it signs in only through SSO (or with a token).
async fn explain_refusal(
    err: CoreError,
    credentials: &Credentials,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreError {
    if err.code != ErrorCode::Unauthorized || !matches!(credentials, Credentials::Password { .. }) {
        return err;
    }
    match argocd::login_options(mgr, cluster, namespace).await {
        Ok(options) if !options.local_users => CoreError::new(
            ErrorCode::Unauthorized,
            "this Argo CD has no local users who may sign in with a password (SSO only); use an API token",
        ),
        _ => err,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    //! The credential store runs on a mock `keyring` backend (a map in memory): no test touches the developer's own
    //! keyring. The sign-in tests need the kind cluster with Argo CD (`scripts/test-cluster.sh up --gitops`):
    //! `SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) SEXTANT_TEST_GITOPS=1 cargo test -p sextant
    //! argocd -- --test-threads=1`.
    use std::any::Any;
    use std::path::Path;

    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
    use sextant_core::KindRef;
    use sextant_core::kubeconfig::KubeconfigEnv;

    use super::*;

    type Saved = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    /// A `keyring` backend keeping entries in `saved` under `<service>/<user>`.
    struct MockBuilder(Saved);
    struct MockCredential {
        key: String,
        saved: Saved,
    }

    impl CredentialBuilderApi for MockBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(MockCredential {
                key: format!("{service}/{user}"),
                saved: Arc::clone(&self.0),
            }))
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    impl CredentialApi for MockCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            lock(&self.saved).insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            lock(&self.saved)
                .get(&self.key)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            lock(&self.saved)
                .remove(&self.key)
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    fn mock_store() -> (Arc<KeyringStore>, Saved) {
        let saved = Saved::default();
        let store = KeyringStore::with_builder(Box::new(MockBuilder(Arc::clone(&saved))));
        (Arc::new(store), saved)
    }

    #[test]
    fn a_login_is_saved_under_the_documented_key_and_forgotten() {
        let (store, saved) = mock_store();
        let user = keyring_user(&ClusterId::from("c1"), "argocd");

        store.save(&user, r#"{"token":"t"}"#).unwrap();
        let loaded = store.load(&user).unwrap();
        let keys: Vec<String> = lock(&saved).keys().cloned().collect();
        store.forget(&user).unwrap();

        assert_eq!(user, "argocd:c1:argocd");
        assert_eq!(keys, ["sextant/argocd:c1:argocd"]);
        assert_eq!(loaded.as_deref(), Some(r#"{"token":"t"}"#));
        assert_eq!(store.load(&user).unwrap(), None);
        assert!(store.forget(&user).is_ok(), "forgetting twice is fine");
    }

    #[test]
    fn the_sign_in_window_needs_a_password_or_a_token() {
        let typed = |username: Option<&str>, password: Option<&str>, token: Option<&str>| {
            credentials_of(ArgoLogin {
                username: username.map(str::to_string),
                password: password.map(SecretString::new),
                token: token.map(SecretString::new),
                remember: false,
            })
        };

        assert_eq!(
            typed(None, None, None).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(
            typed(Some("bob"), Some(""), Some(" ")).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert!(
            matches!(typed(None, Some("pw"), None).unwrap(), Credentials::Password { username, .. } if username == "admin")
        );
        assert!(matches!(
            typed(Some("bob"), Some("pw"), Some("tok")).unwrap(),
            Credentials::Token { .. }
        ));
        let login = ArgoLogin {
            password: Some(SecretString::new("hunter2")),
            ..Default::default()
        };
        assert!(!format!("{login:?}").contains("hunter2"));
    }

    fn password(value: &str) -> Credentials {
        Credentials::Password {
            username: "admin".into(),
            password: SecretString::new(value),
        }
    }

    fn candidate(key: &str, source: CredentialSource, value: &str) -> Candidate {
        Candidate {
            key: key.into(),
            source,
            credentials: password(value),
        }
    }

    /// Signs in through a fake Argo CD that accepts only `good` and counts the attempts per password.
    async fn sign_in_counting(
        candidates: Vec<Candidate>,
        refused: &Mutex<HashSet<String>>,
        tried: &Mutex<Vec<String>>,
    ) -> Result<CredentialSource, CoreError> {
        let login = |credentials: Credentials| async move {
            let Credentials::Password { password, .. } = credentials else {
                unreachable!()
            };
            lock(tried).push(password.expose().to_string());
            if password.expose() == "good" {
                Ok("session")
            } else {
                Err(CoreError::new(
                    ErrorCode::Unauthorized,
                    "invalid username or password",
                ))
            }
        };
        first_accepted(candidates, refused, login)
            .await
            .map(|(_, source)| source)
    }

    #[tokio::test]
    async fn a_refused_candidate_is_not_tried_again_until_its_source_changes() {
        let refused = Mutex::new(HashSet::new());
        let tried = Mutex::new(Vec::new());
        let stale = || {
            vec![
                candidate("saved:c1", CredentialSource::Saved, "old-saved"),
                candidate(
                    "secret:c1:argocd/argocd-initial-admin-secret@7",
                    CredentialSource::Secret,
                    "old-initial",
                ),
                candidate(
                    "secret:c1:argocd/ci-token@9",
                    CredentialSource::Secret,
                    "good",
                ),
            ]
        };

        let first = sign_in_counting(stale(), &refused, &tried).await.unwrap();
        let again = sign_in_counting(stale(), &refused, &tried).await.unwrap();
        assert_eq!(first, CredentialSource::Secret);
        assert_eq!(again, CredentialSource::Secret);
        assert_eq!(
            *lock(&tried),
            ["old-saved", "old-initial", "good", "good"],
            "refused candidates are tried once"
        );

        // Only refused candidates left: unauthorized at once, nothing sent to Argo CD.
        lock(&tried).clear();
        let err = sign_in_counting(stale()[..2].to_vec(), &refused, &tried)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unauthorized);
        assert!(lock(&tried).is_empty());

        // A new version of the Secret is a new candidate.
        let changed = vec![candidate(
            "secret:c1:argocd/argocd-initial-admin-secret@8",
            CredentialSource::Secret,
            "good",
        )];
        assert_eq!(
            sign_in_counting(changed, &refused, &tried).await.unwrap(),
            CredentialSource::Secret
        );
        assert_eq!(*lock(&tried), ["good"]);

        // A failure that is not a refusal (Argo CD unreachable) is not remembered.
        let unreachable = Mutex::new(HashSet::new());
        let down =
            |_: Credentials| async { Err::<(), _>(CoreError::new(ErrorCode::Unreachable, "down")) };
        let err = first_accepted(stale(), &unreachable, down)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);
        assert!(lock(&unreachable).is_empty());
    }

    /// An application state connected to the kind cluster with Argo CD, using the mock keyring `store`.
    async fn gitops_state(dirs: &Path, store: Arc<KeyringStore>) -> Option<(AppState, ClusterId)> {
        let Some(kubeconfig) =
            std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return None;
        };
        if std::env::var("SEXTANT_TEST_GITOPS").as_deref() != Ok("1") {
            eprintln!(
                "skipped: SEXTANT_TEST_GITOPS=1 is not set (see scripts/test-cluster.sh up --gitops)"
            );
            return None;
        }
        let state = AppState::new(&dirs.join("config"), &dirs.join("data"));
        state.argocd.set_store(store);
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig),
            home: Some(dirs.join("home")),
        });
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state.clusters.connect(&id).await.unwrap();
        // Something in settings.json, so the test can check it holds nothing secret.
        state
            .settings
            .update(|s| s.helm_path = Some("/usr/bin/helm".into()))
            .unwrap();
        Some((state, id))
    }

    fn guestbook() -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: "argoproj.io".into(),
                version: "v1alpha1".into(),
                kind: "Application".into(),
            },
            namespace: Some("argocd".into()),
            name: "guestbook".into(),
        }
    }

    /// The first admin password, read by the test only to check it goes nowhere.
    async fn initial_password(state: &AppState, id: &ClusterId) -> String {
        let (ns, name) = ("argocd", argocd::INITIAL_ADMIN_SECRET);
        sextant_core::resources::secret_value(&state.clusters, id, ns, name, "password")
            .await
            .unwrap()
    }

    fn settings_text(dirs: &Path) -> String {
        std::fs::read_to_string(dirs.join("config").join("settings.json")).unwrap_or_default()
    }

    #[tokio::test]
    async fn the_initial_admin_secret_signs_in_by_itself_and_its_password_goes_nowhere() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), store).await else {
            return;
        };
        let password = initial_password(&state, &id).await;

        let before = state.argocd.status(&state.clusters, &id).await.unwrap();
        let diff = state
            .argocd
            .diff(&state.clusters, &id, &guestbook())
            .await
            .unwrap();
        let after = state.argocd.status(&state.clusters, &id).await.unwrap();

        assert!(!before.signed_in);
        assert_eq!(after.namespace, "argocd");
        assert!(after.signed_in);
        assert_eq!(after.source, Some(CredentialSource::Secret));
        assert_eq!(after.user.as_deref(), Some("admin"));
        assert!(
            diff.iter()
                .any(|r| r.kind == "Deployment" && r.name == "guestbook-ui")
        );
        let sent = format!(
            "{}{}",
            serde_json::to_string(&after).unwrap(),
            serde_json::to_string(&diff).unwrap()
        );
        assert!(
            !sent.contains(&password),
            "the admin password reached the frontend"
        );
        assert!(!settings_text(dirs.path()).contains(&password));
        assert!(lock(&saved).is_empty(), "nothing is saved without Remember");
        state.close_all();
    }

    #[tokio::test]
    async fn remember_saves_the_login_it_is_used_next_time_and_forget_deletes_it() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), Arc::clone(&store)).await else {
            return;
        };
        let password = initial_password(&state, &id).await;
        let key = format!("sextant/argocd:{id}:argocd");

        let status = state
            .argocd
            .login(
                &state.clusters,
                &id,
                ArgoLogin {
                    username: Some("admin".into()),
                    password: Some(SecretString::new(password.clone())),
                    token: None,
                    remember: true,
                },
            )
            .await
            .unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&lock(&saved)[&key]).unwrap();
        assert_eq!(status.source, Some(CredentialSource::Saved));
        assert_eq!(stored["username"], "admin");
        assert_eq!(stored["password"], password.as_str());
        assert!(!serde_json::to_string(&status).unwrap().contains(&password));

        // A new run of the application signs in with the saved login before the standard secrets.
        let next = tempfile::tempdir().unwrap();
        let (again, again_id) = gitops_state(next.path(), Arc::clone(&store)).await.unwrap();
        again
            .argocd
            .diff(&again.clusters, &again_id, &guestbook())
            .await
            .unwrap();
        let next_status = again
            .argocd
            .status(&again.clusters, &again_id)
            .await
            .unwrap();
        assert_eq!(next_status.source, Some(CredentialSource::Saved));

        let out = state
            .argocd
            .logout(&state.clusters, &id, true)
            .await
            .unwrap();
        assert!(!out.signed_in);
        assert!(
            !lock(&saved).contains_key(&key),
            "Forget deletes the saved login"
        );
        for dir in [dirs.path(), next.path()] {
            assert!(!settings_text(dir).contains(&password));
        }
        state.close_all();
        again.close_all();
    }

    #[tokio::test]
    async fn wrong_credentials_are_refused_in_plain_words_and_a_session_token_signs_in() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), store).await else {
            return;
        };
        let login =
            |username: Option<&str>, password: Option<&str>, token: Option<&str>| ArgoLogin {
                username: username.map(str::to_string),
                password: password.map(SecretString::new),
                token: token.map(SecretString::new),
                remember: true,
            };

        let bad_password = state
            .argocd
            .login(
                &state.clusters,
                &id,
                login(Some("admin"), Some("not-the-password-42"), None),
            )
            .await
            .unwrap_err();
        let bad_token = state
            .argocd
            .login(
                &state.clusters,
                &id,
                login(None, None, Some("not-a-token-42")),
            )
            .await
            .unwrap_err();

        assert_eq!(bad_password.code, ErrorCode::Unauthorized);
        assert!(bad_password.message.contains("refused"), "{bad_password}");
        assert!(!bad_password.message.contains("not-the-password-42"));
        assert_eq!(bad_token.code, ErrorCode::Unauthorized);
        assert!(!bad_token.message.contains("not-a-token-42"));
        assert!(lock(&saved).is_empty(), "a refused login is not saved");

        // A token Argo CD issued signs in as a token.
        let password = initial_password(&state, &id).await;
        let forward = state
            .forwarder
            .start(
                &state.clusters,
                &id,
                ForwardTarget::Service {
                    namespace: "argocd".into(),
                    name: "argocd-server".into(),
                },
                443,
                None,
            )
            .await
            .unwrap();
        let session = ArgoClient::new(forward.local_port)
            .login_password("admin", &SecretString::new(password))
            .await
            .unwrap();
        let mut by_token = login(None, None, Some(session.token().expose()));
        by_token.remember = false;
        let status = state
            .argocd
            .login(&state.clusters, &id, by_token)
            .await
            .unwrap();
        assert!(status.signed_in);
        assert_eq!(status.source, Some(CredentialSource::Manual));
        assert_eq!(status.user.as_deref(), Some("admin"));
        state.close_all();
    }

    #[tokio::test]
    async fn after_signing_out_without_a_saved_login_the_diff_is_unauthorized() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, _saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), store).await else {
            return;
        };
        state
            .argocd
            .diff(&state.clusters, &id, &guestbook())
            .await
            .unwrap();

        state
            .argocd
            .logout(&state.clusters, &id, false)
            .await
            .unwrap();
        let err = state
            .argocd
            .diff(&state.clusters, &id, &guestbook())
            .await
            .unwrap_err();
        let status = state.argocd.status(&state.clusters, &id).await.unwrap();

        assert_eq!(err.code, ErrorCode::Unauthorized);
        assert!(!status.signed_in);
        state.close_all();
    }

    #[tokio::test]
    async fn closing_the_cluster_ends_the_session_and_the_forward() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, _saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), store).await else {
            return;
        };
        state
            .argocd
            .diff(&state.clusters, &id, &guestbook())
            .await
            .unwrap();
        assert_eq!(state.argocd.forwards(), 1);

        state.close_cluster(&id);

        assert_eq!(state.argocd.forwards(), 0);
        let status = state.argocd.status(&state.clusters, &id).await.unwrap();
        assert!(!status.signed_in, "the session ends with the cluster");
        state.close_all();
    }
}
