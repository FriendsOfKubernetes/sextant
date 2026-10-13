//! The MCP server through real HTTP on 127.0.0.1 (a small HTTP/1.1 client over a TCP socket): the checks before
//! MCP, the MCP handshake and tools, the token, the life of the server with the settings. The tools against a real
//! cluster need the kind test cluster (`SEXTANT_TEST_KUBECONFIG`, see `scripts/test-cluster.sh`) and are skipped
//! without it.

use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sextant_core::access::{
    AccessAction, AccessPreset, AccessRule, ClusterAccess, KindPattern, KindScope, NamespaceScope,
};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{ClusterId, ClusterSettings, ConnectionState, McpSettings};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::audit::AuditDecision;
use super::context::McpEvent;
use super::server::{McpState, McpStatus};
use crate::state::AppState;

const PROTOCOL: &str = "2025-06-18";

/// An HTTP answer.
#[derive(Debug)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The JSON-RPC message of the answer: the body itself, or the `data:` of an SSE event with an `id`.
    fn message(&self) -> Value {
        if let Ok(value) = serde_json::from_str::<Value>(&self.body) {
            return value;
        }
        self.body
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|m| m.get("id").is_some())
            .unwrap_or_else(|| panic!("no JSON-RPC answer in {self:?}"))
    }
}

/// Sends one request on a fresh connection (`Connection: close`) and reads the whole answer. `Host` is
/// `127.0.0.1:<port>` unless `headers` name one; the body goes with `Content-Length`.
async fn send(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Reply {
    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("host")) {
        request.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !headers
        .iter()
        .any(|(n, _)| n.eq_ignore_ascii_case("content-length"))
    {
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(body);
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    read_reply(stream).await
}

async fn read_reply(mut stream: TcpStream) -> Reply {
    let mut raw = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
            }
        }
    })
    .await;
    assert!(
        read.is_ok(),
        "no complete answer in 10 s: {:?}",
        String::from_utf8_lossy(&raw)
    );
    parse_reply(&raw)
}

fn parse_reply(raw: &[u8]) -> Reply {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("not an HTTP answer: {text:?}"));
    let mut lines = head.lines();
    let status = lines.next().unwrap().split_whitespace().nth(1).unwrap();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let chunked = headers.iter().any(|(n, v)| {
        n.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case("chunked")
    });
    let body = if chunked {
        dechunk(body)
    } else {
        body.to_owned()
    };
    Reply {
        status: status.parse().unwrap(),
        headers,
        body,
    }
}

fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.trim(), 16) else {
            break;
        };
        if size == 0 || rest.len() < size {
            break;
        }
        out.push_str(&rest[..size]);
        body = rest[size..].trim_start_matches("\r\n");
    }
    out
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A JSON-RPC POST to `/mcp`.
async fn rpc(port: u16, token: &str, session: Option<&str>, message: Value) -> Reply {
    let auth = bearer(token);
    let mut headers = vec![
        ("Authorization", auth.as_str()),
        ("Content-Type", "application/json"),
        ("Accept", "application/json, text/event-stream"),
        ("MCP-Protocol-Version", PROTOCOL),
    ];
    if let Some(session) = session {
        headers.push(("Mcp-Session-Id", session));
    }
    send(port, "POST", "/mcp", &headers, &message.to_string()).await
}

/// `initialize` + `notifications/initialized`; the session id.
async fn initialize(port: u16, token: &str) -> String {
    let reply = rpc(
        port,
        token,
        None,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL, "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" },
            },
        }),
    )
    .await;
    assert_eq!(reply.status, 200, "{reply:?}");
    let answer = reply.message();
    assert_eq!(
        answer["result"]["serverInfo"]["name"], "sextant",
        "{answer}"
    );
    let session = reply
        .header("mcp-session-id")
        .unwrap_or_else(|| panic!("no session id: {reply:?}"))
        .to_owned();
    let done = rpc(
        port,
        token,
        Some(&session),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(done.status, 202, "{done:?}");
    session
}

async fn call_tool(port: u16, token: &str, session: &str, name: &str, args: Value) -> Value {
    let reply = rpc(
        port,
        token,
        Some(session),
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": name, "arguments": args },
        }),
    )
    .await;
    assert_eq!(reply.status, 200, "{reply:?}");
    reply.message()["result"].clone()
}

