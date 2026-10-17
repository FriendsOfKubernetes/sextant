//! Debug containers, as `kubectl debug` makes them: a shell for pods without one (distroless images) or for pods that
//! crash before anyone can look inside.
//!
//! [`start`] does one of two things, by [`DebugSpec::copy`]:
//! - **ephemeral container** (`kubectl debug -it <pod> --image=<image> --target=<container>`): an ephemeral container is
//!   added to the pod through its `ephemeralcontainers` subresource (strategic merge patch, so the pod's earlier ones
//!   stay), sharing the process namespace of the target container when one is named. It runs the image's own command
//!   with `stdin`, `stdinOnce` and `tty`, and a terminal attaches to it ([`crate::exec::attach_terminal`]). When the
//!   terminal goes away it ends the shell (Ctrl+C, Ctrl+D, then its stdin closes). Ephemeral containers can never be
//!   removed from a pod: it stays in the pod's spec (stopped) until the pod is deleted.
//! - **a copy of the pod** (`kubectl debug <pod> -it --copy-to=… --image=<image> --share-processes`): a new pod
//!   `<pod>-debug-<rand>` in the same namespace with the original's spec (no node, no probes, no ephemeral containers,
//!   `shareProcessNamespace`), the debug container added, and optionally the target container's command replaced (a
//!   crash-looping container can be kept alive with `sleep`). Labels and owners are not copied, so no Service routes to
//!   the copy and no controller adopts it. The copy is deleted by [`DebugCopyPod::delete`] or when its handle is dropped
//!   (the terminal closed, the cluster disconnected, the application quit), on the runtime and with the client it was
//!   made with. [`wait_for_deletions`] lets the application wait for those deletions before it exits. As a safety net
//!   the copy ends by itself after [`MAX_AGE`], and a start in a namespace first deletes this user's copies left there
//!   by an earlier run ([`sweep`]).
//!
//! A start can be called off at any moment with a [`StartCancel`]; a copy already made is deleted then.
//!
//! Debug containers are the user's own tool: AI agents and extensions are never offered them.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::jiff::Timestamp;
use kube::Api;
use kube::api::{DeleteParams, ListParams, Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;
pub use crate::node_shell::StartCancel;
use crate::node_shell::{owner_id, session_id};
use crate::resources::{KindRef, ObjectRef};

/// Image used when none is given (`AppSettings.debug_image` empty).
pub const DEFAULT_IMAGE: &str = "busybox:stable";
/// Images offered in the debug dialog.
pub const PRESET_IMAGES: [&str; 2] = ["busybox:stable", "nicolaka/netshoot:latest"];
/// How long the debug container may take to run (an image such as netshoot takes a while to pull).
pub const START_TIMEOUT: Duration = Duration::from_secs(120);
/// A copy's `activeDeadlineSeconds`; [`sweep`] deletes this user's copies of earlier runs and anyone's older ones.
pub const MAX_AGE: Duration = Duration::from_secs(8 * 60 * 60);

pub const LABEL_MANAGED_BY: &str = "app.kubernetes.io/managed-by";
/// Marks a copy made for debugging; value `true`.
pub const LABEL_DEBUG_COPY: &str = "sextant.dev/debug-copy";
/// The run of the application that made the copy ([`session_id`]).
pub const LABEL_DEBUG_SESSION: &str = "sextant.dev/debug-session";
/// Who made the copy ([`owner_id`]): a hash of the OS user and the machine.
pub const LABEL_DEBUG_OWNER: &str = "sextant.dev/debug-owner";

/// Names of debug containers: `debugger-<rand>`, as `kubectl debug` names them.
const CONTAINER_PREFIX: &str = "debugger-";
const COPY_INFIX: &str = "-debug-";
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// The creation of a copy may take this long; after that it is deleted by name for [`LOST_POD_WINDOW`].
const CREATE_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(30)
};
/// How long, from sending the creation, a copy whose answer was lost may still appear.
const LOST_POD_WINDOW: Duration = if cfg!(test) {
    Duration::from_secs(3)
} else {
    Duration::from_secs(75)
};
const DELETE_TIMEOUT: Duration = Duration::from_secs(10);
const DELETE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(3);
const FIRST_PAUSE: Duration = Duration::from_millis(250);
/// Waiting reasons of a container that will not start without a change.
const FATAL_WAITING: [&str; 7] = [
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "ErrImageNeverPull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
];

/// Whether `object` (a pod as the API gives it) is a copy Sextant made for debugging: a pod with both
/// `app.kubernetes.io/managed-by=sextant` and `sextant.dev/debug-copy=true`. Agents never run commands there: the
/// user's debug session lives in it.
pub fn is_debug_copy_object(object: &Value) -> bool {
    let text = |pointer: &str| object.pointer(pointer).and_then(Value::as_str);
    let pod = text("/kind").is_none_or(|k| k.eq_ignore_ascii_case("Pod"))
        && text("/apiVersion").is_none_or(|v| !v.contains('/'));
    let label = |key: &str| {
        object
            .pointer("/metadata/labels")
            .and_then(Value::as_object)
            .and_then(|labels| labels.get(key))
            .and_then(Value::as_str)
    };
    pod && label(LABEL_MANAGED_BY) == Some("sextant") && label(LABEL_DEBUG_COPY) == Some("true")
}

