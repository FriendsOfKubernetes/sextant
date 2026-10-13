//! `sextant mcp`: a stdio proxy for MCP clients that start their servers as commands (Claude Desktop). It reads
//! JSON-RPC lines from stdin, posts them to the MCP server of the running application (`127.0.0.1:<port>/mcp`,
//! port from `settings.json`, token from `mcp-token`) and writes the answers (JSON or an event stream) to stdout,
//! one message per line.
//!
//! stdout carries JSON-RPC and nothing else; diagnostics go to stderr, and the token goes nowhere. The proxy only
//! reads the token file: the application makes and changes the token.
//!
//! The HTTP side is a small HTTP/1.1 client over a loopback TCP socket (one connection per request): the proxy
//! only ever talks to `127.0.0.1`, so it needs neither TLS nor connection pooling, and no HTTP client crate.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::mcp::http::MCP_PATH;
use crate::mcp::paths;
use crate::mcp::token::{self, Token};

/// What the client is told when the application cannot be reached.
pub const NOT_RUNNING: &str = "Sextant is not running or its MCP server is off — open Sextant and enable it in Settings → AI agents (MCP)";

const REJECTED: &str =
    "Sextant did not accept the MCP token — it may have been regenerated; restart this MCP client";
const SESSION_ENDED: &str = "The Sextant MCP session has ended (Sextant was restarted or its MCP server was reconfigured) — restart this MCP client";
const LOST: &str = "The connection to Sextant was lost — restart this MCP client";

/// JSON-RPC "server error" (the range -32000..-32099 is for the implementation).
const SERVER_ERROR: i64 = -32000;
const PARSE_ERROR: i64 = -32700;

/// The port when `settings.json` has none (`DEFAULT_MCP_PORT` of the settings).
const DEFAULT_PORT: u16 = sextant_core::settings::DEFAULT_MCP_PORT;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Ending the session on the server is a courtesy; it must not hold the exit.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// A reply's head (status line and headers) is small; a longer one is not from our server.
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// A JSON reply or an error body is read whole; longer is not from our server (tool results are cut at ~256 KB).
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Where the server is and what it wants to see.
#[derive(Debug)]
pub struct Target {
    port: u16,
    token: Token,
}

