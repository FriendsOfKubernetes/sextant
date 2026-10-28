//! A backend for the runtime's tests: each method exercises one thing the runtime must allow or stop.

wit_bindgen::generate!({
    path: "../../../../sdk/wit",
    world: "backend",
});

use sextant::extension::host;

struct Backend;

fn http_get(url: &str) -> Result<String, String> {
    use wasi::http::outgoing_handler;
    use wasi::http::types::{Fields, OutgoingRequest, Scheme};
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "not a URL".to_owned())?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let request = OutgoingRequest::new(Fields::new());
    let _ = request.set_scheme(Some(&if scheme == "https" { Scheme::Https } else { Scheme::Http }));
    let _ = request.set_authority(Some(authority));
    let _ = request.set_path_with_query(Some(path));
    let future = outgoing_handler::handle(request, None).map_err(|e| format!("{e:?}"))?;
    let response = loop {
        if let Some(r) = future.get() {
            break r.map_err(|()| "taken".to_owned())?.map_err(|e| format!("{e:?}"))?;
        }
        future.subscribe().block();
    };
    let status = response.status();
    let body = response.consume().map_err(|()| "no body".to_owned())?;
    let stream = body.stream().map_err(|()| "no stream".to_owned())?;
    let mut bytes = Vec::new();
    loop {
        match stream.blocking_read(64 * 1024) {
            Ok(chunk) => bytes.extend_from_slice(&chunk),
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("{e:?}")),
        }
    }
    Ok(format!("{status} {}", String::from_utf8_lossy(&bytes)))
}

impl Guest for Backend {
    fn handle(method: String, params: String) -> Result<String, String> {
        match method.as_str() {
            "echo" => Ok(params),
            "host" => {
                // params: {"method": "...", "params": "<json text>"}
                let (method, inner) = params.split_once('\n').ok_or("method\\nparams")?;
                match host::call(method, inner) {
                    Ok(result) => Ok(result),
                    Err(e) => Err(format!("{}: {}", e.code, e.message)),
                }
            }
            "log" => {
                host::log(host::Level::Info, &params);
                println!("to stdout");
                eprintln!("to stderr");
                Ok("logged".into())
            }
            "env" => {
                let vars = std::env::vars().count();
                let args = std::env::args().count();
                let root = std::fs::read_dir("/").is_ok();
                let file = std::fs::read("/etc/passwd").is_ok();
                let tcp = std::net::TcpStream::connect("127.0.0.1:22").is_ok();
                Ok(format!("vars={vars} args={args} root={root} file={file} tcp={tcp}"))
            }
            "clock" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?;
                Ok(now.as_secs().to_string())
            }
            "spin" => {
                let mut x: u64 = 0;
                loop {
                    x = x.wrapping_add(std::hint::black_box(1));
                    if x == u64::MAX {
                        return Ok(x.to_string());
                    }
                }
            }
            "grow" => {
                let mut kept: Vec<Vec<u8>> = Vec::new();
                loop {
                    kept.push(vec![1u8; 8 * 1024 * 1024]);
                    if kept.len() > 1000 {
                        return Ok(kept.len().to_string());
                    }
                }
            }
            "panic" => panic!("on purpose"),
            "fetch" => http_get(&params),
            "big" => Ok("x".repeat(params.parse::<usize>().map_err(|e| e.to_string())?)),
            other => Err(format!("unknown method {other}")),
        }
    }
}

export!(Backend);
