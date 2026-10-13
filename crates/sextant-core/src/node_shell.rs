//! Shell on a node through a temporary privileged pod, as Lens does.
//!
//! [`create`] starts a pod `sextant-node-shell-<node>-<rand>` in `kube-system` on the node (`nodeName`, every taint
//! tolerated) with `hostPID`, `hostNetwork` and a privileged container whose first process enters the namespaces of
//! the node's PID 1 (`nsenter -t 1 -m -u -i -n -p`) and sleeps. An exec into that container joins the namespaces of
//! its first process, so [`crate::exec::exec_shell`] into [`CONTAINER`] is a shell on the node itself (its `bash`
//! if it has one, else `sh`).
//!
//! The pod is deleted by [`NodeShellPod::delete`] or, when the handle is dropped (the terminal closed, the cluster
//! disconnected, the application quit), by a deletion started on the runtime the pod was made on, with the client it
//! was made with — it does not need the cluster to be connected any more. A start can be called off with
//! [`StartCancel`] at any moment: the pod (if the API server already made it) is deleted. [`wait_for_deletions`] lets
//! the application wait, before it exits, until no node shell pod of this process is left: from the moment a start
//! sends its request until the pod's deletion is answered. As a safety net the pod ends by itself after [`MAX_AGE`]
//! (`activeDeadlineSeconds`), and [`sweep`] (run when a cluster connects, see
//! [`ClusterManager::sweep_node_shells_on_connect`]) deletes this user's pods of earlier runs and anyone's pods older
//! than [`MAX_AGE`].
//!
//! Every node shell pod carries `app.kubernetes.io/managed-by=sextant`, `sextant.dev/node-shell=true`,
//! `sextant.dev/session=<`[`session_id`]`>` (one value per run of the application) and
//! `sextant.dev/owner=<`[`owner_id`]`>` (a hash of the OS user and the machine).

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use k8s_openapi::api::core::v1::{Event, Pod};
use k8s_openapi::jiff::Timestamp;
use kube::Api;
use kube::api::{DeleteParams, ListParams, PostParams};
use serde_json::json;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;
use crate::resources::{KindRef, ObjectRef};

/// Where node shell pods run.
pub const NAMESPACE: &str = "kube-system";
/// The pod's only container; the shell is opened in it.
pub const CONTAINER: &str = "shell";
/// Image used when the setting is empty (`AppSettings.node_shell_image`).
pub const DEFAULT_IMAGE: &str = "busybox:stable";
/// How long the pod may take to become `Running`.
pub const START_TIMEOUT: Duration = Duration::from_secs(60);
/// The pod's `activeDeadlineSeconds`; older node shell pods are removed by [`sweep`].
pub const MAX_AGE: Duration = Duration::from_secs(8 * 60 * 60);

pub const LABEL_MANAGED_BY: &str = "app.kubernetes.io/managed-by";
pub const LABEL_NODE_SHELL: &str = "sextant.dev/node-shell";
pub const LABEL_SESSION: &str = "sextant.dev/session";
pub const LABEL_OWNER: &str = "sextant.dev/owner";

const NAME_PREFIX: &str = "sextant-node-shell-";
/// Pod names are kept within a DNS label (63), so the node's name is cut to fit.
const MAX_NODE_PART: usize = 63 - NAME_PREFIX.len() - 6;
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// A deletion request may take this long.
const DELETE_TIMEOUT: Duration = Duration::from_secs(10);
/// Waiting reasons of a container that will not start without a change (a retry does not help).
const FATAL_WAITING: [&str; 7] = [
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "ErrImageNeverPull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
];

/// Identifies this run of the application in the `sextant.dev/session` label: pods with another value are left from
/// an earlier run and are removed by [`sweep`].
pub fn session_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| random_text(12))
}

