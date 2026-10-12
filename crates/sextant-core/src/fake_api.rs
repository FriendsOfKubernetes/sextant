//! A fake Kubernetes API server for unit tests of the core: plain HTTP on 127.0.0.1, answers chosen by the test.
//!
//! ```ignore
//! let api = FakeApi::start(|req: &Request| match req.path.as_str() {
//!     "/api" => Reply::json(200, API_VERSIONS),
//!     _ => Reply::not_found(),
//! })
//! .await;
//! let (_tmp, mgr, id) = connected_to(api.url()).await;
//! assert_eq!(api.count("/api"), 1);
//! ```
//!
//! Every request is recorded before it is answered ([`FakeApi::requests`]). A connection serves one request at a
//! time (keep-alive); a request body is read by its `Content-Length`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::cluster::ClusterManager;
use crate::kubeconfig::{ClusterId, KubeconfigEnv, KubeconfigRegistry};

/// `{"kind":"Status",…,"code":404}`, the answer of [`Reply::not_found`].
pub const NOT_FOUND: &str =
    r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#;

/// One request as the server got it.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// Without the query.
    pub path: String,
    /// After `?`, empty if none.
    pub query: String,
    /// The request line and the headers.
    pub head: String,
    pub body: Vec<u8>,
}

impl Request {
    /// The value of header `name` (any case), empty if missing.
    pub fn header(&self, name: &str) -> &str {
        self.head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
            .map_or("", |(_, value)| value.trim())
    }

    /// `"PATCH /api/v1/nodes/n1"`.
    pub fn line(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

enum Body {
    /// A complete JSON answer with `Content-Length`.
    Full(String),
    /// A chunked answer (a watch): `first` as the first chunk (if not empty), then open until the client leaves.
    Stream(String),
    /// No answer at all; the connection stays open until the client closes it ([`FakeApi::abandoned`]).
    Hang,
}

/// The answer to one request.
pub struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Body,
    delay: Duration,
}

impl Reply {
    /// `status` with a JSON `body`.
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Body::Full(body.into()),
            delay: Duration::ZERO,
        }
    }

    /// 404 with a `Status` object.
    pub fn not_found() -> Self {
        Self::json(404, NOT_FOUND)
    }

    /// 200, chunked: `first` (whole JSON lines, may be empty) and then nothing more — an open watch.
    pub fn stream(first: impl Into<String>) -> Self {
        Self {
            body: Body::Stream(first.into()),
            ..Self::json(200, "")
        }
    }

    /// Never answers.
    pub fn hang() -> Self {
        Self {
            body: Body::Hang,
            ..Self::json(200, "")
        }
    }

    /// An extra response header.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    /// Waits `delay` before answering.
    pub fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

type Handler = dyn Fn(&Request) -> Reply + Send + Sync;

/// A running fake API server; it stops with the test's runtime.
pub struct FakeApi {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    abandoned: Arc<AtomicUsize>,
}

impl FakeApi {
    /// Starts a server on a free port of 127.0.0.1 that answers each request with `answer(request)`.
    pub async fn start(answer: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let abandoned = Arc::new(AtomicUsize::new(0));
        let answer: Arc<Handler> = Arc::new(answer);
        let (record, gave_up) = (Arc::clone(&requests), Arc::clone(&abandoned));
        tokio::spawn(async move {
            while let Ok((conn, _)) = listener.accept().await {
                tokio::spawn(serve(
                    conn,
                    Arc::clone(&answer),
                    Arc::clone(&record),
                    Arc::clone(&gave_up),
                ));
            }
        });
        Self {
            url,
            requests,
            abandoned,
        }
    }

    /// `http://127.0.0.1:<port>`.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// All requests so far, in order.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    /// Requests to `path` (any method, any query).
    pub fn count(&self, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == path)
            .count()
    }

    /// Requests answered with [`Reply::hang`] whose connection the client has closed.
    pub fn abandoned(&self) -> usize {
        self.abandoned.load(Ordering::SeqCst)
    }
}

/// Reads until `buf` holds `wanted` bytes; false once the client is gone.
async fn fill(conn: &mut TcpStream, buf: &mut Vec<u8>, wanted: impl Fn(&[u8]) -> bool) -> bool {
    while !wanted(buf) {
        let mut chunk = [0u8; 4096];
        match conn.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

/// Waits until the client closes the connection.
async fn until_closed(conn: &mut TcpStream) {
    let mut chunk = [0u8; 256];
    while matches!(conn.read(&mut chunk).await, Ok(n) if n > 0) {}
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

async fn serve(
    mut conn: TcpStream,
    answer: Arc<Handler>,
    requests: Arc<Mutex<Vec<Request>>>,
    abandoned: Arc<AtomicUsize>,
) {
    let head_end = |buf: &[u8]| buf.windows(4).position(|w| w == b"\r\n\r\n");
    let mut buf = Vec::new();
    loop {
        if !fill(&mut conn, &mut buf, |b| head_end(b).is_some()).await {
            return;
        }
        let end = head_end(&buf).unwrap_or_default() + 4;
        let head = String::from_utf8_lossy(&buf[..end]).into_owned();
        buf.drain(..end);
        let mut request = Request {
            method: String::new(),
            path: String::new(),
            query: String::new(),
            head,
            body: Vec::new(),
        };
        let length: usize = request.header("content-length").parse().unwrap_or(0);
        if !fill(&mut conn, &mut buf, |b| b.len() >= length).await {
            return;
        }
        request.body = buf.drain(..length).collect();
        let mut words = request.head.split_whitespace();
        request.method = words.next().unwrap_or_default().to_owned();
        let target = words.next().unwrap_or_default();
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        (request.path, request.query) = (path.to_owned(), query.to_owned());

        let reply = answer(&request);
        requests.lock().unwrap().push(request);
        tokio::time::sleep(reply.delay).await;

        let status = format!("HTTP/1.1 {} {}\r\n", reply.status, reason(reply.status));
        let mut headers: String = reply
            .headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect();
        headers.push_str("content-type: application/json\r\n");
        let response = match &reply.body {
            Body::Hang => {
                until_closed(&mut conn).await;
                abandoned.fetch_add(1, Ordering::SeqCst);
                return;
            }
            Body::Full(body) => {
                format!(
                    "{status}{headers}content-length: {}\r\n\r\n{body}",
                    body.len()
                )
            }
            Body::Stream(first) if first.is_empty() => {
                format!("{status}{headers}transfer-encoding: chunked\r\n\r\n")
            }
            Body::Stream(first) => format!(
                "{status}{headers}transfer-encoding: chunked\r\n\r\n{:x}\r\n{first}\r\n",
                first.len()
            ),
        };
        if conn.write_all(response.as_bytes()).await.is_err() {
            return;
        }
        if matches!(reply.body, Body::Stream(_)) {
            until_closed(&mut conn).await;
            return;
        }
    }
}

/// A manager whose only cluster is `url` through a kubeconfig without credentials, connected.
pub async fn connected_to(url: &str) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("kubeconfig");
    std::fs::write(
        &path,
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster:\n    server: {url}\n\
             contexts:\n- name: fake\n  context:\n    cluster: fake\n    user: fake\n\
             users:\n- name: fake\n  user: {{}}\ncurrent-context: fake\n"
        ),
    )
    .unwrap();
    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().join("state")).with_env(KubeconfigEnv {
            kubeconfig: Some(path.into_os_string()),
            home: None,
        });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();
    (tmp, mgr, id)
}
