//! The registry client against a fake registry (plain HTTP on 127.0.0.1 behind the client's test rewrite: a request
//! for `https://<host>/<path>` goes to `http://127.0.0.1:<port>/<host>/<path>`; every policy check sees the original).

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use sextant_core::image_fs::fixtures::{self, Blob, Image, dir, file, symlink};
use sextant_core::image_fs::manifest::{ImagePlatform, OCI_INDEX, OCI_MANIFEST};
use sextant_core::image_fs::{EntryKind, ImageCredentials};
use sextant_core::{CoreResult, ErrorCode};

use super::*;
use crate::state::AppState;

const REGISTRY: &str = "registry.example";
const REPO: &str = "team/app";

#[derive(Clone, Default)]
struct Seen {
    /// (host, path, authorization)
    requests: Arc<Mutex<Vec<(String, String, String)>>>,
}

struct Fake {
    image: Image,
    arm: Image,
    index: Vec<u8>,
    seen: Seen,
    /// What the blob request redirects to (`{digest}` is replaced); `None` serves the blob from the registry.
    redirect: Option<String>,
    /// Where the token realm is.
    realm: Option<String>,
    /// Corrupts every blob served.
    tamper: bool,
    /// Where a manifest request redirects to.
    manifest_redirect: Option<String>,
}

fn blob_of(fake: &Fake, digest: &str) -> Option<Vec<u8>> {
    if digest == sextant_core::image_fs::manifest::sha256_digest(&fake.image.config) {
        return Some(fake.image.config.clone());
    }
    if digest == sextant_core::image_fs::manifest::sha256_digest(&fake.arm.config) {
        return Some(fake.arm.config.clone());
    }
    fake.image
        .layers
        .iter()
        .chain(&fake.arm.layers)
        .find(|l| l.digest() == digest)
        .map(|l| l.bytes.clone())
}