/// Who runs this Sextant, in the `sextant.dev/owner` label: a short hash of the OS user and the machine's name, so
/// [`sweep`] never removes a colleague's live shell. The names themselves never reach the cluster.
pub fn owner_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let env = |names: &[&str]| {
            names
                .iter()
                .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
        };
        let user = env(&["USER", "USERNAME", "LOGNAME"]).unwrap_or_default();
        let host = env(&["HOSTNAME", "COMPUTERNAME"])
            .or_else(|| {
                ["/etc/hostname", "/proc/sys/kernel/hostname"]
                    .iter()
                    .find_map(|p| std::fs::read_to_string(p).ok())
            })
            .unwrap_or_default();
        let digest = Sha256::digest(format!("{}@{}", user.trim(), host.trim()).as_bytes());
        digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
    })
}

/// `len` random characters `[a-z0-9]` (not for secrets: names and labels only).
fn random_text(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_u64(COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            hasher.write_u128(now.as_nanos());
        }
        let mut value = hasher.finish();
        for _ in 0..8 {
            if out.len() == len {
                break;
            }
            out.push(ALPHABET[(value % ALPHABET.len() as u64) as usize] as char);
            value /= ALPHABET.len() as u64;
        }
    }
    out
}

/// `sextant-node-shell-<node>-<rand>`, within 63 characters.
fn pod_name(node: &str) -> String {
    let node: String = node
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(MAX_NODE_PART)
        .collect();
    let node = node.trim_matches('-');
    format!("{NAME_PREFIX}{node}-{}", random_text(5))
}

/// The pod of story 26.
fn pod_manifest(name: &str, node: &str, image: &str) -> CoreResult<Pod> {
    serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": NAMESPACE,
            "labels": {
                LABEL_MANAGED_BY: "sextant",
                LABEL_NODE_SHELL: "true",
                LABEL_SESSION: session_id(),
                LABEL_OWNER: owner_id(),
            },
        },
        "spec": {
            "nodeName": node,
            "hostPID": true,
            "hostNetwork": true,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": MAX_AGE.as_secs(),
            "terminationGracePeriodSeconds": 0,
            "automountServiceAccountToken": false,
            "enableServiceLinks": false,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": CONTAINER,
                "image": image,
                "imagePullPolicy": "IfNotPresent",
                // The first process moves into the node's namespaces; an exec joins them.
                "command": ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
                            "sleep", MAX_AGE.as_secs().to_string()],
                "securityContext": { "privileged": true },
            }],
        },
    }))
    .map_err(|e| CoreError::other(format!("cannot build the node shell pod: {e}")))
}

/// A running node shell pod. Dropping it deletes the pod (see the module docs); [`NodeShellPod::delete`] does it
/// and waits for the answer.
pub struct NodeShellPod {
    pod: ObjectRef,
    node: String,
    owner: Option<Owner>,
}

/// What a deletion needs once the cluster may be gone from the manager.
struct Owner {
    client: kube::Client,
    runtime: tokio::runtime::Handle,
    /// Counted by [`wait_for_deletions`] until the deletion is answered.
    tracked: Tracked,
}

impl std::fmt::Debug for NodeShellPod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeShellPod")
            .field("pod", &self.pod.name)
            .field("node", &self.node)
            .finish()
    }
}

impl NodeShellPod {
    /// The pod, for [`crate::exec::exec_shell`] (container [`CONTAINER`]).
    pub fn pod(&self) -> &ObjectRef {
        &self.pod
    }

    pub fn node(&self) -> &str {
        &self.node
    }

    /// Deletes the pod and waits for the API server's answer (a pod that is already gone is fine).
    pub async fn delete(mut self) -> CoreResult<()> {
        let Some(owner) = self.owner.take() else {
            return Ok(());
        };
        let result = delete_pod(&owner.client, &self.pod.name).await;
        drop(owner.tracked);
        result
    }
}

impl Drop for NodeShellPod {
    fn drop(&mut self) {
        let Some(Owner {
            client,
            runtime,
            tracked,
        }) = self.owner.take()
        else {
            return;
        };
        let name = std::mem::take(&mut self.pod.name);
        // A runtime that is shutting down drops the task at once, and with it `tracked`.
        runtime.spawn(async move {
            let _tracked = tracked;
            let _ = delete_pod(&client, &name).await;
        });
    }
}

/// Node shell pods of this process that exist or may exist: starting, running, or being deleted.
static PENDING: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

