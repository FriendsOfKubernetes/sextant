//! A backend for the runtime's and the app's tests: each method exercises one thing the runtime must allow or stop.
//! `params` may be JSON (as the app passes it) or plain text (the runtime's own tests); every answer is JSON.

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

/// A JSON string's value, or the text itself.
fn text(params: &str) -> String {
    serde_json::from_str::<String>(params).unwrap_or_else(|_| params.to_owned())
}

fn json(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

impl Guest for Backend {
    fn handle(method: String, params: String) -> Result<String, String> {
        match method.as_str() {
            "echo" => Ok(params),
            "host" => {
                // `method\nparams`, as text or as a JSON string.
                let request = text(&params);
                let (method, inner) = request.split_once('\n').ok_or("method\\nparams")?;
                match host::call(method, inner) {
                    Ok(result) => Ok(result),
                    Err(e) => Err(format!("{}: {}", e.code, e.message)),
                }
            }
            "log" => {
                host::log(host::Level::Info, &text(&params));
                println!("to stdout");
                eprintln!("to stderr");
                Ok(json("logged"))
            }
            "env" => {
                let vars = std::env::vars().count();
                let args = std::env::args().count();
                let root = std::fs::read_dir("/").is_ok();
                let file = std::fs::read("/etc/passwd").is_ok();
                let tcp = std::net::TcpStream::connect("127.0.0.1:22").is_ok();
                Ok(json(&format!("vars={vars} args={args} root={root} file={file} tcp={tcp}")))
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
            "fetch" => http_get(&text(&params)).map(|answer| json(&answer)),
            "big" => Ok(json(&"x".repeat(text(&params).parse::<usize>().map_err(|e| e.to_string())?))),
            // A problem judge (ADR-0168): every object it was given has the fact `seen` with its name, and the texts say
            // whether a host call and a request got through; then a fact about an object it was not given, and one it
            // does not declare, which Sextant leaves out.
            judge if judge.starts_with("problemJudge:") => {
                let given: serde_json::Value = serde_json::from_str(&params).map_err(|e| e.to_string())?;
                let host = match host::call("clusters.list", "{}") {
                    Ok(_) => "allowed",
                    Err(_) => "refused",
                };
                let net = match http_get("https://api.example.com/") {
                    Ok(_) => "allowed",
                    Err(_) => "refused",
                };
                let mut facts: Vec<serde_json::Value> = given["objects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|o| {
                        serde_json::json!({
                            "uid": o["metadata"]["uid"],
                            "fact": "seen",
                            "values": { "name": o["metadata"]["name"], "host": host, "net": net, "values": o["values"].to_string() },
                        })
                    })
                    .collect();
                facts.push(serde_json::json!({ "uid": "not-given", "fact": "seen" }));
                facts.push(serde_json::json!({ "uid": given["objects"][0]["metadata"]["uid"], "fact": "undeclared" }));
                Ok(serde_json::Value::Array(facts).to_string())
            }
            other => Err(format!("unknown method {other}")),
        }
    }
}

export!(Backend);