fn text_of(result: &Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn free_port() -> u16 {
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Application state in `dir` whose only cluster is `server` (kubeconfig `test`, no credentials), and the events
/// the MCP server emits.
fn state_in(dir: &Path, kubeconfig: Option<std::ffi::OsString>) -> (AppState, Events) {
    let state = AppState::new(&dir.join("config"), &dir.join("data"));
    let kubeconfig = kubeconfig.unwrap_or_else(|| {
        let path = dir.join("kubeconfig");
        std::fs::write(
            &path,
            "apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    server: https://127.0.0.1:1\n\
             contexts:\n- name: test\n  context:\n    cluster: test\n    user: test\n\
             users:\n- name: test\n  user: {}\ncurrent-context: test\n",
        )
        .unwrap();
        path.into_os_string()
    });
    state.registry.write().unwrap().set_env(KubeconfigEnv {
        kubeconfig: Some(kubeconfig),
        home: Some(dir.join("home")),
    });
    let events = Events::default();
    let sink = events.clone();
    state.mcp.set_emitter(Arc::new(move |event| {
        sink.0.lock().unwrap().push(event);
        true
    }));
    (state, events)
}

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<McpEvent>>>);

impl Events {
    fn statuses(&self) -> Vec<McpStatus> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                McpEvent::Status(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    fn audits(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, McpEvent::Audit(_)))
            .count()
    }
}

/// Tests that run a server take turns: a port one of them released could otherwise be bound by another at once, and
/// "the port is closed now" would see the other's server.
static SERVERS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Turns the server on at a free port and returns it. A port released by `free_port` can be taken again (e.g. as
/// the local port of another test's connection) before the server binds it, so a taken one is tried again.
async fn turn_on_free(state: &AppState) -> u16 {
    for _ in 0..20 {
        let port = free_port();
        turn_on(state, port).await;
        if state.mcp.status().state == McpState::Running {
            return port;
        }
    }
    panic!("no free port: {:?}", state.mcp.status());
}

async fn turn_on(state: &AppState, port: u16) {
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
}

fn first_cluster(state: &AppState) -> ClusterId {
    state.registry.read().unwrap().clusters().unwrap()[0]
        .id
        .clone()
}

fn set_access(state: &AppState, cluster: &ClusterId, access: ClusterAccess) {
    state
        .settings
        .update(|s| {
            s.clusters.insert(
                cluster.0.clone(),
                ClusterSettings {
                    agent_access: access,
                    ..ClusterSettings::default()
                },
            );
        })
        .unwrap();
}

fn preset(preset: AccessPreset) -> ClusterAccess {
    ClusterAccess {
        preset,
        rules: Vec::new(),
    }
}

async fn port_is_closed(port: u16) -> bool {
    TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .is_err()
}

#[tokio::test]
async fn only_requests_with_the_token_and_without_browser_headers_get_through() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let port = turn_on_free(&state).await;
    let token = state.mcp.token().unwrap();
    let token = token.as_str();
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } },
    })
    .to_string();
    let json_headers = [
        ("Content-Type", "application/json"),
        ("Accept", "application/json, text/event-stream"),
    ];
    let with = |extra: &[(&'static str, String)]| {
        let mut all: Vec<(&str, String)> = json_headers
            .iter()
            .map(|(n, v)| (*n, v.to_string()))
            .collect();
        all.extend(extra.iter().cloned());
        all
    };
    let post = |headers: Vec<(&'static str, String)>| {
        let init = init.clone();
        async move {
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
            send(port, "POST", "/mcp", &headers, &init).await
        }
    };

    let none = post(with(&[])).await;
    assert_eq!(none.status, 401, "{none:?}");
    assert_eq!(none.header("www-authenticate"), Some("Bearer"));
    assert!(!none.body.contains(token));
    let wrong = post(with(&[("Authorization", bearer("not-the-token"))])).await;
    assert_eq!(wrong.status, 401);
    let basic = post(with(&[("Authorization", format!("Basic {token}"))])).await;
    assert_eq!(basic.status, 401);

    let origin = post(with(&[
        ("Authorization", bearer(token)),
        ("Origin", "https://evil.example".into()),
    ]))
    .await;
    assert_eq!(origin.status, 403, "{origin:?}");
    let null_origin = post(with(&[
        ("Authorization", bearer(token)),
        ("Origin", "null".into()),
    ]))
    .await;
    assert_eq!(null_origin.status, 403);
    for host in [
        format!("evil.example:{port}"),
        "127.0.0.1".to_owned(),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
    ] {
        let rebound = post(with(&[
            ("Authorization", bearer(token)),
            ("Host", host.clone()),
        ]))
        .await;
        assert_eq!(rebound.status, 403, "{host}: {rebound:?}");
    }

    let local = post(with(&[
        ("Authorization", bearer(token)),
        ("Host", format!("localhost:{port}")),
    ]))
    .await;
    assert_eq!(local.status, 200, "{local:?}");

    let elsewhere = send(port, "GET", "/", &[("Authorization", &bearer(token))], "").await;
    assert_eq!(elsewhere.status, 404);
    state.close_all();
}