/// What to debug and how (`debug_start`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DebugSpec {
    /// Image of the debug container; empty: [`DEFAULT_IMAGE`].
    #[serde(default)]
    pub image: String,
    /// The container whose processes the debug container sees (an ephemeral container's `targetContainerName`); for a
    /// copy, the container whose command [`DebugCopySpec::command`] replaces. `None`: none.
    #[serde(default)]
    pub target: Option<String>,
    /// Debug a copy of the pod instead of the pod itself.
    #[serde(default)]
    pub copy: Option<DebugCopySpec>,
}

/// How the copy differs from the pod.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DebugCopySpec {
    /// Replaces the command of the target container in the copy (its arguments are dropped); empty keeps both.
    #[serde(default)]
    pub command: Vec<String>,
}

/// A debug container that runs: attach a terminal to `container` of `pod`. `copy` is the copy of the pod (deleted
/// when dropped), `None` for an ephemeral container.
#[derive(Debug)]
pub struct DebugTarget {
    pub pod: ObjectRef,
    pub container: String,
    pub copy: Option<DebugCopyPod>,
}

/// Starts a debug container for `pod` of `cluster` as `spec` says and waits until it runs, at most [`START_TIMEOUT`].
/// When `cancel` is called off, the start fails with [`cancelled`] and a copy (if one was made) is deleted.
///
/// Errors: the pod or the target container does not exist — `notFound` / `invalid`; the cluster has no ephemeral
/// containers — `notFound`, "This cluster does not support ephemeral containers…"; no permission — `forbidden`, naming
/// the permission (`pods/ephemeralcontainers`, or creating pods for a copy); the image cannot be pulled or the container
/// does not start — `other` with the reason; not running in time — `timeout`.
pub async fn start(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    spec: &DebugSpec,
    cancel: &StartCancel,
) -> CoreResult<DebugTarget> {
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    let namespace = pod.required_namespace()?.to_owned();
    let image = match spec.image.trim() {
        "" => DEFAULT_IMAGE,
        image => image,
    };
    if image.chars().any(char::is_whitespace) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("not an image name: {image:?}"),
        ));
    }
    let target = spec
        .target
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let client = mgr.client(cluster)?;
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let original = until_cancelled(cancel, async {
        api.get_opt(&pod.name)
            .await
            .map_err(|e| kube_error(e, None))?
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("pod {namespace}/{} not found", pod.name),
                )
            })
    })
    .await?;
    let containers = container_names(&original);
    if let Some(target) = target
        && !containers.iter().any(|c| c == target)
    {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("pod {namespace}/{} has no container {target}", pod.name),
        ));
    }
    let container = unused_name(&containers);
    match &spec.copy {
        None => {
            let body = ephemeral_patch(&container, image, target);
            let params = PatchParams {
                field_manager: Some("sextant".into()),
                ..Default::default()
            };
            until_cancelled(cancel, async {
                api.patch_ephemeral_containers(&pod.name, &params, &Patch::Strategic(&body))
                    .await
                    .map_err(|e| ephemeral_error(e, &namespace))
            })
            .await?;
            until_cancelled(
                cancel,
                wait_running(&api, &pod.name, &container, Statuses::Ephemeral),
            )
            .await?;
            Ok(DebugTarget {
                pod: pod_ref(&namespace, &pod.name),
                container,
                copy: None,
            })
        }
        Some(copy) => {
            // Copies this user left here in an earlier run go first; a failure here does not stop the debugging.
            let _ = until_cancelled(cancel, sweep(client.clone(), &namespace)).await;
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            let name = copy_name(&pod.name);
            let manifest = copy_pod(&original, &name, &container, image, target, &copy.command)?;
            let made = create_copy(&client, &namespace, &name, &manifest).await?;
            let started = until_cancelled(
                cancel,
                wait_running(&api, &name, &container, Statuses::Regular),
            )
            .await;
            match started {
                Ok(()) => Ok(DebugTarget {
                    pod: pod_ref(&namespace, &name),
                    container,
                    copy: Some(made),
                }),
                Err(err) => {
                    let _ = made.delete().await;
                    Err(err)
                }
            }
        }
    }
}

/// The error of a start that was called off.
pub fn cancelled() -> CoreError {
    CoreError::other("the debug session was closed before it started")
}

/// Runs `work` unless `cancel` is called off first ([`cancelled`]).
async fn until_cancelled<T>(
    cancel: &StartCancel,
    work: impl Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(cancelled()),
    }
}

fn pod_ref(namespace: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespace: Some(namespace.to_owned()),
        name: name.to_owned(),
    }
}

/// Every container name of the pod: regular, init and ephemeral ones (a new one must differ from all).
fn container_names(pod: &Pod) -> Vec<String> {
    let Some(spec) = &pod.spec else {
        return Vec::new();
    };
    let regular = spec.containers.iter().map(|c| c.name.clone());
    let init = spec
        .init_containers
        .iter()
        .flatten()
        .map(|c| c.name.clone());
    let ephemeral = spec
        .ephemeral_containers
        .iter()
        .flatten()
        .map(|c| c.name.clone());
    regular.chain(init).chain(ephemeral).collect()
}

