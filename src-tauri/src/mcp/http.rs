//! The HTTP side of the MCP server: `POST/GET/DELETE /mcp` (rmcp's Streamable HTTP) behind a check that runs before
//! MCP sees anything — `Host` must be `127.0.0.1:<port>` or `localhost:<port>` and there must be no `Origin` (a page
//! in a browser, DNS rebinding: 403), `Authorization: Bearer <token>` must carry the current token (401, no details),
//! and the body is at most [`MAX_BODY_BYTES`] (413).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tokio_util::sync::CancellationToken;

use super::context::McpContext;
use super::server::SextantMcp;

/// The path of the MCP endpoint.
pub const MCP_PATH: &str = "/mcp";

/// Largest request body.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

struct HttpCheck {
    ctx: Arc<McpContext>,
    port: u16,
}

/// The routes of a server on `127.0.0.1:<port>`; cancelling `cancel` ends every MCP session.
pub fn router(handler: SextantMcp, port: u16, cancel: CancellationToken) -> Router {
    let ctx = Arc::clone(handler.context());
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(allowed_hosts(port))
        // An empty list with validation on: any `Origin` is refused (our own check refuses it first).
        .enforce_origin_validation()
        .with_max_request_body_bytes(MAX_BODY_BYTES)
        .with_cancellation_token(cancel);
    let service = StreamableHttpService::new(
        move || Ok(handler.for_new_session()),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new()
        .route_service(MCP_PATH, service)
        .layer(middleware::from_fn_with_state(
            Arc::new(HttpCheck { ctx, port }),
            check_request,
        ))
}

fn allowed_hosts(port: u16) -> [String; 2] {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
}

async fn check_request(
    State(check): State<Arc<HttpCheck>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if !host_allowed(headers, check.port) || headers.contains_key(header::ORIGIN) {
        return plain(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !bearer(headers).is_some_and(|token| check.ctx.token_matches(token)) {
        let mut response = plain(StatusCode::UNAUTHORIZED, "Unauthorized");
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Bearer"),
        );
        return response;
    }
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declared.is_some_and(|len| len > MAX_BODY_BYTES as u64) {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
    }
    // A body without a length (chunked) is limited while it streams, by rmcp (`max_request_body_bytes`).
    next.run(request).await
}

fn host_allowed(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    allowed_hosts(port)
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host.trim()))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

fn plain(status: StatusCode, text: &'static str) -> Response {
    (status, Body::from(text)).into_response()
}
