//! Argo CD: sign-in to its API and the desired ↔ live diff of an Application.
//!
//! The API is reached through a port forward to `argocd-server` (a [`PortForwarder`] of its own, so it does not show
//! in the user's list of forwards; it closes with the cluster). A session token lives only in memory
//! ([`ArgoSessions`] in `AppState`). Without a session `argocd_diff` signs in by itself, in this order: the login typed
//! in earlier in this run, the login saved in the OS credential store, `admin` with `argocd-initial-admin-secret`
//! (unless `admin.enabled` is `"false"`), the `token` of a Secret labelled `app.kubernetes.io/part-of=argocd`;
//! otherwise it answers `unauthorized` and the frontend shows the sign-in window, which says which logins Argo CD
//! refused ([`ArgoStatus::refused`]). A candidate Argo CD refused is not tried by itself again until its source changes
//! (a new `resourceVersion` of the Secret, a new login typed or saved), the user signs out, or the cluster is closed,
//! so a stale password does not pile up failed attempts. A saved login is a JSON `{"username","password"}` or
//! `{"token"}` with a `binding` `{"server","caSha256","entry"}` — the API server URL and certificate authority of the
//! kubeconfig entry it was saved through, and that entry's [`ClusterId`] — and it is offered only to a connection made
//! through the same entry that still gives the same server and CA ([`SavedLogin`]); a value without such a binding is
//! deleted unread — in the OS credential store (service `sextant`, user `argocd:<namespace>@<kubeSystemUid>`, or
//! `argocd:<clusterId>:<namespace>` when `kube-system` cannot be read; see [`keyring_user`]), never in
//! `settings.json`; the store is read once per login and run (the answer is kept in
//! memory and follows "Remember" and "Forget"). No password or token goes to the frontend, into an error message or
//! into a log. The API is talked to in plain HTTP only when the installation runs its server without TLS
//! (`server.insecure` in `argocd-cmd-params-cm`, [`ArgoStatus::insecure`]).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sextant_core::argocd::{
    self, ArgoClient, ArgoServer, CredentialSource, Credentials, ManagedResource, SecretString,
    ServerBinding, Session,
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

/// Whose saved Argo CD login it is: the cluster part of [`keyring_user`]. Never the API server URL — one URL can
/// front several clusters (a Teleport proxy, `kubectl proxy` on 127.0.0.1:8001, a reused local tunnel or kind port),
/// and a login saved for one must not be sent to another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginOwner {
    /// The UID of the cluster's `kube-system` Namespace ([`argocd::cluster_uid`]): the cluster itself, whichever
    /// context or proxy reaches it.
    Cluster(String),
    /// `kube-system` cannot be read: the kubeconfig entry (its id hashes the source path and the context), never
    /// shared between entries.
    Entry(ClusterId),
}

/// User name of the saved login of the Argo CD in `namespace` of `owner`'s cluster in the OS credential store:
/// `argocd:<namespace>@<kubeSystemUid>`, or `argocd:<clusterId>:<namespace>` (the user name of every login saved
/// before v0.6.1) when the UID cannot be read.
pub fn keyring_user(owner: &LoginOwner, namespace: &str) -> String {
    match owner {
        LoginOwner::Cluster(uid) => format!("argocd:{namespace}@{uid}"),
        LoginOwner::Entry(cluster) => format!("argocd:{cluster}:{namespace}"),
    }
}

/// How saved logins of a cluster are found ([`LoginKeys::user`]) and which older entries are deleted on sight
/// ([`LoginKeys::stale`]). Resolved once per connection ([`ArgoSessions`] keeps it with the cluster).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginKeys {
    pub owner: LoginOwner,
    /// The kubeconfig entry; its `argocd:<clusterId>:<namespace>` entry is stale once the cluster has a UID.
    pub cluster: ClusterId,
    /// The kubeconfig cluster's server URL, only to delete what an unreleased build saved under it.
    pub api_server: Option<String>,
    /// The API server of the kubeconfig entry the connection was made with ([`argocd::server_binding`]); `None` when
    /// the entry was edited since connecting or its server or certificate authority cannot be read. A saved login is
    /// offered only when it was saved with this binding through this entry ([`LoginKeys::login_binding`]), and saved
    /// only with one.
    pub binding: Option<ServerBinding>,
}

impl LoginKeys {
    pub fn user(&self, namespace: &str) -> String {
        keyring_user(&self.owner, namespace)
    }

    /// What a login saved through this connection is bound to, and what a saved login must be bound to for it to be
    /// offered: the API server and CA of the kubeconfig entry, and the entry itself (#116) — clusters behind one proxy
    /// URL and CA (Teleport, `kubectl proxy`) are told apart by the entry, so a hostile cluster that claims another's
    /// `kube-system` UID does not get its login. `None` while the entry gives no [`ServerBinding`].
    fn login_binding(&self) -> Option<LoginBinding> {
        let binding = self.binding.clone()?;
        Some(LoginBinding {
            server: binding.server,
            ca_sha256: binding.ca_sha256,
            entry: self.cluster.clone(),
        })
    }

    /// Entries no login is read from, deleted the first time the saved login is looked for: under a UID, the entry of
    /// the kubeconfig entry (the context may have been pointed at another cluster since it was saved, so it is not
    /// moved — the user signs in once more); always, one keyed by the API server URL (`argocd:<namespace>@<url>`,
    /// written only by unreleased builds).
    fn stale(&self, namespace: &str) -> Vec<String> {
        let mut stale = Vec::new();
        if let LoginOwner::Cluster(_) = self.owner {
            stale.push(keyring_user(
                &LoginOwner::Entry(self.cluster.clone()),
                namespace,
            ));
        }
        if let Some(url) = &self.api_server {
            stale.push(format!("argocd:{namespace}@{url}"));
        }
        stale.retain(|user| *user != self.user(namespace));
        stale
    }
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
    /// The OS credential store holds a login for this Argo CD (whatever the current session came from), so "Forget"
    /// has something to delete.
    pub saved: bool,
    /// Only in the answer of `argocd_login` with "Remember": signed in, but the OS credential store refused the
    /// login. The reason, without any secret.
    pub save_error: Option<String>,
    /// The installation runs `argocd-server` without TLS (`server.insecure` in `argocd-cmd-params-cm`): the API is
    /// talked to in plain HTTP inside the port forward.
    pub insecure: bool,
    /// The logins Argo CD refused on the last sign-in Sextant tried by itself; they are not tried again by
    /// themselves until their source changes or the user signs out.
    pub refused: Vec<RefusedLogin>,
}

/// A login Sextant tried by itself and Argo CD refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RefusedLogin {
    /// The login typed in earlier in this run.
    Typed,
    /// The login saved in the OS credential store.
    Saved,
    /// `admin` with the password of `argocd-initial-admin-secret` (it may have been changed in Argo CD).
    AdminSecret,
    /// The `token` of a Secret labelled `app.kubernetes.io/part-of=argocd`.
    TokenSecret,
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

/// The namespace of the Argo CD installation the user chose for the cluster (`clusters[id].argocdNamespace` in the
/// settings, written by the frontend when several namespaces looked like one). Only a hint: the core takes it only
/// when it is one of the candidates it found itself ([`argocd::find_server`]).
fn chosen_namespace(state: &AppState, cluster: &ClusterId) -> Option<String> {
    state
        .settings
        .get()
        .clusters
        .get(cluster.as_str())
        .and_then(|c| c.argocd_namespace.clone())
        .map(|ns| ns.trim().to_owned())
        .filter(|ns| !ns.is_empty())
}