#[tokio::test]
async fn a_body_over_4_mb_is_refused() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let port = turn_on_free(&state).await;
    let token = state.mcp.token().unwrap();
    let auth = bearer(token.as_str());

    // Declared too long: refused before the body is read.
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        4 * 1024 * 1024 + 1
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    assert_eq!(read_reply(stream).await.status, 413);

    // Sent without a length (chunked): refused while it streams.
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    let (mut reader, mut writer) = stream.into_split();
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    let writing = tokio::spawn(async move {
        writer.write_all(head.as_bytes()).await?;
        let chunk = format!("{:x}\r\n{}\r\n", 64 * 1024, "x".repeat(64 * 1024));
        for _ in 0..80 {
            writer.write_all(chunk.as_bytes()).await?;
        }
        writer.write_all(b"0\r\n\r\n").await
    });
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), reader.read_to_end(&mut raw)).await;
    let _ = writing.await;
    assert_eq!(parse_reply(&raw).status, 413);
    state.close_all();
}

#[tokio::test]
async fn an_agent_initializes_lists_the_tools_and_calls_one_and_the_call_is_journaled() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, events) = state_in(dir.path(), None);
    let port = turn_on_free(&state).await;
    let token = state.mcp.token().unwrap();
    let session = initialize(port, token.as_str()).await;

    let reply = rpc(
        port,
        token.as_str(),
        Some(&session),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    let tools = reply.message()["result"]["tools"].clone();
    let mut names: Vec<&str> = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "apply_yaml",
            "cordon_node",
            "delete_resource",
            "drain_node",
            "exec_command",
            "get_events",
            "get_logs",
            "get_metrics",
            "get_resource",
            "get_secret_value",
            "gitops_action",
            "helm_get_release",
            "helm_install",
            "helm_list_releases",
            "helm_rollback",
            "helm_uninstall",
            "helm_upgrade",
            "list_clusters",
            "list_kinds",
            "list_resources",
            "patch_resource",
            "port_forward_list",
            "port_forward_start",
            "port_forward_stop",
            "restart",
            "scale",
            "suspend_cronjob",
            "trigger_cronjob",
        ]
    );
    assert!(
        tools
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["inputSchema"]["type"] == "object")
    );

    let result = call_tool(port, token.as_str(), &session, "list_clusters", json!({})).await;
    assert_ne!(result["isError"], true, "{result}");
    let listed: Value = serde_json::from_str(&text_of(&result)).unwrap();
    let cluster = &listed["clusters"][0];
    assert_eq!(cluster["context"], "test");
    assert_eq!(cluster["access"], "off");
    assert_eq!(cluster["state"], "disconnected");

    let journal = state.mcp.context().audit.list(None);
    assert_eq!(journal.len(), 1);
    let entry = &journal[0];
    assert_eq!(
        (
            entry.client.as_str(),
            entry.tool.as_str(),
            entry.result.as_str()
        ),
        ("test-client", "list_clusters", "ok")
    );
    assert_eq!(entry.decision, AuditDecision::Allowed);
    assert_eq!(events.audits(), 1);
    state.close_all();
}