/// The server of the application whose files are in `config_dir`: the port from `settings.json`, the token from
/// `mcp-token`. `Err` is the text for the client: no token (the server never ran) or `mcp.enabled` false.
pub fn resolve_target(config_dir: &Path) -> Result<Target, String> {
    let settings = std::fs::read_to_string(paths::settings_path(config_dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let mcp = settings.as_ref().map(|s| &s["mcp"]);
    if !mcp.and_then(|m| m["enabled"].as_bool()).unwrap_or(false) {
        return Err(NOT_RUNNING.to_owned());
    }
    let port = mcp
        .and_then(|m| m["port"].as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PORT);
    match token::load(&paths::token_path(config_dir)) {
        Ok(Some(token)) => Ok(Target { port, token }),
        Ok(None) => Err(NOT_RUNNING.to_owned()),
        Err(e) => Err(format!("Cannot read the Sextant MCP token: {e}")),
    }
}

/// How a delivery went wrong in a way that ends the proxy: the client is told, then the process exits with 1.
enum Failure {
    /// The text for the client and for stderr.
    Fatal(String),
    /// An answer that is not the server's (the request fails, the proxy goes on).
    Request(String),
}

/// What the tasks tell the loop that writes stdout.
enum Output {
    Line(String),
    Fatal(String),
}

struct Shared {
    target: Result<Target, String>,
    /// `Mcp-Session-Id` the server gave to `initialize`.
    session: Mutex<Option<String>>,
}

/// Forwards the lines of `input` (`None` — stdin closed) to the server and writes what comes back to `output`.
/// Requests run side by side (a slow tool does not hold a cancellation). `true` if the input ended and every
/// request was answered; `false` after a failure that ended the proxy.
pub async fn proxy<W: Write + Send>(
    target: Result<Target, String>,
    mut input: mpsc::Receiver<String>,
    mut output: W,
) -> bool {
    let shared = Arc::new(Shared {
        target,
        session: Mutex::new(None),
    });
    let (tx, mut rx) = mpsc::unbounded_channel::<Output>();
    let mut tasks = JoinSet::new();
    let mut input_open = true;
    loop {
        if !input_open && tasks.is_empty() {
            // Everything a task sent is already in the channel (it sends before it ends).
            while let Ok(item) = rx.try_recv() {
                if !write_item(&mut output, item) {
                    return false;
                }
            }
            break;
        }
        tokio::select! {
            line = input.recv(), if input_open => match line {
                Some(line) if line.trim().is_empty() => {}
                Some(line) if opens_session(&line) => {
                    // Nothing else goes before the session id is known (a client that sends at once would
                    // otherwise race it); an answer to `initialize` is what a client waits for anyway.
                    forward(Arc::clone(&shared), line, tx.clone()).await;
                    while let Ok(item) = rx.try_recv() {
                        if !write_item(&mut output, item) {
                            return false;
                        }
                    }
                }
                Some(line) => {
                    tasks.spawn(forward(Arc::clone(&shared), line, tx.clone()));
                }
                None => input_open = false,
            },
            Some(item) = rx.recv() => {
                if !write_item(&mut output, item) {
                    return false;
                }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    close_session(&shared).await;
    true
}

/// Whether the line is an `initialize` request (it opens the session).
fn opens_session(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|m| m["method"] == "initialize")
}

/// Writes one item; `false` — the proxy ends (a fatal failure, or nobody reads stdout any more).
fn write_item<W: Write>(output: &mut W, item: Output) -> bool {
    match item {
        Output::Line(line) => writeln!(output, "{line}")
            .and_then(|()| output.flush())
            .is_ok(),
        Output::Fatal(text) => {
            eprintln!("sextant mcp: {text}");
            false
        }
    }
}

/// Posts one line of the client and sends the answers on.
async fn forward(shared: Arc<Shared>, line: String, out: mpsc::UnboundedSender<Output>) {
    let message = match serde_json::from_str::<Value>(&line) {
        Ok(message) => message,
        Err(_) => {
            let _ = out.send(Output::Line(error_message(
                &Value::Null,
                PARSE_ERROR,
                "Parse error: the line is not JSON",
            )));
            return;
        }
    };
    let ids = request_ids(&message);
    match deliver(&shared, &line, &out).await {
        Ok(()) => {}
        Err(failure) => {
            let (text, fatal) = match failure {
                Failure::Fatal(text) => (text, true),
                Failure::Request(text) => (text, false),
            };
            for id in &ids {
                let _ = out.send(Output::Line(error_message(id, SERVER_ERROR, &text)));
            }
            if fatal {
                let _ = out.send(Output::Fatal(text));
            }
        }
    }
}

/// The ids of the requests in a message (one, or several in a batch); notifications have none.
fn request_ids(message: &Value) -> Vec<Value> {
    let one = |m: &Value| {
        (m.get("method").is_some())
            .then(|| m.get("id").cloned())
            .flatten()
    };
    match message {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        other => one(other).into_iter().collect(),
    }
}

fn error_message(id: &Value, code: i64, text: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }).to_string()
}

async fn deliver(
    shared: &Shared,
    body: &str,
    out: &mpsc::UnboundedSender<Output>,
) -> Result<(), Failure> {
    let target = shared
        .target
        .as_ref()
        .map_err(|text| Failure::Fatal(text.clone()))?;
    let session = shared
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut reply = request(target, "POST", session.as_deref(), Some(body))
        .await
        .map_err(|e| match e {
            ClientError::Connect => Failure::Fatal(NOT_RUNNING.to_owned()),
            ClientError::Io => Failure::Fatal(LOST.to_owned()),
        })?;
    match reply.status {
        401 | 403 => return Err(Failure::Fatal(REJECTED.to_owned())),
        404 if session.is_some() => return Err(Failure::Fatal(SESSION_ENDED.to_owned())),
        _ => {}
    }
    let lost = |_| Failure::Fatal(LOST.to_owned());
    if !(200..300).contains(&reply.status) {
        // Not an answer of the MCP layer unless it is JSON-RPC (rmcp answers some errors that way).
        let text = reply.read_all().await.map_err(lost)?;
        return match serde_json::from_slice::<Value>(&text) {
            Ok(value) if value.get("jsonrpc").is_some() => {
                let _ = out.send(Output::Line(compact(&String::from_utf8_lossy(&text))));
                Ok(())
            }
            _ => Err(Failure::Request(format!(
                "Sextant answered the request with HTTP status {}",
                reply.status
            ))),
        };
    }
    if session.is_none()
        && let Some(id) = reply.header("mcp-session-id")
    {
        *shared.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_owned());
    }
    if reply
        .header("content-type")
        .is_some_and(|t| t.to_ascii_lowercase().contains("text/event-stream"))
    {
        let mut events = EventParser::default();
        while let Some(piece) = reply.next_piece().await.map_err(lost)? {
            for data in events.push(&piece) {
                let _ = out.send(Output::Line(compact(&data)));
            }
        }
        for data in events.finish() {
            let _ = out.send(Output::Line(compact(&data)));
        }
    } else {
        let text = reply.read_all().await.map_err(lost)?;
        let text = String::from_utf8_lossy(&text);
        if !text.trim().is_empty() {
            let _ = out.send(Output::Line(compact(&text)));
        }
    }
    Ok(())
}

/// The message on one line (the framing of stdio): as it is when it has no line break, else re-written compact.
fn compact(text: &str) -> String {
    let text = text.trim();
    if !text.contains(['\n', '\r']) {
        return text.to_owned();
    }
    serde_json::from_str::<Value>(text)
        .map_or_else(|_| text.replace(['\n', '\r'], " "), |v| v.to_string())
}

/// Ends the session on the server (stdin is closed). Best effort.
async fn close_session(shared: &Shared) {
    let (Ok(target), Some(session)) = (
        shared.target.as_ref(),
        shared
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    ) else {
        return;
    };
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
        if let Ok(mut reply) = request(target, "DELETE", Some(&session), None).await {
            let _ = reply.read_all().await;
        }
    })
    .await;
}