/// `debugger-<rand>` that no container of the pod has.
fn unused_name(taken: &[String]) -> String {
    loop {
        let name = format!("{CONTAINER_PREFIX}{}", random_text(5));
        if !taken.contains(&name) {
            return name;
        }
    }
}

/// `<pod>-debug-<rand>`, within a DNS label (63).
fn copy_name(pod: &str) -> String {
    let room = 63 - COPY_INFIX.len() - 5;
    let base: String = pod.chars().take(room).collect();
    let base = base.trim_end_matches(['-', '.']);
    format!("{base}{COPY_INFIX}{}", random_text(5))
}

/// `len` random characters `[a-z0-9]` (names only, not secrets).
fn random_text(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
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

/// The debug container: the image's own command with a terminal; its stdin closes when the first terminal detaches.
fn debug_container(name: &str, image: &str) -> Value {
    json!({
        "name": name,
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "stdin": true,
        "stdinOnce": true,
        "tty": true,
        "terminationMessagePolicy": "File",
    })
}

/// The strategic merge patch of the `ephemeralcontainers` subresource that adds the debug container `name` (the list
/// is merged by name, so the pod's earlier ephemeral containers stay).
pub fn ephemeral_patch(name: &str, image: &str, target: Option<&str>) -> Value {
    let mut container = debug_container(name, image);
    if let Some(target) = target {
        container["targetContainerName"] = json!(target);
    }
    json!({ "spec": { "ephemeralContainers": [container] } })
}

/// The copy of `original` named `name`, with the debug container `container` added (see the module docs).
pub fn copy_pod(
    original: &Pod,
    name: &str,
    container: &str,
    image: &str,
    target: Option<&str>,
    command: &[String],
) -> CoreResult<Pod> {
    let namespace = original.metadata.namespace.clone().unwrap_or_default();
    let mut spec = serde_json::to_value(original.spec.clone().unwrap_or_default())
        .map_err(|e| CoreError::other(format!("cannot copy the pod: {e}")))?;
    let Some(fields) = spec.as_object_mut() else {
        return Err(CoreError::other("cannot copy the pod: it has no spec"));
    };
    // The scheduler picks a node; ephemeral containers are not part of a new pod.
    fields.remove("nodeName");
    fields.remove("ephemeralContainers");
    fields.insert("shareProcessNamespace".into(), json!(true));
    let deadline = MAX_AGE.as_secs();
    let keeps_deadline = fields
        .get("activeDeadlineSeconds")
        .and_then(Value::as_u64)
        .is_some_and(|d| d <= deadline);
    if !keeps_deadline {
        fields.insert("activeDeadlineSeconds".into(), json!(deadline));
    }
    let command: Vec<&String> = command.iter().filter(|c| !c.is_empty()).collect();
    let mut replaced = false;
    for item in fields
        .get_mut("containers")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let Some(c) = item.as_object_mut() else {
            continue;
        };
        // A probe would restart or hide a container that is being looked at.
        for probe in ["livenessProbe", "readinessProbe", "startupProbe"] {
            c.remove(probe);
        }
        let is_target = target.is_some() && c.get("name").and_then(Value::as_str) == target;
        if is_target && !command.is_empty() {
            c.insert("command".into(), json!(command));
            c.remove("args");
            replaced = true;
        }
    }
    if !command.is_empty() && !replaced {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a changed command needs the container to run it in",
        ));
    }
    if let Some(containers) = fields.get_mut("containers").and_then(Value::as_array_mut) {
        containers.push(debug_container(container, image));
    }
    let annotations: BTreeMap<String, String> = original
        .metadata
        .annotations
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| k != "kubectl.kubernetes.io/last-applied-configuration")
        .collect();
    serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "annotations": annotations,
            "labels": {
                LABEL_MANAGED_BY: "sextant",
                LABEL_DEBUG_COPY: "true",
                LABEL_DEBUG_SESSION: session_id(),
                LABEL_DEBUG_OWNER: owner_id(),
            },
        },
        "spec": spec,
    }))
    .map_err(|e| CoreError::other(format!("cannot copy the pod: {e}")))
}

/// Which statuses of the pod hold the debug container's.
#[derive(Clone, Copy)]
enum Statuses {
    Ephemeral,
    Regular,
}

/// Waits until `container` of pod `name` runs; fails at once when it cannot start (see [`FATAL_WAITING`]).
async fn wait_running(
    api: &Api<Pod>,
    name: &str,
    container: &str,
    statuses: Statuses,
) -> CoreResult<()> {
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    let mut last: Option<String> = None;
    loop {
        let pod = api
            .get_opt(name)
            .await
            .map_err(|e| kube_error(e, None))?
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("pod {name} disappeared before the debug container started"),
                )
            })?;
        match progress(&pod, container, statuses) {
            Progress::Running => return Ok(()),
            Progress::Failed(reason) => {
                return Err(CoreError::new(
                    ErrorCode::Other,
                    format!("The debug container could not start: {reason}"),
                ));
            }
            Progress::Pending(reason) => last = reason.or(last),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "The debug container did not start in {} seconds: {}",
                    START_TIMEOUT.as_secs(),
                    last.unwrap_or_else(|| "it is still waiting".to_owned())
                ),
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

