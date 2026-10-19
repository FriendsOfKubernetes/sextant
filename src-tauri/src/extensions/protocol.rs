//! The `sextant-ext` protocol: files of an active extension, served to its sandboxed frame.
//!
//! URLs (the webview's own form per OS):
//! - Linux, macOS: `sextant-ext://<id>/<path>` (the id is the host). An extension whose id is `localhost` uses the
//!   path form `sextant-ext://localhost/localhost/<path>`.
//! - Windows (and Android): `http://sextant-ext.localhost/<id>/<path>`; WebView2 hands it to the handler as
//!   `sextant-ext://localhost/<id>/<path>`.
//!
//! The handler accepts all three: host `localhost` or `sextant-ext.localhost` means the id is the first path part.
//! The query and fragment are ignored (the frame reads `?view=…` itself). The path is percent-decoded and then opened
//! only through [`resolve_package_file`]: exact names inside the extension's folder, no `..`, no dot-files, no links.
//! A disabled, unknown or paused extension, or any file that cannot be served, is `404`. A file carries the CSP of
//! its extension ([`extension_csp`]: sources only from its own folder, no network, a sandbox); a `404` or `405`
//! carries [`ERROR_CSP`]. Every answer has `nosniff`, `no-store` and `Referrer-Policy: no-referrer`. Why a file was refused (a link, a hard link,
//! another spelling, a file system that cannot be checked, too big) goes to stderr once per file, without its contents;
//! a file that is simply not there is not logged.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use sextant_core::ErrorCode;
use sextant_core::extensions::{MAX_UNPACKED_BYTES, resolve_package_file};
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime};

use super::ExtensionHost;

/// The scheme name.
pub const SCHEME: &str = "sextant-ext";

/// The sandbox of an extension frame: the iframe attribute (`FRAME_SANDBOX` in `src/extensions/ExtensionFrame.tsx`,
/// pinned by a test) and the CSP `sandbox` of every file. Never `allow-same-origin`.
pub const SANDBOX: &str = "allow-scripts allow-forms allow-popups-to-escape-sandbox";

/// The `Content-Security-Policy` of a `404` or `405`: nothing loads, nothing runs.
pub const ERROR_CSP: &str = "default-src 'none'; sandbox";

/// The `Content-Security-Policy` of a file of the extension served from `base` ([`base_url`]), spec story 10: only
/// its own scripts, styles, images and fonts (inline allowed), no network, no form submission, and a sandbox like the
/// frame's should the document ever be opened outside it.
///
/// The sources name the extension's own folder instead of `'self'`: the frame is sandboxed without
/// `allow-same-origin`, so its origin is opaque and `'self'` matches nothing (WebKitGTK then blocks the package's own
/// `<script src>` and stylesheets); and on Windows every extension shares the origin `http://sextant-ext.localhost`,
/// where the path prefix `/<id>/` is what keeps one extension from loading another's files.
pub fn extension_csp(base: &str) -> String {
    format!(
        "default-src 'none'; script-src {base} 'unsafe-inline'; style-src {base} 'unsafe-inline'; \
         img-src {base} data:; font-src {base} data:; connect-src 'none'; form-action 'none'; sandbox {SANDBOX}"
    )
}

/// Where the files of `id` are served from, ending with `/`, in this OS's form (see the module docs).
pub fn base_url(id: &str) -> String {
    base_url_in(id, cfg!(any(windows, target_os = "android")))
}

/// [`base_url`] in the Windows form (`windows`) or the Linux/macOS one.
fn base_url_in(id: &str, windows: bool) -> String {
    if windows {
        format!("http://{SCHEME}.localhost/{id}/")
    } else if is_path_form_host(id) {
        format!("{SCHEME}://localhost/{id}/")
    } else {
        format!("{SCHEME}://{id}/")
    }
}

/// Hosts that mean "the id is the first part of the path".
fn is_path_form_host(host: &str) -> bool {
    host == "localhost" || host == format!("{SCHEME}.localhost")
}