// ---- the HTTP client ------------------------------------------------------------------------------------------

enum ClientError {
    /// The connection could not be made: nobody listens (the application is not running, the server is off).
    Connect,
    /// The connection broke or the server did not speak HTTP.
    Io,
}

/// How the body ends.
enum Framing {
    Length(usize),
    Chunked { left: usize, done: bool },
    UntilClose,
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    reader: BufReader<TcpStream>,
    framing: Framing,
}

/// Sends one request on a new connection (`Connection: close`) and reads the head of the answer.
async fn request(
    target: &Target,
    method: &str,
    session: Option<&str>,
    body: Option<&str>,
) -> Result<Reply, ClientError> {
    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, target.port)),
    )
    .await
    .map_err(|_| ClientError::Connect)?
    .map_err(|_| ClientError::Connect)?;

    let mut head = format!(
        "{method} {MCP_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\
         Accept: application/json, text/event-stream\r\nConnection: close\r\n",
        target.port,
        target.token.as_str()
    );
    if let Some(session) = session {
        head.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str("\r\n");

    let mut reader = BufReader::new(stream);
    let io = |_| ClientError::Io;
    reader
        .get_mut()
        .write_all(head.as_bytes())
        .await
        .map_err(io)?;
    if let Some(body) = body {
        reader
            .get_mut()
            .write_all(body.as_bytes())
            .await
            .map_err(io)?;
    }
    reader.get_mut().flush().await.map_err(io)?;

    let status_line = read_line(&mut reader).await?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(ClientError::Io)?;
    let mut headers = Vec::new();
    let mut head_bytes = status_line.len();
    loop {
        let line = read_line(&mut reader).await?;
        head_bytes += line.len();
        if line.is_empty() {
            break;
        }
        if head_bytes > MAX_HEAD_BYTES {
            return Err(ClientError::Io);
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    let find = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    };
    let framing =
        if find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            Framing::Chunked {
                left: 0,
                done: false,
            }
        } else if let Some(length) = find("content-length").and_then(|v| v.parse::<usize>().ok()) {
            Framing::Length(length)
        } else if status == 204 || status == 202 || method == "HEAD" {
            Framing::Length(0)
        } else {
            Framing::UntilClose
        };
    Ok(Reply {
        status,
        headers,
        reader,
        framing,
    })
}