#[tokio::test]
async fn a_cluster_with_access_off_is_refused_without_being_connected() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let port = turn_on_free(&state).await;
    let token = state.mcp.token().unwrap();
    let session = initialize(port, token.as_str()).await;
    let cluster = first_cluster(&state);

    let args =
        json!({ "cluster": cluster.0, "kind": "Pod", "namespace": "default", "name": "web" });
    let result = call_tool(port, token.as_str(), &session, "get_resource", args).await;
    assert_eq!(result["isError"], true);
    assert_eq!(
        text_of(&result),
        "Sextant denied access to cluster test: AI agent access to it is off. The user can allow it in Sextant → \
         cluster settings → AI agent access."
    );
    assert_eq!(
        state.clusters.state(&cluster),
        ConnectionState::Disconnected
    );
    let entry = &state.mcp.context().audit.list(Some(&cluster))[0];
    assert_eq!(entry.decision, AuditDecision::Denied);
    assert_eq!(entry.result, "denied");
    assert_eq!(entry.cluster_name.as_deref(), Some("test"));

    // With access, the tool connects the cluster itself (this one is unreachable, so the connection fails).
    set_access(&state, &cluster, preset(AccessPreset::ReadOnly));
    let by_context = json!({ "cluster": "test" });
    let result = call_tool(port, token.as_str(), &session, "list_kinds", by_context).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        matches!(state.clusters.state(&cluster), ConnectionState::Error(_)),
        "{:?}",
        state.clusters.state(&cluster)
    );
    let entry = &state.mcp.context().audit.list(Some(&cluster))[0];
    assert_eq!(entry.decision, AuditDecision::Allowed);
    assert_eq!(entry.result, "unreachable");
    state.close_all();
}

#[tokio::test]
async fn a_new_token_ends_the_sessions_and_the_old_token_at_once() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let port = turn_on_free(&state).await;
    let old = state.mcp.token().unwrap();
    let session = initialize(port, old.as_str()).await;

    let new = state.mcp.regenerate_token().await.unwrap();
    assert_ne!(old, new);
    assert_eq!(
        state.mcp.status().state,
        McpState::Running,
        "{:?}",
        state.mcp.status()
    );
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
    let refused = rpc(port, old.as_str(), Some(&session), list.clone()).await;
    assert_eq!(refused.status, 401);
    let gone = rpc(port, new.as_str(), Some(&session), list.clone()).await;
    assert_eq!(gone.status, 404, "the old session is closed: {gone:?}");
    let fresh = initialize(port, new.as_str()).await;
    let reply = rpc(port, new.as_str(), Some(&fresh), list).await;
    assert_eq!(reply.status, 200);
    assert_eq!(state.mcp.status().state, McpState::Running);
    state.close_all();
}

#[tokio::test]
async fn the_server_follows_the_settings_and_stops_with_the_application() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, events) = state_in(dir.path(), None);
    assert_eq!(state.mcp.status().state, McpState::Off);

    let port = turn_on_free(&state).await;
    assert_eq!(
        state.mcp.status(),
        McpStatus {
            state: McpState::Running,
            url: Some(format!("http://127.0.0.1:{port}/mcp")),
            error: None,
        }
    );

    // Another port: the old one is released.
    let other = turn_on_free(&state).await;
    assert!(port_is_closed(port).await);
    let token = state.mcp.token().unwrap();
    initialize(other, token.as_str()).await;

    // Off: the port is released.
    state.settings.update(|s| s.mcp.enabled = false).unwrap();
    state.mcp.apply_settings(&state.settings.get()).await;
    assert_eq!(state.mcp.status().state, McpState::Off);
    assert!(port_is_closed(other).await);

    // A taken port is an error status, not a failure of the application.
    let taken = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let taken_port = taken.local_addr().unwrap().port();
    turn_on(&state, taken_port).await;
    assert_eq!(
        state.mcp.status(),
        McpStatus {
            state: McpState::Error,
            url: None,
            error: Some(format!(
                "Port {taken_port} is in use — another Sextant or program?"
            )),
        }
    );
    drop(taken);
    // Applying the same settings again retries. (Another test's connection may grab the released port for a
    // moment as its local port, hence a few tries.)
    for _ in 0..50 {
        state.mcp.apply_settings(&state.settings.get()).await;
        if state.mcp.status().state == McpState::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state.mcp.status().state, McpState::Running, "retried");

    // Closing the application stops it and refuses the confirmations still waiting.
    let ctx = Arc::clone(state.mcp.context());
    let waiting = tokio::spawn(async move {
        ctx.confirmations
            .ask(
                super::confirm::ConfirmRequest {
                    id: String::new(),
                    client: "c".into(),
                    cluster_id: ClusterId::from("x"),
                    cluster_name: "x".into(),
                    tool: "delete_resource".into(),
                    target: "Pod a/b".into(),
                    details: None,
                },
                |_| true,
            )
            .await
    });
    while state.mcp.context().confirmations.pending() == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    state.close_all();
    assert_eq!(
        waiting.await.unwrap(),
        super::confirm::ConfirmOutcome::Declined
    );
    assert_eq!(state.mcp.status().state, McpState::Off);
    for _ in 0..50 {
        if port_is_closed(taken_port).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(port_is_closed(taken_port).await);

    let mut states: Vec<McpState> = events.statuses().iter().map(|s| s.state).collect();
    states.dedup();
    assert_eq!(states[0], McpState::Running, "{states:?}");
    assert!(
        states.ends_with(&[
            McpState::Off,
            McpState::Error,
            McpState::Running,
            McpState::Off
        ]),
        "{states:?}"
    );
}

