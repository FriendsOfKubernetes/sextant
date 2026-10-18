//! Installing Flux or Argo CD from the window (spec stories 14–26): the versions to choose from, the download and its
//! checks ([`download`]), the preview with a token for the prepared plan ([`prepare`]), and the install itself
//! ([`run`]): the core's object-by-object apply, then waiting for the controllers to be ready.
//!
//! Only the window's commands (`commands::gitops_install`) reach this: there is no MCP tool and no extension method
//! for it, so an install always starts from the user's click.

pub mod download;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sextant_core::gitops_install::{
    self, AccessCheck, GitopsTool, InstallPlan, InstallStep, InstallSummary, InstalledState,
    Overlap, WorkloadState,
};
use sextant_core::{ClusterId, ClusterManager, CoreError, CoreResult, ErrorCode};
use tokio::task::AbortHandle;
use ts_rs::TS;

use self::download::GitopsDownloader;
use crate::state::check_stream_id;

/// How long a prepared plan waits for the user's "Install".
pub const PLAN_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many prepared plans are kept (each holds a parsed manifest); a new one pushes out the oldest.
const MAX_PLANS: usize = 4;
/// How long the install waits for the controllers to be ready.
pub const READY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How often readiness is read while waiting.
pub const READY_POLL: Duration = Duration::from_secs(3);
/// A stop is noticed within this while waiting.
const STOP_CHECK: Duration = Duration::from_millis(100);

/// What the window shows before the user confirms an install (`gitops_install_prepare`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstallPreview {
    /// Starts this plan (`gitops_install_start`), once, within ten minutes.
    pub token: String,
    pub tool: GitopsTool,
    pub version: String,
    pub namespace: String,
    /// Where the manifest was downloaded from.
    pub source_url: String,
    /// SHA-256 of the downloaded manifest.
    pub sha256: String,
    /// Flux: the SHA-256 matched the release's checksums file. Argo CD publishes none (false).
    pub checksum_verified: bool,
    pub summary: InstallSummary,
    /// Whether the user may create CRDs and ClusterRoleBindings.
    pub access: AccessCheck,
    /// Whether the tool is already (partly) in the cluster.
    pub existing: InstalledState,
    /// What already exists and is overwritten, and (Flux) left-out controllers losing their permissions.
    pub overlap: Overlap,
}

/// Whether each tool is in the cluster (`gitops_install_status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitopsStatus {
    pub flux: InstalledState,
    pub argo_cd: InstalledState,
}

/// One event of an install stream (sent through the channel of `gitops_install_start`). The last one is `done`,
/// `timedOut`, `stopped` or `error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum InstallEvent {
    /// An object was applied.
    Applied { kind: String, name: String },
    /// The object whose failure ended the apply (an `error` follows).
    Failed {
        kind: String,
        name: String,
        error: String,
    },
    /// Everything was applied; the controllers are not all ready yet.
    Waiting { workloads: Vec<WorkloadState> },
    /// Everything was applied and every controller is ready.
    Done { workloads: Vec<WorkloadState> },
    /// Not every controller was ready in time; what was applied stays.
    TimedOut { workloads: Vec<WorkloadState> },
    /// The user stopped the install; `applied` objects were applied before it.
    Stopped { applied: u32 },
    /// The install ended with an error (an apply failure says which object and how many were applied before it).
    Error { message: String },
}

/// The last event of an install aborted for `why` (disconnect, reload, exit) after `applied` of `total` objects.
pub fn aborted(why: &str, applied: u32, total: u32) -> InstallEvent {
    let message = if applied >= total {
        format!(
            "The install was stopped because {why}: all {total} objects were applied; the wait for the controllers ended"
        )
    } else {
        format!(
            "The install was stopped because {why}: {applied} of {total} objects were applied; the object being sent at that moment may or may not have been applied, and nothing after it was sent"
        )
    };
    InstallEvent::Error { message }
}

/// How long [`run`] waits for readiness, and how often it looks.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub poll: Duration,
    pub timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: READY_POLL,
            timeout: READY_TIMEOUT,
        }
    }
}

struct PendingPlan {
    cluster: ClusterId,
    plan: Arc<InstallPlan>,
    created: Instant,
}

/// Tells the window why an install was aborted (its last event), with what it knows: called with the reason.
pub type OnAbort = Box<dyn FnOnce(&str) + Send>;

struct Running {
    cluster: ClusterId,
    stop: Arc<AtomicBool>,
    task: AbortHandle,
    on_abort: OnAbort,
}

impl Running {
    /// Ends the task at once, then gives the window its final event (a late event of the task is ignored there).
    fn abort(self, why: &str) {
        self.stop.store(true, Ordering::SeqCst);
        self.task.abort();
        (self.on_abort)(why);
    }
}

/// Why [`GitopsInstalls::stop_cluster`] ended an install.
pub const ABORTED_DISCONNECTED: &str = "the cluster was disconnected";
/// Why [`GitopsInstalls::stop_all`] / [`GitopsInstalls::abort`] ended an install.
pub const ABORTED_CLOSED: &str = "the window was reloaded or closed";