enum Progress {
    Running,
    Pending(Option<String>),
    Failed(String),
}

fn progress(pod: &Pod, container: &str, statuses: Statuses) -> Progress {
    let Some(status) = &pod.status else {
        return Progress::Pending(None);
    };
    if let Some(phase @ ("Failed" | "Succeeded")) = status.phase.as_deref() {
        let reason = status
            .message
            .clone()
            .or_else(|| status.reason.clone())
            .unwrap_or_else(|| format!("the pod is {phase}"));
        return Progress::Failed(reason);
    }
    let list = match statuses {
        Statuses::Ephemeral => status.ephemeral_container_statuses.as_ref(),
        Statuses::Regular => status.container_statuses.as_ref(),
    };
    let state = list
        .into_iter()
        .flatten()
        .find(|c| c.name == container)
        .and_then(|c| c.state.as_ref());
    let Some(state) = state else {
        let unscheduled = status
            .conditions
            .iter()
            .flatten()
            .find(|c| c.type_ == "PodScheduled" && c.status == "False")
            .and_then(|c| c.message.clone());
        return Progress::Pending(unscheduled);
    };
    if state.running.is_some() {
        return Progress::Running;
    }
    if let Some(waiting) = &state.waiting {
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
    if let Some(terminated) = &state.terminated {
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
    Progress::Pending(None)
}

/// A refused patch of the `ephemeralcontainers` subresource, in words that say what to do.
fn ephemeral_error(err: kube::Error, namespace: &str) -> CoreError {
    let kube::Error::Api(status) = &err else {
        return kube_error(err, None);
    };
    let message = status.message.clone();
    match status.code {
        404 | 405 if !message.contains("pods \"") => CoreError::new(
            ErrorCode::NotFound,
            "This cluster does not support ephemeral containers (Kubernetes 1.25 or newer is needed); debug a copy \
             of the pod instead",
        ),
        403 if message.contains("PodSecurity") => CoreError::new(
            ErrorCode::Forbidden,
            format!("Pod Security admission refused the debug container: {message}"),
        ),
        403 => CoreError::new(
            ErrorCode::Forbidden,
            format!(
                "You need permission to update pods/ephemeralcontainers in namespace {namespace} to add a debug \
                 container"
            ),
        ),
        400 | 422 => CoreError::new(
            ErrorCode::Invalid,
            format!("The cluster refused the debug container: {message}"),
        ),
        _ => kube_error(err, None),
    }
}

fn create_error(err: kube::Error, namespace: &str) -> CoreError {
    let kube::Error::Api(status) = &err else {
        return kube_error(err, None);
    };
    let message = status.message.clone();
    match status.code {
        403 if message.contains("PodSecurity") => CoreError::new(
            ErrorCode::Forbidden,
            format!("Pod Security admission refused the copy of the pod: {message}"),
        ),
        403 => CoreError::new(
            ErrorCode::Forbidden,
            format!("You need permission to create pods in namespace {namespace} to debug a copy"),
        ),
        _ => kube_error(err, None),
    }
}

/// A copy of a pod made for debugging. Dropping it deletes the copy; [`DebugCopyPod::delete`] does it and waits for
/// the answer.
pub struct DebugCopyPod {
    pod: ObjectRef,
    owner: Option<Owner>,
}

struct Owner {
    client: kube::Client,
    runtime: tokio::runtime::Handle,
    tracked: Tracked,
}

impl std::fmt::Debug for DebugCopyPod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DebugCopyPod")
            .field("namespace", &self.pod.namespace)
            .field("name", &self.pod.name)
            .finish()
    }
}

impl DebugCopyPod {
    pub fn pod(&self) -> &ObjectRef {
        &self.pod
    }

    /// Deletes the copy and waits for the API server's answer (a copy that is already gone is fine).
    pub async fn delete(mut self) -> CoreResult<()> {
        let Some(owner) = self.owner.take() else {
            return Ok(());
        };
        let namespace = self.pod.namespace.clone().unwrap_or_default();
        let result = delete_pod(&owner.client, &namespace, &self.pod.name).await;
        drop(owner.tracked);
        result
    }
}

impl Drop for DebugCopyPod {
    fn drop(&mut self) {
        let Some(Owner {
            client,
            runtime,
            tracked,
        }) = self.owner.take()
        else {
            return;
        };
        let namespace = self.pod.namespace.clone().unwrap_or_default();
        let name = std::mem::take(&mut self.pod.name);
        runtime.spawn(async move {
            let _tracked = tracked;
            let _ = delete_pod(&client, &namespace, &name).await;
        });
    }
}

/// Copies of this process that exist or may exist: from the creation's request until the deletion is answered.
static PENDING: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

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

