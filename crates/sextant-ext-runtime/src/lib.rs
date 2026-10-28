//! Extension backends (ADR-0131): WebAssembly components of the world `sextant:extension/backend` (the WIT in
//! `sdk/wit/sextant-extension.wit`), run by wasmtime with nothing behind them but what the embedder's [`Host`] gives.
//!
//! - **Compile once.** [`Runtime::compile`] checks a component (size, the `handle` export, imports this runtime can
//!   satisfy) and compiles it; [`Backend::serialize`] and [`Runtime::load`] keep the compiled form between runs.
//! - **A fresh instance per call.** [`Runtime::invoke`] instantiates the backend in a new store, calls `handle` and
//!   drops the store: nothing a backend did survives but what it wrote through the host.
//! - **No ambient access.** WASI 0.2 is linked with an empty context: no environment, arguments or preopened
//!   directories, every socket address refused, stdin closed; stdout and stderr are captured (capped) and handed to
//!   [`Host::log`]. Clocks and random numbers work. `wasi:http/outgoing-handler` sends nothing itself: each request,
//!   with its body read within [`Limits::request_body_bytes`], goes to [`Host::http`], which applies the embedder's
//!   policy (declared hosts, address checks) and answers or refuses.
//! - **Limits per call** ([`Limits`]): wall time by epoch interruption, linear memory and table size, payload size.
//!
//! The runtime knows nothing about clusters, extensions or settings: `host.call` is passed on to [`Host::call`] as
//! method name and JSON text.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, ResourceLimiter, Store};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../../sdk/wit",
        world: "backend",
        imports: { default: async },
        exports: { default: async },
    });
}

use bindings::sextant::extension::host as wit_host;

/// The contract, for the SDK and the embedder's tests.
pub const WIT: &str = include_str!("../../../sdk/wit/sextant-extension.wit");
/// A component larger than this is refused before it is compiled.
pub const MAX_COMPONENT_BYTES: usize = 16 * 1024 * 1024;
/// How often the epoch advances; a call's time limit is counted in these.
const EPOCH_TICK: Duration = Duration::from_millis(50);

/// What one call may use.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Wall time of the whole call, instantiation included.
    pub time: Duration,
    /// Linear memory, summed over the component's memories.
    pub memory_bytes: usize,
    /// Elements of every table together.
    pub table_elements: usize,
    /// `params` in, the result out, and each `host.call`'s parameters and answer.
    pub payload_bytes: usize,
    /// A request body the backend sends over HTTP.
    pub request_body_bytes: usize,
    /// What stdout and stderr keep each (the rest is dropped).
    pub output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            time: Duration::from_secs(10),
            memory_bytes: 64 * 1024 * 1024,
            table_elements: 10_000,
            payload_bytes: 1024 * 1024,
            request_body_bytes: 1024 * 1024,
            output_bytes: 16 * 1024,
        }
    }
}

/// An error `host.call` answers the backend with: the extension API's code and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub code: String,
    pub message: String,
}

/// A line of the backend's log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

/// An HTTP request a backend sends, its body already read.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: http::Method,
    pub uri: http::Uri,
    pub headers: http::HeaderMap,
    pub body: Bytes,
}

/// The answer to an [`HttpRequest`], its body read whole by the embedder within its own limit.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: http::StatusCode,
    pub headers: http::HeaderMap,
    pub body: Bytes,
}

/// Why a request was not answered; the backend sees the matching `wasi:http` error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// The policy refused it (a host that is not declared, a forbidden address, plain HTTP).
    Denied,
    /// The host name did not resolve.
    Dns(String),
    /// Connecting or reading took too long.
    Timeout,
    /// The response body was larger than the embedder allows.
    TooLarge,
    /// Anything else (refused connection, TLS failure).
    Failed(String),
}

/// A future the host returns.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a backend reaches through Sextant. Implemented by the embedder for one extension.
pub trait Host: Send + Sync + 'static {
    /// `host.call(method, params)`: one method of the extension API with the extension's grant.
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: &'a str,
    ) -> HostFuture<'a, Result<String, CallError>>;
    /// A line from `host.log`, stdout or stderr.
    fn log(&self, level: Level, message: &str);
    /// A request through `wasi:http/outgoing-handler`.
    fn http(&self, request: HttpRequest) -> HostFuture<'static, Result<HttpResponse, HttpError>>;
}

