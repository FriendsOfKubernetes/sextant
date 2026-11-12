//! A line of counts in Sextant's log every [`EVERY`] (and once [`FIRST`] after the start), so a log sent with a
//! report says how the process grew and what it was doing meanwhile (#342, ADR-0170): the process's memory, the open
//! streams by kind and how many wait for the window, the messages and bytes sent to the window and acknowledged, the
//! Kubernetes API requests, the connected clusters and whether the window is shown. Counts only — never a name, a
//! namespace, a URL, a cluster's content or a credential.
//!
//! Exec auth plugins (`tsh`, `aws`, `gke-gcloud-auth-plugin`…) are run by kube-rs inside its client, which offers no
//! hook to count them without changing how they run, so they are not counted.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};
use tokio::task::AbortHandle;

use super::FlowCounts;
use crate::state::AppState;

/// The first line after the start.
pub const FIRST: Duration = Duration::from_secs(60);
/// Then a line this often.
pub const EVERY: Duration = Duration::from_secs(10 * 60);

/// Whether the main window is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowShown {
    Visible,
    Minimized,
    /// Hidden to the tray.
    Hidden,
    /// No main window (closing).
    None,
}

impl WindowShown {
    fn name(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Minimized => "minimized",
            Self::Hidden => "hidden",
            Self::None => "none",
        }
    }
}

/// Everything one line counts, read at one moment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sample {
    /// `(name, bytes)` of `sextant_core::process_memory::sample`.
    pub memory: Vec<(&'static str, u64)>,
    pub flows: FlowCounts,
    /// Requests since the start (`sextant_core::cluster::api_requests`).
    pub api_requests: u64,
    pub clusters_connected: usize,
    pub window: Option<WindowShown>,
}

/// The line for `now`, with what was sent and asked since `before`, `elapsed` after it.
pub fn line(now: &Sample, before: &Sample, elapsed: Duration) -> String {
    let memory = if now.memory.is_empty() {
        "unknown".to_owned()
    } else {
        now.memory
            .iter()
            .map(|(name, bytes)| format!("{name}={}", mib(*bytes)))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let open: u64 = now.flows.open.values().sum();
    let kinds = if now.flows.open.is_empty() {
        String::new()
    } else {
        let each: Vec<String> = now
            .flows
            .open
            .iter()
            .map(|(kind, n)| format!("{}={n}", kind.name()))
            .collect();
        format!(" ({})", each.join(" "))
    };
    let delta = |a: u64, b: u64| a.saturating_sub(b);
    format!(
        "counters ({} min): memory {memory}; streams open={open}{kinds} waiting={}; to the window messages={} \
         bytes={} acknowledged={}; API requests={}; clusters connected={}; window={}",
        elapsed.as_secs().div_ceil(60),
        now.flows.waiting,
        delta(now.flows.messages, before.flows.messages),
        mib(delta(now.flows.bytes, before.flows.bytes)),
        delta(now.flows.acknowledged, before.flows.acknowledged),
        delta(now.api_requests, before.api_requests),
        now.clusters_connected,
        now.window.unwrap_or(WindowShown::None).name(),
    )
}

/// `12.3MiB`.
fn mib(bytes: u64) -> String {
    format!("{:.1}MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// Reads the counts now.
fn sample<R: Runtime>(app: &AppHandle<R>) -> Option<Sample> {
    let state = app.try_state::<AppState>()?;
    let window = app
        .get_webview_window(crate::window::MAIN_WINDOW)
        .map(|w| {
            if w.is_minimized().unwrap_or(false) {
                WindowShown::Minimized
            } else if w.is_visible().unwrap_or(true) {
                WindowShown::Visible
            } else {
                WindowShown::Hidden
            }
        })
        .or(Some(WindowShown::None));
    Some(Sample {
        memory: sextant_core::process_memory::sample(),
        flows: state.flows.counts(),
        api_requests: sextant_core::cluster::api_requests(),
        clusters_connected: state.clusters.connected_count(),
        window,
    })
}

/// The task writing the lines (`AppState.counters`); stopped by `close_all`.
#[derive(Debug, Default)]
pub struct CountersTask(Mutex<Option<AbortHandle>>);

impl CountersTask {
    /// Starts the lines (once; a second start replaces the first).
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) {
        let app = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut before = Sample::default();
            let mut since = Instant::now();
            let mut pause = FIRST;
            loop {
                tokio::time::sleep(pause).await;
                pause = EVERY;
                let Some(now) = sample(&app) else { return };
                sextant_core::applog!("{}", line(&now, &before, since.elapsed()));
                before = now;
                since = Instant::now();
            }
        });
        if let Some(old) = super::lock(&self.0).replace(task.inner().abort_handle()) {
            old.abort();
        }
    }

    /// Stops the lines.
    pub fn stop(&self) {
        if let Some(task) = super::lock(&self.0).take() {
            task.abort();
        }
    }
}
