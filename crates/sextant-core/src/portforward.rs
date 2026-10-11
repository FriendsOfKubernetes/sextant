//! Port forwarding from a local port to a pod or service.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use ts_rs::TS;

use crate::cluster::{ClusterManager, ConnectionState};
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;

/// How often a forward checks that its pod is still there.
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);

/// Serialized with a `type` tag: `{ "type": "pod", "namespace": "…", "name": "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ForwardTarget {
    Pod { namespace: String, name: String },
    Service { namespace: String, name: String },
}

/// Serialized with a `state` tag: `{ "state": "active" }`, `{ "state": "error", "code": …, "message": … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum ForwardStatus {
    Active,
    Error(CoreError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForwardInfo {
    pub id: String,
    pub cluster: ClusterId,
    pub target: ForwardTarget,
    pub remote_port: u16,
    pub local_port: u16,
    pub status: ForwardStatus,
}

/// All active forwards of the application. Each forward is a listener on `127.0.0.1` that opens a new stream to
/// the pod for every accepted connection (like `kubectl port-forward`), plus a monitor that turns the status into
/// `Error` when the pod goes away. Dropping the forwarder closes every forward.
pub struct PortForwarder {
    inner: Arc<Inner>,
}

struct Inner {
    entries: Mutex<Vec<Entry>>,
    tx: broadcast::Sender<Vec<ForwardInfo>>,
    next_id: AtomicU64,
    /// Whether the task that closes forwards of disconnected clusters is running.
    watching_clusters: AtomicBool,
}

struct Entry {
    info: ForwardInfo,
    listener: JoinHandle<()>,
    monitor: JoinHandle<()>,
}

impl Entry {
    fn abort(&self) {
        self.listener.abort();
        self.monitor.abort();
    }
}

/// The pod (and the port inside it) a forward currently points at.
#[derive(Debug, Clone)]
struct Resolved {
    namespace: String,
    name: String,
    uid: Option<String>,
    port: u16,
}

impl Default for PortForwarder {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PortForwarder {
    fn drop(&mut self) {
        self.inner.stop_where(|_| true);
    }
}

impl PortForwarder {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            inner: Arc::new(Inner {
                entries: Mutex::new(Vec::new()),
                tx,
                next_id: AtomicU64::new(1),
                watching_clusters: AtomicBool::new(false),
            }),
        }
    }

    /// Starts forwarding; `local_port: None` picks a free port. A taken port gives `PortInUse`.
    ///
    /// A pod target is forwarded as is. A service target is resolved to one of its ready pods (the service port
    /// is translated to the pod's `targetPort`); when that pod goes away the forward turns to `Error` and
    /// recovers by itself as soon as the service has another ready pod.
    pub async fn start(
        &self,
        mgr: &ClusterManager,
        cluster: &ClusterId,
        target: ForwardTarget,
        remote_port: u16,
        local_port: Option<u16>,
    ) -> CoreResult<ForwardInfo> {
        let client = mgr.client(cluster)?;
        let listener = bind_local(local_port.unwrap_or(0)).await?;
        let local_port = listener.local_addr()?.port();
        let resolved = resolve(&client, &target, remote_port).await?;
        self.watch_clusters(mgr);

        let id = format!("pf-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let info = ForwardInfo {
            id: id.clone(),
            cluster: cluster.clone(),
            target: target.clone(),
            remote_port,
            local_port,
            status: ForwardStatus::Active,
        };
        let current = Arc::new(Mutex::new(resolved));
        let listener = tokio::spawn(accept_loop(listener, client.clone(), Arc::clone(&current)));
        let monitor = tokio::spawn(monitor(
            Arc::clone(&self.inner),
            id,
            client,
            target,
            remote_port,
            current,
        ));
        self.inner.lock().push(Entry {
            info: info.clone(),
            listener,
            monitor,
        });
        self.inner.publish();
        Ok(info)
    }

    pub fn list(&self) -> Vec<ForwardInfo> {
        self.inner.lock().iter().map(|e| e.info.clone()).collect()
    }

    /// Closes a forward. Returns once its local port is free again.
    pub async fn stop(&self, id: &str) -> CoreResult<()> {
        let entry = {
            let mut entries = self.inner.lock();
            let at = entries.iter().position(|e| e.info.id == id);
            at.map(|at| entries.remove(at))
        };
        let Some(entry) = entry else {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!("no port forward {id}"),
            ));
        };
        entry.abort();
        // Wait until the listener is really dropped, so the port can be bound again right away.
        let _ = entry.listener.await;
        let _ = entry.monitor.await;
        self.inner.publish();
        Ok(())
    }

    /// Closes every forward of a cluster (it was disconnected). Does not wait for the ports to be released.
    pub fn stop_cluster(&self, cluster: &ClusterId) {
        self.inner.stop_where(|info| &info.cluster == cluster);
    }

    /// Closes every forward (the application is closing).
    pub fn stop_all(&self) {
        self.inner.stop_where(|_| true);
    }

    /// Receives the full list after every change.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<ForwardInfo>> {
        self.inner.tx.subscribe()
    }

    /// Closes the forwards of a cluster as soon as the manager reports it disconnected.
    fn watch_clusters(&self, mgr: &ClusterManager) {
        if self.inner.watching_clusters.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut states = mgr.subscribe_states();
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match states.recv().await {
                    Ok((cluster, ConnectionState::Disconnected)) => {
                        let Some(inner) = inner.upgrade() else { break };
                        inner.stop_where(|info| info.cluster == cluster);
                    }
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn publish(&self) {
        let list: Vec<ForwardInfo> = self.lock().iter().map(|e| e.info.clone()).collect();
        let _ = self.tx.send(list);
    }

    fn stop_where(&self, matches: impl Fn(&ForwardInfo) -> bool) {
        let stopped = {
            let mut entries = self.lock();
            let before = entries.len();
            entries.retain(|e| {
                let keep = !matches(&e.info);
                if !keep {
                    e.abort();
                }
                keep
            });
            entries.len() != before
        };
        if stopped {
            self.publish();
        }
    }

    fn set_status(&self, id: &str, status: ForwardStatus) {
        let changed = {
            let mut entries = self.lock();
            match entries.iter_mut().find(|e| e.info.id == id) {
                Some(entry) if entry.info.status != status => {
                    entry.info.status = status;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.publish();
        }
    }
}

async fn bind_local(port: u16) -> CoreResult<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => CoreError::new(
                ErrorCode::PortInUse,
                format!("local port {port} is already in use"),
            ),
            std::io::ErrorKind::PermissionDenied => CoreError::new(
                ErrorCode::Invalid,
                format!("not allowed to listen on local port {port}"),
            ),
            _ => CoreError::from(e),
        })
}