/// One of [`PENDING`], from the start's request until the pod's deletion is answered (or the start failed before the
/// pod was made).
struct Tracked;

impl Tracked {
    fn new() -> Self {
        *PENDING.0.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        Self
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        let mut count = PENDING.0.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        PENDING.1.notify_all();
    }
}

/// Blocks until no node shell pod of this process is left — every start finished or was called off, every
/// [`NodeShellPod`] dropped and its deletion answered — at most `timeout`; `true` when none is left. For the
/// application's exit (after it stopped every session and called off every start), so the process does not end
/// before its pods are deleted. Must not be called on a thread of the runtime the starts and deletions run on.
pub fn wait_for_deletions(timeout: Duration) -> bool {
    let count = PENDING.0.lock().unwrap_or_else(|e| e.into_inner());
    let (count, _) = PENDING
        .1
        .wait_timeout_while(count, timeout, |n| *n > 0)
        .unwrap_or_else(|e| e.into_inner());
    *count == 0
}

/// Calls off a node shell start ([`create_until`]). Cheap to clone; every clone calls off the same start.
#[derive(Clone, Default)]
pub struct StartCancel(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl StartCancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once [`StartCancel::cancel`] was called (at once if it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Whether `other` is a clone of this one (calls off the same start).
    pub fn same(&self, other: &StartCancel) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// The error of a start that was called off.
    pub fn error() -> CoreError {
        CoreError::other("the node shell was closed before it started")
    }
}

/// [`create_until`] that nobody calls off.
pub async fn create(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
    image: &str,
) -> CoreResult<NodeShellPod> {
    create_until(mgr, cluster, node, image, &StartCancel::new()).await
}

/// Starts a node shell pod on `node` of `cluster` with `image` (empty: [`DEFAULT_IMAGE`]) and waits until it runs, at
/// most [`START_TIMEOUT`]. A pod that does not start is deleted, and the error says why (from its events). When
/// `cancel` is called off, the pod is deleted (a request already sent is answered first, so a pod made meanwhile is
/// not missed) and the start fails with [`StartCancel::error`]. [`wait_for_deletions`] counts the start from before
/// its request.
///
/// Errors: no permission to create pods in `kube-system` — `forbidden`, "You need permission to create privileged pods
/// in kube-system"; Pod Security admission refuses privileged pods there — `forbidden` with the server's reason; the
/// image cannot be pulled or the container cannot start — `other` with the reason; not running in time — `timeout`.
pub async fn create_until(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
    image: &str,
    cancel: &StartCancel,
) -> CoreResult<NodeShellPod> {
    let tracked = Tracked::new();
    if cancel.is_cancelled() {
        return Err(StartCancel::error());
    }
    let node = node.trim();
    if node.is_empty() {
        return Err(CoreError::new(ErrorCode::Invalid, "no node given"));
    }
    let image = match image.trim() {
        "" => DEFAULT_IMAGE,
        image => image,
    };
    let client = mgr.client(cluster)?;
    let api: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let name = pod_name(node);
    let manifest = pod_manifest(&name, node, image)?;
    api.create(&PostParams::default(), &manifest)
        .await
        .map_err(create_error)?;
    // From here on, dropping the handle (the caller gave up) deletes the pod. The request above is not raced with
    // `cancel`: once sent, the pod may exist, and only its answer says so.
    let shell = NodeShellPod {
        pod: ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
            },
            namespace: Some(NAMESPACE.into()),
            name: name.clone(),
        },
        node: node.to_owned(),
        owner: Some(Owner {
            client: client.clone(),
            runtime: tokio::runtime::Handle::current(),
            tracked,
        }),
    };
    let started = tokio::select! {
        started = wait_running(&client, &name, node) => started,
        () = cancel.cancelled() => Err(StartCancel::error()),
    };
    match started {
        Ok(()) => Ok(shell),
        Err(err) => {
            let _ = shell.delete().await;
            Err(err)
        }
    }
}

