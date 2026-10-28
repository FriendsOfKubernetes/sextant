//! The runtime against a real component: `tests/guest` (Rust, `wasm32-wasip2`), built by `tests/guest/build.sh` into
//! `tests/fixtures/guest.wasm`. Each test calls one of its methods and checks what the runtime allowed or stopped.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use sextant_ext_runtime::{
    Backend, CallError, CompileError, Host, HostFuture, HttpError, HttpRequest, HttpResponse,
    InvokeError, Level, Limits, Runtime,
};

const GUEST: &[u8] = include_bytes!("fixtures/guest.wasm");

#[derive(Default)]
struct Recorder {
    logs: Mutex<Vec<(Level, String)>>,
    calls: Mutex<Vec<(String, String)>>,
    requests: Mutex<Vec<String>>,
}

impl Host for Recorder {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: &'a str,
    ) -> HostFuture<'a, Result<String, CallError>> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_owned(), params.to_owned()));
        Box::pin(async move {
            match method {
                "clusters.list" => Ok(r#"[{"name":"kind-test"}]"#.to_owned()),
                "big" => Ok("y".repeat(2 * 1024 * 1024)),
                _ => Err(CallError {
                    code: "forbidden".to_owned(),
                    message: format!("{method} is not allowed"),
                }),
            }
        })
    }

    fn log(&self, level: Level, message: &str) {
        self.logs.lock().unwrap().push((level, message.to_owned()));
    }

    fn http(&self, request: HttpRequest) -> HostFuture<'static, Result<HttpResponse, HttpError>> {
        self.requests.lock().unwrap().push(request.uri.to_string());
        let host = request.uri.host().unwrap_or_default().to_owned();
        Box::pin(async move {
            if host == "api.example.com" {
                Ok(HttpResponse {
                    status: http::StatusCode::OK,
                    headers: http::HeaderMap::new(),
                    body: Bytes::from_static(b"hello from the host"),
                })
            } else {
                Err(HttpError::Denied)
            }
        })
    }
}

struct Fixture {
    runtime: Runtime,
    backend: Backend,
    host: Arc<Recorder>,
}

fn fixture() -> Fixture {
    let runtime = Runtime::new().unwrap();
    let backend = runtime.compile(GUEST).unwrap();
    Fixture {
        runtime,
        backend,
        host: Arc::new(Recorder::default()),
    }
}

impl Fixture {
    async fn run(
        &self,
        method: &str,
        params: &str,
        limits: &Limits,
    ) -> Result<String, InvokeError> {
        let host: Arc<dyn Host> = self.host.clone();
        self.runtime
            .invoke(&self.backend, host, method, params, limits)
            .await
    }

    async fn call(&self, method: &str, params: &str) -> Result<String, InvokeError> {
        self.run(method, params, &Limits::default()).await
    }
}