/// Finds the pod and the port inside it for a target.
async fn resolve(
    client: &kube::Client,
    target: &ForwardTarget,
    remote_port: u16,
) -> CoreResult<Resolved> {
    match target {
        ForwardTarget::Pod { namespace, name } => {
            let pod = Api::<Pod>::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|e| kube_error(e, None))?;
            if let Some(problem) = pod_problem(&pod, None) {
                return Err(problem);
            }
            Ok(Resolved {
                namespace: namespace.clone(),
                name: name.clone(),
                uid: pod.metadata.uid,
                port: remote_port,
            })
        }
        ForwardTarget::Service { namespace, name } => {
            let service = Api::<Service>::namespaced(client.clone(), namespace)
                .get(name)
                .await
                .map_err(|e| kube_error(e, None))?;
            let spec = service.spec.unwrap_or_default();
            let selector = spec.selector.unwrap_or_default();
            if selector.is_empty() {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    format!(
                        "service {namespace}/{name} has no selector, so it has no pods to forward to"
                    ),
                ));
            }
            let service_port = spec
                .ports
                .unwrap_or_default()
                .into_iter()
                .find(|p| p.port == i32::from(remote_port))
                .ok_or_else(|| {
                    CoreError::new(
                        ErrorCode::Invalid,
                        format!("service {namespace}/{name} has no port {remote_port}"),
                    )
                })?;
            let labels = selector
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(",");
            let mut pods = Api::<Pod>::namespaced(client.clone(), namespace)
                .list(&ListParams::default().labels(&labels))
                .await
                .map_err(|e| kube_error(e, None))?
                .items;
            pods.retain(is_ready);
            pods.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
            let pod = pods.into_iter().next().ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("service {namespace}/{name} has no ready pods"),
                )
            })?;
            let port = pod_port(&pod, service_port.target_port.as_ref(), remote_port)?;
            Ok(Resolved {
                namespace: namespace.clone(),
                name: pod.metadata.name.unwrap_or_default(),
                uid: pod.metadata.uid,
                port,
            })
        }
    }
}

