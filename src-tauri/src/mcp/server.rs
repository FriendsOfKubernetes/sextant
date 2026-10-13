//! The MCP server in the application: started, stopped and restarted by the settings (`mcp.enabled`, `mcp.port`),
//! listening only on `127.0.0.1:<port>/mcp`, with the tools of `tools_read` (and `tools_write`, task 04).

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, JsonObject, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use sextant_core::{AppSettings, CoreError, ErrorCode};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::audit::{AuditDecision, AuditEntry};
use super::context::{Emitter, McpContext, McpEvent};
use super::guard::{ClusterKinds, Guard, KindLookup, Refusal};
use super::http;
use super::token::Token;
use super::tools::{ToolCall, ToolError, ToolResult, ToolSet, to_call_result};
use super::tools_read;

/// Ports the user may choose.
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = 1024..=65535;

/// How long a stopping server waits for its connections before it lets go of the port anyway.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// Extra tries to bind a port that is in use, and the pause between them.
const BIND_RETRIES: u32 = 4;
const BIND_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Whether the server runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum McpState {
    Off,
    Running,
    /// It should run but cannot (port taken, …); `error` says why.
    Error,
}

/// `mcp_status` and the payload of the `mcp-status` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct McpStatus {
    pub state: McpState,
    /// `http://127.0.0.1:<port>/mcp` while running.
    pub url: Option<String>,
    pub error: Option<String>,
}

impl McpStatus {
    fn off() -> Self {
        Self {
            state: McpState::Off,
            url: None,
            error: None,
        }
    }
}

/// The URL of a server on `port`.
pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{}", http::MCP_PATH)
}

/// Every tool the server offers.
pub fn all_tools() -> ToolSet {
    let mut tools = ToolSet::new();
    tools_read::register_read_tools(&mut tools);
    register_write_tools(&mut tools);
    tools
}

use super::tools_write::register_write_tools;

/// The MCP handler: one per session, all sharing the context and the tools.
#[derive(Clone)]
pub struct SextantMcp {
    ctx: Arc<McpContext>,
    kinds: Arc<dyn KindLookup>,
    tools: Arc<ToolSet>,
    /// Cancelled when the server this handler belongs to stops: its calls end refused, nothing more is run.
    stopped: CancellationToken,
}

impl SextantMcp {
    pub fn new(
        ctx: Arc<McpContext>,
        kinds: Arc<dyn KindLookup>,
        tools: Arc<ToolSet>,
        stopped: CancellationToken,
    ) -> Self {
        Self {
            ctx,
            kinds,
            tools,
            stopped,
        }
    }

    pub fn context(&self) -> &Arc<McpContext> {
        &self.ctx
    }

    /// Runs a tool for `client` and journals the call (`mcp-audit`). When the server stops while the call runs, the
    /// call is dropped where it is (rmcp does not cancel a handler itself) and ends refused.
    pub async fn call(&self, client: &str, tool: &str, arguments: JsonObject) -> ToolResult {
        let at = now_ms();
        let started = Instant::now();
        let guard = Guard::new(
            Arc::clone(&self.ctx),
            Arc::clone(&self.kinds),
            self.stopped.clone(),
            client,
            tool,
        );
        let client = guard.client().to_owned();
        let record = guard.record_handle();
        let run = async {
            match self.tools.find(tool).cloned() {
                Some(def) => def.run(ToolCall { guard }, arguments).await,
                None => Err(ToolError::Failed(CoreError::new(
                    ErrorCode::Invalid,
                    format!("unknown tool {tool}"),
                ))),
            }
        };
        let result = tokio::select! {
            biased;
            () = self.stopped.cancelled() => Err(ToolError::Refused(Refusal::Stopped)),
            result = run => result,
        };
        if matches!(result, Err(ToolError::Refused(Refusal::Stopped))) {
            lock(&record).decision = Some(AuditDecision::Denied);
        }
        let record = lock(&record).clone();
        let entry = AuditEntry {
            at,
            client,
            cluster_id: record.cluster.as_ref().map(|c| c.id.clone()),
            cluster_name: record.cluster.as_ref().map(|c| c.name.clone()),
            tool: tool.to_owned(),
            target: record.target.clone(),
            decision: record.decision.unwrap_or(AuditDecision::Allowed),
            result: match &result {
                Ok(_) => "ok".to_owned(),
                Err(e) => error_code_name(e),
            },
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        self.ctx.audit.record(entry.clone());
        self.ctx.emit(McpEvent::Audit(entry));
        result
    }
}

fn error_code_name(error: &ToolError) -> String {
    serde_json::to_value(error.code())
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The client's name: from `initialize`, else its `User-Agent`, else `unknown`.
fn client_name(context: &RequestContext<RoleServer>) -> String {
    let from_initialize = context
        .peer
        .peer_info()
        .map(|info| info.client_info.name.clone())
        // rmcp fills a stateless request with its own name.
        .filter(|name| !name.trim().is_empty() && *name != Implementation::default().name);
    let from_header = || {
        context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.headers.get(axum::http::header::USER_AGENT))
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(80).collect::<String>())
            .filter(|s| !s.trim().is_empty())
    };
    from_initialize
        .or_else(from_header)
        .unwrap_or_else(|| "unknown".to_owned())
}