async fn handle(State(fake): State<Arc<Fake>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let (host, rest) = path
        .trim_start_matches('/')
        .split_once('/')
        .unwrap_or(("", ""));
    let rest = format!("/{rest}");
    fake.seen
        .requests
        .lock()
        .unwrap()
        .push((host.to_owned(), rest.clone(), auth.clone()));
    let prefix = format!("/v2/{REPO}/");
    match host {
        "auth.example" => {
            if !query.contains("scope=repository%3Ateam%2Fapp%3Apull")
                || !query.contains("service=registry.example")
            {
                return StatusCode::BAD_REQUEST.into_response();
            }
            return (StatusCode::OK, r#"{"token":"tok-1"}"#).into_response();
        }
        "storage.example" => {
            let digest = rest.trim_start_matches("/b/");
            return match blob_of(&fake, digest) {
                Some(mut bytes) => {
                    if fake.tamper {
                        bytes.push(0);
                    }
                    (StatusCode::OK, bytes).into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            };
        }
        REGISTRY => {}
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    if fake.realm.is_some() && auth != "Bearer tok-1" {
        let mut headers = HeaderMap::new();
        let realm = fake.realm.clone().unwrap_or_default();
        headers.insert(
            "www-authenticate",
            format!(r#"Bearer realm="{realm}",service="registry.example",scope="repository:team/app:pull,push""#).parse().unwrap(),
        );
        return (StatusCode::UNAUTHORIZED, headers).into_response();
    }
    let Some(tail) = rest.strip_prefix(&prefix) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Some(reference) = tail.strip_prefix("manifests/") {
        if let Some(to) = &fake.manifest_redirect {
            return (StatusCode::TEMPORARY_REDIRECT, [("location", to.clone())]).into_response();
        }
        let (bytes, kind) = if reference == "1.0" || reference == fake_index_digest(&fake) {
            (fake.index.clone(), OCI_INDEX)
        } else if reference == fake.image.digest() {
            (fake.image.manifest.clone(), OCI_MANIFEST)
        } else if reference == fake.arm.digest() {
            (fake.arm.manifest.clone(), OCI_MANIFEST)
        } else {
            return StatusCode::NOT_FOUND.into_response();
        };
        return (StatusCode::OK, [("content-type", kind)], bytes).into_response();
    }
    if let Some(digest) = tail.strip_prefix("blobs/") {
        if let Some(to) = &fake.redirect {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", to.replace("{digest}", digest))],
            )
                .into_response();
        }
        return match blob_of(&fake, digest) {
            Some(bytes) => Response::new(Body::from(bytes)),
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    StatusCode::NOT_FOUND.into_response()
}

fn fake_index_digest(fake: &Fake) -> String {
    sextant_core::image_fs::manifest::sha256_digest(&fake.index)
}

fn images() -> (Image, Image) {
    let base = Blob::gzip_layer(&[
        dir("etc/"),
        file("etc/os-release", b"NAME=fake\n"),
        file("etc/secret-old", b"gone"),
        file("bin/tool", b"\x7fELF\0\0"),
    ]);
    let upper = Blob::zstd_layer(&[
        file("etc/.wh.secret-old", b""),
        symlink("etc/alias", "os-release"),
    ]);
    let image = Image::new(vec![base, upper]);
    let arm = Image::new(vec![Blob::tar_layer(&[file("arm-only", b"arm")])]);
    (image, arm)
}

type Configure = Box<dyn FnOnce(&mut Fake)>;

struct Server {
    port: u16,
    seen: Seen,
    _task: tokio::task::JoinHandle<()>,
}

async fn serve(configure: impl FnOnce(&mut Fake)) -> Server {
    let (image, arm) = images();
    let index = fixtures::index(&[(&arm, "linux", "arm64"), (&image, "linux", "amd64")]);
    let seen = Seen::default();
    let mut fake = Fake {
        image,
        arm,
        index,
        seen: seen.clone(),
        redirect: Some("https://storage.example/b/{digest}?sig=1".into()),
        realm: Some("https://auth.example/token".into()),
        tamper: false,
        manifest_redirect: None,
    };
    configure(&mut fake);
    let router = axum::Router::new()
        .fallback(handle)
        .with_state(Arc::new(fake));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        port,
        seen,
        _task: task,
    }
}

impl Server {
    fn connect(&self) -> Connect {
        let port = self.port;
        Arc::new(move |url: &Url| {
            let mut text = format!(
                "http://127.0.0.1:{port}/{}{}",
                url.host_str().unwrap_or(""),
                url.path()
            );
            if let Some(q) = url.query() {
                text.push('?');
                text.push_str(q);
            }
            Url::parse(&text).unwrap()
        })
    }

    fn requests(&self) -> Vec<(String, String, String)> {
        self.seen.requests.lock().unwrap().clone()
    }
}

struct Opened {
    session: ImageSession,
    summary: ImageSummary,
    events: Vec<ImageOpenEvent>,
}

async fn open_with(
    server: &Server,
    reference: &str,
    platform: Option<ImagePlatform>,
    cache: &IndexCache,
) -> CoreResult<Opened> {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(&tmp.path().join("c"), &tmp.path().join("d"));
    let ctx = OpenContext {
        clusters: state.clusters.clone(),
        docker: None,
        cache: cache.clone(),
        connect: Some(server.connect()),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let emit: Emit<ImageOpenEvent> = Arc::new(move |e| sink.lock().unwrap().push(e));
    let source = ImageSource::Reference {
        reference: reference.into(),
    };
    let (session, summary) = open(&ctx, &source, platform, "s-1", emit).await?;
    let events = events.lock().unwrap().clone();
    Ok(Opened {
        session,
        summary,
        events,
    })
}

fn reference() -> String {
    format!("{REGISTRY}/{REPO}:1.0")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_opens_through_a_token_and_storage_redirects_and_the_cache_spares_a_second_download()
 {
    let server = serve(|_| {}).await;
    let cache_dir = tempfile::tempdir().unwrap();
    let cache = IndexCache::new(cache_dir.path());
    let opened = open_with(&server, &reference(), None, &cache)
        .await
        .unwrap();
    let summary = &opened.summary;
    assert_eq!(
        summary.platform.architecture, "amd64",
        "linux/amd64 by default"
    );
    assert_eq!(summary.platforms.len(), 2);
    assert_eq!(summary.layers.len(), 2);
    assert_eq!(summary.layers[0].created_by.as_deref(), Some("RUN step 0"));
    assert_eq!(summary.credentials, ImageCredentials::Anonymous);
    assert!(matches!(
        opened.events.last(),
        Some(ImageOpenEvent::Layer {
            state: LayerState::Indexed,
            index: 1,
            ..
        })
    ));
    let names: Vec<_> = opened
        .session
        .tree
        .list("/etc")
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(
        names,
        vec!["alias", "os-release"],
        "the whiteout removed the old file"
    );
    assert_eq!(
        opened.session.tree.entry("/etc/alias").unwrap().kind,
        EntryKind::Symlink
    );

    let requests = server.requests();
    let token = requests
        .iter()
        .filter(|(h, ..)| h == "auth.example")
        .count();
    assert_eq!(token, 1, "one token for the whole open");
    assert!(
        requests
            .iter()
            .filter(|(h, ..)| h == "storage.example")
            .all(|(_, _, auth)| auth.is_empty()),
        "no credential or token goes to the storage a blob redirects to"
    );
    assert!(
        requests
            .iter()
            .filter(|(h, p, _)| h == REGISTRY && p.contains("/blobs/"))
            .all(|(_, _, a)| a == "Bearer tok-1")
    );

    // The text view and a download read the file's layer again.
    let file = read_text(
        &opened.session,
        "/etc/os-release",
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(file.text.as_deref(), Some("NAME=fake\n"));
    let binary = read_text(
        &opened.session,
        "/bin/tool",
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    assert!(binary.binary);
    let out = tempfile::tempdir().unwrap();
    let dest = out.path().join("os-release");
    let bytes = save(
        &opened.session,
        "/etc/os-release",
        dest.clone(),
        Arc::new(AtomicBool::new(false)),
        Box::new(|_, _| {}),
    )
    .await
    .unwrap();
    assert_eq!(
        (bytes, std::fs::read(&dest).unwrap()),
        (10, b"NAME=fake\n".to_vec())
    );
    assert!(
        read_text(
            &opened.session,
            "/etc/alias",
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {})
        )
        .await
        .is_err(),
        "a link is never read"
    );

    // Opened again: both layers come from the cache.
    let before = server
        .requests()
        .iter()
        .filter(|(h, ..)| h == "storage.example")
        .count();
    let again = open_with(&server, &reference(), None, &cache)
        .await
        .unwrap();
    assert!(again.summary.layers.iter().all(|l| l.cached));
    let after = server
        .requests()
        .iter()
        .filter(|(h, ..)| h == "storage.example")
        .count();
    assert_eq!(after - before, 1, "only the config is fetched again");
}

#[tokio::test(flavor = "multi_thread")]
async fn platforms_and_digests_are_chosen_and_checked() {
    let server = serve(|f| {
        f.redirect = None;
        f.realm = None;
    })
    .await;
    let cache_dir = tempfile::tempdir().unwrap();
    let cache = IndexCache::new(cache_dir.path());
    let arm = ImagePlatform {
        os: "linux".into(),
        architecture: "arm64".into(),
        variant: None,
    };
    let opened = open_with(&server, &reference(), Some(arm.clone()), &cache)
        .await
        .unwrap();
    assert_eq!(opened.summary.platform, arm);
    assert!(opened.session.tree.entry("/arm-only").is_ok());
    let riscv = ImagePlatform {
        os: "linux".into(),
        architecture: "riscv64".into(),
        variant: None,
    };
    assert!(
        open_with(&server, &reference(), Some(riscv), &cache)
            .await
            .is_err()
    );
    // A reference pinned to a digest the registry's bytes do not match is refused.
    let wrong = format!("{REGISTRY}/{REPO}@sha256:{}", "e".repeat(64));
    assert!(open_with(&server, &wrong, None, &cache).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tampered_blob_is_refused_and_not_cached() {
    let server = serve(|f| f.tamper = true).await;
    let cache_dir = tempfile::tempdir().unwrap();
    let cache = IndexCache::new(cache_dir.path());
    let err = open_with(&server, &reference(), None, &cache)
        .await
        .err()
        .unwrap();
    assert!(
        err.message.contains("digest") || err.message.contains("config"),
        "{}",
        err.message
    );
    assert_eq!(std::fs::read_dir(cache_dir.path()).unwrap().count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn redirects_and_realms_to_forbidden_places_are_refused() {
    let cases: Vec<(&str, Configure)> = vec![
        (
            "metadata",
            Box::new(|f: &mut Fake| {
                f.redirect = Some("https://169.254.169.254/latest/{digest}".into())
            }),
        ),
        (
            "loopback",
            Box::new(|f: &mut Fake| f.redirect = Some("https://localhost/b/{digest}".into())),
        ),
        (
            "plain http",
            Box::new(|f: &mut Fake| f.redirect = Some("http://storage.example/b/{digest}".into())),
        ),
        (
            "userinfo",
            Box::new(|f: &mut Fake| {
                f.redirect = Some("https://u:p@storage.example/b/{digest}".into())
            }),
        ),
        (
            "http realm",
            Box::new(|f: &mut Fake| f.realm = Some("http://auth.example/token".into())),
        ),
        (
            "loopback realm",
            Box::new(|f: &mut Fake| f.realm = Some("https://127.0.0.1/token".into())),
        ),
        (
            "manifest elsewhere",
            Box::new(|f: &mut Fake| f.manifest_redirect = Some("https://storage.example/m".into())),
        ),
    ];
    for (name, configure) in cases {
        let server = serve(configure).await;
        let cache_dir = tempfile::tempdir().unwrap();
        let err = open_with(
            &server,
            &reference(),
            None,
            &IndexCache::new(cache_dir.path()),
        )
        .await
        .err();
        let err = err.unwrap_or_else(|| panic!("{name}: opened"));
        assert_eq!(err.code, ErrorCode::Invalid, "{name}: {}", err.message);
        assert!(
            !err.message.contains("169.254") && !err.message.contains("sig="),
            "{name}: {}",
            err.message
        );
        if name.contains("realm") {
            assert!(
                server.requests().iter().all(|(h, ..)| h != "auth.example"),
                "{name}: the realm was asked"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn credentials_go_to_the_realm_only_and_sessions_are_bounded() {
    let server = serve(|_| {}).await;
    let image = ImageRef::parse(&reference()).unwrap();
    let credential = sextant_core::image_fs::auth::Credential::Basic {
        username: "u".into(),
        password: "p".into(),
    };
    let registry = Registry::new(image, Some(credential), Some(server.connect())).unwrap();
    let (bytes, _) = registry.manifest("1.0").await.unwrap();
    assert!(!bytes.is_empty());
    let requests = server.requests();
    let basic = "Basic dTpw";
    assert!(
        requests
            .iter()
            .any(|(h, _, a)| h == "auth.example" && a == basic),
        "the realm gets the credentials"
    );
    assert!(
        requests
            .iter()
            .all(|(h, _, a)| h == "auth.example" || a != basic),
        "nobody else does"
    );

    let sessions = ImageSessions::default();
    for i in 0..limits::MAX_OPEN_IMAGES {
        let reg =
            Arc::new(Registry::new(ImageRef::parse("ghcr.io/a/b").unwrap(), None, None).unwrap());
        sessions
            .insert(
                format!("s{i}"),
                ImageSession {
                    cluster: Some(ClusterId("c".into())),
                    registry: reg,
                    tree: MergedTree::new(),
                    layers: vec![],
                },
            )
            .unwrap();
    }
    let reg = Arc::new(Registry::new(ImageRef::parse("ghcr.io/a/b").unwrap(), None, None).unwrap());
    assert!(
        sessions
            .insert(
                "extra".into(),
                ImageSession {
                    cluster: None,
                    registry: reg,
                    tree: MergedTree::new(),
                    layers: vec![]
                }
            )
            .is_err()
    );
    sessions.close_cluster(&ClusterId("c".into()));
    assert!(sessions.is_empty(), "closing the cluster closes its images");
}

#[tokio::test(flavor = "multi_thread")]
async fn names_that_resolve_only_to_forbidden_addresses_are_never_contacted() {
    use reqwest::dns::Resolve;
    use std::str::FromStr;
    let resolver = registry::FilteringResolver;
    let name = reqwest::dns::Name::from_str("localhost").unwrap();
    assert!(
        resolver.resolve(name).await.is_err(),
        "localhost resolves to loopback only"
    );
    // Even when a reference slips a name past the syntax check, the client cannot reach it.
    let registry = Registry::new(
        ImageRef::parse("ghcr.io/a/b").unwrap(),
        None,
        Some(Arc::new(|_: &Url| {
            Url::parse("https://localhost:1/v2/").unwrap()
        })),
    )
    .unwrap();
    let err = registry.manifest("latest").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable, "{}", err.message);
}