/// A line without its CRLF.
async fn read_line(reader: &mut BufReader<TcpStream>) -> Result<String, ClientError> {
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .await
        .map_err(|_| ClientError::Io)?;
    if read == 0 {
        return Err(ClientError::Io);
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The next piece of the body, `None` at its end.
    async fn next_piece(&mut self) -> Result<Option<Vec<u8>>, ClientError> {
        let mut buf = vec![0u8; 8192];
        match &mut self.framing {
            Framing::Length(left) => {
                if *left == 0 {
                    return Ok(None);
                }
                let want = (*left).min(buf.len());
                let n = self
                    .reader
                    .read(&mut buf[..want])
                    .await
                    .map_err(|_| ClientError::Io)?;
                if n == 0 {
                    return Err(ClientError::Io);
                }
                *left -= n;
                buf.truncate(n);
                Ok(Some(buf))
            }
            Framing::UntilClose => {
                let n = self
                    .reader
                    .read(&mut buf)
                    .await
                    .map_err(|_| ClientError::Io)?;
                if n == 0 {
                    return Ok(None);
                }
                buf.truncate(n);
                Ok(Some(buf))
            }
            Framing::Chunked { left, done } => {
                if *done {
                    return Ok(None);
                }
                if *left == 0 {
                    let size_line = read_line(&mut self.reader).await?;
                    let size = size_line.split(';').next().unwrap_or("").trim();
                    let size = usize::from_str_radix(size, 16).map_err(|_| ClientError::Io)?;
                    if size == 0 {
                        // Trailers, then the empty line.
                        while !read_line(&mut self.reader).await?.is_empty() {}
                        *done = true;
                        return Ok(None);
                    }
                    *left = size;
                }
                let want = (*left).min(buf.len());
                let n = self
                    .reader
                    .read(&mut buf[..want])
                    .await
                    .map_err(|_| ClientError::Io)?;
                if n == 0 {
                    return Err(ClientError::Io);
                }
                *left -= n;
                if *left == 0 && !read_line(&mut self.reader).await?.is_empty() {
                    return Err(ClientError::Io);
                }
                buf.truncate(n);
                Ok(Some(buf))
            }
        }
    }

    /// The whole body (at most [`MAX_BODY_BYTES`]).
    async fn read_all(&mut self) -> Result<Vec<u8>, ClientError> {
        let mut body = Vec::new();
        while let Some(piece) = self.next_piece().await? {
            body.extend_from_slice(&piece);
            if body.len() > MAX_BODY_BYTES {
                return Err(ClientError::Io);
            }
        }
        Ok(body)
    }
}

/// Server-sent events: the `data` of each event, in order. Everything else in the stream (ids, retry, comments,
/// the empty priming event) is dropped.
#[derive(Default)]
struct EventParser {
    pending: Vec<u8>,
    data: Vec<String>,
}

impl EventParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                events.extend(self.take());
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        events
    }

    /// The stream ended: an event without its closing blank line still counts.
    fn finish(&mut self) -> Vec<String> {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let line = String::from_utf8_lossy(&rest);
            if let Some(value) = line.trim_end_matches(['\r', '\n']).strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        self.take().into_iter().collect()
    }

    fn take(&mut self) -> Option<String> {
        let data = std::mem::take(&mut self.data).join("\n");
        (!data.trim().is_empty()).then_some(data)
    }
}

// ---- the process ----------------------------------------------------------------------------------------------