const INSTRUCTIONS: &str = "Sextant gives access to the user's Kubernetes clusters. Start with list_clusters; \
list_kinds shows what you may touch in a cluster. The user decides per cluster, namespace, kind and action what you \
may do; a refused call says how the user can allow it. Changes may wait for the user's confirmation in Sextant.";

impl ServerHandler for SextantMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sextant", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let client = client_name(&context);
        let arguments = request.arguments.unwrap_or_default();
        let result = self.call(&client, &request.name, arguments).await;
        Ok(to_call_result(&result).into())
    }
}

/// A running HTTP server.
struct Running {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

/// The server's life: kept in `AppState.mcp`.
pub struct McpServer {
    ctx: Arc<McpContext>,
    kinds: Arc<dyn KindLookup>,
    tools: Arc<ToolSet>,
    running: Mutex<Option<Running>>,
    /// The token of the current (or last) server: its sessions and the calls that came through it end when it is
    /// cancelled. Never cancelled before the first stop, so tests may call tools without a server.
    serving: Mutex<CancellationToken>,
    /// Grows with every [`McpServer::stop`] (under the `running` lock): a start that began before it does not run.
    stops: AtomicU64,
    status: Mutex<McpStatus>,
    /// One start or restart at a time ([`McpServer::stop`] does not wait for it, see `stops`).
    changing: tokio::sync::Mutex<()>,
}

impl McpServer {
    pub fn new(ctx: McpContext) -> Self {
        let kinds = Arc::new(ClusterKinds(ctx.clusters.clone()));
        Self::with_parts(Arc::new(ctx), kinds, Arc::new(all_tools()))
    }

