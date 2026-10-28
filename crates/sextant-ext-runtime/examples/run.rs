//! Runs one call of a backend component with a stand-in host, for the SDK's checks and for authors:
//!
//!   cargo run -p sextant-ext-runtime --example run -- <component.wasm> <method> [params-json]
//!
//! The host answers `clusters.list` with one cluster (`demo`), `credentials.get` with null, and refuses every other
//! extension-API method and every HTTP request; the backend's log goes to stderr. The answer is printed on stdout; a
//! failed call exits with 1.

use std::sync::Arc;

use sextant_ext_runtime::{
    CallError, Host, HostFuture, HttpError, HttpRequest, HttpResponse, Level, Limits, Runtime,
};

struct StandIn;

impl Host for StandIn {
    fn call<'a>(
        &'a self,
        method: &'a str,
        _params: &'a str,
    ) -> HostFuture<'a, Result<String, CallError>> {
        Box::pin(async move {
            match method {
                "clusters.list" => Ok(r#"[{"id":"demo","name":"demo","context":"demo"}]"#.to_owned()),
                "credentials.get" => Ok("null".to_owned()),
                _ => Err(CallError {
                    code: "forbidden".to_owned(),
                    message: format!("the stand-in host does not serve {method}"),
                }),
            }
        })
    }

    fn log(&self, level: Level, message: &str) {
        eprintln!("[{level:?}] {}", message.trim_end());
    }

    fn http(&self, request: HttpRequest) -> HostFuture<'static, Result<HttpResponse, HttpError>> {
        eprintln!("[http] {} {} refused by the stand-in host", request.method, request.uri);
        Box::pin(async { Err(HttpError::Denied) })
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path, method, rest @ ..] = args.as_slice() else {
        eprintln!("usage: run <component.wasm> <method> [params-json]");
        std::process::exit(2);
    };
    let params = rest.first().map_or("null", String::as_str);
    let wasm = std::fs::read(path).unwrap_or_else(|e| {
        eprintln!("cannot read {path}: {e}");
        std::process::exit(2);
    });
    let runtime = Runtime::new().expect("the runtime starts");
    let backend = runtime.compile(&wasm).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    match runtime
        .invoke(&backend, Arc::new(StandIn), method, params, &Limits::default())
        .await
    {
        Ok(answer) => println!("{answer}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