/// Whether Argo CD is signed in for the cluster, and how. Does not sign in.
#[tauri::command]
pub async fn argocd_status(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<ArgoStatus, CoreError> {
    let chosen = chosen_namespace(&state, &cluster_id);
    state
        .argocd
        .status(&state.clusters, &cluster_id, chosen.as_deref())
        .await
}

/// Signs in with what the user typed; `remember` saves it in the OS credential store.
#[tauri::command]
pub async fn argocd_login(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    login: ArgoLogin,
) -> Result<ArgoStatus, CoreError> {
    let chosen = chosen_namespace(&state, &cluster_id);
    let call = state
        .argocd
        .login(&state.clusters, &cluster_id, chosen.as_deref(), login);
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
    let chosen = chosen_namespace(&state, &cluster_id);
    state
        .argocd
        .logout(
            &state.clusters,
            &cluster_id,
            chosen.as_deref(),
            options.forget,
        )
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
    let chosen = chosen_namespace(&state, &cluster_id);
    let call = state
        .argocd
        .diff(&state.clusters, &cluster_id, chosen.as_deref(), &app);
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
    /// The saved login of each [`keyring_user`] as last read from or written to the credential store (`None`: none,
    /// or the store could not be read), so the store — and the OS prompt an unsigned build may raise for it — is
    /// reached once per login and run, not on every status. Whether it is offered depends on the binding of the
    /// connection asking ([`SavedLogin::offered_to`]). Only bound logins are kept here.
    saved: Mutex<HashMap<String, Option<SavedLogin>>>,
}

/// Everything Argo CD of one cluster has for one connection ([`ClusterManager::connection`]): a reconnect may reach
/// another cluster (the kubeconfig entry was repointed), so nothing of it — server, forward, session, typed login,
/// keys, refusals — outlives the connection it was made on ([`ArgoSessions::attach`]).
#[derive(Default)]
struct ArgoConn {
    /// The connection all of this belongs to.
    connection: Option<u64>,
    server: Option<ArgoServer>,
    /// The installation namespace the user chose ([`chosen_namespace`]) that `server` was looked up with.
    chosen: Option<String>,
    /// What saved logins of the cluster are keyed by, resolved once per connection.
    keys: Option<LoginKeys>,
    /// Id of the forward to `argocd-server` and the client on its local port.
    forward: Option<(String, ArgoClient)>,
    session: Option<SignedIn>,
    /// The login typed in this run (without "Remember"), to sign in again when the session expires.
    typed: Option<Credentials>,
    /// Signed out by hand: the saved login and the standard secrets wait for the next sign-in.
    signed_out: bool,
    expired: bool,
    /// Keys of the candidates Argo CD refused ([`Candidate::key`]); they are not tried again by themselves, so a stale
    /// password does not pile up failed attempts (Argo CD locks the account out). Emptied by signing out, and gone
    /// with the cluster when it closes.
    refused: HashSet<String>,
    /// What Argo CD refused on the last sign-in Sextant tried by itself ([`ArgoStatus::refused`]).
    last_refused: Vec<RefusedLogin>,
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
            saved: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces the credential store (tests use a mock `keyring` backend); what was read from the old one is dropped.
    pub fn set_store(&self, store: Arc<dyn CredentialStore>) {
        *self.store.write().unwrap_or_else(|e| e.into_inner()) = store;
        lock(&self.saved).clear();
    }

    fn store(&self) -> Arc<dyn CredentialStore> {
        Arc::clone(&self.store.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Forwards to `argocd-server` that are open now.
    pub fn forwards(&self) -> usize {
        self.forwarder.list().len()
    }

    /// Ends the session and closes the forward of a cluster (it was disconnected); the logins Argo CD refused are
    /// tried again after it reconnects.
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

    /// `chosen` (here and in the other calls) is the installation namespace the user chose; see
    /// [`ArgoSessions::choose`].
    pub async fn status(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        chosen: Option<&str>,
    ) -> Result<ArgoStatus, CoreError> {
        let conn = self.conn(cluster);
        let mut conn = conn.lock().await;
        self.attach(&mut conn, mgr, cluster).await?;
        self.choose(&mut conn, mgr, cluster, chosen).await?;
        let server = self.server(&mut conn, mgr, cluster).await?;
        let namespace = server.namespace;
        let options = argocd::login_options(mgr, cluster, &namespace).await?;
        let keys = login_keys(&mut conn, mgr, cluster).await?;
        Ok(ArgoStatus {
            namespace: namespace.clone(),
            signed_in: conn.session.is_some(),
            source: conn.session.as_ref().map(|s| s.source),
            user: conn
                .session
                .as_ref()
                .and_then(|s| s.session.username.clone()),
            local_users: options.local_users,
            sso: options.sso,
            expired: conn.expired,
            saved: self.has_saved(&keys, &namespace).await,
            save_error: None,
            insecure: server.insecure,
            refused: conn.last_refused.clone(),
        })
    }

    pub async fn login(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        chosen: Option<&str>,
        login: ArgoLogin,
    ) -> Result<ArgoStatus, CoreError> {
        let credentials = credentials_of(login.clone())?;
        let mut save_error = None;
        {
            let conn = self.conn(cluster);
            let mut conn = conn.lock().await;
            self.attach(&mut conn, mgr, cluster).await?;
            self.choose(&mut conn, mgr, cluster, chosen).await?;
            let client = self.client(&mut conn, mgr, cluster).await?;
            let namespace = self.server(&mut conn, mgr, cluster).await?.namespace;
            let keys = login_keys(&mut conn, mgr, cluster).await?;
            same_connection(&conn, mgr, cluster)?;
            let session = match client.login(&credentials).await {
                Ok(session) => session,
                Err(err) => {
                    return Err(explain_refusal(err, &credentials, mgr, cluster, &namespace).await);
                }
            };
            conn.session = Some(SignedIn {
                session,
                source: CredentialSource::Manual,
            });
            conn.typed = Some(credentials.clone());
            conn.signed_out = false;
            conn.expired = false;
            conn.last_refused.clear();
            // A new login: the typed one (and, saved, the saved one) may be tried again by itself.
            conn.refused.remove(TYPED_KEY);
            if login.remember {
                conn.refused.remove(&saved_key(&keys, &namespace));
                save_error = self.remember(&keys, &namespace, &credentials).await?;
            }
            if let Some(signed) = conn.session.as_mut() {
                signed.source = login_source(login.remember, save_error.as_deref());
            }
        }
        let mut status = self.status(mgr, cluster, chosen).await?;
        status.save_error = save_error;
        Ok(status)
    }

    /// Saves the login in the credential store (and drops the [`LoginKeys::stale`] entries). The sign-in itself
    /// worked, so a store that refuses is not an error of the call: the reason comes back (`Some`) for the window to
    /// say it once. `Err` only when the login cannot be written as JSON.
    async fn remember(
        &self,
        keys: &LoginKeys,
        namespace: &str,
        credentials: &Credentials,
    ) -> Result<Option<String>, CoreError> {
        let Some(binding) = keys.login_binding() else {
            return Ok(Some(UNBOUND_SAVE.to_owned()));
        };
        let login = SavedLogin {
            credentials: credentials.clone(),
            binding,
        };
        let store = self.store();
        let user = keys.user(namespace);
        let stale = keys.stale(namespace);
        let value = login.to_value()?;
        let saved_as = user.clone();
        let result = blocking(move || {
            store.save(&user, &value)?;
            for old in &stale {
                let _ = store.forget(old);
            }
            Ok(())
        })
        .await;
        if result.is_ok() {
            lock(&self.saved).insert(saved_as, Some(login));
        }
        Ok(result.err().map(|err| err.message))
    }

    /// Whether the credential store holds a readable login for the Argo CD of `namespace`, whoever signed in now.
    async fn has_saved(&self, keys: &LoginKeys, namespace: &str) -> bool {
        self.saved(keys, namespace).await.is_some()
    }

    pub async fn logout(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        chosen: Option<&str>,
        forget: bool,
    ) -> Result<ArgoStatus, CoreError> {
        {
            let conn = self.conn(cluster);
            let mut conn = conn.lock().await;
            self.attach(&mut conn, mgr, cluster).await?;
            self.choose(&mut conn, mgr, cluster, chosen).await?;
            let namespace = self.server(&mut conn, mgr, cluster).await?.namespace;
            conn.session = None;
            conn.typed = None;
            conn.signed_out = true;
            conn.expired = false;
            // The next sign-in starts afresh: what Argo CD refused (a changed admin password, say) may be tried again.
            conn.refused.clear();
            conn.last_refused.clear();
            if forget {
                let keys = login_keys(&mut conn, mgr, cluster).await?;
                self.forget(&keys, &namespace).await?;
            }
        }
        self.status(mgr, cluster, chosen).await
    }

    pub async fn diff(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        chosen: Option<&str>,
        app: &ObjectRef,
    ) -> Result<Vec<ManagedResource>, CoreError> {
        let conn = self.conn(cluster);
        let mut conn = conn.lock().await;
        self.attach(&mut conn, mgr, cluster).await?;
        self.choose(&mut conn, mgr, cluster, chosen).await?;
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
        let namespace = self.server(conn, mgr, cluster).await?.namespace;
        let candidates = self.candidates(conn, mgr, cluster, &namespace).await?;
        // Everything above — the forward, the keys, the Secrets read — came through the connection the candidates
        // belong to; a reconnect in between may have reached another cluster.
        same_connection(conn, mgr, cluster)?;
        let login = |credentials: Credentials| {
            let client = client.clone();
            async move { client.login(&credentials).await }
        };
        let kinds: Vec<(String, RefusedLogin)> = candidates
            .iter()
            .map(|c| (c.key.clone(), c.refused_as))
            .collect();
        let result = first_accepted(candidates, &mut conn.refused, login).await;
        conn.last_refused = refused_of(&kinds, &conn.refused);
        let (session, source) = result?;
        conn.session = Some(SignedIn {
            session: session.clone(),
            source,
        });
        conn.expired = false;
        Ok((client, session))
    }

    /// What [`ArgoSessions::signed_in`] tries, in order: the login typed in this connection, the saved login of the
    /// cluster, the standard secrets (the last two not after signing out by hand).
    async fn candidates(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        namespace: &str,
    ) -> Result<Vec<Candidate>, CoreError> {
        let mut candidates = Vec::new();
        if let Some(typed) = &conn.typed {
            candidates.push(Candidate {
                key: TYPED_KEY.into(),
                source: CredentialSource::Manual,
                refused_as: RefusedLogin::Typed,
                credentials: typed.clone(),
            });
        }
        if conn.signed_out {
            return Ok(candidates);
        }
        let keys = login_keys(conn, mgr, cluster).await?;
        if let Some(saved) = self.saved(&keys, namespace).await {
            candidates.push(Candidate {
                key: saved_key(&keys, namespace),
                source: CredentialSource::Saved,
                refused_as: RefusedLogin::Saved,
                credentials: saved,
            });
        }
        let standard = argocd::standard_credentials_with_origin(mgr, cluster, namespace).await?;
        candidates.extend(standard.into_iter().map(|(origin, credentials)| Candidate {
            key: format!("secret:{origin}"),
            source: CredentialSource::Secret,
            refused_as: match credentials {
                Credentials::Password { .. } => RefusedLogin::AdminSecret,
                Credentials::Token { .. } => RefusedLogin::TokenSecret,
            },
            credentials,
        }));
        Ok(candidates)
    }

    /// Ties `conn` to the cluster's current connection: when it was made on another one (the cluster reconnected,
    /// maybe to another cluster behind the same kubeconfig entry), all of it ends first — its forward closes, and the
    /// server, session, typed login, keys, choice and refusals are gone — so nothing typed, saved or signed in for
    /// one cluster goes to another's `argocd-server`.
    async fn attach(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<(), CoreError> {
        let current = mgr.connection(cluster)?;
        if conn.connection == Some(current) {
            return Ok(());
        }
        if let Some((id, _)) = conn.forward.take() {
            let _ = self.forwarder.stop(&id).await;
        }
        *conn = ArgoConn {
            connection: Some(current),
            ..ArgoConn::default()
        };
        Ok(())
    }

    /// The saved login offered to this connection ([`SavedLogin::offered_to`]), if the store has a readable one (a
    /// store that cannot be reached counts as none). The store is read once per [`keyring_user`] and run; the
    /// [`LoginKeys::stale`] entries are deleted then (best effort), never read, and so is a login without a binding
    /// under any key (saved by v0.6.1, or bound by v0.7.0 without the kubeconfig entry, #116) — it cannot say which
    /// cluster it is for, so the user signs in once more. A bound login of another entry or server is kept, unoffered.
    async fn saved(&self, keys: &LoginKeys, namespace: &str) -> Option<Credentials> {
        let user = keys.user(namespace);
        let known = lock(&self.saved).get(&user).cloned();
        let login = match known {
            Some(known) => known,
            None => {
                let store = self.store();
                let stale = keys.stale(namespace);
                let key = user.clone();
                let found = blocking(move || {
                    for old in &stale {
                        let _ = store.forget(old);
                    }
                    match load(&*store, &key)? {
                        Stored::Bound(login) => Ok(Some(login)),
                        Stored::Unbound => {
                            let _ = store.forget(&key);
                            Ok(None)
                        }
                        Stored::None => Ok(None),
                    }
                })
                .await
                .ok()
                .flatten();
                lock(&self.saved).insert(user, found.clone());
                found
            }
        };
        login.filter(|l| l.offered_to(keys)).map(|l| l.credentials)
    }

    /// Deletes the saved login (and the [`LoginKeys::stale`] entries).
    async fn forget(&self, keys: &LoginKeys, namespace: &str) -> Result<(), CoreError> {
        let store = self.store();
        let user = keys.user(namespace);
        let stale = keys.stale(namespace);
        let key = user.clone();
        blocking(move || {
            for old in &stale {
                let _ = store.forget(old);
            }
            store.forget(&key)
        })
        .await?;
        lock(&self.saved).insert(user, None);
        Ok(())
    }

    /// The server of the cluster, found once per connection (and choice, [`ArgoSessions::choose`]).
    async fn server(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<ArgoServer, CoreError> {
        if let Some(server) = &conn.server {
            return Ok(server.clone());
        }
        let server = argocd::find_server(mgr, cluster, conn.chosen.as_deref()).await?;
        conn.server = Some(server.clone());
        Ok(server)
    }

    /// Takes the installation namespace the user chose. When it changed since the server was found, the server is
    /// looked up again (the core takes the choice only among the candidates it finds); when that gives another
    /// server, everything of the old one ends — its forward, session, typed login and refusals — so nothing typed for
    /// one installation goes to another.
    async fn choose(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        chosen: Option<&str>,
    ) -> Result<(), CoreError> {
        if conn.chosen.as_deref() == chosen {
            return Ok(());
        }
        conn.chosen = chosen.map(str::to_owned);
        let Some(old) = conn.server.take() else {
            return Ok(());
        };
        let found = argocd::find_server(mgr, cluster, chosen).await;
        if found.as_ref().ok() == Some(&old) {
            conn.server = Some(old);
            return found.map(|_| ());
        }
        if let Some((id, _)) = conn.forward.take() {
            let _ = self.forwarder.stop(&id).await;
        }
        conn.session = None;
        conn.typed = None;
        conn.signed_out = false;
        conn.expired = false;
        conn.refused.clear();
        conn.last_refused.clear();
        conn.server = Some(found?);
        Ok(())
    }

    /// The client on the forward to `argocd-server`, opening the forward when there is none (or it broke).
    async fn client(
        &self,
        conn: &mut ArgoConn,
        mgr: &ClusterManager,
        cluster: &ClusterId,
    ) -> Result<ArgoClient, CoreError> {
        let server = self.server(conn, mgr, cluster).await?;
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
            .start(
                mgr,
                cluster,
                target,
                server.port,
                None,
                sextant_core::portforward::PodFilter::Any,
            )
            .await
            .map_err(|err| match err.code {
                ErrorCode::NotFound | ErrorCode::Other => CoreError::new(
                    ErrorCode::Unreachable,
                    format!("Argo CD is not reachable: {}", err.message),
                ),
                _ => err,
            })?;
        // The forward keeps the Kubernetes client it started with: it must be this connection's.
        if let Err(err) = same_connection(conn, mgr, cluster) {
            let _ = self.forwarder.stop(&info.id).await;
            return Err(err);
        }
        let client = ArgoClient::for_server(&server, info.local_port);
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
    /// How the sign-in window names it when Argo CD refuses it.
    refused_as: RefusedLogin,
    credentials: Credentials,
}

/// [`Candidate::key`] of the login typed in this run.
const TYPED_KEY: &str = "typed";

fn saved_key(keys: &LoginKeys, namespace: &str) -> String {
    format!("saved:{}", keys.user(namespace))
}

/// The kinds of the candidates (`key`, kind) whose key is in `refused`, sorted, each once.
fn refused_of(
    candidates: &[(String, RefusedLogin)],
    refused: &HashSet<String>,
) -> Vec<RefusedLogin> {
    let mut kinds: Vec<RefusedLogin> = candidates
        .iter()
        .filter(|(key, _)| refused.contains(key))
        .map(|(_, kind)| *kind)
        .collect();
    kinds.sort();
    kinds.dedup();
    kinds
}

/// What the credential store holds for one [`keyring_user`].
enum Stored {
    /// A login bound to the API server and kubeconfig entry it was saved through.
    Bound(SavedLogin),
    /// A login without a binding, or with one that does not name the kubeconfig entry (saved by v0.6.1 or v0.7.0):
    /// never offered, deleted on sight (#116).
    Unbound,
    /// Nothing, or an entry that is not a login.
    None,
}

/// The saved login of `user`.
fn load(store: &dyn CredentialStore, user: &str) -> Result<Stored, CoreError> {
    Ok(match store.load(user)? {
        Some(text) => SavedLogin::parse(&text),
        None => Stored::None,
    })
}

/// Why "Remember" saved nothing when the kubeconfig entry gives no [`ServerBinding`].
const UNBOUND_SAVE: &str = "the login was not saved: this cluster's kubeconfig entry was changed since it was \
connected (reconnect it), or its server or certificate authority cannot be read; a saved login is kept only \
together with the server it is for";

/// What a saved login is bound to ([`LoginKeys::login_binding`]): the API server URL and the SHA-256 of the
/// certificate authority of the kubeconfig entry it was saved through, and that entry's id. Serialized
/// `{"server","caSha256","entry"}`; all three must match the connection for the login to be offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBinding {
    server: String,
    ca_sha256: Option<String>,
    entry: ClusterId,
}

/// A login in the credential store and what it was saved for. The value is the login's JSON
/// (`{"username","password"}` or `{"token"}`) with a `binding` ([`LoginBinding`]); one without a complete binding is
/// [`Stored::Unbound`] (older builds read a bound value as the plain login, ignoring the binding).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SavedLogin {
    credentials: Credentials,
    binding: LoginBinding,
}

impl SavedLogin {
    fn parse(text: &str) -> Stored {
        #[derive(Deserialize)]
        struct Binding {
            #[serde(default)]
            binding: Option<serde_json::Value>,
        }
        let Ok(credentials) = serde_json::from_str::<Credentials>(text) else {
            return Stored::None;
        };
        let binding = serde_json::from_str::<Binding>(text)
            .ok()
            .and_then(|b| b.binding)
            .and_then(|b| serde_json::from_value::<LoginBinding>(b).ok());
        match binding {
            Some(binding) => Stored::Bound(Self {
                credentials,
                binding,
            }),
            None => Stored::Unbound,
        }
    }

    fn to_value(&self) -> Result<String, CoreError> {
        let mut value = serde_json::to_value(&self.credentials)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("binding".into(), serde_json::to_value(&self.binding)?);
        }
        Ok(value.to_string())
    }

    /// Offered to a connection only when it was made through the kubeconfig entry the login was saved through and
    /// that entry still gives the same API server URL and certificate authority (#109, #116).
    fn offered_to(&self, keys: &LoginKeys) -> bool {
        keys.login_binding().as_ref() == Some(&self.binding)
    }
}

/// Where a login typed into the window counts as coming from: the credential store only when "Remember" was asked
/// and the store took it (`save_error` is `None`); a login the store refused lives in memory until Sextant closes.
fn login_source(remember: bool, save_error: Option<&str>) -> CredentialSource {
    if remember && save_error.is_none() {
        CredentialSource::Saved
    } else {
        CredentialSource::Manual
    }
}

/// Signs in (`login`) with the first candidate Argo CD accepts, skipping those whose key is in `refused` and adding
/// the key of every candidate it refuses. Only a refusal is remembered: an unreachable server ends the attempt and
/// counts against nobody. Nothing left to try is `unauthorized`.
async fn first_accepted<S, F, Fut>(
    candidates: Vec<Candidate>,
    refused: &mut HashSet<String>,
    mut login: F,
) -> Result<(S, CredentialSource), CoreError>
where
    F: FnMut(Credentials) -> Fut,
    Fut: Future<Output = Result<S, CoreError>>,
{
    let any = !candidates.is_empty();
    let fresh: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| !refused.contains(&c.key))
        .collect();
    for candidate in fresh {
        match login(candidate.credentials).await {
            Ok(session) => return Ok((session, candidate.source)),
            Err(err) if argocd::is_refusal(&err) => {
                refused.insert(candidate.key);
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

/// `conn` still belongs to the cluster's current connection ([`ArgoSessions::attach`]); otherwise the cluster
/// reconnected during the call, and nothing gathered in it may be sent anywhere.
fn same_connection(
    conn: &ArgoConn,
    mgr: &ClusterManager,
    cluster: &ClusterId,
) -> Result<(), CoreError> {
    if conn.connection.is_some() && mgr.connection(cluster).ok() == conn.connection {
        return Ok(());
    }
    Err(CoreError::new(
        ErrorCode::Unreachable,
        "the cluster reconnected during the Argo CD call; try again",
    ))
}

/// What saved logins of the cluster are keyed by, resolved once per connection: the UID of its `kube-system`
/// Namespace, or the kubeconfig entry when that cannot be read. A cluster that cannot be reached is an error (and
/// nothing is kept). The binding is checked again on every call ([`argocd::server_binding`]): an entry edited since
/// connecting gets nothing offered and nothing saved until it reconnects.
async fn login_keys(
    conn: &mut ArgoConn,
    mgr: &ClusterManager,
    cluster: &ClusterId,
) -> Result<LoginKeys, CoreError> {
    if let Some(keys) = &mut conn.keys {
        keys.binding = argocd::server_binding(mgr, cluster).ok().flatten();
        return Ok(keys.clone());
    }
    let owner = match argocd::cluster_uid(mgr, cluster).await? {
        Some(uid) => LoginOwner::Cluster(uid),
        None => LoginOwner::Entry(cluster.clone()),
    };
    let keys = LoginKeys {
        owner,
        cluster: cluster.clone(),
        api_server: argocd::api_server_url(mgr, cluster).ok(),
        binding: argocd::server_binding(mgr, cluster).ok().flatten(),
    };
    conn.keys = Some(keys.clone());
    Ok(keys)
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
    use serde_json::json;
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

    /// The kube-system UID of the cluster the unit tests' saved logins belong to.
    const UID: &str = "0b1d6c1e-7f3a-4c2e-9d55-1f0e2a3b4c5d";
    /// The API server URL in front of it.
    const SERVER: &str = "https://10.0.0.1:6443";

    fn keys_of(owner: LoginOwner, cluster: &str) -> LoginKeys {
        LoginKeys {
            owner,
            cluster: ClusterId::from(cluster),
            api_server: Some(SERVER.into()),
            binding: Some(binding_of(SERVER, Some(CA))),
        }
    }

    /// SHA-256 of the certificate authority of [`SERVER`]'s kubeconfig entry.
    const CA: &str = "9e7d0b95ce1401718101be73ed16d45f90f75aa5beea977101f24860ce2c8a9b";

    fn binding_of(server: &str, ca: Option<&str>) -> ServerBinding {
        ServerBinding {
            server: server.into(),
            ca_sha256: ca.map(str::to_owned),
        }
    }

    /// The same keys, with the kubeconfig entry now naming `binding`.
    fn rebound(keys: &LoginKeys, binding: Option<ServerBinding>) -> LoginKeys {
        LoginKeys {
            binding,
            ..keys.clone()
        }
    }

    /// The saved value of `user`, as JSON.
    fn value_of(saved: &Saved, user: &str) -> Option<serde_json::Value> {
        lock(saved)
            .get(&format!("{KEYRING_SERVICE}/{user}"))
            .map(|v| serde_json::from_slice(v).unwrap())
    }

    /// The keys of a cluster whose kube-system UID is `uid`, reached through the kubeconfig entry `cluster`.
    fn by_uid(uid: &str, cluster: &str) -> LoginKeys {
        keys_of(LoginOwner::Cluster(uid.into()), cluster)
    }

    fn stored(saved: &Saved) -> Vec<String> {
        let mut keys: Vec<String> = lock(saved).keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn a_login_is_saved_under_the_documented_key_and_forgotten() {
        let (store, saved) = mock_store();
        let user = keyring_user(&LoginOwner::Cluster(UID.into()), "argocd");

        store.save(&user, r#"{"token":"t"}"#).unwrap();
        let loaded = store.load(&user).unwrap();
        let keys = stored(&saved);
        store.forget(&user).unwrap();

        assert_eq!(user, format!("argocd:argocd@{UID}"));
        assert_eq!(
            keyring_user(&LoginOwner::Entry(ClusterId::from("c1")), "argocd"),
            "argocd:c1:argocd",
            "without a readable kube-system: the key every login had before v0.6.1"
        );
        assert_eq!(keys, [format!("sextant/argocd:argocd@{UID}")]);
        assert_eq!(loaded.as_deref(), Some(r#"{"token":"t"}"#));
        assert_eq!(store.load(&user).unwrap(), None);
        assert!(store.forget(&user).is_ok(), "forgetting twice is fine");
    }

    /// A credential store that cannot be written to (a locked keyring, no Secret Service on Linux).
    struct LockedStore;

    impl CredentialStore for LockedStore {
        fn load(&self, _user: &str) -> Result<Option<String>, CoreError> {
            Err(CoreError::new(ErrorCode::Other, "locked"))
        }

        fn save(&self, _user: &str, _value: &str) -> Result<(), CoreError> {
            Err(CoreError::new(
                ErrorCode::Other,
                "the system credential store: no secret service is running",
            ))
        }

        fn forget(&self, _user: &str) -> Result<(), CoreError> {
            Err(CoreError::new(ErrorCode::Other, "locked"))
        }
    }

    fn token_login() -> Credentials {
        Credentials::Token {
            token: SecretString::new("tok"),
        }
    }

    #[tokio::test]
    async fn a_saved_login_is_reported_whatever_the_session_came_from() {
        let (store, _saved) = mock_store();
        let keys = by_uid(UID, "c1");
        store
            .save(&keys.user("argocd"), &bound_through("c1").to_string())
            .unwrap();
        let sessions = ArgoSessions::new(store.clone());

        assert!(sessions.has_saved(&keys, "argocd").await);
        assert!(
            !sessions.has_saved(&keys, "other").await,
            "a login is saved per namespace of the installation"
        );
        assert!(
            !sessions.has_saved(&by_uid(UID, "c2"), "argocd").await,
            "another kubeconfig entry, even of the same cluster, signs in once more (#116)"
        );
        sessions.set_store(Arc::new(LockedStore));
        assert!(
            !sessions.has_saved(&keys, "argocd").await,
            "a store that cannot be read counts as none"
        );
    }

    /// A store that counts how often each user is read.
    struct CountingStore {
        inner: Arc<KeyringStore>,
        loads: Mutex<HashMap<String, usize>>,
    }

    impl CredentialStore for CountingStore {
        fn load(&self, user: &str) -> Result<Option<String>, CoreError> {
            *lock(&self.loads).entry(user.to_string()).or_default() += 1;
            self.inner.load(user)
        }

        fn save(&self, user: &str, value: &str) -> Result<(), CoreError> {
            self.inner.save(user, value)
        }

        fn forget(&self, user: &str) -> Result<(), CoreError> {
            self.inner.forget(user)
        }
    }

    #[tokio::test]
    async fn the_credential_store_is_read_once_and_follows_remember_and_forget() {
        let (inner, _saved) = mock_store();
        let store = Arc::new(CountingStore {
            inner,
            loads: Mutex::new(HashMap::new()),
        });
        let sessions = ArgoSessions::new(store.clone());
        let keys = by_uid(UID, "c1");

        for _ in 0..5 {
            assert!(!sessions.has_saved(&keys, "argocd").await);
        }
        let user = keys.user("argocd");
        assert_eq!(
            lock(&store.loads).get(&user).copied(),
            Some(1),
            "a status does not read the store every time"
        );

        sessions
            .remember(&keys, "argocd", &token_login())
            .await
            .unwrap();
        assert!(sessions.has_saved(&keys, "argocd").await);
        sessions.forget(&keys, "argocd").await.unwrap();
        assert!(!sessions.has_saved(&keys, "argocd").await);
        assert_eq!(lock(&store.loads).get(&user).copied(), Some(1));
        assert_eq!(
            lock(&store.loads).len(),
            1,
            "no other entry is read, the stale ones included"
        );
    }

    #[tokio::test]
    async fn a_login_saved_by_the_kubeconfig_entry_is_not_tried_under_a_uid_and_is_deleted() {
        let (store, saved) = mock_store();
        let value = serde_json::to_string(&token_login()).unwrap();
        // Saved before v0.6.1 (by the entry) and by an unreleased build (by the API server URL).
        store.save("argocd:c1:argocd", &value).unwrap();
        store
            .save(&format!("argocd:argocd@{SERVER}"), &value)
            .unwrap();
        let sessions = ArgoSessions::new(store.clone());

        let found = sessions.saved(&by_uid(UID, "c1"), "argocd").await;

        assert_eq!(found, None, "the context may point at another cluster now");
        assert!(stored(&saved).is_empty(), "{:?}", stored(&saved));
    }

    #[tokio::test]
    async fn without_a_uid_the_login_of_the_kubeconfig_entry_keeps_working() {
        let (store, saved) = mock_store();
        let value = serde_json::to_string(&token_login()).unwrap();
        store
            .save("argocd:c1:argocd", &bound_through("c1").to_string())
            .unwrap();
        store
            .save(&format!("argocd:argocd@{SERVER}"), &value)
            .unwrap();
        let sessions = ArgoSessions::new(store.clone());
        let keys = keys_of(LoginOwner::Entry(ClusterId::from("c1")), "c1");

        let found = sessions.saved(&keys, "argocd").await;
        sessions
            .remember(&keys, "argocd", &token_login())
            .await
            .unwrap();

        assert_eq!(found, Some(token_login()));
        assert_eq!(
            stored(&saved),
            ["sextant/argocd:c1:argocd"],
            "the URL-keyed entry is deleted, the entry's own is kept"
        );
        assert!(
            !sessions
                .has_saved(
                    &keys_of(LoginOwner::Entry(ClusterId::from("c2")), "c2"),
                    "argocd"
                )
                .await,
            "another kubeconfig entry never finds it"
        );
    }

    /// A login saved as Sextant 0.6.1 saved it: no binding.
    fn unbound(credentials: &Credentials) -> String {
        serde_json::to_string(credentials).unwrap()
    }

    /// [`token_login`] as this build saves it through the kubeconfig entry `entry` of [`SERVER`] with [`CA`].
    fn bound_through(entry: &str) -> serde_json::Value {
        json!({ "token": "tok", "binding": { "server": SERVER, "caSha256": CA, "entry": entry } })
    }

    #[tokio::test]
    async fn a_saved_login_is_bound_to_its_server_and_offered_only_to_it() {
        let (store, saved) = mock_store();
        let keys = by_uid(UID, "c1");
        let sessions = ArgoSessions::new(store.clone());

        sessions
            .remember(&keys, "argocd", &token_login())
            .await
            .unwrap();

        assert_eq!(
            value_of(&saved, &keys.user("argocd")),
            Some(bound_through("c1"))
        );
        let next_run = || ArgoSessions::new(store.clone());
        assert_eq!(next_run().saved(&keys, "argocd").await, Some(token_login()));
        let other_server = rebound(&keys, Some(binding_of("https://10.9.9.9:6443", Some(CA))));
        let other_ca = rebound(&keys, Some(binding_of(SERVER, Some(&"0".repeat(64)))));
        let no_ca = rebound(&keys, Some(binding_of(SERVER, None)));
        let unreadable = rebound(&keys, None);
        for keys in [&other_server, &other_ca, &no_ca, &unreadable] {
            assert_eq!(
                next_run().saved(keys, "argocd").await,
                None,
                "{:?}",
                keys.binding
            );
            assert!(!next_run().has_saved(keys, "argocd").await);
        }
        assert_eq!(
            sessions.saved(&other_server, "argocd").await,
            None,
            "nor from what this run read"
        );
        assert!(
            value_of(&saved, &keys.user("argocd")).is_some(),
            "a login of another server is kept: the entry may be pointed back"
        );
    }

    #[tokio::test]
    async fn a_repointed_kubeconfig_entry_does_not_get_the_login_saved_through_it() {
        let (store, saved) = mock_store();
        let entry = keys_of(LoginOwner::Entry(ClusterId::from("c1")), "c1");
        ArgoSessions::new(store.clone())
            .remember(&entry, "argocd", &token_login())
            .await
            .unwrap();
        let repointed = rebound(&entry, Some(binding_of("https://10.9.9.9:6443", None)));

        let sessions = ArgoSessions::new(store.clone());
        assert_eq!(sessions.saved(&repointed, "argocd").await, None);
        assert!(!sessions.has_saved(&repointed, "argocd").await);
        assert_eq!(
            ArgoSessions::new(store).saved(&entry, "argocd").await,
            Some(token_login())
        );
        assert_eq!(stored(&saved), ["sextant/argocd:c1:argocd"]);
    }

    #[tokio::test]
    async fn an_unbound_or_entryless_login_is_deleted_unread_under_any_key() {
        let (store, saved) = mock_store();
        let keys = by_uid(UID, "c1");
        let entry = keys_of(LoginOwner::Entry(ClusterId::from("c1")), "c1");
        // As v0.7.0 bound it: the server and CA, no kubeconfig entry.
        let entryless = json!({ "token": "tok", "binding": { "server": SERVER, "caSha256": CA } });
        for value in [unbound(&token_login()), entryless.to_string()] {
            for keys in [&keys, &entry] {
                store.save(&keys.user("argocd"), &value).unwrap();
                let sessions = ArgoSessions::new(store.clone());

                assert_eq!(sessions.saved(keys, "argocd").await, None, "{value}");
                assert!(!sessions.has_saved(keys, "argocd").await);
                assert!(stored(&saved).is_empty(), "{value}: {:?}", stored(&saved));
            }
        }
    }

    #[tokio::test]
    async fn a_login_is_offered_only_through_the_kubeconfig_entry_it_was_saved_through() {
        let (store, saved) = mock_store();
        // Two contexts behind one proxy URL and CA; the attacker's cluster claims the victim's kube-system UID.
        let victim = by_uid(UID, "victim");
        let attacker = by_uid(UID, "attacker");
        assert_eq!(victim.user("argocd"), attacker.user("argocd"));
        assert_eq!(victim.binding, attacker.binding);
        ArgoSessions::new(store.clone())
            .remember(&victim, "argocd", &token_login())
            .await
            .unwrap();

        let sessions = ArgoSessions::new(store.clone());
        assert_eq!(sessions.saved(&attacker, "argocd").await, None);
        assert!(!sessions.has_saved(&attacker, "argocd").await);
        assert_eq!(
            sessions.saved(&victim, "argocd").await,
            Some(token_login()),
            "the entry it was saved through still gets it"
        );
        assert_eq!(
            value_of(&saved, &victim.user("argocd")),
            Some(bound_through("victim")),
            "looking for the attacker's login deletes nothing of the victim's"
        );
    }

    #[tokio::test]
    async fn a_cluster_claiming_another_ones_uid_behind_one_proxy_gets_none_of_its_logins() {
        // The attacker's token reaches a cluster that answers with the victim's kube-system UID.
        let url = proxy_api(HashMap::from([("token-v", UID_A), ("token-x", UID_A)])).await;
        let dirs = tempfile::tempdir().unwrap();
        let kubeconfig = dirs.path().join("kubeconfig");
        let text = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: proxy\n  cluster:\n    server: {url}\ncontexts:\n\
             - name: v\n  context:\n    cluster: proxy\n    user: v\n- name: x\n  context:\n    cluster: proxy\n    \
             user: x\nusers:\n- name: v\n  user:\n    token: token-v\n- name: x\n  user:\n    token: token-x\n\
             current-context: v\n"
        );
        std::fs::write(&kubeconfig, text).unwrap();
        let state = AppState::new(&dirs.path().join("config"), &dirs.path().join("data"));
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let (store, saved) = mock_store();
        state.argocd.set_store(store);
        let clusters = state.registry.read().unwrap().clusters().unwrap();
        let id = |context: &str| {
            clusters
                .iter()
                .find(|c| c.context == context)
                .unwrap()
                .id
                .clone()
        };
        let (victim, attacker) = (id("v"), id("x"));
        for cluster in [&victim, &attacker] {
            state.clusters.connect(cluster).await.unwrap();
            state
                .argocd
                .status(&state.clusters, cluster, None)
                .await
                .unwrap();
        }
        let victim_keys = {
            let conn = state.argocd.conn(&victim);
            let mut conn = conn.lock().await;
            let keys = login_keys(&mut conn, &state.clusters, &victim)
                .await
                .unwrap();
            let refused = state
                .argocd
                .remember(&keys, "argocd", &password("victims-login"))
                .await
                .unwrap();
            assert_eq!(refused, None);
            keys
        };

        let conn = state.argocd.conn(&attacker);
        let mut conn = conn.lock().await;
        let attacker_keys = login_keys(&mut conn, &state.clusters, &attacker)
            .await
            .unwrap();
        let candidates = state
            .argocd
            .candidates(&mut conn, &state.clusters, &attacker, "argocd")
            .await
            .unwrap();
        drop(conn);
        let attacker_status = state
            .argocd
            .status(&state.clusters, &attacker, None)
            .await
            .unwrap();
        let victim_status = state
            .argocd
            .status(&state.clusters, &victim, None)
            .await
            .unwrap();

        assert_eq!(victim_keys.user("argocd"), attacker_keys.user("argocd"));
        assert_eq!(victim_keys.binding, attacker_keys.binding);
        assert!(candidates.is_empty(), "{:?}", secrets_of(&candidates));
        assert!(!attacker_status.saved);
        assert!(victim_status.saved, "the victim's entry still gets it");
        let value = value_of(&saved, &victim_keys.user("argocd")).unwrap();
        assert_eq!(value["binding"]["entry"], victim.0.as_str());
        state.close_all();
    }

    /// A Kubernetes API in front of several clusters, as a proxy is (Teleport, `kubectl proxy`): `/api` for the
    /// connection check, the `kube-system` Namespace with the UID the bearer token maps to in `uids` — 403 for any
    /// other token — and an `argocd-server` Service in `argocd`; everything else is 404. Plain HTTP on 127.0.0.1;
    /// returns its URL.
    async fn proxy_api(uids: HashMap<&'static str, &'static str>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut conn, _)) = listener.accept().await {
                let uids = uids.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match conn.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head).into_owned();
                    let path = head
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .split('?')
                        .next()
                        .unwrap_or_default();
                    let token = head
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
                        .and_then(|(_, value)| value.trim().strip_prefix("Bearer "))
                        .unwrap_or_default();
                    let (status, body) = match path {
                        "/api" => (
                            200,
                            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#
                                .to_string(),
                        ),
                        "/api/v1/namespaces/argocd/services" => (
                            200,
                            serde_json::json!({ "apiVersion": "v1", "kind": "ServiceList", "metadata": {},
                                "items": [{
                                    "metadata": { "name": "argocd-server", "namespace": "argocd" },
                                    "spec": { "ports": [{ "name": "https", "port": 443 }] }
                                }] })
                            .to_string(),
                        ),
                        "/api/v1/namespaces/kube-system" => match uids.get(token) {
                            Some(uid) => (
                                200,
                                serde_json::json!({ "apiVersion": "v1", "kind": "Namespace",
                                    "metadata": { "name": "kube-system", "uid": uid } })
                                .to_string(),
                            ),
                            None => (
                                403,
                                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#
                                    .to_string(),
                            ),
                        },
                        _ => (
                            404,
                            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#
                                .to_string(),
                        ),
                    };
                    let answer = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                         Connection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = conn.write_all(answer.as_bytes()).await;
                });
            }
        });
        url
    }

    const UID_A: &str = "aaaaaaaa-0000-4000-8000-00000000000a";
    const UID_B: &str = "bbbbbbbb-0000-4000-8000-00000000000b";

    /// A kubeconfig whose only context `context` reaches `server` with `token`.
    fn single_context(context: &str, server: &str, token: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: {server}\ncontexts:\n\
             - name: {context}\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    \
             token: {token}\ncurrent-context: {context}\n"
        )
    }

    fn secrets_of(candidates: &[Candidate]) -> Vec<String> {
        candidates
            .iter()
            .map(|c| match &c.credentials {
                Credentials::Password { password, .. } => password.expose().to_string(),
                Credentials::Token { token } => token.expose().to_string(),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_reconnect_to_another_cluster_drops_the_typed_and_saved_logins_of_the_old_one() {
        let url = proxy_api(HashMap::from([("token-a", UID_A), ("token-b", UID_B)])).await;
        let dirs = tempfile::tempdir().unwrap();
        let kubeconfig = dirs.path().join("kubeconfig");
        std::fs::write(&kubeconfig, single_context("x", &url, "token-a")).unwrap();
        let state = AppState::new(&dirs.path().join("config"), &dirs.path().join("data"));
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.clone().into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let (store, _saved) = mock_store();
        state.argocd.set_store(store);
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state.clusters.connect(&id).await.unwrap();

        state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let for_a = {
            // Signed in on A as the window does it (typed, and remembered), without an Argo CD to accept it.
            let conn = state.argocd.conn(&id);
            let mut conn = conn.lock().await;
            conn.typed = Some(password("typed-for-a"));
            let keys = login_keys(&mut conn, &state.clusters, &id).await.unwrap();
            state
                .argocd
                .remember(&keys, "argocd", &password("saved-for-a"))
                .await
                .unwrap();
            state
                .argocd
                .candidates(&mut conn, &state.clusters, &id, "argocd")
                .await
                .unwrap()
        };

        // The entry now reaches cluster B (same context name, same file: the same cluster id).
        std::fs::write(&kubeconfig, single_context("x", &url, "token-b")).unwrap();
        state.clusters.connect(&id).await.unwrap();
        let on_b = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let conn = state.argocd.conn(&id);
        let mut conn = conn.lock().await;
        let for_b = state
            .argocd
            .candidates(&mut conn, &state.clusters, &id, "argocd")
            .await
            .unwrap();
        let keys_b = conn.keys.clone().unwrap();
        // A reconnect in the middle of a call: what the call gathered goes nowhere.
        state.clusters.connect(&id).await.unwrap();
        let midway = same_connection(&conn, &state.clusters, &id).unwrap_err();

        assert_eq!(secrets_of(&for_a), ["typed-for-a", "saved-for-a"]);
        assert!(for_b.is_empty(), "{:?}", secrets_of(&for_b));
        assert!(!on_b.saved && !on_b.signed_in);
        assert_eq!(keys_b.owner, LoginOwner::Cluster(UID_B.into()));
        assert_eq!(midway.code, ErrorCode::Unreachable);
        state.close_all();
    }

    #[tokio::test]
    async fn an_entry_edited_since_connecting_gets_nothing_offered_and_nothing_saved() {
        // kube-system is forbidden for this token: the fallback key, by the kubeconfig entry.
        let url = proxy_api(HashMap::from([("token-a", UID_A)])).await;
        let dirs = tempfile::tempdir().unwrap();
        let kubeconfig = dirs.path().join("kubeconfig");
        std::fs::write(&kubeconfig, single_context("x", &url, "token-z")).unwrap();
        let state = AppState::new(&dirs.path().join("config"), &dirs.path().join("data"));
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.clone().into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let (store, saved) = mock_store();
        state.argocd.set_store(store);
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state.clusters.connect(&id).await.unwrap();
        let conn = state.argocd.conn(&id);
        let mut conn = conn.lock().await;
        let keys = login_keys(&mut conn, &state.clusters, &id).await.unwrap();
        assert_eq!(keys.owner, LoginOwner::Entry(id.clone()));
        assert_eq!(keys.binding, Some(binding_of(&url, None)));
        let saved_before = state
            .argocd
            .remember(&keys, "argocd", &password("for-x"))
            .await
            .unwrap();
        assert_eq!(saved_before, None);
        let value = value_of(&saved, &keys.user("argocd"));

        // The entry now names another server (with another cluster's CA), not reconnected: the connection still
        // reaches the first cluster, but nothing is offered or saved until it reconnects.
        let ca = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            "-----BEGIN CERTIFICATE-----\nY2EtZGVy\n-----END CERTIFICATE-----\n",
        );
        let edits = [
            single_context("x", "https://10.9.9.9:6443", "token-z"),
            single_context("x", &url, "token-z").replace(
                &format!("server: {url}"),
                &format!("server: {url}\n    certificate-authority-data: {ca}"),
            ),
        ];
        for edit in edits {
            std::fs::write(&kubeconfig, edit).unwrap();
            let keys = login_keys(&mut conn, &state.clusters, &id).await.unwrap();
            let candidates = state
                .argocd
                .candidates(&mut conn, &state.clusters, &id, "argocd")
                .await
                .unwrap();
            let refused = state
                .argocd
                .remember(&keys, "argocd", &password("for-y"))
                .await
                .unwrap();

            assert_eq!(keys.binding, None);
            assert!(
                secrets_of(&candidates).is_empty(),
                "{:?}",
                secrets_of(&candidates)
            );
            assert!(!state.argocd.has_saved(&keys, "argocd").await);
            assert_eq!(refused.as_deref(), Some(UNBOUND_SAVE));
            assert_eq!(value_of(&saved, &keys.user("argocd")), value);
        }
        drop(conn);
        state.close_all();
    }

    #[tokio::test]
    async fn two_kubeconfig_entries_behind_one_url_never_share_a_saved_login() {
        let url = proxy_api(HashMap::from([("token-a", UID_A), ("token-b", UID_B)])).await;
        let dirs = tempfile::tempdir().unwrap();
        let kubeconfig = dirs.path().join("kubeconfig");
        let mut text = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: proxy\n  cluster:\n    server: {url}\ncontexts:\n"
        );
        for name in ["a", "b", "c"] {
            text.push_str(&format!(
                "- name: {name}\n  context:\n    cluster: proxy\n    user: {name}\n"
            ));
        }
        text.push_str("users:\n");
        for name in ["a", "b", "c"] {
            text.push_str(&format!(
                "- name: {name}\n  user:\n    token: token-{name}\n"
            ));
        }
        text.push_str("current-context: a\n");
        std::fs::write(&kubeconfig, text).unwrap();
        let state = AppState::new(&dirs.path().join("config"), &dirs.path().join("data"));
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let clusters = state.registry.read().unwrap().clusters().unwrap();
        let id = |context: &str| {
            clusters
                .iter()
                .find(|c| c.context == context)
                .unwrap()
                .id
                .clone()
        };
        let (a, b, c) = (id("a"), id("b"), id("c"));
        let mut keys = Vec::new();
        for cluster in [&a, &b, &c] {
            state.clusters.connect(cluster).await.unwrap();
            let mut conn = ArgoConn::default();
            keys.push(
                login_keys(&mut conn, &state.clusters, cluster)
                    .await
                    .unwrap(),
            );
        }
        let (store, saved) = mock_store();
        let sessions = ArgoSessions::new(store.clone());

        sessions
            .remember(&keys[0], "argocd", &password("a-only"))
            .await
            .unwrap();
        let b_finds = sessions.saved(&keys[1], "argocd").await;
        let c_finds = sessions.saved(&keys[2], "argocd").await;
        let b_next_run = ArgoSessions::new(store).saved(&keys[1], "argocd").await;

        assert_eq!(
            keys[0].owner,
            LoginOwner::Cluster("aaaaaaaa-0000-4000-8000-00000000000a".into())
        );
        assert_eq!(
            keys[1].owner,
            LoginOwner::Cluster("bbbbbbbb-0000-4000-8000-00000000000b".into())
        );
        assert_eq!(
            keys[2].owner,
            LoginOwner::Entry(c.clone()),
            "kube-system is forbidden: keyed by the kubeconfig entry"
        );
        let users: HashSet<String> = keys.iter().map(|k| k.user("argocd")).collect();
        assert_eq!(users.len(), 3, "{users:?}");
        assert!(users.iter().all(|user| !user.contains(&url)));
        assert_eq!(b_finds, None, "A's login is not among B's candidates");
        assert_eq!(c_finds, None);
        assert_eq!(b_next_run, None);
        assert_eq!(
            stored(&saved),
            ["sextant/argocd:argocd@aaaaaaaa-0000-4000-8000-00000000000a"],
            "looking for B's login deletes nothing of A's"
        );
        state.close_all();
    }

    #[test]
    fn the_sign_in_window_is_told_which_current_logins_were_refused() {
        let kinds = vec![
            ("typed".to_string(), RefusedLogin::Typed),
            ("saved:x".to_string(), RefusedLogin::Saved),
            (
                "secret:argocd/argocd-initial-admin-secret@8".to_string(),
                RefusedLogin::AdminSecret,
            ),
            ("secret:argocd/ci@1".to_string(), RefusedLogin::TokenSecret),
            ("secret:argocd/ci2@1".to_string(), RefusedLogin::TokenSecret),
        ];
        let refused: HashSet<String> = [
            "saved:x",
            "secret:argocd/ci@1",
            "secret:argocd/ci2@1",
            // An older version of the admin secret: not a current candidate.
            "secret:argocd/argocd-initial-admin-secret@7",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();

        assert_eq!(
            refused_of(&kinds, &refused),
            [RefusedLogin::Saved, RefusedLogin::TokenSecret]
        );
    }

    #[tokio::test]
    async fn a_login_that_could_not_be_saved_gives_one_plain_reason() {
        let (store, saved) = mock_store();
        let sessions = ArgoSessions::new(store);
        let keys = by_uid(UID, "c1");

        let ok = sessions
            .remember(&keys, "argocd", &token_login())
            .await
            .unwrap();
        assert_eq!(ok, None);
        assert_eq!(lock(&saved).len(), 1);

        sessions.set_store(Arc::new(LockedStore));
        let reason = sessions
            .remember(&keys, "argocd", &token_login())
            .await
            .unwrap();
        assert_eq!(
            reason.as_deref(),
            Some("the system credential store: no secret service is running")
        );
    }

    #[test]
    fn a_login_the_store_refused_is_not_called_saved() {
        assert_eq!(login_source(true, None), CredentialSource::Saved);
        assert_eq!(login_source(false, None), CredentialSource::Manual);
        assert_eq!(
            login_source(true, Some("no secret service is running")),
            CredentialSource::Manual
        );
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
            refused_as: RefusedLogin::Saved,
            credentials: password(value),
        }
    }

    /// Signs in through a fake Argo CD that accepts only `good` and counts the attempts per password.
    async fn sign_in_counting(
        candidates: Vec<Candidate>,
        refused: &mut HashSet<String>,
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
        let mut refused = HashSet::new();
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

        let first = sign_in_counting(stale(), &mut refused, &tried)
            .await
            .unwrap();
        let again = sign_in_counting(stale(), &mut refused, &tried)
            .await
            .unwrap();
        assert_eq!(first, CredentialSource::Secret);
        assert_eq!(again, CredentialSource::Secret);
        assert_eq!(
            *lock(&tried),
            ["old-saved", "old-initial", "good", "good"],
            "refused candidates are tried once"
        );

        // Only refused candidates left: unauthorized at once, nothing sent to Argo CD.
        lock(&tried).clear();
        let err = sign_in_counting(stale()[..2].to_vec(), &mut refused, &tried)
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
            sign_in_counting(changed, &mut refused, &tried)
                .await
                .unwrap(),
            CredentialSource::Secret
        );
        assert_eq!(*lock(&tried), ["good"]);

        // A failure that is not a refusal (Argo CD unreachable) is not remembered.
        let mut unreachable = HashSet::new();
        let down =
            |_: Credentials| async { Err::<(), _>(CoreError::new(ErrorCode::Unreachable, "down")) };
        let err = first_accepted(stale(), &mut unreachable, down)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);
        assert!(unreachable.is_empty());
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

        let before = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let diff = state
            .argocd
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap();
        let after = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();

        assert!(!before.signed_in);
        assert!(!after.insecure, "the test installation runs with TLS");
        assert!(after.refused.is_empty());
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
    async fn an_unreadable_certificate_authority_after_connecting_offers_and_saves_nothing() {
        let dirs = tempfile::tempdir().unwrap();
        let Some(original) = std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return;
        };
        // A copy of the test cluster's kubeconfig, edited after connecting.
        let copy = dirs.path().join("kubeconfig");
        std::fs::copy(&original, &copy).unwrap();
        let (store, saved) = mock_store();
        let Some((state, _)) = gitops_state(dirs.path(), Arc::clone(&store)).await else {
            return;
        };
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(copy.clone().into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state.clusters.connect(&id).await.unwrap();
        let password = initial_password(&state, &id).await;
        let login = || ArgoLogin {
            username: Some("admin".into()),
            password: Some(SecretString::new(password.clone())),
            token: None,
            remember: true,
        };
        let first = state
            .argocd
            .login(&state.clusters, &id, None, login())
            .await
            .unwrap();
        assert!(first.saved);
        assert_eq!(first.save_error, None);
        let before = stored(&saved);
        let value = lock(&saved).clone();

        let text = std::fs::read_to_string(&copy).unwrap();
        let missing = dirs.path().join("missing-ca.crt");
        let edited: String = text
            .lines()
            .map(
                |line| match line.split_once("certificate-authority-data:") {
                    Some((indent, _)) => {
                        format!("{indent}certificate-authority: {}", missing.display())
                    }
                    None => line.to_owned(),
                },
            )
            .collect::<Vec<_>>()
            .join("\n");
        assert_ne!(
            edited, text,
            "the test cluster's kubeconfig names its CA inline"
        );
        std::fs::write(&copy, edited).unwrap();

        let status = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let again = state
            .argocd
            .login(&state.clusters, &id, None, login())
            .await
            .unwrap();

        assert!(!status.saved, "nothing is offered");
        assert!(again.signed_in, "signing in itself works");
        assert!(!again.saved);
        assert_eq!(again.save_error.as_deref(), Some(UNBOUND_SAVE));
        assert_eq!(again.source, Some(CredentialSource::Manual));
        assert_eq!(stored(&saved), before);
        assert_eq!(*lock(&saved), value, "the saved login was not rewritten");
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
        let uid = argocd::cluster_uid(&state.clusters, &id)
            .await
            .unwrap()
            .expect("the admin of the test cluster reads kube-system");
        let key = format!("sextant/argocd:argocd@{uid}");

        let status = state
            .argocd
            .login(
                &state.clusters,
                &id,
                None,
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
        assert!(status.saved);
        assert_eq!(status.save_error, None);
        assert_eq!(stored["username"], "admin");
        assert_eq!(stored["password"], password.as_str());
        assert_eq!(stored["binding"]["entry"], id.0.as_str());
        assert!(!serde_json::to_string(&status).unwrap().contains(&password));

        // A new run of the application signs in with the saved login before the standard secrets.
        let next = tempfile::tempdir().unwrap();
        let (again, again_id) = gitops_state(next.path(), Arc::clone(&store)).await.unwrap();
        again
            .argocd
            .diff(&again.clusters, &again_id, None, &guestbook())
            .await
            .unwrap();
        let next_status = again
            .argocd
            .status(&again.clusters, &again_id, None)
            .await
            .unwrap();
        assert_eq!(next_status.source, Some(CredentialSource::Saved));

        let out = state
            .argocd
            .logout(&state.clusters, &id, None, true)
            .await
            .unwrap();
        assert!(!out.signed_in);
        assert!(!out.saved);
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
                None,
                login(Some("admin"), Some("not-the-password-42"), None),
            )
            .await
            .unwrap_err();
        let bad_token = state
            .argocd
            .login(
                &state.clusters,
                &id,
                None,
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
                sextant_core::portforward::PodFilter::Any,
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
            .login(&state.clusters, &id, None, by_token)
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
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap();

        state
            .argocd
            .logout(&state.clusters, &id, None, false)
            .await
            .unwrap();
        let err = state
            .argocd
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap_err();
        let status = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();

        assert_eq!(err.code, ErrorCode::Unauthorized);
        assert!(!status.signed_in);
        state.close_all();
    }

    #[tokio::test]
    async fn a_refused_saved_login_is_named_and_tried_again_after_signing_out() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, _saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), Arc::clone(&store)).await else {
            return;
        };
        let uid = argocd::cluster_uid(&state.clusters, &id)
            .await
            .unwrap()
            .unwrap();
        let server = argocd::server_binding(&state.clusters, &id)
            .unwrap()
            .unwrap();
        let login = SavedLogin {
            credentials: password("not-the-admin-password-42"),
            binding: LoginBinding {
                server: server.server,
                ca_sha256: server.ca_sha256,
                entry: id.clone(),
            },
        };
        store
            .save(
                &keyring_user(&LoginOwner::Cluster(uid), "argocd"),
                &login.to_value().unwrap(),
            )
            .unwrap();

        state
            .argocd
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap();
        let signed = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let out = state
            .argocd
            .logout(&state.clusters, &id, None, false)
            .await
            .unwrap();

        assert_eq!(signed.source, Some(CredentialSource::Secret));
        assert_eq!(signed.refused, [RefusedLogin::Saved]);
        assert!(
            out.refused.is_empty(),
            "signing out forgets what Argo CD refused"
        );
        assert!(
            !serde_json::to_string(&signed)
                .unwrap()
                .contains("not-the-admin-password-42")
        );
        state.close_all();
    }

    #[tokio::test]
    async fn a_chosen_namespace_that_is_not_a_candidate_changes_nothing() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, _saved) = mock_store();
        let Some((state, id)) = gitops_state(dirs.path(), store).await else {
            return;
        };
        state
            .argocd
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap();

        let elsewhere = state
            .argocd
            .status(&state.clusters, &id, Some("kube-system"))
            .await
            .unwrap();
        let same = state
            .argocd
            .status(&state.clusters, &id, Some("argocd"))
            .await
            .unwrap();

        assert_eq!(elsewhere.namespace, "argocd");
        assert!(
            elsewhere.signed_in && same.signed_in,
            "the same server keeps its session"
        );
        assert_eq!(state.argocd.forwards(), 1);
        state.close_all();
    }

    #[tokio::test]
    async fn a_reconnect_to_another_cluster_does_not_reuse_the_session_or_the_logins() {
        let dirs = tempfile::tempdir().unwrap();
        let (store, saved) = mock_store();
        let Some(source) = std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return;
        };
        let Some((probe, _)) = gitops_state(&dirs.path().join("probe"), Arc::clone(&store)).await
        else {
            return;
        };
        probe.close_all();
        // Entry X: a copy of the kind kubeconfig, later pointed at another cluster under the same context name.
        let kubeconfig = dirs.path().join("kubeconfig");
        std::fs::copy(&source, &kubeconfig).unwrap();
        let state = AppState::new(&dirs.path().join("config"), &dirs.path().join("data"));
        state.argocd.set_store(store);
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.clone().into_os_string()),
            home: Some(dirs.path().join("home")),
        });
        let entry = state.registry.read().unwrap().clusters().unwrap()[0].clone();
        let id = entry.id.clone();
        state.clusters.connect(&id).await.unwrap();
        let password_a = initial_password(&state, &id).await;
        let on_a = state
            .argocd
            .login(
                &state.clusters,
                &id,
                None,
                ArgoLogin {
                    username: Some("admin".into()),
                    password: Some(SecretString::new(password_a.clone())),
                    token: None,
                    remember: true,
                },
            )
            .await
            .unwrap();
        assert!(on_a.signed_in && on_a.saved);
        assert_eq!(state.argocd.forwards(), 1);

        let url = proxy_api(HashMap::from([("token-b", UID_B)])).await;
        std::fs::write(&kubeconfig, single_context(&entry.context, &url, "token-b")).unwrap();
        state.clusters.connect(&id).await.unwrap();
        let on_b = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        let conn = state.argocd.conn(&id);
        let mut conn = conn.lock().await;
        let for_b = state
            .argocd
            .candidates(&mut conn, &state.clusters, &id, "argocd")
            .await
            .unwrap();

        assert!(!on_b.signed_in, "A's session is not reused on B");
        assert_eq!(on_b.source, None);
        assert!(!on_b.saved);
        assert!(
            !secrets_of(&for_b).contains(&password_a),
            "neither A's typed nor A's saved login is tried on B"
        );
        assert!(for_b.is_empty());
        assert_eq!(
            state.argocd.forwards(),
            0,
            "the forward to A's server is closed"
        );
        assert_eq!(lock(&saved).len(), 1, "A's saved login stays A's");
        drop(conn);
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
            .diff(&state.clusters, &id, None, &guestbook())
            .await
            .unwrap();
        assert_eq!(state.argocd.forwards(), 1);

        state.close_cluster(&id);

        assert_eq!(state.argocd.forwards(), 0);
        let status = state
            .argocd
            .status(&state.clusters, &id, None)
            .await
            .unwrap();
        assert!(!status.signed_in, "the session ends with the cluster");
        state.close_all();
    }
}