/// How many copies of this process exist or may exist (being made, held, or being deleted).
pub fn pending_copies() -> usize {
    *PENDING.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Blocks until no copy of this process is left, at most `timeout`; `true` when none is left. For the application's
/// exit; must not be called on a thread of the runtime the deletions run on.
pub fn wait_for_deletions(timeout: Duration) -> bool {
    let count = PENDING.0.lock().unwrap_or_else(|e| e.into_inner());
    let (count, _) = PENDING
        .1
        .wait_timeout_while(count, timeout, |n| *n > 0)
        .unwrap_or_else(|e| e.into_inner());
    *count == 0
}

/// Creates the copy. When the answer is lost (a 5xx, a transport error, no answer in time), the copy may exist all the
/// same: the start fails, and in the background the copy is deleted by name for as long as it may still appear.
async fn create_copy(
    client: &kube::Client,
    namespace: &str,
    name: &str,
    manifest: &Pod,
) -> CoreResult<DebugCopyPod> {
    let tracked = Tracked::new();
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let sent = tokio::time::Instant::now();
    let created =
        tokio::time::timeout(CREATE_TIMEOUT, api.create(&PostParams::default(), manifest)).await;
    let lost = match created {
        Ok(Ok(_)) => None,
        Ok(Err(kube::Error::Api(status))) if status.code < 500 && status.code != 408 => {
            return Err(create_error(kube::Error::Api(status), namespace));
        }
        Ok(Err(err)) => Some(create_error(err, namespace)),
        Err(_) => Some(CoreError::new(
            ErrorCode::Timeout,
            format!(
                "no answer to creating the copy of the pod in {} seconds",
                CREATE_TIMEOUT.as_secs()
            ),
        )),
    };
    if let Some(err) = lost {
        let client = client.clone();
        let (namespace, name) = (namespace.to_owned(), name.to_owned());
        tokio::spawn(async move {
            let _tracked = tracked;
            remove_lost(&client, &namespace, &name, sent).await;
        });
        return Err(err);
    }
    Ok(DebugCopyPod {
        pod: pod_ref(namespace, name),
        owner: Some(Owner {
            client: client.clone(),
            runtime: tokio::runtime::Handle::current(),
            tracked,
        }),
    })
}

/// Deletes a copy whose creation was not answered, by name, until it was deleted or [`LOST_POD_WINDOW`] after `sent`
/// passed; what is left then goes with the next [`sweep`] of its namespace or its deadline.
async fn remove_lost(
    client: &kube::Client,
    namespace: &str,
    name: &str,
    sent: tokio::time::Instant,
) {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let deadline = sent + LOST_POD_WINDOW;
    let mut pause = FIRST_PAUSE;
    loop {
        let attempt = tokio::time::timeout(
            DELETE_ATTEMPT_TIMEOUT,
            api.delete(name, &DeleteParams::default()),
        )
        .await;
        if matches!(attempt, Ok(Ok(_))) {
            return;
        }
        if tokio::time::Instant::now() + pause > deadline {
            return;
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(Duration::from_secs(10));
    }
}

/// Deletes a pod; one that is already gone is fine. Busy answers, transport errors and hung attempts are repeated
/// within [`DELETE_TIMEOUT`] (the client never repeats a `DELETE` by itself).
async fn delete_pod(client: &kube::Client, namespace: &str, name: &str) -> CoreResult<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = DeleteParams {
        grace_period_seconds: Some(1),
        ..Default::default()
    };
    let deadline = tokio::time::Instant::now() + DELETE_TIMEOUT;
    let mut pause = FIRST_PAUSE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let err =
            match tokio::time::timeout(left.min(DELETE_ATTEMPT_TIMEOUT), api.delete(name, &params))
                .await
            {
                Ok(Ok(_)) => return Ok(()),
                Ok(Err(kube::Error::Api(status))) if status.code == 404 => return Ok(()),
                Ok(Err(kube::Error::Api(status))) if status.code != 429 && status.code < 500 => {
                    return Err(kube_error(kube::Error::Api(status), None));
                }
                Ok(Err(err)) => kube_error(err, None),
                Err(_) => CoreError::new(
                    ErrorCode::Timeout,
                    format!("no answer to deleting pod {namespace}/{name}"),
                ),
            };
        if tokio::time::Instant::now() + pause >= deadline {
            return Err(err);
        }
        tokio::time::sleep(pause).await;
        pause *= 2;
    }
}