/// `sextant mcp`: exit code 0 when stdin closed and every request was answered, 1 otherwise.
pub fn run() -> ExitCode {
    let target = resolve_target(&paths::config_dir());
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("sextant mcp: cannot start: {e}");
            return ExitCode::FAILURE;
        }
    };
    let (tx, rx) = mpsc::channel(64);
    // Reading stdin blocks, so it has a thread of its own; it ends with stdin (or with the process).
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match stdin.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx
                        .blocking_send(String::from_utf8_lossy(&line).into_owned())
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    if runtime.block_on(proxy(target, rx, std::io::stdout())) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{Value, json};
    use sextant_core::McpSettings;
    use sextant_core::kubeconfig::KubeconfigEnv;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::mcp::server::McpState;
    use crate::state::AppState;

    /// Stands in for stdout: the proxy writes here, the test reads.
    #[derive(Clone, Default)]
    struct Out(Arc<Mutex<Vec<u8>>>);

    impl Write for Out {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Out {
        /// Every line written so far, each of them parsed: stdout must carry JSON-RPC and nothing else.
        fn messages(&self) -> Vec<Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            assert!(text.is_empty() || text.ends_with('\n'), "{text:?}");
            text.lines()
                .map(|line| {
                    let message: Value = serde_json::from_str(line)
                        .unwrap_or_else(|e| panic!("stdout line is not JSON ({e}): {line:?}"));
                    assert_eq!(message["jsonrpc"], "2.0", "{line}");
                    message
                })
                .collect()
        }
    }

    /// A proxy running over channels, the way an MCP client drives it: one line in, wait for the answer.
    struct Driver {
        input: Option<mpsc::Sender<String>>,
        out: Out,
        task: tokio::task::JoinHandle<bool>,
    }

    impl Driver {
        fn start(target: Result<Target, String>) -> Self {
            let (tx, rx) = mpsc::channel(16);
            let out = Out::default();
            let task = tokio::spawn(proxy(target, rx, out.clone()));
            Self {
                input: Some(tx),
                out,
                task,
            }
        }

        async fn send(&self, message: Value) {
            self.input
                .as_ref()
                .unwrap()
                .send(message.to_string())
                .await
                .unwrap();
        }

        /// Waits until `count` messages are on stdout and returns all of them.
        async fn wait_for(&self, count: usize) -> Vec<Value> {
            for _ in 0..200 {
                let messages = self.out.messages();
                if messages.len() >= count {
                    return messages;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("no {count} messages in 10 s: {:?}", self.out.messages());
        }

        /// Closes stdin and returns whether the proxy ended well (exit code 0).
        async fn finish(mut self) -> bool {
            self.input.take();
            tokio::time::timeout(Duration::from_secs(10), self.task)
                .await
                .expect("the proxy did not end")
                .unwrap()
        }
    }

    fn initialize(id: u64) -> Value {
        json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" },
            },
        })
    }

    fn target(port: u16) -> Target {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-token");
        let token = crate::mcp::token::regenerate(&path).unwrap();
        Target { port, token }
    }

    // ---- a fake HTTP server -------------------------------------------------------------------------------

    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    /// Answers each connection with the raw HTTP response `reply` makes of the request, and keeps the requests.
    async fn fake_server(
        reply: impl Fn(&Seen) -> String + Send + Sync + 'static,
    ) -> (u16, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let reply = Arc::new(reply);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let (log, reply) = (Arc::clone(&log), Arc::clone(&reply));
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    let (head_end, length) = loop {
                        let n = stream.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&raw).into_owned();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .filter_map(|l| l.split_once(':'))
                                .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (end + 4, length);
                        }
                    };
                    while raw.len() < head_end + length {
                        let n = stream.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buf[..n]);
                    }
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    let mut lines = text[..head_end].lines();
                    let mut first = lines.next().unwrap().split_whitespace();
                    let seen = Seen {
                        method: first.next().unwrap().to_owned(),
                        path: first.next().unwrap().to_owned(),
                        headers: lines
                            .filter_map(|l| l.split_once(':'))
                            .map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned()))
                            .collect(),
                        body: text[head_end..].to_owned(),
                    };
                    let answer = reply(&seen);
                    log.lock().unwrap().push(seen);
                    let _ = stream.write_all(answer.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (port, seen)
    }

    fn json_reply(extra_headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn chunked(data: &str) -> String {
        // Two chunks that split the second event in the middle of a line.
        let (first, second) = data.split_at(data.len() - 20);
        format!(
            "{:x}\r\n{first}\r\n{:x}\r\n{second}\r\n0\r\n\r\n",
            first.len(),
            second.len()
        )
    }

    // ---- tests --------------------------------------------------------------------------------------------

    #[tokio::test]
    async fn json_answers_and_the_session_id_are_forwarded() {
        let (port, seen) = fake_server(|request| {
            if request.body.contains("\"initialize\"") {
                json_reply(
                    "Mcp-Session-Id: session-1\r\n",
                    r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake"}}}"#,
                )
            } else if request.body.contains("notifications/initialized") {
                "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
            } else {
                json_reply("", r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#)
            }
        })
        .await;
        let target = target(port);
        let token = target.token.as_str().to_owned();
        let driver = Driver::start(Ok(target));

        driver.send(initialize(1)).await;
        let messages = driver.wait_for(1).await;
        assert_eq!(messages[0]["result"]["serverInfo"]["name"], "fake");

        driver
            .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        driver
            .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await;
        let messages = driver.wait_for(2).await;
        assert_eq!(messages[1]["id"], 2);
        assert!(driver.finish().await);

        let seen = seen.lock().unwrap().clone();
        let posts: Vec<_> = seen.iter().filter(|r| r.method == "POST").collect();
        assert_eq!(posts.len(), 3);
        for post in &posts {
            assert_eq!(post.path, "/mcp");
            assert_eq!(
                post.header("host"),
                Some(format!("127.0.0.1:{port}").as_str())
            );
            assert_eq!(
                post.header("authorization"),
                Some(format!("Bearer {token}").as_str())
            );
            assert_eq!(
                post.header("accept"),
                Some("application/json, text/event-stream")
            );
            assert_eq!(post.header("content-type"), Some("application/json"));
        }
        // The first request opens the session; the later ones carry its id.
        assert_eq!(posts[0].header("mcp-session-id"), None);
        assert_eq!(posts[1].header("mcp-session-id"), Some("session-1"));
        assert_eq!(posts[2].header("mcp-session-id"), Some("session-1"));
        // Closing stdin ends the session on the server.
        let delete = seen.iter().find(|r| r.method == "DELETE").unwrap();
        assert_eq!(delete.header("mcp-session-id"), Some("session-1"));
        // The body goes through as the client wrote it.
        assert_eq!(
            serde_json::from_str::<Value>(&posts[0].body).unwrap(),
            initialize(1)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn messages_sent_at_once_wait_for_the_session_to_open() {
        let (port, seen) = fake_server(|request| {
            if request.body.contains("\"initialize\"") {
                // The session id comes late; a request that does not wait for it would go without.
                std::thread::sleep(Duration::from_millis(300));
                json_reply(
                    "Mcp-Session-Id: session-9\r\n",
                    r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
                )
            } else {
                json_reply("", r#"{"jsonrpc":"2.0","id":2,"result":{}}"#)
            }
        })
        .await;
        let driver = Driver::start(Ok(target(port)));
        driver.send(initialize(1)).await;
        driver
            .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await;
        driver.wait_for(2).await;
        assert!(driver.finish().await);
        let seen = seen.lock().unwrap().clone();
        let list = seen.iter().find(|r| r.body.contains("tools/list")).unwrap();
        assert_eq!(list.header("mcp-session-id"), Some("session-9"));
    }

    #[tokio::test]
    async fn an_event_stream_comes_out_one_message_per_line() {
        let events = "id: 0\ndata:\n\n\
                      data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\n\
                      data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n\n";
        let (port, _) = fake_server(move |_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\
                 Connection: close\r\n\r\n{}",
                chunked(events)
            )
        })
        .await;
        let driver = Driver::start(Ok(target(port)));
        driver
            .send(json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "x" } }))
            .await;
        let messages = driver.wait_for(2).await;
        assert_eq!(messages[0]["method"], "notifications/progress");
        assert_eq!(messages[1]["id"], 7);
        assert_eq!(messages[1]["result"]["content"][0]["text"], "done");
        let out = driver.out.clone();
        assert!(driver.finish().await);
        assert_eq!(out.messages().len(), 2);
    }

    #[tokio::test]
    async fn without_a_server_the_request_gets_an_error_and_the_proxy_fails() {
        let port = {
            let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let driver = Driver::start(Ok(target(port)));
        driver.send(initialize(1)).await;
        let messages = driver.wait_for(1).await;
        assert_eq!(messages[0]["id"], 1);
        assert_eq!(messages[0]["error"]["message"], NOT_RUNNING);
        assert!(!driver.finish().await);
    }

    #[tokio::test]
    async fn without_a_token_or_with_the_server_off_the_request_gets_the_same_error() {
        let dir = tempfile::tempdir().unwrap();
        let message = resolve_target(dir.path()).unwrap_err();
        assert_eq!(message, NOT_RUNNING);
        // Nothing was created: the proxy never makes a token of its own.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        let driver = Driver::start(Err(message));
        driver.send(initialize(3)).await;
        let messages = driver.wait_for(1).await;
        assert_eq!(messages[0]["id"], 3);
        assert_eq!(messages[0]["error"]["message"], NOT_RUNNING);
        assert!(!driver.finish().await);
    }

    #[tokio::test]
    async fn the_target_is_read_from_the_application_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"theme":"dark","mcp":{"enabled":true,"port":51234}}"#,
        )
        .unwrap();
        let token = crate::mcp::token::regenerate(&dir.path().join("mcp-token")).unwrap();
        let found = resolve_target(dir.path()).unwrap();
        assert_eq!(found.port, 51234);
        assert!(found.token.matches(token.as_str()));
        // The token stays out of the debug output.
        assert!(!format!("{found:?}").contains(token.as_str()));

        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"mcp":{"enabled":false,"port":51234}}"#,
        )
        .unwrap();
        assert_eq!(resolve_target(dir.path()).unwrap_err(), NOT_RUNNING);

        // Without a "port" the default one is used.
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"mcp":{"enabled":true}}"#,
        )
        .unwrap();
        assert_eq!(resolve_target(dir.path()).unwrap().port, 47391);
    }

    #[tokio::test]
    async fn a_refused_token_gets_an_error_that_does_not_name_it() {
        let (port, _) = fake_server(|_| {
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\nUnauthorized"
                .to_owned()
        })
        .await;
        let target = target(port);
        let token = target.token.as_str().to_owned();
        let driver = Driver::start(Ok(target));
        driver.send(initialize(1)).await;
        let messages = driver.wait_for(1).await;
        assert_eq!(messages[0]["id"], 1);
        let text = messages[0]["error"]["message"].as_str().unwrap().to_owned();
        assert!(text.contains("token"), "{text}");
        assert!(!text.contains(&token));
        assert!(!driver.finish().await);
    }

    #[tokio::test]
    async fn a_session_the_server_lost_ends_the_proxy() {
        let (port, _) = fake_server(|request| {
            if request.body.contains("\"initialize\"") {
                json_reply(
                    "Mcp-Session-Id: session-1\r\n",
                    r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
                )
            } else {
                // The server was restarted: it does not know the session any more.
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_owned()
            }
        })
        .await;
        let driver = Driver::start(Ok(target(port)));
        driver.send(initialize(1)).await;
        driver.wait_for(1).await;
        driver
            .send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }))
            .await;
        let messages = driver.wait_for(2).await;
        assert_eq!(messages[1]["id"], 4);
        assert!(
            messages[1]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("restart")
        );
        assert!(!driver.finish().await);
    }

    #[tokio::test]
    async fn the_real_server_answers_through_the_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let state = AppState::new(&config, &dir.path().join("data"));
        let kubeconfig = dir.path().join("kubeconfig");
        std::fs::write(
            &kubeconfig,
            "apiVersion: v1\nkind: Config\nclusters:\n- name: proxied\n  cluster:\n    server: https://127.0.0.1:1\n\
             contexts:\n- name: proxied\n  context:\n    cluster: proxied\n    user: proxied\n\
             users:\n- name: proxied\n  user: {}\ncurrent-context: proxied\n",
        )
        .unwrap();
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.into_os_string()),
            home: Some(dir.path().join("home")),
        });
        // A port released by the probe can be taken again before the server binds it: try another.
        let mut running = false;
        for _ in 0..20 {
            let port = {
                let probe = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
                probe.local_addr().unwrap().port()
            };
            state
                .settings
                .update(|s| {
                    s.mcp = McpSettings {
                        enabled: true,
                        port,
                    }
                })
                .unwrap();
            state.mcp.apply_settings(&state.settings.get()).await;
            if state.mcp.status().state == McpState::Running {
                running = true;
                break;
            }
        }
        assert!(running, "{:?}", state.mcp.status());

        // The proxy finds the server the way `sextant mcp` does: from the files of the application.
        let target = resolve_target(&config).expect("settings.json and mcp-token");
        let driver = Driver::start(Ok(target));

        driver.send(initialize(1)).await;
        let messages = driver.wait_for(1).await;
        assert_eq!(messages[0]["result"]["serverInfo"]["name"], "sextant");

        driver
            .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        driver
            .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await;
        let messages = driver.wait_for(2).await;
        let tools = messages[1]["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "list_clusters"));

        driver
            .send(json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "list_clusters", "arguments": {} },
            }))
            .await;
        let messages = driver.wait_for(3).await;
        let result = &messages[2]["result"];
        assert_ne!(result["isError"], true, "{result}");
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("proxied"), "{text}");

        assert!(driver.finish().await);
        // The proxy ended its session; the application's files are as it left them.
        assert!(config.join("mcp-token").exists());
        state.mcp.stop();
    }
}