#[tokio::test]
async fn a_call_is_answered_and_the_backends_own_error_is_passed_on() {
    let f = fixture();
    assert_eq!(f.call("echo", r#"{"a":1}"#).await.unwrap(), r#"{"a":1}"#);
    assert_eq!(
        f.call("nothing", "{}").await.unwrap_err(),
        InvokeError::Backend("unknown method nothing".into())
    );
}

#[tokio::test]
async fn host_calls_go_to_the_host_with_its_answers_and_errors() {
    let f = fixture();
    assert_eq!(
        f.call("host", "clusters.list\n{}").await.unwrap(),
        r#"[{"name":"kind-test"}]"#
    );
    assert_eq!(
        f.call("host", "resources.delete\n{}").await.unwrap_err(),
        InvokeError::Backend("forbidden: resources.delete is not allowed".into())
    );
    // An answer past the payload limit never reaches the backend.
    assert_eq!(
        f.call("host", "big\n{}").await.unwrap_err(),
        InvokeError::Backend("invalid: the answer of big is larger than 1048576 bytes".into())
    );
    let calls = f.host.calls.lock().unwrap().clone();
    assert_eq!(calls[0], ("clusters.list".to_owned(), "{}".to_owned()));
}

#[tokio::test]
async fn logs_stdout_and_stderr_reach_the_hosts_log() {
    let f = fixture();
    assert_eq!(f.call("log", "a line").await.unwrap(), "logged");
    let logs = f.host.logs.lock().unwrap().clone();
    assert!(
        logs.contains(&(Level::Info, "a line".to_owned())),
        "{logs:?}"
    );
    assert!(
        logs.contains(&(Level::Info, "to stdout\n".to_owned())),
        "{logs:?}"
    );
    assert!(
        logs.contains(&(Level::Warn, "to stderr\n".to_owned())),
        "{logs:?}"
    );
}

#[tokio::test]
async fn there_is_no_environment_no_file_and_no_socket_but_the_clock_works() {
    let f = fixture();
    assert_eq!(
        f.call("env", "").await.unwrap(),
        "vars=0 args=0 root=false file=false tcp=false"
    );
    let seconds: u64 = f.call("clock", "").await.unwrap().parse().unwrap();
    assert!(seconds > 1_700_000_000);
}

#[tokio::test]
async fn http_goes_only_through_the_hosts_policy() {
    let f = fixture();
    assert_eq!(
        f.call("fetch", "https://api.example.com/v1/x")
            .await
            .unwrap(),
        "200 hello from the host"
    );
    let denied = f
        .call("fetch", "https://elsewhere.example.org/")
        .await
        .unwrap_err();
    assert!(
        matches!(&denied, InvokeError::Backend(m) if m.contains("HttpRequestDenied")),
        "{denied:?}"
    );
    // Plain HTTP never reaches the host.
    let plain = f
        .call("fetch", "http://api.example.com/")
        .await
        .unwrap_err();
    assert!(matches!(plain, InvokeError::Backend(_)), "{plain:?}");
    let requests = f.host.requests.lock().unwrap().clone();
    assert_eq!(
        requests,
        [
            "https://api.example.com/v1/x",
            "https://elsewhere.example.org/"
        ]
    );
}

#[tokio::test]
async fn a_backend_that_runs_too_long_is_stopped() {
    let f = fixture();
    let limits = Limits {
        time: Duration::from_millis(300),
        ..Limits::default()
    };
    let started = Instant::now();
    assert_eq!(
        f.run("spin", "", &limits).await.unwrap_err(),
        InvokeError::Timeout
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    // The runtime is still usable afterwards.
    assert_eq!(f.call("echo", "after").await.unwrap(), "after");
}

#[tokio::test]
async fn a_backend_that_takes_too_much_memory_is_stopped() {
    let f = fixture();
    let limits = Limits {
        memory_bytes: 32 * 1024 * 1024,
        ..Limits::default()
    };
    assert_eq!(
        f.run("grow", "", &limits).await.unwrap_err(),
        InvokeError::OutOfMemory
    );
}

#[tokio::test]
async fn a_panic_is_a_failed_call_and_the_next_call_starts_afresh() {
    let f = fixture();
    let err = f.call("panic", "").await.unwrap_err();
    assert!(matches!(err, InvokeError::Trap(_)), "{err:?}");
    let logs = f.host.logs.lock().unwrap().clone();
    assert!(
        logs.iter()
            .any(|(l, m)| *l == Level::Warn && m.contains("on purpose")),
        "{logs:?}"
    );
    assert_eq!(f.call("echo", "fresh").await.unwrap(), "fresh");
}

#[tokio::test]
async fn payloads_past_the_limit_are_refused_both_ways() {
    let f = fixture();
    let limits = Limits {
        payload_bytes: 1000,
        ..Limits::default()
    };
    assert_eq!(
        f.run("echo", &"x".repeat(1001), &limits).await.unwrap_err(),
        InvokeError::PayloadTooLarge
    );
    assert_eq!(
        f.run("big", "1001", &limits).await.unwrap_err(),
        InvokeError::PayloadTooLarge
    );
    assert_eq!(f.run("big", "1000", &limits).await.unwrap().len(), 1000);
}

#[tokio::test]
async fn a_compiled_backend_is_kept_and_loaded_again() {
    let f = fixture();
    let compiled = f.backend.serialize().unwrap();
    let loaded = f.runtime.load(&compiled).unwrap();
    let host: Arc<dyn Host> = f.host.clone();
    assert_eq!(
        f.runtime
            .invoke(&loaded, host, "echo", "again", &Limits::default())
            .await
            .unwrap(),
        "again"
    );
    assert!(f.runtime.load(b"not compiled code").is_err());
}

#[test]
fn what_is_not_a_backend_is_refused_with_a_reason() {
    let runtime = Runtime::new().unwrap();
    assert!(matches!(
        runtime.compile(b"\0asm junk"),
        Err(CompileError::Invalid(_))
    ));
    assert!(matches!(
        runtime.compile(&vec![0u8; sextant_ext_runtime::MAX_COMPONENT_BYTES + 1]),
        Err(CompileError::TooLarge { .. })
    ));
    // A component that imports something Sextant does not provide.
    for foreign in [
        r#"(component (import "acme:secret/door" (instance)))"#,
        r#"(component (import "acme:secret/door" (instance (export "open" (func)))))"#,
    ] {
        let err = runtime
            .compile(&wat::parse_str(foreign).unwrap())
            .map(|_| ())
            .unwrap_err();
        assert!(
            matches!(&err, CompileError::Incompatible(m) if m.contains("`acme:secret/door`")),
            "{err:?}"
        );
    }
    // A component with no `handle` export.
    let err = runtime
        .compile(&wat::parse_str("(component)").unwrap())
        .map(|_| ())
        .unwrap_err();
    assert!(
        matches!(&err, CompileError::Incompatible(m) if m.contains("handle")),
        "{err:?}"
    );
}