#[tokio::test]
async fn a_port_outside_the_range_is_an_error() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    turn_on(&state, 80).await;
    let status = state.mcp.status();
    assert_eq!(status.state, McpState::Error);
    assert_eq!(
        status.error.as_deref(),
        Some("Port 80 is outside 1024–65535")
    );
}

// -----------------------------------------------------------------------------------------------------------------
// Tools against the kind test cluster.

const DEMO: &str = "sextant-demo";

/// State connected to the test cluster, or `None` (skipped) without `SEXTANT_TEST_KUBECONFIG`.
fn cluster_state(dir: &Path) -> Option<(AppState, ClusterId)> {
    let Some(kubeconfig) = std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
    else {
        eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
        return None;
    };
    let (state, _) = state_in(dir, Some(kubeconfig));
    let id = first_cluster(&state);
    Some((state, id))
}

async fn tool(state: &AppState, name: &str, args: Value) -> Result<Value, String> {
    let args = match args {
        Value::Object(map) => map,
        _ => unreachable!(),
    };
    let result = state.mcp.handler().call("test", name, args).await;
    let rendered = super::tools::to_call_result(&result);
    let text = rendered.content[0]
        .as_text()
        .map(|t| t.text.clone())
        .unwrap_or_default();
    if rendered.is_error == Some(true) {
        Err(text)
    } else {
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

fn rule(namespaces: &[&str], kinds: &[(&str, &str)], actions: &[AccessAction]) -> AccessRule {
    AccessRule {
        namespaces: if namespaces.is_empty() {
            NamespaceScope::All
        } else {
            NamespaceScope::Only {
                namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
            }
        },
        kinds: if kinds.is_empty() {
            KindScope::All
        } else {
            KindScope::Only {
                kinds: kinds
                    .iter()
                    .map(|(g, k)| KindPattern::new(*g, *k))
                    .collect(),
            }
        },
        actions: actions.to_vec(),
        confirm: false,
    }
}

fn names(list: &Value) -> Vec<String> {
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["metadata"]["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn read_only_reads_objects_events_logs_and_metrics_but_no_secret_values() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = cluster_state(dir.path()) else {
        return;
    };
    set_access(&state, &id, preset(AccessPreset::ReadOnly));
    let cluster = id.0.as_str();

    let pods = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "pods", "namespace": DEMO }),
    )
    .await
    .unwrap();
    assert!(
        names(&pods).iter().any(|n| n.starts_with("nginx-")),
        "{pods}"
    );
    assert_eq!(pods["truncated"], false);
    let one = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "Pod", "namespace": DEMO, "limit": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(names(&one).len(), 1);
    assert_eq!(one["truncated"], true);

    let secret = tool(
        &state,
        "get_resource",
        json!({ "cluster": cluster, "kind": "Secret", "namespace": DEMO, "name": "demo-secret" }),
    )
    .await
    .unwrap();
    // Assertions on secrets never print the object: a failure must not show a value.
    assert!(
        secret["data"]["password"] == "",
        "the Secret came with its values"
    );
    assert!(!secret.to_string().contains("not-a-real-password"));
    assert!(secret["metadata"].get("managedFields").is_none());

    let refused = tool(
        &state,
        "get_secret_value",
        json!({ "cluster": cluster, "namespace": DEMO, "name": "demo-secret", "key": "password" }),
    )
    .await
    .unwrap_err();
    assert!(
        refused.starts_with(
            "Sextant denied secret values on Secret sextant-demo/demo-secret key password"
        ),
        "{refused}"
    );

    let nginx = names(&pods)
        .into_iter()
        .find(|n| n.starts_with("nginx-"))
        .unwrap();
    let log = tool(
        &state,
        "get_logs",
        json!({ "cluster": cluster, "namespace": DEMO, "pod": nginx, "lines": 5 }),
    )
    .await;
    assert!(log.is_ok(), "{log:?}");

    let events = tool(
        &state,
        "get_events",
        json!({ "cluster": cluster, "namespace": DEMO }),
    )
    .await
    .unwrap();
    assert!(events["events"].is_array(), "{events}");

    let usage = tool(
        &state,
        "get_metrics",
        json!({ "cluster": cluster, "of": "pods", "namespace": DEMO }),
    )
    .await;
    // metrics-server of the test cluster may still be warming up; a refusal would be a bug either way.
    if let Err(e) = &usage {
        assert!(!e.contains("denied"), "{e}");
    }

    let kinds = tool(&state, "list_kinds", json!({ "cluster": cluster }))
        .await
        .unwrap();
    let listed = kinds["kinds"].as_array().unwrap();
    assert!(
        listed
            .iter()
            .any(|k| k["kind"] == "Deployment" && k["apiVersion"] == "apps/v1")
    );
    assert!(
        listed
            .iter()
            .any(|k| k["kind"] == "Release" && k["apiVersion"] == "helm.sh")
    );

    let node = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "Node" }),
    )
    .await
    .unwrap();
    assert!(!names(&node).is_empty());

    // A release of the GitOps fixture (`scripts/test-cluster.sh up --gitops`), when the cluster has it.
    let releases = tool(&state, "helm_list_releases", json!({ "cluster": cluster }))
        .await
        .unwrap();
    let has_podinfo = releases["releases"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["name"] == "podinfo-helm");
    if has_podinfo {
        let release = tool(
            &state,
            "helm_get_release",
            json!({ "cluster": cluster, "namespace": "sextant-flux", "name": "podinfo-helm" }),
        )
        .await
        .unwrap();
        assert!(release.get("values").is_none() && release.get("manifest").is_none());
        assert!(release["valuesHidden"].is_string());
        assert!(!release["history"].as_array().unwrap().is_empty());
        assert_eq!(release["release"]["name"], "podinfo-helm");
    }
    state.close_all();
}