/// Percent-encodes what a `/`-separated package path may hold that a URL path may not (spaces, `#`, `?`, `%`, …).
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        let plain = byte.is_ascii_alphanumeric() || b"-._~/!$&'()*+,;=:@".contains(&byte);
        if plain {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Percent-decodes a URL path; `None` for a broken escape or bytes that are not UTF-8.
fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = path.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `(id, path inside the extension)` of a request URI (path still percent-encoded); `None` when it names no id.
fn split_target(uri: &tauri::http::Uri) -> Option<(String, String)> {
    let host = uri.host()?;
    let path = uri.path().strip_prefix('/').unwrap_or(uri.path());
    if is_path_form_host(host) {
        let (id, rest) = path.split_once('/').unwrap_or((path, ""));
        Some((decode_path(id)?, rest.to_owned()))
    } else {
        Some((host.to_owned(), path.to_owned()))
    }
}

/// `Content-Type` by the file's extension; unknown is `application/octet-stream` (with `nosniff` it never runs).
fn content_type(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn response(status: StatusCode, content_type: &str, csp: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        // The frame's links and loads never name the extension's file in a `Referer` (the iframe also sets it).
        // No `Cross-Origin-Resource-Policy`: the frame's origin is opaque, so `same-site` would block its own images,
        // styles and classic scripts; the CSP sources of each extension keep it to its own folder instead.
        .header(header::REFERRER_POLICY, "no-referrer")
        // The frame is sandboxed without `allow-same-origin`, so its origin is opaque (`null`) and module scripts
        // (`<script type="module">`, fetched in CORS mode) load only with this. Other extensions cannot read the
        // files anyway: their CSP allows no `connect-src` and only scripts from their own folder.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    response(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        ERROR_CSP,
        b"Not found".to_vec(),
    )
}

/// Answers one request of the frame.
pub fn serve(host: &ExtensionHost, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return response(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            ERROR_CSP,
            Vec::new(),
        );
    }
    let Some((id, path)) = split_target(request.uri()) else {
        return not_found();
    };
    let Some((root, entry)) = host.serving_root(&id) else {
        return not_found();
    };
    let file = if path.is_empty() {
        entry
    } else {
        match decode_path(&path) {
            Some(file) => file,
            None => return not_found(),
        }
    };
    match read_file(&root, &file) {
        Some(body) => {
            let body = if head { Vec::new() } else { body };
            let csp = extension_csp(&base_url(&id));
            response(StatusCode::OK, content_type(&file), &csp, body)
        }
        None => not_found(),
    }
}

fn read_file(root: &Path, file: &str) -> Option<Vec<u8>> {
    let open = match resolve_package_file(root, file) {
        Ok(open) => open,
        Err(err) => {
            if err.code != ErrorCode::NotFound {
                let _ = log_refusal(root, file, &err.message);
            }
            return None;
        }
    };
    match super::manage::read_limited(open, MAX_UNPACKED_BYTES + 1) {
        Ok(body) if body.len() as u64 <= MAX_UNPACKED_BYTES => Some(body),
        Ok(_) => {
            let _ = log_refusal(
                root,
                file,
                &format!("larger than {MAX_UNPACKED_BYTES} bytes"),
            );
            None
        }
        Err(err) => {
            let _ = log_refusal(root, file, &err.message);
            None
        }
    }
}

/// At most this many refused files are remembered (and so logged); a frame retrying one file logs it once.
const MAX_LOGGED_REFUSALS: usize = 256;

/// Writes why `file` of `root` was not served to stderr, the first time only. `reason` names the file and the check,
/// never its contents. Whether it was written.
fn log_refusal(root: &Path, file: &str, reason: &str) -> bool {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = format!("{}|{file}", root.display());
    let first = {
        let mut logged = LOGGED
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        logged.len() < MAX_LOGGED_REFUSALS && logged.insert(key)
    };
    if first {
        eprintln!(
            "sextant: extension file `{file}` in {} is not served: {reason}",
            root.display()
        );
    }
    first
}