    /// A server with its own kind lookup and tools (tests).
    pub fn with_parts(
        ctx: Arc<McpContext>,
        kinds: Arc<dyn KindLookup>,
        tools: Arc<ToolSet>,
    ) -> Self {
        Self {
            ctx,
            kinds,
            tools,
            running: Mutex::new(None),
            serving: Mutex::new(CancellationToken::new()),
            stops: AtomicU64::new(0),
            status: Mutex::new(McpStatus::off()),
            changing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn context(&self) -> &Arc<McpContext> {
        &self.ctx
    }

    /// The handler of the current server (tests call tools through it without HTTP); its calls end refused when
    /// that server stops.
    pub fn handler(&self) -> SextantMcp {
        self.handler_with(lock(&self.serving).clone())
    }

    fn handler_with(&self, stopped: CancellationToken) -> SextantMcp {
        SextantMcp::new(
            Arc::clone(&self.ctx),
            Arc::clone(&self.kinds),
            Arc::clone(&self.tools),
            stopped,
        )
    }

    /// Where `mcp-status`, `mcp-confirm` and `mcp-audit` go.
    pub fn set_emitter(&self, emitter: Emitter) {
        self.ctx.set_emitter(emitter);
    }

    pub fn status(&self) -> McpStatus {
        lock(&self.status).clone()
    }

    /// The token (created on first use).
    pub fn token(&self) -> io::Result<Token> {
        self.ctx.token()
    }

    /// Starts, stops or restarts the server to match `settings.mcp`. Nothing happens when it already runs on the
    /// right port.
    pub async fn apply_settings(&self, settings: &AppSettings) {
        let stops = self.stops.load(Ordering::SeqCst);
        let _changing = self.changing.lock().await;
        let wanted = settings.mcp.enabled.then_some(settings.mcp.port);
        let current = lock(&self.running).as_ref().map(|r| r.port);
        if wanted.is_some() && wanted == current {
            return;
        }
        self.shut_down().await;
        match wanted {
            None => self.set_status(McpStatus::off()),
            Some(port) => self.start(port, stops).await,
        }
    }

    /// A new token: the old one stops working at once and every session ends (a running server restarts).
    pub async fn regenerate_token(&self) -> io::Result<Token> {
        let stops = self.stops.load(Ordering::SeqCst);
        let _changing = self.changing.lock().await;
        let token = self.ctx.regenerate_token()?;
        let port = lock(&self.running).as_ref().map(|r| r.port);
        if let Some(port) = port {
            self.shut_down().await;
            self.start(port, stops).await;
        }
        Ok(token)
    }

    /// Stops at once (window closed, application exiting): the port is released, sessions end, waiting
    /// confirmations are refused.
    ///
    /// Calls that came through it end refused, and none of them asks or acts any more; a start in progress does not
    /// leave a listener behind.
    pub fn stop(&self) {
        let running = {
            let mut running = lock(&self.running);
            self.stops.fetch_add(1, Ordering::SeqCst);
            lock(&self.serving).cancel();
            running.take()
        };
        self.ctx.confirmations.close();
        if let Some(running) = running {
            running.task.abort();
        }
        if self.status().state != McpState::Off {
            self.set_status(McpStatus::off());
        }
    }

    /// Starts on `port` unless [`McpServer::stop`] ran since `stops` was read.
    async fn start(&self, port: u16, stops: u64) {
        if !PORT_RANGE.contains(&port) {
            return self.set_error(format!(
                "Port {port} is outside {}–{}",
                PORT_RANGE.start(),
                PORT_RANGE.end()
            ));
        }
        if let Err(e) = self.ctx.token() {
            return self.set_error(format!("Cannot create the MCP token: {e}"));
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let listener = match bind(address).await {
            Ok(listener) => listener,
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                return self.set_error(format!(
                    "Port {port} is in use — another Sextant or program?"
                ));
            }
            Err(e) => return self.set_error(format!("Cannot listen on {address}: {e}")),
        };
        let mut running = lock(&self.running);
        if self.stops.load(Ordering::SeqCst) != stops {
            // Stopped (window closed) while binding: the listener goes, nothing runs.
            return;
        }
        let serving = CancellationToken::new();
        *lock(&self.serving) = serving.clone();
        self.ctx.confirmations.open();
        let router = http::router(self.handler_with(serving.clone()), port, serving.clone());
        let shutdown = serving.cancelled_owned();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .await;
        });
        *running = Some(Running { port, task });
        // Under the `running` lock, so a stop that follows sets `off` after this.
        self.set_status(McpStatus {
            state: McpState::Running,
            url: Some(url(port)),
            error: None,
        });
    }

    /// Stops the running server, giving open connections [`STOP_GRACE`] to finish; the port is free on return.
    async fn shut_down(&self) {
        let running = {
            let mut running = lock(&self.running);
            lock(&self.serving).cancel();
            running.take()
        };
        self.ctx.confirmations.close();
        let Some(Running { task, .. }) = running else {
            return;
        };
        let mut task = task;
        if tokio::time::timeout(STOP_GRACE, &mut task).await.is_err() {
            task.abort();
            // Dropping the aborted task closes its listener: the port is free once this returns.
            let _ = task.await;
        }
    }

    fn set_error(&self, error: String) {
        self.set_status(McpStatus {
            state: McpState::Error,
            url: None,
            error: Some(error),
        });
    }

    fn set_status(&self, status: McpStatus) {
        *lock(&self.status) = status.clone();
        self.ctx.emit(McpEvent::Status(status));
    }
}

/// Binds `address`; a port that is in use is tried a few more times for a moment (a port this server just released,
/// or one an outgoing connection held for an instant), then reported.
async fn bind(address: SocketAddr) -> io::Result<tokio::net::TcpListener> {
    let mut tries = 0;
    loop {
        match tokio::net::TcpListener::bind(address).await {
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && tries < BIND_RETRIES => {
                tries += 1;
                tokio::time::sleep(BIND_RETRY_DELAY).await;
            }
            result => return result,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