#[tokio::test]
async fn rules_for_some_namespaces_limit_lists_and_refuse_cluster_wide_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let Some((state, id)) = cluster_state(dir.path()) else {
        return;
    };
    set_access(
        &state,
        &id,
        ClusterAccess {
            preset: AccessPreset::Custom,
            rules: vec![
                rule(&[DEMO], &[], &[AccessAction::Read]),
                rule(&[DEMO], &[("", "Secret")], &[AccessAction::SecretValues]),
                rule(
                    &["sextant-flux"],
                    &[("helm.sh", "Release")],
                    &[AccessAction::Read, AccessAction::SecretValues],
                ),
            ],
        },
    );
    let cluster = id.0.as_str();

    let pods = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "Pod" }),
    )
    .await
    .unwrap();
    assert_eq!(pods["namespaces"], json!([DEMO]));
    assert!(
        pods["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["metadata"]["namespace"] == DEMO),
        "{pods}"
    );
    let elsewhere = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "Pod", "namespace": "kube-system" }),
    )
    .await
    .unwrap_err();
    assert!(
        elsewhere.contains("Pod in namespace kube-system"),
        "{elsewhere}"
    );

    // A Node has no namespace: a rule for sextant-demo does not cover it, whatever namespace the agent sends.
    let node = tool(
        &state,
        "list_resources",
        json!({ "cluster": cluster, "kind": "Node", "namespace": DEMO }),
    )
    .await
    .unwrap_err();
    assert!(node.starts_with("Sextant denied read on Node"), "{node}");

    let value = tool(
        &state,
        "get_secret_value",
        json!({ "cluster": cluster, "namespace": DEMO, "name": "demo-secret", "key": "password" }),
    )
    .await
    .unwrap();
    assert!(value == "not-a-real-password", "not the value of the key");
    let secret = tool(
        &state,
        "get_resource",
        json!({ "cluster": cluster, "kind": "Secret", "namespace": DEMO, "name": "demo-secret" }),
    )
    .await
    .unwrap();
    assert!(
        secret["data"]["username"] != "",
        "the values come with the permission"
    );

    // Helm releases only where a rule names them; values and manifest with "Secret values".
    let releases = tool(&state, "helm_list_releases", json!({ "cluster": cluster }))
        .await
        .unwrap();
    let listed = releases["releases"].as_array().unwrap();
    assert!(
        listed.iter().all(|r| r["namespace"] == "sextant-flux"),
        "{releases}"
    );
    if listed.iter().any(|r| r["name"] == "podinfo-helm") {
        let release = tool(
            &state,
            "helm_get_release",
            json!({ "cluster": cluster, "namespace": "sextant-flux", "name": "podinfo-helm" }),
        )
        .await
        .unwrap();
        assert!(release["manifest"].as_str().is_some_and(|m| !m.is_empty()));
        assert!(release.get("valuesHidden").is_none());
    }

    let journal = state.mcp.context().audit.list(Some(&id));
    let written = std::fs::read_to_string(dir.path().join("data/mcp-audit.jsonl")).unwrap();
    assert!(
        !written.contains("not-a-real-password") && !written.contains("bm90LWEtcmVhbC1wYXNzd29yZA")
    );
    assert!(
        journal
            .iter()
            .any(|e| e.decision == AuditDecision::Denied && e.result == "denied")
    );
    state.close_all();
}