/// Deletes debug copies left in `namespace`: this user's ([`owner_id`]) of another run ([`session_id`]) and anyone's
/// older than [`MAX_AGE`]. Only pods with both `app.kubernetes.io/managed-by=sextant` and `sextant.dev/debug-copy=true`
/// are touched. Returns how many were deleted.
pub async fn sweep(client: kube::Client, namespace: &str) -> CoreResult<usize> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let selector = format!("{LABEL_MANAGED_BY}=sextant,{LABEL_DEBUG_COPY}=true");
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
        let labels = pod.metadata.labels.clone().unwrap_or_default();
        let label = |key: &str| labels.get(key).map(String::as_str);
        if label(LABEL_MANAGED_BY) != Some("sextant") || label(LABEL_DEBUG_COPY) != Some("true") {
            continue;
        }
        let my_other_run = label(LABEL_DEBUG_OWNER) == Some(owner_id())
            && label(LABEL_DEBUG_SESSION) != Some(session_id());
        let too_old = pod
            .metadata
            .creation_timestamp
            .as_ref()
            .and_then(|t| now.duration_since(t.0).try_into().ok())
            .is_some_and(|age: Duration| age > MAX_AGE);
        if (my_other_run || too_old) && delete_pod(&client, namespace, &name).await.is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, connected_to};
    use std::sync::Arc;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const PODS: &str = "/api/v1/namespaces/team-a/pods";

    fn web_pod() -> Value {
        json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {
                "name": "web", "namespace": "team-a",
                "labels": { "app": "web" },
                "annotations": { "note": "kept", "kubectl.kubernetes.io/last-applied-configuration": "{}" },
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-1", "uid": "u" }],
            },
            "spec": {
                "nodeName": "node-1",
                "containers": [
                    { "name": "app", "image": "distroless/app", "args": ["--serve"],
                      "livenessProbe": { "httpGet": { "port": 80 } } },
                    { "name": "sidecar", "image": "proxy" },
                ],
                "ephemeralContainers": [{ "name": "debugger-old", "image": "busybox" }],
            },
            "status": { "phase": "Running" },
        })
    }

    fn running(statuses_key: &str, container: &str) -> Value {
        let mut pod = web_pod();
        pod["status"][statuses_key] = json!([{
            "name": container, "image": "busybox:stable", "imageID": "", "ready": false, "restartCount": 0,
            "state": { "running": { "startedAt": "2026-01-01T00:00:00Z" } },
        }]);
        pod
    }

    fn pod_spec() -> ObjectRef {
        pod_ref("team-a", "web")
    }

    #[test]
    fn the_ephemeral_patch_adds_one_container_with_a_terminal_sharing_the_target() {
        let body = ephemeral_patch("debugger-abcde", "busybox:stable", Some("app"));
        assert_eq!(
            body,
            json!({ "spec": { "ephemeralContainers": [{
                "name": "debugger-abcde",
                "image": "busybox:stable",
                "imagePullPolicy": "IfNotPresent",
                "stdin": true,
                "stdinOnce": true,
                "tty": true,
                "terminationMessagePolicy": "File",
                "targetContainerName": "app",
            }] } })
        );
        let untargeted = ephemeral_patch("debugger-x", "nicolaka/netshoot:latest", None);
        assert!(
            untargeted["spec"]["ephemeralContainers"][0]
                .get("targetContainerName")
                .is_none()
        );
    }

    #[tokio::test]
    async fn an_ephemeral_container_is_patched_into_the_pod_and_waited_for() {
        let patched: Arc<Mutex<Option<(String, String, Value)>>> = Arc::default();
        let seen = Arc::clone(&patched);
        let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("PATCH", path) if path == format!("{PODS}/web/ephemeralcontainers") => {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                *seen.lock().unwrap() = Some((
                    req.header("content-type").to_owned(),
                    req.query.clone(),
                    body,
                ));
                Reply::json(200, web_pod().to_string())
            }
            ("GET", path) if path == format!("{PODS}/web") => {
                let name = seen.lock().unwrap().as_ref().map(|(_, _, b)| {
                    b["spec"]["ephemeralContainers"][0]["name"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                });
                match name {
                    Some(name) => Reply::json(
                        200,
                        running("ephemeralContainerStatuses", &name).to_string(),
                    ),
                    None => Reply::json(200, web_pod().to_string()),
                }
            }
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = DebugSpec {
            image: " ".into(),
            target: Some("app".into()),
            copy: None,
        };

        let target = start(&mgr, &id, &pod_spec(), &spec, &StartCancel::new())
            .await
            .unwrap();

        let (content_type, query, body) = patched.lock().unwrap().clone().expect("patched");
        assert_eq!(content_type, "application/strategic-merge-patch+json");
        assert!(query.contains("fieldManager=sextant"), "{query}");
        let added = &body["spec"]["ephemeralContainers"][0];
        assert_eq!(added["image"], DEFAULT_IMAGE);
        assert_eq!(added["targetContainerName"], "app");
        let name = added["name"].as_str().unwrap();
        assert!(
            name.starts_with("debugger-") && name != "debugger-old",
            "{name}"
        );
        assert_eq!(target.container, name);
        assert_eq!(target.pod, pod_spec());
        assert!(target.copy.is_none());
        assert!(api.requests().iter().all(|r| r.method != "POST"));
    }

    #[tokio::test]
    async fn a_cluster_without_ephemeral_containers_or_rights_says_so() {
        let not_found = json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound",
                                "code": 404, "message": "the server could not find the requested resource" });
        let forbidden = json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden",
                                "code": 403, "message": "pods \"web\" is forbidden: User \"x\" cannot patch resource \"pods/ephemeralcontainers\"" });
        for (answer, code, expected) in [
            (
                not_found,
                ErrorCode::NotFound,
                "This cluster does not support ephemeral containers",
            ),
            (
                forbidden,
                ErrorCode::Forbidden,
                "You need permission to update pods/ephemeralcontainers in namespace team-a",
            ),
        ] {
            let status = answer["code"].as_u64().unwrap() as u16;
            let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/api") => Reply::json(200, API_VERSIONS),
                ("GET", path) if path == format!("{PODS}/web") => {
                    Reply::json(200, web_pod().to_string())
                }
                ("PATCH", _) => Reply::json(status, answer.to_string()),
                _ => Reply::not_found(),
            })
            .await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let err = start(
                &mgr,
                &id,
                &pod_spec(),
                &DebugSpec::default(),
                &StartCancel::new(),
            )
            .await
            .expect_err("refused");
            assert_eq!(err.code, code);
            assert!(err.message.starts_with(expected), "{}", err.message);
        }
    }

    #[tokio::test]
    async fn a_missing_target_container_is_invalid_before_anything_changes() {
        let api = FakeApi::start(|req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", _) => Reply::json(200, web_pod().to_string()),
            _ => Reply::json(500, "{}"),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = DebugSpec {
            target: Some("nope".into()),
            ..Default::default()
        };
        let err = start(&mgr, &id, &pod_spec(), &spec, &StartCancel::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(api.requests().iter().all(|r| r.method == "GET"));
    }

    #[test]
    fn the_copy_drops_node_probes_labels_and_owners_and_replaces_the_target_command() {
        let original: Pod = serde_json::from_value(web_pod()).unwrap();
        let command = vec!["sleep".to_owned(), "infinity".to_owned()];
        let copy = copy_pod(
            &original,
            "web-debug-abcde",
            "debugger-xyz",
            "busybox:stable",
            Some("app"),
            &command,
        )
        .unwrap();
        let copy = serde_json::to_value(copy).unwrap();
        assert_eq!(copy["metadata"]["name"], "web-debug-abcde");
        assert_eq!(copy["metadata"]["namespace"], "team-a");
        assert!(copy["metadata"].get("ownerReferences").is_none());
        assert_eq!(
            copy["metadata"]["annotations"],
            json!({ "note": "kept" }),
            "last-applied is not copied"
        );
        let labels = &copy["metadata"]["labels"];
        assert!(labels.get("app").is_none(), "{labels}");
        assert_eq!(labels[LABEL_DEBUG_COPY], "true");
        assert_eq!(labels[LABEL_MANAGED_BY], "sextant");
        assert_eq!(labels[LABEL_DEBUG_OWNER], owner_id());
        assert_eq!(labels[LABEL_DEBUG_SESSION], session_id());
        // Not a node shell pod: agents and drains treat it as an ordinary pod.
        assert!(!crate::node_shell::is_node_shell_object(&copy));
        let spec = &copy["spec"];
        assert!(spec.get("nodeName").is_none());
        assert!(spec.get("ephemeralContainers").is_none());
        assert_eq!(spec["shareProcessNamespace"], true);
        assert_eq!(spec["activeDeadlineSeconds"], MAX_AGE.as_secs());
        let containers = spec["containers"].as_array().unwrap();
        assert_eq!(containers.len(), 3);
        assert_eq!(containers[0]["command"], json!(["sleep", "infinity"]));
        assert!(containers[0].get("args").is_none());
        assert!(containers[0].get("livenessProbe").is_none());
        assert!(containers[1].get("command").is_none());
        assert_eq!(containers[2]["name"], "debugger-xyz");
        assert_eq!(containers[2]["tty"], true);

        // A command without a container to run it in is refused.
        let err = copy_pod(&original, "c", "d", "busybox", None, &command).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
    }

    #[test]
    fn a_debug_copy_is_known_by_its_two_labels() {
        let original: Pod = serde_json::from_value(web_pod()).unwrap();
        let copy = copy_pod(&original, "web-debug-x", "debugger-x", "busybox", None, &[]).unwrap();
        assert!(is_debug_copy_object(&serde_json::to_value(copy).unwrap()));
        assert!(!is_debug_copy_object(&web_pod()));
        let half = json!({ "kind": "Pod", "metadata": { "labels": { LABEL_DEBUG_COPY: "true" } } });
        assert!(!is_debug_copy_object(&half));
        let other = json!({ "kind": "ConfigMap", "metadata": { "labels": {
            LABEL_MANAGED_BY: "sextant", LABEL_DEBUG_COPY: "true" } } });
        assert!(!is_debug_copy_object(&other));
    }

    #[test]
    fn copy_names_stay_within_a_dns_label() {
        let long = "a".repeat(80);
        let name = copy_name(&long);
        assert!(name.len() <= 63, "{name}");
        assert!(name.contains("-debug-"), "{name}");
        assert_ne!(copy_name("web"), copy_name("web"));
    }

    /// A fake API server for copies: the copy is "made" on POST, runs on GET when `runs`, and is deleted on DELETE.
    async fn copies(runs: bool) -> (FakeApi, Arc<Mutex<Option<Value>>>) {
        let made: Arc<Mutex<Option<Value>>> = Arc::default();
        let seen = Arc::clone(&made);
        let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", path) if path == format!("{PODS}/web") => {
                Reply::json(200, web_pod().to_string())
            }
            ("GET", PODS) => Reply::json(200, r#"{"kind":"PodList","apiVersion":"v1","metadata":{},"items":[]}"#),
            ("POST", PODS) => {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                *seen.lock().unwrap() = Some(body.clone());
                Reply::json(201, body.to_string())
            }
            ("GET", _) => {
                let copy = seen.lock().unwrap().clone();
                match copy {
                    Some(mut copy) if runs => {
                        let debugger = copy["spec"]["containers"][2]["name"].clone();
                        copy["status"] = json!({ "phase": "Running", "containerStatuses": [{
                            "name": debugger, "image": "", "imageID": "", "ready": true, "restartCount": 0,
                            "state": { "running": {} } }] });
                        Reply::json(200, copy.to_string())
                    }
                    Some(mut copy) => {
                        copy["status"] = json!({ "phase": "Pending" });
                        Reply::json(200, copy.to_string())
                    }
                    None => Reply::not_found(),
                }
            }
            ("DELETE", _) => Reply::json(200, "{}"),
            _ => Reply::not_found(),
        })
        .await;
        (api, made)
    }

    fn deletions(api: &FakeApi) -> Vec<String> {
        api.requests()
            .into_iter()
            .filter(|r| r.method == "DELETE")
            .map(|r| r.path)
            .collect()
    }

    async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_copy_is_held_while_its_handle_lives_and_deleted_when_it_is_dropped() {
        let (api, made) = copies(true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = DebugSpec {
            image: "nicolaka/netshoot:latest".into(),
            target: Some("app".into()),
            copy: Some(DebugCopySpec {
                command: vec!["sleep".into(), "1d".into()],
            }),
        };

        let target = start(&mgr, &id, &pod_spec(), &spec, &StartCancel::new())
            .await
            .unwrap();
        let name = made.lock().unwrap().as_ref().unwrap()["metadata"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(name.starts_with("web-debug-"), "{name}");
        assert_eq!(target.pod, pod_ref("team-a", &name));
        assert_eq!(target.copy.as_ref().unwrap().pod(), &target.pod);
        assert!(deletions(&api).is_empty(), "held while the session lives");
        // The sweep of earlier copies looked only at Sextant's debug copies.
        let listed = api
            .requests()
            .into_iter()
            .find(|r| r.method == "GET" && r.path == PODS)
            .expect("swept");
        assert!(
            listed.query.contains(
                "app.kubernetes.io%2Fmanaged-by%3Dsextant%2Csextant.dev%2Fdebug-copy%3Dtrue"
            ),
            "{}",
            listed.query
        );

        drop(target);
        eventually("the copy's deletion", || !deletions(&api).is_empty()).await;
        assert_eq!(deletions(&api), [format!("{PODS}/{name}")]);
    }

    #[tokio::test]
    async fn a_copy_called_off_while_it_starts_is_deleted() {
        let (api, made) = copies(false).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let cancel = StartCancel::new();
        let spec = DebugSpec {
            copy: Some(DebugCopySpec::default()),
            ..Default::default()
        };
        let starting = {
            let cancel = cancel.clone();
            let mgr = mgr.clone();
            let id = id.clone();
            tokio::spawn(async move { start(&mgr, &id, &pod_spec(), &spec, &cancel).await })
        };
        eventually("the copy to be made", || made.lock().unwrap().is_some()).await;
        cancel.cancel();
        let err = starting.await.unwrap().unwrap_err();
        assert_eq!(err.message, cancelled().message);
        let name = made.lock().unwrap().as_ref().unwrap()["metadata"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(deletions(&api), [format!("{PODS}/{name}")]);
    }

    #[tokio::test]
    async fn the_sweep_deletes_this_users_copies_of_other_runs_and_anyones_old_ones() {
        let recent = Timestamp::now().to_string();
        let old = (Timestamp::now() - Duration::from_secs(9 * 3600)).to_string();
        let copy = |name: &str, owner: &str, session: &str, created: &str| {
            json!({ "metadata": { "name": name, "namespace": "team-a", "creationTimestamp": created,
                "labels": { LABEL_MANAGED_BY: "sextant", LABEL_DEBUG_COPY: "true",
                            LABEL_DEBUG_OWNER: owner, LABEL_DEBUG_SESSION: session } } })
        };
        let items = json!([
            copy("mine-now", owner_id(), session_id(), &recent),
            copy("mine-earlier", owner_id(), "earlier", &recent),
            copy("colleague", "someone", "theirs", &recent),
            copy("colleague-old", "someone", "theirs", &old),
        ]);
        let api = FakeApi::start(move |req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", PODS) => Reply::json(
                200,
                json!({ "kind": "PodList", "apiVersion": "v1", "metadata": {}, "items": items })
                    .to_string(),
            ),
            ("DELETE", _) => Reply::json(200, "{}"),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        assert_eq!(sweep(mgr.client(&id).unwrap(), "team-a").await.unwrap(), 2);
        let mut deleted = deletions(&api);
        deleted.sort();
        assert_eq!(
            deleted,
            [
                format!("{PODS}/colleague-old"),
                format!("{PODS}/mine-earlier")
            ]
        );
    }
}