fn create_error(err: kube::Error) -> CoreError {
    let kube::Error::Api(status) = &err else {
        return kube_error(err, None);
    };
    if status.code != 403 {
        return kube_error(err, None);
    }
    let message = status.message.clone();
    if message.contains("PodSecurity") {
        CoreError::new(
            ErrorCode::Forbidden,
            format!(
                "Pod Security admission does not allow privileged pods in {NAMESPACE}: {message}"
            ),
        )
    } else if message.contains("cannot create resource") || message.is_empty() {
        CoreError::new(
            ErrorCode::Forbidden,
            format!("You need permission to create privileged pods in {NAMESPACE}"),
        )
    } else {
        CoreError::new(
            ErrorCode::Forbidden,
            format!("The cluster refused to create the node shell pod in {NAMESPACE}: {message}"),
        )
    }
}

/// What the pod is doing while we wait.
enum Progress {
    Running,
    Pending(Option<String>),
    /// It will not start; the reason from its status.
    Failed(String),
}

fn progress(pod: &Pod) -> Progress {
    let Some(status) = &pod.status else {
        return Progress::Pending(None);
    };
    match status.phase.as_deref() {
        Some("Running") => return Progress::Running,
        Some(phase @ ("Failed" | "Succeeded")) => {
            let reason = status
                .message
                .clone()
                .or_else(|| status.reason.clone())
                .unwrap_or_else(|| format!("the pod is {phase}"));
            return Progress::Failed(reason);
        }
        _ => {}
    }
    let container = status
        .container_statuses
        .iter()
        .flatten()
        .find_map(|c| c.state.as_ref());
    if let Some(waiting) = container.and_then(|s| s.waiting.as_ref()) {
        let reason = waiting.reason.clone().unwrap_or_default();
        let text = match &waiting.message {
            Some(message) if !message.is_empty() => format!("{reason}: {message}"),
            _ => reason.clone(),
        };
        if FATAL_WAITING.contains(&reason.as_str()) {
            return Progress::Failed(text);
        }
        return Progress::Pending(Some(text).filter(|t| !t.is_empty()));
    }
    if let Some(terminated) = container.and_then(|s| s.terminated.as_ref()) {
        return Progress::Failed(
            terminated
                .message
                .clone()
                .or_else(|| terminated.reason.clone())
                .unwrap_or_else(|| {
                    format!("the container exited with code {}", terminated.exit_code)
                }),
        );
    }
    let unscheduled = status
        .conditions
        .iter()
        .flatten()
        .find(|c| c.type_ == "PodScheduled" && c.status == "False")
        .and_then(|c| c.message.clone());
    Progress::Pending(unscheduled)
}

async fn wait_running(client: &kube::Client, name: &str, node: &str) -> CoreResult<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    let mut last = None;
    loop {
        let pod = api.get_opt(name).await.map_err(|e| kube_error(e, None))?;
        let Some(pod) = pod else {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!("the node shell pod {name} disappeared before it started"),
            ));
        };
        match progress(&pod) {
            Progress::Running => return Ok(()),
            Progress::Failed(status_reason) => {
                let reason = event_reason(client, name).await.unwrap_or(status_reason);
                return Err(CoreError::new(
                    ErrorCode::Other,
                    format!("The node shell pod could not start on node {node}: {reason}"),
                ));
            }
            Progress::Pending(reason) => last = reason.or(last),
        }
        if tokio::time::Instant::now() >= deadline {
            let reason = event_reason(client, name)
                .await
                .or(last)
                .unwrap_or_else(|| "it is still pending".to_owned());
            return Err(CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "The node shell pod did not start on node {node} in {} seconds: {reason}",
                    START_TIMEOUT.as_secs()
                ),
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// The message of the pod's latest warning event, if any. Bare "Error: <Reason>" messages (`ImagePullBackOff`) are
/// used only when no warning says more (such as "Failed to pull image …: not found").
async fn event_reason(client: &kube::Client, name: &str) -> Option<String> {
    let api: Api<Event> = Api::namespaced(client.clone(), NAMESPACE);
    let selector = format!("involvedObject.kind=Pod,involvedObject.name={name}");
    let events = api
        .list(&ListParams::default().fields(&selector))
        .await
        .ok()?;
    let mut warnings: Vec<_> = events
        .items
        .into_iter()
        .filter(|e| e.type_.as_deref() == Some("Warning"))
        .filter_map(|e| {
            let at = e
                .last_timestamp
                .as_ref()
                .map(|t| t.0)
                .or_else(|| e.event_time.as_ref().map(|t| t.0))
                .or_else(|| e.metadata.creation_timestamp.as_ref().map(|t| t.0));
            Some((at, e.message?))
        })
        .collect();
    warnings.sort_by_key(|(at, _)| *at);
    let bare = |m: &str| {
        m.strip_prefix("Error: ")
            .is_some_and(|rest| !rest.contains(' '))
    };
    let telling = warnings.iter().rev().find(|(_, m)| !bare(m));
    telling
        .or_else(|| warnings.last())
        .map(|(_, message)| message.clone())
}

async fn delete_pod(client: &kube::Client, name: &str) -> CoreResult<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let params = DeleteParams {
        grace_period_seconds: Some(1),
        ..Default::default()
    };
    match tokio::time::timeout(DELETE_TIMEOUT, api.delete(name, &params)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(kube::Error::Api(status))) if status.code == 404 => Ok(()),
        Ok(Err(err)) => Err(kube_error(err, None)),
        Err(_) => Err(CoreError::new(
            ErrorCode::Timeout,
            format!("no answer to deleting pod {NAMESPACE}/{name}"),
        )),
    }
}