// -----------------------------------------------------------------------------------------------------------------
// Stopping, limits of what the journal keeps.

/// A server sharing `state`'s context whose only tool, `change`, waits for `go`, then asks for a Modify of
/// `Pod team-a/<name>` (confirmation required by the Read + write preset) and, when allowed, sets `done`.
struct Probe {
    server: super::server::McpServer,
    go: Arc<tokio::sync::Notify>,
    done: Arc<std::sync::atomic::AtomicBool>,
    confirms: Arc<Mutex<Vec<super::confirm::ConfirmRequest>>>,
}

fn probe(state: &AppState) -> Probe {
    use super::guard::{CallSummary, ClusterKinds, ClusterTarget};
    use super::tools::{ToolCall, ToolKind, ToolOutput, ToolSet};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct Args {
        name: String,
    }

    let go = Arc::new(tokio::sync::Notify::new());
    let done = Arc::new(AtomicBool::new(false));
    let mut tools = ToolSet::new();
    let (go_in, done_in) = (Arc::clone(&go), Arc::clone(&done));
    tools.add(
        "change",
        "test",
        ToolKind::Change,
        move |call: ToolCall, args: Args| {
            let (go, done) = (Arc::clone(&go_in), Arc::clone(&done_in));
            async move {
                go.notified().await;
                let cluster = ClusterTarget {
                    id: ClusterId::from("c1"),
                    name: "c1".into(),
                };
                let summary = CallSummary {
                    tool: "change".into(),
                    target: format!("Pod team-a/{}", args.name),
                    details: None,
                };
                let need = (
                    Some("team-a".to_owned()),
                    KindPattern::new("", "Pod"),
                    AccessAction::Modify,
                );
                call.guard.check(&cluster, &[need], &summary).await?;
                done.store(true, Ordering::SeqCst);
                Ok(ToolOutput::Text("changed".into()))
            }
        },
    );
    set_access(
        state,
        &ClusterId::from("c1"),
        preset(AccessPreset::ReadWrite),
    );
    let ctx = Arc::clone(state.mcp.context());
    let server = super::server::McpServer::with_parts(
        Arc::clone(&ctx),
        Arc::new(ClusterKinds(state.clusters.clone())),
        Arc::new(tools),
    );
    // Every confirmation is allowed at once.
    let confirms = Arc::new(Mutex::new(Vec::new()));
    let (seen, weak) = (Arc::clone(&confirms), Arc::downgrade(&ctx));
    ctx.set_emitter(Arc::new(move |event| {
        if let McpEvent::Confirm(request) = event {
            seen.lock().unwrap().push(request.clone());
            if let Some(ctx) = weak.upgrade() {
                let _ = ctx.confirmations.answer(&request.id, true);
            }
        }
        true
    }));
    Probe {
        server,
        go,
        done,
        confirms,
    }
}