/// Why a component cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileError {
    TooLarge {
        bytes: usize,
    },
    /// Not a component, or not a valid one.
    Invalid(String),
    /// It needs something this runtime does not provide, or lacks the `handle` export.
    Incompatible(String),
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { bytes } => write!(
                f,
                "the backend is {bytes} bytes; at most {MAX_COMPONENT_BYTES} are allowed"
            ),
            Self::Invalid(why) => {
                write!(f, "the backend is not a valid WebAssembly component: {why}")
            }
            Self::Incompatible(why) => write!(f, "the backend does not fit Sextant: {why}"),
        }
    }
}

impl std::error::Error for CompileError {}

/// Why a call did not return the backend's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvokeError {
    /// `handle` returned an error: the backend's own message.
    Backend(String),
    /// It ran past [`Limits::time`].
    Timeout,
    /// It asked for more memory or table space than [`Limits`] allow.
    OutOfMemory,
    /// `params` or the answer is larger than [`Limits::payload_bytes`].
    PayloadTooLarge,
    /// It trapped (a panic, an unreachable instruction, a failed host call); the text is wasmtime's.
    Trap(String),
}

impl std::fmt::Display for InvokeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Backend(message) => f.write_str(message),
            Self::Timeout => f.write_str("the backend ran out of time"),
            Self::OutOfMemory => f.write_str("the backend ran out of memory"),
            Self::PayloadTooLarge => f.write_str("the call's parameters or answer are too large"),
            Self::Trap(why) => write!(f, "the backend failed: {why}"),
        }
    }
}

impl std::error::Error for InvokeError {}

/// A compiled backend, ready to be instantiated for each call.
#[derive(Clone)]
pub struct Backend {
    pre: bindings::BackendPre<State>,
}

impl Backend {
    /// The compiled code, for [`Runtime::load`] on a later run of the same wasmtime.
    pub fn serialize(&self) -> Result<Vec<u8>, CompileError> {
        self.pre
            .instance_pre()
            .component()
            .serialize()
            .map_err(|e| CompileError::Invalid(e.to_string()))
    }
}

/// The per-call limiter: [`Limits`], and whether a limit was hit (a refused `memory.grow` usually ends in a trap whose
/// text does not say why).
struct CallLimiter {
    memory_bytes: usize,
    table_elements: usize,
    hit: bool,
}

impl ResourceLimiter for CallLimiter {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let ok = desired <= self.memory_bytes;
        self.hit |= !ok;
        Ok(ok)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let ok = desired <= self.table_elements;
        self.hit |= !ok;
        Ok(ok)
    }

    fn instances(&self) -> usize {
        // A component holds several core instances (its modules, adapters, a JS engine's parts).
        64
    }

    fn tables(&self) -> usize {
        64
    }

    fn memories(&self) -> usize {
        16
    }
}

/// Sends every `wasi:http` request to [`Host::http`].
struct Hooks {
    host: Arc<dyn Host>,
    request_body_bytes: usize,
}

impl WasiHttpHooks for Hooks {
    fn is_supported_scheme(&mut self, scheme: &http::uri::Scheme) -> bool {
        *scheme == http::uri::Scheme::HTTPS
    }

