//! The backend: a WebAssembly component Sextant runs outside the window (ADR-0131). It reaches the clusters through
//! `host::call` with the extension's grant, the network only at the hosts the manifest declares (here
//! api.github.com), and the credentials the user entered in Sextant.

wit_bindgen::generate!({
    path: "../../../wit",
    world: "backend",
});

use serde::Deserialize;
use serde_json::{Value, json};
use sextant::extension::host;
use wstd::http::{Body, Client, Request};

const LATEST: &str = "https://api.github.com/repos/FriendsOfKubernetes/sextant/releases/latest";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    published_at: String,
}

/// One extension-API method; `Err` is the error's code and message.
fn call(method: &str, params: &Value) -> Result<Value, String> {
    let answer = host::call(method, &params.to_string()).map_err(|e| format!("{}: {}", e.code, e.message))?;
    serde_json::from_str(&answer).map_err(|e| e.to_string())
}

async fn latest_release(token: Option<String>) -> Result<Release, String> {
    let mut request = Request::get(LATEST).header("accept", "application/vnd.github+json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let request = request.body(Body::empty()).map_err(|e| e.to_string())?;
    let mut response = Client::new().send(request).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status().as_u16()));
    }
    response.body_mut().json::<Release>().await.map_err(|e| e.to_string())
}

fn summary() -> Result<Value, String> {
    let clusters = call("clusters.list", &json!({}))?
        .as_array()
        .map_or(0, Vec::len);
    let token = call("credentials.get", &json!({ "name": "github-token" }))?
        .as_str()
        .map(str::to_owned);
    Ok(match wstd::runtime::block_on(latest_release(token)) {
        Ok(release) => {
            host::log(host::Level::Info, &format!("latest release {}", release.tag_name));
            json!({ "clusters": clusters, "latest": { "tag": release.tag_name, "published": release.published_at } })
        }
        Err(error) => json!({ "clusters": clusters, "latest": null, "error": error }),
    })
}

struct Backend;

impl Guest for Backend {
    fn handle(method: String, _params: String) -> Result<String, String> {
        let answer = match method.as_str() {
            "ping" => json!("pong"),
            "summary" => summary()?,
            other => return Err(format!("unknown method {other}")),
        };
        Ok(answer.to_string())
    }
}

export!(Backend);