async fn start_probe(probe: &Probe) -> u16 {
    for _ in 0..20 {
        let port = free_port();
        let settings = sextant_core::AppSettings {
            mcp: McpSettings {
                enabled: true,
                port,
            },
            ..Default::default()
        };
        probe.server.apply_settings(&settings).await;
        if probe.server.status().state == McpState::Running {
            return port;
        }
    }
    panic!("no free port");
}

fn args(name: &str) -> serde_json::Map<String, Value> {
    json!({ "name": name }).as_object().unwrap().clone()
}

#[tokio::test]
async fn a_call_begun_before_the_server_stopped_neither_asks_nor_acts() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let probe = probe(&state);

    // Stopped by closing the window, by turning the server off, and by a new token (a restart).
    for how in ["stop", "off", "regenerate"] {
        start_probe(&probe).await;
        let handler = probe.server.handler();
        let call = tokio::spawn(async move { handler.call("agent", "change", args("web")).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        match how {
            "stop" => probe.server.stop(),
            "off" => {
                probe
                    .server
                    .apply_settings(&sextant_core::AppSettings::default())
                    .await
            }
            _ => {
                probe.server.regenerate_token().await.unwrap();
            }
        }
        probe.go.notify_waiters();
        let result = call.await.unwrap();
        assert!(result.is_err(), "{how}: the call ran: {result:?}");
        assert!(
            !probe.done.load(std::sync::atomic::Ordering::SeqCst),
            "{how}: the action ran"
        );
        assert!(probe.confirms.lock().unwrap().is_empty(), "{how}: asked");
        probe.server.stop();
    }

    // After a stop nothing is asked until the server starts again.
    let ctx = Arc::clone(probe.server.context());
    let outcome = ctx
        .confirmations
        .ask(
            super::confirm::ConfirmRequest {
                id: String::new(),
                client: "c".into(),
                cluster_id: ClusterId::from("c1"),
                cluster_name: "c1".into(),
                tool: "change".into(),
                target: "Pod team-a/web".into(),
                details: None,
            },
            |_| true,
        )
        .await;
    assert_eq!(outcome, super::confirm::ConfirmOutcome::Declined);
    assert!(probe.confirms.lock().unwrap().is_empty());

    // A call begun after a new start works.
    start_probe(&probe).await;
    let handler = probe.server.handler();
    let call = tokio::spawn(async move { handler.call("agent", "change", args("web")).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    probe.go.notify_waiters();
    assert!(call.await.unwrap().is_ok());
    assert!(probe.done.load(std::sync::atomic::Ordering::SeqCst));
    probe.server.stop();
}

#[tokio::test]
async fn a_start_that_ends_after_a_stop_leaves_no_listener() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let state = Arc::new(state);
    // The port is taken, so the start keeps trying to bind it; it is freed right after the stop.
    let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    state
        .settings
        .update(|s| {
            s.mcp = McpSettings {
                enabled: true,
                port,
            }
        })
        .unwrap();
    let starting = Arc::clone(&state);
    let start =
        tokio::spawn(async move { starting.mcp.apply_settings(&starting.settings.get()).await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    state.close_all();
    drop(taken);
    start.await.unwrap();
    assert_eq!(
        state.mcp.status().state,
        McpState::Off,
        "{:?}",
        state.mcp.status()
    );
    assert!(port_is_closed(port).await, "a listener outlived close_all");
}

#[tokio::test]
async fn long_clients_and_targets_are_cut_in_the_journal_and_the_dialog() {
    let _turn = SERVERS.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state_in(dir.path(), None);
    let probe = probe(&state);
    start_probe(&probe).await;
    let handler = probe.server.handler();
    let client = "c".repeat(10_000);
    let name = "n".repeat(10_000);
    let call = {
        let client = client.clone();
        tokio::spawn(async move { handler.call(&client, "change", args(&name)).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    probe.go.notify_waiters();
    assert!(call.await.unwrap().is_ok());

    let limit = super::audit::MAX_TEXT_CHARS;
    let shown = probe.confirms.lock().unwrap()[0].clone();
    let entry = probe.server.context().audit.list(None)[0].clone();
    for text in [&shown.client, &shown.target, &entry.client, &entry.target] {
        assert!(
            text.chars().count() <= limit + 10,
            "{} chars",
            text.chars().count()
        );
        assert!(text.ends_with("[cut]"), "{}", &text[text.len() - 20..]);
    }
    assert!(entry.target.starts_with("Pod team-a/nnn"));
    probe.server.stop();
}