/// Deletes node shell pods left behind: this user's ([`owner_id`]) pods of another run of the application
/// ([`session_id`]), and anyone's pods older than [`MAX_AGE`] — a colleague's live shell stays. Returns how many were
/// deleted. Only pods in `kube-system` with both `app.kubernetes.io/managed-by=sextant` and
/// `sextant.dev/node-shell=true` are ever touched.
pub async fn sweep(client: kube::Client) -> CoreResult<usize> {
    let api: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let selector = format!("{LABEL_MANAGED_BY}=sextant,{LABEL_NODE_SHELL}=true");
    let pods = api
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(|e| kube_error(e, None))?;
    let now = Timestamp::now();
    let mut deleted = 0;
    for pod in pods.items {
        let Some(name) = pod.metadata.name.clone() else {
            continue;
        };
        let labels: BTreeMap<String, String> = pod.metadata.labels.clone().unwrap_or_default();
        let label = |key: &str| labels.get(key).map(String::as_str);
        let ours = label(LABEL_MANAGED_BY) == Some("sextant")
            && label(LABEL_NODE_SHELL) == Some("true")
            && pod.metadata.namespace.as_deref() == Some(NAMESPACE);
        if !ours {
            continue;
        }
        let my_other_run =
            label(LABEL_OWNER) == Some(owner_id()) && label(LABEL_SESSION) != Some(session_id());
        let too_old = pod
            .metadata
            .creation_timestamp
            .as_ref()
            .and_then(|t| now.duration_since(t.0).try_into().ok())
            .is_some_and(|age: Duration| age > MAX_AGE);
        if (my_other_run || too_old) && delete_pod(&client, &name).await.is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const PODS: &str = "/api/v1/namespaces/kube-system/pods";

    fn listed(pods: serde_json::Value) -> String {
        json!({ "kind": "PodList", "apiVersion": "v1", "metadata": {}, "items": pods }).to_string()
    }

    /// A listed pod: `managed` adds `app.kubernetes.io/managed-by=sextant`; `owner` `None` has no owner label.
    fn shell_pod(
        name: &str,
        managed: bool,
        owner: Option<&str>,
        session: &str,
        created: &str,
    ) -> serde_json::Value {
        let mut labels = json!({ LABEL_NODE_SHELL: "true", LABEL_SESSION: session });
        if managed {
            labels[LABEL_MANAGED_BY] = json!("sextant");
        }
        if let Some(owner) = owner {
            labels[LABEL_OWNER] = json!(owner);
        }
        json!({
            "metadata": {
                "name": name,
                "namespace": "kube-system",
                "creationTimestamp": created,
                "labels": labels,
            },
        })
    }

    #[tokio::test]
    async fn the_sweep_deletes_this_users_pods_of_other_runs_and_anyones_older_than_eight_hours() {
        let recent = Timestamp::now().to_string();
        let old = (Timestamp::now() - std::time::Duration::from_secs(9 * 3600)).to_string();
        let me = Some(owner_id());
        let colleague = Some("colleague0000");
        let items = json!([
            shell_pod("ours-recent", true, me, session_id(), &recent),
            shell_pod("ours-old", true, me, session_id(), &old),
            shell_pod("earlier-run", true, me, "another-session", &recent),
            // A colleague's live shell on the same cluster stays; a forgotten one goes after 8 hours.
            shell_pod("colleague-live", true, colleague, "their-session", &recent),
            shell_pod("colleague-old", true, colleague, "their-session", &old),
            shell_pod("no-owner-recent", true, None, "another-session", &recent),
            // Not Sextant's: only one of the two labels, even if old and of another run.
            shell_pod("lookalike", false, me, "another-session", &old),
        ]);
        let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", PODS) => Reply::json(200, listed(items.clone())),
            ("DELETE", _) => Reply::json(200, "{}"),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let deleted = sweep(mgr.client(&id).unwrap()).await.unwrap();

        let list = api
            .requests()
            .into_iter()
            .find(|r| r.method == "GET" && r.path == PODS)
            .expect("the pods were listed");
        assert!(
            list.query.contains(
                "labelSelector=app.kubernetes.io%2Fmanaged-by%3Dsextant%2Csextant.dev%2Fnode-shell%3Dtrue"
            ),
            "{}",
            list.query
        );
        let mut deletions: Vec<String> = api
            .requests()
            .into_iter()
            .filter(|r| r.method == "DELETE")
            .map(|r| r.path)
            .collect();
        deletions.sort();
        assert_eq!(
            deletions,
            [
                format!("{PODS}/colleague-old"),
                format!("{PODS}/earlier-run"),
                format!("{PODS}/ours-old"),
            ]
        );
        assert_eq!(deleted, 3);
    }

    #[test]
    fn the_owner_is_a_short_hash_fit_for_a_label() {
        let owner = owner_id();
        assert_eq!(owner.len(), 12, "{owner}");
        assert!(owner.chars().all(|c| c.is_ascii_hexdigit()), "{owner}");
        assert_eq!(owner, owner_id());
    }

    #[tokio::test]
    async fn pod_security_and_missing_rights_read_as_such() {
        let forbidden = |message: &str| {
            json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden", "code": 403,
                    "message": message })
            .to_string()
        };
        let rbac = forbidden(
            "pods is forbidden: User \"x\" cannot create resource \"pods\" in API group \"\" in the namespace \"kube-system\"",
        );
        let psa = forbidden(
            "pods \"p\" is forbidden: violates PodSecurity \"baseline:latest\": privileged (container \"shell\" must not set securityContext.privileged=true)",
        );
        for (answer, expected) in [
            (rbac, "You need permission to create privileged pods in kube-system".to_owned()),
            (
                psa,
                "Pod Security admission does not allow privileged pods in kube-system: pods \"p\" is forbidden: violates PodSecurity".to_owned(),
            ),
        ] {
            let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/api") => Reply::json(200, API_VERSIONS),
                ("POST", PODS) => Reply::json(403, answer.clone()),
                _ => Reply::not_found(),
            })
            .await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let err = create(&mgr, &id, "node-1", "").await.expect_err("refused");
            assert_eq!(err.code, ErrorCode::Forbidden);
            assert!(err.message.starts_with(&expected), "{}", err.message);
        }
    }

    #[test]
    fn pod_names_stay_within_a_dns_label() {
        let long = "ip-10-0-0-1.eu-west-1.compute.internal-with-a-very-long-suffix-indeed";
        let name = pod_name(long);
        assert!(name.len() <= 63, "{name}");
        assert!(
            name.starts_with("sextant-node-shell-ip-10-0-0-1-eu-west-1"),
            "{name}"
        );
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "{name}"
        );
        assert_ne!(pod_name("n"), pod_name("n"));
    }
}