/// Prepared plans waiting for "Install" and the installs running, in `AppState.gitops`. Disconnecting the cluster,
/// a reload of the window and quitting abort the running installs.
pub struct GitopsInstalls {
    downloader: GitopsDownloader,
    plans: Mutex<HashMap<String, PendingPlan>>,
    running: Mutex<HashMap<String, Running>>,
}

impl Default for GitopsInstalls {
    fn default() -> Self {
        Self::new(GitopsDownloader::github())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn new_token() -> CoreResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| CoreError::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn gone() -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        "The prepared install expired or was already used; prepare it again",
    )
}

impl GitopsInstalls {
    pub fn new(downloader: GitopsDownloader) -> Self {
        Self {
            downloader,
            plans: Mutex::default(),
            running: Mutex::default(),
        }
    }

    pub fn downloader(&self) -> &GitopsDownloader {
        &self.downloader
    }

    /// Keeps `plan` for `cluster` for [`PLAN_TTL`]; returns its token.
    pub fn keep(&self, cluster: ClusterId, plan: InstallPlan) -> CoreResult<String> {
        let token = new_token()?;
        let mut plans = lock(&self.plans);
        plans.retain(|_, p| p.created.elapsed() < PLAN_TTL);
        while plans.len() >= MAX_PLANS {
            let oldest = plans
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(token, _)| token.clone());
            match oldest {
                Some(oldest) => plans.remove(&oldest),
                None => break,
            };
        }
        plans.insert(
            token.clone(),
            PendingPlan {
                cluster,
                plan: Arc::new(plan),
                created: Instant::now(),
            },
        );
        Ok(token)
    }

    /// Takes the plan of `token` (once): `notFound` when it expired, was used, or was prepared for another cluster.
    pub fn take(&self, cluster: &ClusterId, token: &str) -> CoreResult<Arc<InstallPlan>> {
        let pending = lock(&self.plans).remove(token).ok_or_else(gone)?;
        if pending.created.elapsed() >= PLAN_TTL || &pending.cluster != cluster {
            return Err(gone());
        }
        Ok(pending.plan)
    }

    /// Makes the plan of `token` older (tests of the TTL).
    #[cfg(test)]
    pub(crate) fn age(&self, token: &str, by: Duration) {
        if let Some(p) = lock(&self.plans).get_mut(token) {
            p.created = p.created.checked_sub(by).unwrap_or(p.created);
        }
    }

    /// Registers a running install under the stream id the window chose; a malformed or taken id is `invalid`.
    /// `on_abort` gives the window the install's final event when it is aborted (disconnect, reload, exit).
    pub fn register(
        &self,
        id: &str,
        cluster: ClusterId,
        stop: Arc<AtomicBool>,
        task: AbortHandle,
        on_abort: OnAbort,
    ) -> CoreResult<()> {
        check_stream_id(id)?;
        let mut running = lock(&self.running);
        if running.contains_key(id) {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("stream id {id} is already in use"),
            ));
        }
        running.insert(
            id.to_owned(),
            Running {
                cluster,
                stop,
                task,
                on_abort,
            },
        );
        Ok(())
    }

    /// Registers the install `id` (as [`register`](Self::register)), then takes the plan of `token` (as
    /// [`take`](Self::take)) for it. A refused registration (a malformed or taken id) leaves the plan for a retry; a
    /// plan that is gone unregisters the install, without its `on_abort`.
    pub fn begin(
        &self,
        id: &str,
        cluster: &ClusterId,
        token: &str,
        stop: Arc<AtomicBool>,
        task: AbortHandle,
        on_abort: OnAbort,
    ) -> CoreResult<Arc<InstallPlan>> {
        self.register(id, cluster.clone(), stop, task, on_abort)?;
        self.take(cluster, token).inspect_err(|_| {
            if let Some(running) = lock(&self.running).remove(id) {
                running.task.abort();
            }
        })
    }

    /// Asks the install `id` to stop after the object being applied (or to stop waiting); `false` when there is no
    /// such install.
    pub fn stop(&self, id: &str) -> bool {
        match lock(&self.running).get(id) {
            Some(running) => {
                running.stop.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Aborts the install `id` at once (a start that a reset overtook).
    pub fn abort(&self, id: &str) {
        let running = lock(&self.running).remove(id);
        if let Some(running) = running {
            running.abort(ABORTED_CLOSED);
        }
    }

    /// Forgets an install that ended by itself.
    pub fn finished(&self, id: &str) {
        lock(&self.running).remove(id);
    }

    /// Aborts the installs into `cluster` and drops its prepared plans (it was disconnected; a new connection may
    /// reach another cluster).
    pub fn stop_cluster(&self, cluster: &ClusterId) {
        lock(&self.plans).retain(|_, p| &p.cluster != cluster);
        let ended: Vec<Running> = {
            let mut running = lock(&self.running);
            let ids: Vec<String> = running
                .iter()
                .filter(|(_, r)| &r.cluster == cluster)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| running.remove(id)).collect()
        };
        for running in ended {
            running.abort(ABORTED_DISCONNECTED);
        }
    }

    /// Aborts every install (the window was reloaded or closed).
    pub fn stop_all(&self) {
        let ended: Vec<Running> = lock(&self.running).drain().map(|(_, r)| r).collect();
        for running in ended {
            running.abort(ABORTED_CLOSED);
        }
    }

    /// How many installs are running.
    pub fn running(&self) -> usize {
        lock(&self.running).len()
    }
}

/// `gitops_install_prepare`: downloads and checks the manifest of `version`, plans the install, and asks the cluster
/// what the preview needs (access, whether the tool is there, what would be overwritten). The plan is kept under the
/// returned token.
pub async fn prepare(
    installs: &GitopsInstalls,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    tool: GitopsTool,
    version: &str,
) -> CoreResult<InstallPreview> {
    // Not connected: say so before downloading anything.
    mgr.client(cluster)?;
    let manifest = installs.downloader.manifest(tool, version).await?;
    let text = manifest.text.clone();
    let tag = version.to_owned();
    let plan = tokio::task::spawn_blocking(move || gitops_install::prepare(tool, &tag, &text))
        .await
        .map_err(|e| CoreError::other(e.to_string()))??;
    let (access, existing, overlap) = tokio::try_join!(
        gitops_install::access_check(mgr, cluster),
        gitops_install::installed(mgr, cluster, tool),
        gitops_install::overlap(mgr, cluster, &plan),
    )?;
    let summary = plan.summary();
    let namespace = plan.namespace.clone();
    let token = installs.keep(cluster.clone(), plan)?;
    Ok(InstallPreview {
        token,
        tool,
        version: version.to_owned(),
        namespace,
        source_url: manifest.url,
        sha256: manifest.sha256,
        checksum_verified: manifest.checksum_verified,
        summary,
        access,
        existing,
        overlap,
    })
}

/// The workloads the plan installs, each with its state from `found`; one not listed yet is not ready.
fn expected_states(plan: &InstallPlan, found: &[WorkloadState]) -> Vec<WorkloadState> {
    plan.objects
        .iter()
        .filter(|o| o.kind == "Deployment" || o.kind == "StatefulSet")
        .map(|o| {
            found
                .iter()
                .find(|w| w.kind == o.kind && w.name == o.name)
                .cloned()
                .unwrap_or_else(|| WorkloadState {
                    kind: o.kind.clone(),
                    name: o.name.clone(),
                    ready: false,
                    reason: Some("not created yet".to_owned()),
                })
        })
        .collect()
}

/// The install: applies the plan object by object (each reported as `applied`; the first failure as `failed` and
/// `error`), then reads readiness every `timing.poll` (`waiting`) until every workload of the plan is ready (`done`)
/// or `timing.timeout` passes (`timedOut`, with the reasons). `stop` ends it after the object being applied or while
/// waiting (`stopped`). An empty readiness list is never "ready": the plan's workloads must all be there.
pub async fn run(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    plan: &InstallPlan,
    stop: &AtomicBool,
    timing: Timing,
    mut emit: impl FnMut(InstallEvent),
) {
    let applied = gitops_install::apply_until(mgr, cluster, plan, stop, |step| {
        emit(match step {
            InstallStep::Applied { kind, name } => InstallEvent::Applied { kind, name },
            InstallStep::Failed { kind, name, error } => InstallEvent::Failed { kind, name, error },
        })
    })
    .await;
    let report = match applied {
        Ok(report) => report,
        Err(err) => {
            emit(InstallEvent::Error {
                message: err.message,
            });
            return;
        }
    };
    let count = report.applied.len() as u32;
    if report.stopped {
        emit(InstallEvent::Stopped { applied: count });
        return;
    }

    let started = Instant::now();
    let mut last: Vec<WorkloadState> = expected_states(plan, &[]);
    loop {
        if stop.load(Ordering::SeqCst) {
            emit(InstallEvent::Stopped { applied: count });
            return;
        }
        match gitops_install::readiness(mgr, cluster, plan.tool, &plan.namespace).await {
            Ok(found) => last = expected_states(plan, &found),
            Err(err) => {
                for w in last.iter_mut().filter(|w| !w.ready) {
                    w.reason = Some(format!("cannot read its state: {}", err.message));
                }
            }
        }
        if !last.is_empty() && last.iter().all(|w| w.ready) {
            emit(InstallEvent::Done { workloads: last });
            return;
        }
        if started.elapsed() >= timing.timeout {
            emit(InstallEvent::TimedOut { workloads: last });
            return;
        }
        emit(InstallEvent::Waiting {
            workloads: last.clone(),
        });
        let next = Instant::now() + timing.poll;
        while Instant::now() < next {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(STOP_CHECK.min(timing.poll)).await;
        }
    }
}

#[cfg(test)]
mod tests;