/// The port inside the pod that a service port's `targetPort` stands for.
fn pod_port(pod: &Pod, target_port: Option<&IntOrString>, service_port: u16) -> CoreResult<u16> {
    match target_port {
        None => Ok(service_port),
        Some(IntOrString::Int(0)) => Ok(service_port),
        Some(IntOrString::Int(n)) => u16::try_from(*n)
            .map_err(|_| CoreError::new(ErrorCode::Invalid, format!("invalid target port {n}"))),
        Some(IntOrString::String(named)) => pod
            .spec
            .iter()
            .flat_map(|s| &s.containers)
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(named))
            .and_then(|p| u16::try_from(p.container_port).ok())
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Invalid,
                    format!("pod has no container port named {named}"),
                )
            }),
    }
}

fn is_ready(pod: &Pod) -> bool {
    let Some(status) = &pod.status else {
        return false;
    };
    pod.metadata.deletion_timestamp.is_none()
        && status.phase.as_deref() == Some("Running")
        && status
            .conditions
            .iter()
            .flatten()
            .any(|c| c.type_ == "Ready" && c.status == "True")
}

/// Why a pod cannot be forwarded to any more; `uid` is the identity the forward was made for.
fn pod_problem(pod: &Pod, uid: Option<&str>) -> Option<CoreError> {
    let name = pod.metadata.name.as_deref().unwrap_or("?");
    if uid.is_some() && pod.metadata.uid.as_deref() != uid {
        return Some(CoreError::new(
            ErrorCode::NotFound,
            format!("pod {name} was deleted and replaced"),
        ));
    }
    if pod.metadata.deletion_timestamp.is_some() {
        return Some(CoreError::new(
            ErrorCode::NotFound,
            format!("pod {name} is being deleted"),
        ));
    }
    match pod.status.as_ref().and_then(|s| s.phase.as_deref()) {
        Some(phase @ ("Succeeded" | "Failed")) => Some(CoreError::new(
            ErrorCode::NotFound,
            format!("pod {name} has finished ({phase})"),
        )),
        _ => None,
    }
}

async fn accept_loop(listener: TcpListener, client: kube::Client, current: Arc<Mutex<Resolved>>) {
    // Dropping the set (when this task is aborted) aborts the connections that are still open.
    let mut connections = JoinSet::new();
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                let pod = current.lock().unwrap_or_else(|e| e.into_inner()).clone();
                connections.spawn(serve_connection(client.clone(), pod, socket));
            }
            // Transient (too many open files, aborted handshake): keep listening.
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
        while connections.try_join_next().is_some() {}
    }
}

/// Aborts the Kubernetes side of a connection when the connection is over.
struct AbortOnDrop(kube::api::Portforwarder);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn serve_connection(client: kube::Client, pod: Resolved, mut local: TcpStream) {
    let pods = Api::<Pod>::namespaced(client, &pod.namespace);
    let Ok(mut forwarder) = pods.portforward(&pod.name, &[pod.port]).await else {
        return;
    };
    let Some(mut upstream) = forwarder.take_stream(pod.port) else {
        return;
    };
    let _guard = AbortOnDrop(forwarder);
    let _ = tokio::io::copy_bidirectional(&mut local, &mut upstream).await;
}

/// Watches the pod of a forward: when it is gone the status becomes `Error`. A service forward looks for
/// another ready pod and becomes `Active` again when it finds one.
async fn monitor(
    inner: Arc<Inner>,
    id: String,
    client: kube::Client,
    target: ForwardTarget,
    remote_port: u16,
    current: Arc<Mutex<Resolved>>,
) {
    loop {
        tokio::time::sleep(HEALTH_INTERVAL).await;
        let pod = current.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let problem = match Api::<Pod>::namespaced(client.clone(), &pod.namespace)
            .get(&pod.name)
            .await
        {
            Ok(found) => pod_problem(&found, pod.uid.as_deref()),
            Err(kube::Error::Api(status)) if status.code == 404 => Some(CoreError::new(
                ErrorCode::NotFound,
                format!("pod {} was deleted", pod.name),
            )),
            // The API server may be briefly unreachable; that is not the pod's fault.
            Err(_) => continue,
        };
        let Some(problem) = problem else { continue };
        match &target {
            ForwardTarget::Pod { .. } => {
                inner.set_status(&id, ForwardStatus::Error(problem));
                return;
            }
            ForwardTarget::Service { .. } => match resolve(&client, &target, remote_port).await {
                Ok(next) => {
                    *current.lock().unwrap_or_else(|e| e.into_inner()) = next;
                    inner.set_status(&id, ForwardStatus::Active);
                }
                Err(error) => inner.set_status(&id, ForwardStatus::Error(error)),
            },
        }
    }
}