    fn send_request(
        &mut self,
        request: http::Request<wasmtime_wasi_http::WasiBody>,
        _options: Option<wasmtime_wasi_http::RequestOptions>,
        fut: Box<dyn Future<Output = Result<(), wasmtime_wasi_http::Error>> + Send>,
    ) -> Box<
        dyn Future<
                Output = Result<
                    (
                        http::Response<wasmtime_wasi_http::WasiBody>,
                        Box<dyn Future<Output = Result<(), wasmtime_wasi_http::Error>> + Send>,
                    ),
                    wasmtime_wasi_http::Error,
                >,
            > + Send,
    > {
        drop(fut);
        let host = Arc::clone(&self.host);
        let limit = self.request_body_bytes;
        Box::new(async move {
            use wasmtime_wasi_http::Error as E;
            let (parts, body) = request.into_parts();
            let body = http_body_util::Limited::new(body, limit)
                .collect()
                .await
                .map_err(|_| E::HttpRequestBodySize(None))?
                .to_bytes();
            let answer = host
                .http(HttpRequest {
                    method: parts.method,
                    uri: parts.uri,
                    headers: parts.headers,
                    body,
                })
                .await
                .map_err(|e| match e {
                    HttpError::Denied => E::HttpRequestDenied,
                    HttpError::Dns(_) => E::DnsError {
                        rcode: None,
                        info_code: None,
                    },
                    HttpError::Timeout => E::ConnectionTimeout,
                    HttpError::TooLarge => E::HttpResponseBodySize(None),
                    HttpError::Failed(_) => E::ConnectionRefused,
                })?;
            let mut response = http::Response::new(
                Full::new(answer.body)
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            );
            *response.status_mut() = answer.status;
            *response.headers_mut() = answer.headers;
            let done: Box<dyn Future<Output = Result<(), E>> + Send> = Box::new(async { Ok(()) });
            Ok((response, done))
        })
    }
}

/// What a store holds for one call.
struct State {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    hooks: Hooks,
    table: ResourceTable,
    limiter: CallLimiter,
    host: Arc<dyn Host>,
    payload_bytes: usize,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for State {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.hooks,
        }
    }
}

impl wit_host::Host for State {
    async fn call(
        &mut self,
        method: String,
        params: String,
    ) -> Result<String, wit_host::CallError> {
        let too_large = |what: &str| wit_host::CallError {
            code: "invalid".to_owned(),
            message: format!(
                "the {what} of {method} is larger than {} bytes",
                self.payload_bytes
            ),
        };
        if params.len() > self.payload_bytes {
            return Err(too_large("parameters"));
        }
        match self.host.call(&method, &params).await {
            Ok(answer) if answer.len() > self.payload_bytes => Err(too_large("answer")),
            Ok(answer) => Ok(answer),
            Err(e) => Err(wit_host::CallError {
                code: e.code,
                message: e.message,
            }),
        }
    }

    async fn log(&mut self, level: wit_host::Level, message: String) {
        let level = match level {
            wit_host::Level::Debug => Level::Debug,
            wit_host::Level::Info => Level::Info,
            wit_host::Level::Warn => Level::Warn,
            wit_host::Level::Error => Level::Error,
        };
        self.host.log(level, &message);
    }
}

