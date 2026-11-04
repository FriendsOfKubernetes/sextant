//! Backends built by earlier SDKs keep running (ADR-0142): the component of each frozen package in
//! `sdk/test/fixtures/compat/` is compiled and called by today's runtime, with its host calls and requests answered.

use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use sextant_ext_runtime::{
    CallError, Host, HostFuture, HttpError, HttpRequest, HttpResponse, Level, Limits, Runtime,
};

/// The backend's file in a package.
fn component(package: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sdk/test/fixtures/compat")
        .join(package);
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut file = archive.by_name("backend.wasm").unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}

#[derive(Default)]
struct Answers {
    calls: Mutex<Vec<String>>,
    requests: Mutex<Vec<String>>,
}

impl Host for Answers {
    fn call<'a>(
        &'a self,
        method: &'a str,
        _params: &'a str,
    ) -> HostFuture<'a, Result<String, CallError>> {
        self.calls.lock().unwrap().push(method.to_owned());
        Box::pin(async move {
            match method {
                "clusters.list" => Ok(r#"[{"name":"kind-a"},{"name":"kind-b"}]"#.to_owned()),
                "credentials.get" => Ok("null".to_owned()),
                _ => Err(CallError {
                    code: "denied".to_owned(),
                    message: format!("{method} is not granted"),
                }),
            }
        })
    }

    fn log(&self, _level: Level, _message: &str) {}

    fn http(&self, request: HttpRequest) -> HostFuture<'static, Result<HttpResponse, HttpError>> {
        self.requests.lock().unwrap().push(request.uri.to_string());
        Box::pin(async move {
            Ok(HttpResponse {
                status: http::StatusCode::OK,
                headers: http::HeaderMap::new(),
                body: Bytes::from_static(
                    br#"{"tag_name":"v0.26.0","published_at":"2026-10-29T00:00:00Z"}"#,
                ),
            })
        })
    }
}

#[tokio::test]
async fn the_rust_backend_built_by_the_sdk_of_0_26_0_runs() {
    let runtime = Runtime::new().unwrap();
    let backend = runtime
        .compile(&component(
            "sdk-0.26.0/sextant.example.backend-rust-1.0.0.sextant-ext",
        ))
        .unwrap();
    let answers = Arc::new(Answers::default());
    let host: Arc<dyn Host> = answers.clone();
    let limits = Limits::default();
    assert_eq!(
        runtime
            .invoke(&backend, host.clone(), "ping", "{}", &limits)
            .await
            .unwrap(),
        r#""pong""#
    );
    let summary: serde_json::Value = serde_json::from_str(
        &runtime
            .invoke(&backend, host, "summary", "{}", &limits)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(summary["clusters"], 2);
    assert_eq!(summary["latest"]["tag"], "v0.26.0");
    assert_eq!(
        *answers.calls.lock().unwrap(),
        ["clusters.list", "credentials.get"]
    );
    assert_eq!(
        *answers.requests.lock().unwrap(),
        ["https://api.github.com/repos/FriendsOfKubernetes/sextant/releases/latest"]
    );
}
