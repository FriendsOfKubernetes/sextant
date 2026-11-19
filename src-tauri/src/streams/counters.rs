//! A line of counts in Sextant's log every [`EVERY`] (and once [`FIRST`] after the start), so a log sent with a
//! report says how the process grew and what it was doing meanwhile (#342, ADR-0170): the process's memory, the open
//! streams by kind and how many wait for the window, the messages and bytes sent to the window and acknowledged, the
//! Kubernetes API requests, the connected clusters and whether the window is shown; since 0.30.4 also what was sent
//! by kind of stream and how the watches fared — lists after their first snapshot, lost connections, expired
//! `resourceVersion`s and the errors the watcher resumed from (#342). Counts only — never a name, a namespace, a
//! URL, a cluster's content or a credential. Memory is also looked at every minute: when it passes 4 GiB, and then
//! each time it doubles, a line says so at once (a process that runs out of memory may end without a word).
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
/// How often memory is looked at for [`high_memory`].
const MEMORY_CHECK: Duration = Duration::from_secs(60);
/// Memory above this is unusual: a line says so at once, then again at each doubling.
pub const HIGH_MEMORY: u64 = 4 * 1024 * 1024 * 1024;

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
    /// What the watches did since the start (`sextant_core::resources::watch_stats`).
    pub watches: sextant_core::resources::WatchStats,
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
    // What each kind of stream sent since `before`, the kinds that sent anything.
    let by_kind: Vec<String> = now
        .flows
        .sent_by_kind
        .iter()
        .filter_map(|(kind, (messages, bytes))| {
            let (m0, b0) = before
                .flows
                .sent_by_kind
                .get(kind)
                .copied()
                .unwrap_or_default();
            let messages = delta(*messages, m0);
            (messages > 0).then(|| format!("{}={messages}/{}", kind.name(), mib(delta(*bytes, b0))))
        })
        .collect();
    let by_kind = if by_kind.is_empty() {
        String::new()
    } else {
        format!(" ({})", by_kind.join(" "))
    };
    let (w, w0) = (now.watches, before.watches);
    format!(
        "counters ({} min): memory {memory}; streams open={open}{kinds} waiting={}; to the window messages={} \
         bytes={}{by_kind} acknowledged={}; API requests={}; watches relists={} reconnects={} gone={} resumed \
         broken={} start={} event={} list={} other={}; clusters connected={}; window={}",
        elapsed.as_secs().div_ceil(60),
        now.flows.waiting,
        delta(now.flows.messages, before.flows.messages),
        mib(delta(now.flows.bytes, before.flows.bytes)),
        delta(now.flows.acknowledged, before.flows.acknowledged),
        delta(now.api_requests, before.api_requests),
        delta(w.relists, w0.relists),
        delta(w.reconnects, w0.reconnects),
        delta(w.gone, w0.gone),
        delta(w.resumed_broken, w0.resumed_broken),
        delta(w.resumed_start, w0.resumed_start),
        delta(w.resumed_event, w0.resumed_event),
        delta(w.resumed_list, w0.resumed_list),
        delta(w.resumed_other, w0.resumed_other),
        now.clusters_connected,
        now.window.unwrap_or(WindowShown::None).name(),
    )
}

/// The figures of memory the process really holds, in order of preference: Windows' private bytes (its commit
/// charge), then the resident set. Not Linux's `data`, which counts address space only reserved.
const HELD_MEMORY: [&str; 3] = ["private", "rss", "workingSet"];

/// A line when the memory the process holds passed `next` (then `next` doubles past it), else `None`.
pub fn high_memory(memory: &[(&'static str, u64)], next: &mut u64) -> Option<String> {
    let (name, bytes) = HELD_MEMORY
        .iter()
        .find_map(|wanted| memory.iter().copied().find(|(name, _)| name == wanted))?;
    if bytes < *next {
        return None;
    }
    let passed = *next;
    while *next <= bytes {
        *next = next.saturating_mul(2);
    }
    Some(format!(
        "memory is unusually high: {name}={} (over {}); the counters lines say what Sextant was doing",
        mib(bytes),
        mib(passed)
    ))
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
        watches: sextant_core::resources::watch_stats(),
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
            let mut next_line = Instant::now() + FIRST;
            let mut next_memory = HIGH_MEMORY;
            loop {
                tokio::time::sleep(
                    MEMORY_CHECK.min(next_line.saturating_duration_since(Instant::now())),
                )
                .await;
                if let Some(warning) =
                    high_memory(&sextant_core::process_memory::sample(), &mut next_memory)
                {
                    sextant_core::applog!("{warning}");
                }
                if Instant::now() < next_line {
                    continue;
                }
                next_line = Instant::now() + EVERY;
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
