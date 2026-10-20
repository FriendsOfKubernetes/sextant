//! What the MCP server shares with the rest of the application: clusters, settings, port forwards (all from
//! `AppState`), the token, the journal, the waiting confirmations and the way events reach the window.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use sextant_core::portforward::PortForwarder;
use sextant_core::{ClusterId, ClusterInfo, ClusterManager, KubeconfigRegistry, SettingsStore};

use super::audit::{AuditEntry, AuditLog};
use super::confirm::{ConfirmRequest, Confirmations};
use super::paths;
use super::server::McpStatus;
use super::token::{self, Token};
use super::window::{DiagnosticRequest, WindowRequests};

/// Something the server tells the window.
#[derive(Debug, Clone, PartialEq)]
pub enum McpEvent {
    /// `mcp-status`
    Status(McpStatus),
    /// `mcp-confirm`
    Confirm(ConfirmRequest),
    /// `mcp-audit`
    Audit(AuditEntry),
    /// `mcp-diagnostic`: the window computes a diagnostic tool's answer (ADR-0094).
    Diagnostic(DiagnosticRequest),
}

/// Delivers an event to the window; `false` when there is no window to deliver it to.
pub type Emitter = Arc<dyn Fn(McpEvent) -> bool + Send + Sync>;

pub struct McpContext {
    pub registry: Arc<RwLock<KubeconfigRegistry>>,
    pub clusters: ClusterManager,
    pub forwarder: Arc<PortForwarder>,
    pub settings: Arc<SettingsStore>,
    pub audit: AuditLog,
    /// Shared with the extensions' API (`AppState::ext_api`): one pending map, one answer command.
    pub confirmations: Arc<Confirmations>,
    /// Ids of the port forwards agents started: `port_forward_list`/`port_forward_stop` see only these.
    pub agent_forwards: Mutex<HashSet<String>>,
    /// Diagnostic requests waiting for the window's answer (`mcp_diagnostic_answer`).
    pub window: WindowRequests,
    token_path: PathBuf,
    /// The token requests must carry; read on every request, so a new token works (and the old one stops) at once.
    token: RwLock<Option<Token>>,
    emitter: RwLock<Option<Emitter>>,
}

impl McpContext {
    /// `config_dir` holds `mcp-token`, `data_dir` holds `mcp-audit.jsonl`.
    pub fn new(
        registry: Arc<RwLock<KubeconfigRegistry>>,
        clusters: ClusterManager,
        forwarder: Arc<PortForwarder>,
        settings: Arc<SettingsStore>,
        config_dir: &Path,
        data_dir: &Path,
    ) -> Self {
        Self {
            registry,
            clusters,
            forwarder,
            settings,
            audit: AuditLog::open(AuditLog::path_in(data_dir)),
            confirmations: Arc::new(Confirmations::default()),
            agent_forwards: Mutex::new(HashSet::new()),
            window: WindowRequests::default(),
            token_path: paths::token_path(config_dir),
            token: RwLock::new(None),
            emitter: RwLock::new(None),
        }
    }

    /// Where events go from now on (the window; tests capture them).
    pub fn set_emitter(&self, emitter: Emitter) {
        *self.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
    }

    /// Sends an event to the window; `false` when nobody receives it.
    pub fn emit(&self, event: McpEvent) -> bool {
        let emitter = self
            .emitter
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        emitter.is_some_and(|emit| emit(event))
    }

    /// The token, created on first use.
    pub fn token(&self) -> io::Result<Token> {
        if let Some(token) = self.token.read().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(token);
        }
        let mut slot = self.token.write().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = slot.clone() {
            return Ok(token);
        }
        let token = token::load_or_create(&self.token_path)?;
        *slot = Some(token.clone());
        Ok(token)
    }

    /// Replaces the token; the old one stops working with the next request.
    pub fn regenerate_token(&self) -> io::Result<Token> {
        let mut slot = self.token.write().unwrap_or_else(|e| e.into_inner());
        let token = token::regenerate(&self.token_path)?;
        *slot = Some(token.clone());
        Ok(token)
    }

    /// Whether `candidate` is the current token (compared in constant time).
    pub fn token_matches(&self, candidate: &str) -> bool {
        self.token().is_ok_and(|token| token.matches(candidate))
    }

    /// Every cluster of the kubeconfig sources.
    pub fn cluster_list(&self) -> Vec<ClusterInfo> {
        self.registry
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clusters()
            .unwrap_or_default()
    }

    /// The name the user sees: the display name from the cluster settings, else the context.
    pub fn cluster_name(&self, id: &ClusterId) -> String {
        let display = self
            .settings
            .get()
            .clusters
            .get(&id.0)
            .and_then(|c| c.display_name.clone())
            .filter(|n| !n.trim().is_empty());
        display.unwrap_or_else(|| {
            self.cluster_list()
                .into_iter()
                .find(|c| &c.id == id)
                .map(|c| c.context)
                .unwrap_or_else(|| id.0.clone())
        })
    }
}