/// Registers the protocol on the builder; files are read off the main thread.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
        let host = ctx
            .app_handle()
            .try_state::<ExtensionHost>()
            .map(|state| state.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            let answer = match host {
                Some(host) => serve(&host, &request),
                None => not_found(),
            };
            responder.respond(answer);
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::test_support::*;

    fn get(host: &ExtensionHost, uri: &str) -> Response<Vec<u8>> {
        serve(host, &Request::get(uri).body(Vec::new()).unwrap())
    }

    fn header_of(response: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
        response
            .headers()
            .get(name)
            .map_or("", |v| v.to_str().unwrap())
    }

    /// A host with `widgets` installed from a dev folder (granted what it asks).
    fn dev_host(dir: &Path) -> ExtensionHost {
        let folder = dir.join("src");
        write_folder(&folder, "widgets", "1.0.0", read_all());
        let host = host_in(dir);
        let pending = host.inspect_folder(&folder).unwrap();
        host.install(&pending.token).unwrap();
        host
    }

    #[test]
    fn files_are_served_in_the_host_and_the_path_form_with_the_extension_headers() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        for uri in [
            "sextant-ext://widgets/js/app.js",
            "sextant-ext://localhost/widgets/js/app.js?view=page&id=x",
            "http://sextant-ext.localhost/widgets/js/app.js#top",
        ] {
            let answer = get(&host, uri);
            assert_eq!(answer.status(), StatusCode::OK, "{uri}");
            assert_eq!(answer.body(), b"console.log(1)", "{uri}");
            assert_eq!(
                header_of(&answer, header::CONTENT_TYPE),
                "text/javascript; charset=utf-8"
            );
            assert_eq!(
                header_of(&answer, header::CONTENT_SECURITY_POLICY),
                extension_csp(&base_url("widgets"))
            );
            assert_eq!(
                header_of(&answer, header::X_CONTENT_TYPE_OPTIONS),
                "nosniff"
            );
            assert_eq!(header_of(&answer, header::CACHE_CONTROL), "no-store");
        }
        let entry = get(&host, "sextant-ext://widgets/");
        assert_eq!(entry.body(), b"<p>hello</p>", "an empty path is the entry");
        assert_eq!(
            header_of(&entry, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn paths_that_leave_the_folder_or_are_not_plain_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        std::fs::write(dir.path().join("src/.env"), "TOKEN=x").unwrap();
        for uri in [
            "sextant-ext://widgets/../secret.txt",
            "sextant-ext://widgets/%2e%2e/secret.txt",
            "sextant-ext://widgets/js/%2E%2E%2F..%2Fsecret.txt",
            "sextant-ext://localhost/widgets/%2e%2e%2fsecret.txt",
            "sextant-ext://widgets//etc/passwd",
            "sextant-ext://widgets/js%5C..%5C..%5Csecret.txt",
            "sextant-ext://widgets/.env",
            "sextant-ext://widgets/JS/APP.JS",
            "sextant-ext://widgets/%zz",
            "sextant-ext://widgets/missing.js",
            "sextant-ext://localhost/",
        ] {
            let answer = get(&host, uri);
            assert_eq!(answer.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(!answer.body().starts_with(b"secret") && !answer.body().starts_with(b"TOKEN"));
            assert_eq!(
                header_of(&answer, header::X_CONTENT_TYPE_OPTIONS),
                "nosniff"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_the_folder_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("secret.txt"),
            dir.path().join("src/link.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("src/up")).unwrap();
        for uri in [
            "sextant-ext://widgets/link.txt",
            "sextant-ext://widgets/up/secret.txt",
        ] {
            assert_eq!(get(&host, uri).status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[test]
    fn unknown_disabled_and_paused_extensions_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        assert_eq!(
            get(&host, "sextant-ext://other/index.html").status(),
            StatusCode::NOT_FOUND
        );
        host.set_enabled("widgets", false).unwrap();
        assert_eq!(
            get(&host, "sextant-ext://widgets/index.html").status(),
            StatusCode::NOT_FOUND
        );
        host.set_enabled("widgets", true).unwrap();
        assert_eq!(
            get(&host, "sextant-ext://widgets/index.html").status(),
            StatusCode::OK
        );
        // The folder's manifest now asks for more than was granted: paused until the user agrees.
        write_folder(&dir.path().join("src"), "widgets", "1.0.0", modify_all());
        host.reload("widgets").unwrap();
        assert_eq!(
            get(&host, "sextant-ext://widgets/index.html").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn installed_archives_are_served_from_their_version_folder() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let file = dir.path().join("w.sextant-ext");
        std::fs::write(&file, package_zip("widgets", "1.2.0", read_all())).unwrap();
        let pending = host.inspect_file(&file).unwrap();
        host.install(&pending.token).unwrap();
        let answer = get(&host, "sextant-ext://widgets/index.html");
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.body(), b"<p>hello</p>");
        let head = serve(
            &host,
            &Request::head("sextant-ext://widgets/index.html")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        let post = serve(
            &host,
            &Request::post("sextant-ext://widgets/index.html")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// The CSP of each URL form, written out: sources are the extension's own folder, never `'self'`.
    #[test]
    fn the_csp_names_the_extensions_own_folder_in_every_url_form() {
        let csp = |base: &str| {
            format!(
                "default-src 'none'; script-src {base} 'unsafe-inline'; style-src {base} 'unsafe-inline'; \
                 img-src {base} data:; font-src {base} data:; connect-src 'none'; form-action 'none'; \
                 sandbox allow-scripts allow-forms allow-popups-to-escape-sandbox"
            )
        };
        let forms = [
            (base_url_in("widgets", false), "sextant-ext://widgets/"),
            (
                base_url_in("localhost", false),
                "sextant-ext://localhost/localhost/",
            ),
            (
                base_url_in("widgets", true),
                "http://sextant-ext.localhost/widgets/",
            ),
            (
                base_url_in("localhost", true),
                "http://sextant-ext.localhost/localhost/",
            ),
        ];
        for (base, expected) in forms {
            assert_eq!(base, expected);
            let policy = extension_csp(&base);
            assert_eq!(policy, csp(expected));
            assert!(!policy.contains("'self'"), "{policy}");
        }
    }

    #[test]
    fn every_answer_carries_the_csp_of_its_extension_and_errors_a_closed_one() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        for uri in [
            "sextant-ext://widgets/index.html",
            "sextant-ext://localhost/widgets/index.html",
            "http://sextant-ext.localhost/widgets/index.html",
        ] {
            let answer = get(&host, uri);
            assert_eq!(answer.status(), StatusCode::OK, "{uri}");
            let policy = header_of(&answer, header::CONTENT_SECURITY_POLICY);
            assert_eq!(policy, extension_csp(&base_url("widgets")), "{uri}");
            assert!(!policy.contains("'self'"), "{policy}");
        }
        let missing = get(&host, "sextant-ext://widgets/missing.js");
        let post = serve(
            &host,
            &Request::post("sextant-ext://widgets/index.html")
                .body(Vec::new())
                .unwrap(),
        );
        for answer in [missing, post] {
            assert_ne!(answer.status(), StatusCode::OK);
            assert_eq!(
                header_of(&answer, header::CONTENT_SECURITY_POLICY),
                "default-src 'none'; sandbox"
            );
        }
    }

    /// Every answer, whatever it carries (a document, a script, a style, an image, an error), has the hardening
    /// headers: a CSP whose `sandbox` is the frame's (so a document opened outside the frame is still sandboxed and
    /// never same-origin), `nosniff`, `no-store` and `Referrer-Policy: no-referrer`. No `Cross-Origin-Resource-Policy`:
    /// the frame's origin is opaque, so `same-site`/`same-origin` would block its own `<img>`, `<link>` and classic
    /// `<script src>` (no-cors loads); the per-extension CSP sources already keep extensions apart.
    #[test]
    fn every_answer_carries_the_hardening_headers() {
        let dir = tempfile::tempdir().unwrap();
        let host = dev_host(dir.path());
        let src = dir.path().join("src");
        std::fs::write(src.join("style.css"), "p{color:red}").unwrap();
        std::fs::write(src.join("logo.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(
            src.join("logo.svg"),
            "<svg xmlns='http://www.w3.org/2000/svg'/>",
        )
        .unwrap();
        let sandbox = format!("sandbox {SANDBOX}");
        let served = [
            (
                "sextant-ext://widgets/index.html",
                "text/html; charset=utf-8",
            ),
            ("sextant-ext://widgets/", "text/html; charset=utf-8"),
            (
                "sextant-ext://widgets/js/app.js",
                "text/javascript; charset=utf-8",
            ),
            ("sextant-ext://widgets/style.css", "text/css; charset=utf-8"),
            ("sextant-ext://widgets/logo.png", "image/png"),
            (
                "http://sextant-ext.localhost/widgets/logo.svg",
                "image/svg+xml",
            ),
        ];
        for (uri, kind) in served {
            let answer = get(&host, uri);
            assert_eq!(answer.status(), StatusCode::OK, "{uri}");
            assert_eq!(header_of(&answer, header::CONTENT_TYPE), kind, "{uri}");
            let policy = header_of(&answer, header::CONTENT_SECURITY_POLICY);
            assert!(policy.ends_with(&sandbox), "{uri}: {policy}");
            assert!(!policy.contains("allow-same-origin"), "{policy}");
        }
        let errors = [
            get(&host, "sextant-ext://widgets/missing.js"),
            get(&host, "sextant-ext://other/index.html"),
            serve(
                &host,
                &Request::post("sextant-ext://widgets/index.html")
                    .body(Vec::new())
                    .unwrap(),
            ),
        ];
        for answer in errors {
            assert_ne!(answer.status(), StatusCode::OK);
            assert_eq!(
                header_of(&answer, header::CONTENT_SECURITY_POLICY),
                ERROR_CSP
            );
        }
        let answers = served.iter().map(|(uri, _)| get(&host, uri)).chain([
            get(&host, "sextant-ext://widgets/missing.js"),
            serve(
                &host,
                &Request::post("sextant-ext://widgets/index.html")
                    .body(Vec::new())
                    .unwrap(),
            ),
        ]);
        for answer in answers {
            let status = answer.status();
            assert_eq!(
                header_of(&answer, header::X_CONTENT_TYPE_OPTIONS),
                "nosniff",
                "{status}"
            );
            assert_eq!(
                header_of(&answer, header::CACHE_CONTROL),
                "no-store",
                "{status}"
            );
            assert_eq!(
                header_of(&answer, header::REFERRER_POLICY),
                "no-referrer",
                "{status}"
            );
            assert!(
                answer
                    .headers()
                    .get("cross-origin-resource-policy")
                    .is_none(),
                "{status}"
            );
        }
    }

    /// The `sandbox` of the CSP is exactly the frame's attribute (`FRAME_SANDBOX`), so a document opened outside the
    /// frame gets no more than inside it.
    #[test]
    fn the_csp_sandbox_is_the_frames_sandbox() {
        let frame = include_str!("../../../src/extensions/ExtensionFrame.tsx");
        let line = format!("export const FRAME_SANDBOX = \"{SANDBOX}\";");
        assert!(
            frame.contains(&line),
            "FRAME_SANDBOX in ExtensionFrame.tsx is not {SANDBOX:?}"
        );
        assert!(!SANDBOX.contains("allow-same-origin"));
        assert!(extension_csp("sextant-ext://widgets/").ends_with(&format!("; sandbox {SANDBOX}")));
    }

    #[test]
    fn urls_are_built_in_the_form_of_this_os() {
        if cfg!(windows) {
            assert_eq!(base_url("widgets"), "http://sextant-ext.localhost/widgets/");
        } else {
            assert_eq!(base_url("widgets"), "sextant-ext://widgets/");
            assert_eq!(base_url("localhost"), "sextant-ext://localhost/localhost/");
        }
        assert_eq!(encode_path("a b/c#d.js"), "a%20b/c%23d.js");
    }

    #[test]
    fn the_app_csp_lets_the_window_frame_extensions_and_nothing_else_changed() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert_eq!(
            csp,
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src sextant-ext: http://sextant-ext.localhost"
        );
    }

    #[test]
    fn a_refused_file_is_logged_once() {
        let root = Path::new("/nonexistent/sextant-log-once-test");
        assert!(log_refusal(root, "app.js", "a link"));
        assert!(
            !log_refusal(root, "app.js", "a link"),
            "the same file again"
        );
        assert!(log_refusal(root, "other.js", "a link"));
    }
}