/// Stops the epoch thread when the runtime goes.
struct Ticker {
    stop: Arc<AtomicBool>,
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The engine, the linker with everything a backend may import, and the epoch clock. One per app.
pub struct Runtime {
    engine: Engine,
    linker: Linker<State>,
    _ticker: Ticker,
}

impl Runtime {
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.epoch_interruption(true);
        let engine = Engine::new(&config).map_err(|e| e.to_string())?;
        let mut linker = Linker::<State>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker).map_err(|e| e.to_string())?;
        wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)
            .map_err(|e| e.to_string())?;
        bindings::Backend::add_to_linker::<State, wasmtime::component::HasSelf<State>>(
            &mut linker,
            |s| s,
        )
        .map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let ticking = engine.clone();
        let stopped = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("sextant-ext-epoch".to_owned())
            .spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    std::thread::sleep(EPOCH_TICK);
                    ticking.increment_epoch();
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            engine,
            linker,
            _ticker: Ticker { stop },
        })
    }

    /// Checks and compiles a component.
    pub fn compile(&self, wasm: &[u8]) -> Result<Backend, CompileError> {
        if wasm.len() > MAX_COMPONENT_BYTES {
            return Err(CompileError::TooLarge { bytes: wasm.len() });
        }
        let component = Component::new(&self.engine, wasm)
            .map_err(|e| CompileError::Invalid(format!("{e:#}")))?;
        self.prepare(&component)
    }

    /// A backend from [`Backend::serialize`]'s bytes, which must come from this app's own files: wasmtime trusts
    /// them as compiled code. Bytes of another wasmtime version are refused (compile again).
    pub fn load(&self, compiled: &[u8]) -> Result<Backend, CompileError> {
        // SAFETY: the bytes are what `Backend::serialize` wrote into Sextant's own data directory; wasmtime checks
        // the version and configuration they were made with.
        let component = unsafe { Component::deserialize(&self.engine, compiled) }
            .map_err(|e| CompileError::Invalid(format!("{e:#}")))?;
        self.prepare(&component)
    }

    fn prepare(&self, component: &Component) -> Result<Backend, CompileError> {
        // Only WASI and Sextant's own interfaces, whatever the linker could satisfy (an import with nothing in it
        // links trivially, and it would still be a door the manifest does not name).
        let ty = component.component_type();
        if let Some((name, _)) = ty.imports(&self.engine).find(|(name, _)| {
            !(name.starts_with("wasi:") || name.starts_with("sextant:extension/"))
        }) {
            return Err(CompileError::Incompatible(format!(
                "it imports `{name}`; a backend may import only WASI and sextant:extension"
            )));
        }
        let pre = self
            .linker
            .instantiate_pre(component)
            .map_err(|e| CompileError::Incompatible(format!("{e:#}")))?;
        let pre = bindings::BackendPre::new(pre)
            .map_err(|e| CompileError::Incompatible(format!("{e:#}")))?;
        Ok(Backend { pre })
    }

    /// Runs `handle(method, params)` in a fresh instance within `limits`.
    pub async fn invoke(
        &self,
        backend: &Backend,
        host: Arc<dyn Host>,
        method: &str,
        params: &str,
        limits: &Limits,
    ) -> Result<String, InvokeError> {
        if params.len() > limits.payload_bytes {
            return Err(InvokeError::PayloadTooLarge);
        }
        let stdout = MemoryOutputPipe::new(limits.output_bytes);
        let stderr = MemoryOutputPipe::new(limits.output_bytes);
        let wasi = WasiCtxBuilder::new()
            .stdout(stdout.clone())
            .stderr(stderr.clone())
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false)
            .build();
        let mut store = Store::new(
            &self.engine,
            State {
                wasi,
                http: WasiHttpCtx::new(),
                hooks: Hooks {
                    host: Arc::clone(&host),
                    request_body_bytes: limits.request_body_bytes,
                },
                table: ResourceTable::new(),
                limiter: CallLimiter {
                    memory_bytes: limits.memory_bytes,
                    table_elements: limits.table_elements,
                    hit: false,
                },
                host: Arc::clone(&host),
                payload_bytes: limits.payload_bytes,
            },
        );
        store.limiter(|s| &mut s.limiter);
        let ticks = limits
            .time
            .as_millis()
            .div_ceil(EPOCH_TICK.as_millis())
            .max(1);
        store.set_epoch_deadline(u64::try_from(ticks).unwrap_or(u64::MAX));
        store.epoch_deadline_trap();

        let run = async {
            let instance = backend.pre.instantiate_async(&mut store).await?;
            instance.call_handle(&mut store, method, params).await
        };
        let result = run.await;
        let hit = store.data().limiter.hit;
        drop(store);
        for (pipe, level) in [(stdout, Level::Info), (stderr, Level::Warn)] {
            let text = pipe.contents();
            if !text.is_empty() {
                host.log(level, &String::from_utf8_lossy(&text));
            }
        }
        match result {
            Ok(Ok(answer)) if answer.len() > limits.payload_bytes => {
                Err(InvokeError::PayloadTooLarge)
            }
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(message)) => Err(InvokeError::Backend(message)),
            Err(error) => Err(
                if error.downcast_ref::<wasmtime::Trap>() == Some(&wasmtime::Trap::Interrupt) {
                    InvokeError::Timeout
                } else if hit {
                    InvokeError::OutOfMemory
                } else {
                    InvokeError::Trap(format!("{error:#}"))
                },
            ),
        }
    }
}
