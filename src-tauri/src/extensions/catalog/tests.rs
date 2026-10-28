//! The catalog against a local fake GitHub: the SDK's fixture index and signed package
//! (`sdk/test/fixtures/catalog/`), served under the paths of the real hosts.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use reqwest::Url;
use sextant_core::ErrorCode;
use sextant_core::extensions::ExtensionSource;
use sextant_core::extensions::catalog::{CatalogStatus, catalog_source};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::extensions::ExtensionState;
use crate::extensions::manage::{DOWNLOAD_TIMEOUT, Downloader, MAX_DOWNLOAD_BYTES};
use crate::extensions::test_support::host_with;

const INDEX: &[u8] = include_bytes!("../../../../sdk/test/fixtures/catalog/index.json");
const PACKAGE: &[u8] =
    include_bytes!("../../../../sdk/test/fixtures/catalog/demo.catalog-1.0.0.sextant-ext");
const SIGNATURE: &[u8] =
    include_bytes!("../../../../sdk/test/fixtures/catalog/demo.catalog-1.0.0.sextant-ext.minisig");

const INDEX_PATH: &str =
    "/raw.githubusercontent.com/FriendsOfKubernetes/sextant-extensions/main/index.json";
const PACKAGE_PATH: &str =
    "/github.com/FriendsOfKubernetes/demo/releases/download/v1.0.0/demo.catalog-1.0.0.sextant-ext";

/// What the fake GitHub serves; every request is counted by path.
#[derive(Clone)]
struct Served {
    index: Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    package: Arc<std::sync::Mutex<Vec<u8>>>,
    index_requests: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
}

impl Served {
    fn new() -> Self {
        Self {
            index: Arc::new(std::sync::Mutex::new(Some(INDEX.to_vec()))),
            package: Arc::new(std::sync::Mutex::new(PACKAGE.to_vec())),
            index_requests: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn answer(&self, path: &str) -> Vec<u8> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let body = match path {
            INDEX_PATH => {
                self.index_requests.fetch_add(1, Ordering::SeqCst);
                self.index.lock().unwrap().clone()
            }
            PACKAGE_PATH => Some(self.package.lock().unwrap().clone()),
            p if p == format!("{PACKAGE_PATH}.minisig") => Some(SIGNATURE.to_vec()),
            _ => None,
        };
        match body {
            Some(body) => {
                let mut r = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes();
                r.extend_from_slice(&body);
                r
            }
            None => {
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            }
        }
    }
}

async fn fake_github(served: Served) -> Downloader {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let served = served.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let _ = socket.write_all(&served.answer(&path)).await;
            });
        }
    });
    Downloader::redirected(
        Arc::new(move |url: &Url| {
            let mut target = Url::parse(&format!("http://{addr}/")).unwrap();
            target.set_path(&format!("{}{}", url.host_str().unwrap_or(""), url.path()));
            target
        }),
        MAX_DOWNLOAD_BYTES,
        DOWNLOAD_TIMEOUT,
    )
}

#[tokio::test]
async fn the_index_is_fetched_when_missing_or_old_and_kept_across_runs() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);

    let view = host.catalog_view(false).await;
    assert!(view.enabled);
    assert!(view.error.is_none(), "{:?}", view.error);
    let index = view.index.unwrap();
    assert_eq!(index.entries.len(), 2);
    assert!(view.fetched_at.is_some());
    // Fresh: the next look reads the copy.
    host.catalog_view(false).await;
    assert_eq!(served.index_requests.load(Ordering::SeqCst), 1);
    // "Refresh" asks again; a failure keeps the copy and says why.
    *served.index.lock().unwrap() = None;
    let failed = host.catalog_view(true).await;
    assert_eq!(served.index_requests.load(Ordering::SeqCst), 2);
    assert_eq!(failed.error.unwrap().code, ErrorCode::NotFound);
    assert_eq!(failed.index.unwrap().entries.len(), 2);

    // Another run reads the file, and does not ask while it is fresh.
    let again = host_with(dir.path(), fake_github(served.clone()).await);
    let view = again.catalog_view(false).await;
    assert_eq!(view.index.unwrap().entries.len(), 2);
    assert_eq!(served.index_requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_catalog_turned_off_is_never_asked() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);
    host.inner
        .settings
        .update(|s| s.extension_catalog.enabled = false)
        .unwrap();
    let view = host.catalog_view(true).await;
    assert!(!view.enabled);
    assert!(view.index.is_none());
    let err = host.inspect_catalog("demo.catalog").await.unwrap_err();
    assert_eq!(
        err.message,
        "The extension catalog is turned off in Settings → Extensions"
    );
    assert_eq!(served.requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_install_from_the_catalog_is_checked_signed_and_pinned() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);
    let entry = host.catalog_view(false).await.index.unwrap().entries[0].clone();

    let pending = host.inspect_catalog("demo.catalog").await.unwrap();
    assert_eq!(pending.source, catalog_source(&entry));
    assert_eq!(pending.listed_in_catalog, None);
    assert!(pending.new_permissions);
    let info = host.install(&pending.token).unwrap();
    assert_eq!(info.state, ExtensionState::Active);
    assert!(matches!(info.source, ExtensionSource::Catalog { .. }));

    let view = host.catalog_view(false).await;
    assert_eq!(view.installed.len(), 1);
    assert_eq!(view.installed[0].status, CatalogStatus::UpToDate);
}

#[tokio::test]
async fn a_package_that_is_not_the_listed_one_is_refused_before_it_is_kept() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);
    host.catalog_view(false).await;
    let mut changed = PACKAGE.to_vec();
    let at = changed.len() - 30;
    changed[at] ^= 1;
    *served.package.lock().unwrap() = changed;
    let err = host.inspect_catalog("demo.catalog").await.unwrap_err();
    assert_eq!(
        err.message,
        "The downloaded package of demo.catalog 1.0.0 is not the one the catalog lists"
    );
    let pending = dir.path().join("data").join("extensions-pending");
    assert!(!pending.exists() || std::fs::read_dir(pending).unwrap().next().is_none());
}

#[tokio::test]
async fn a_catalog_id_from_elsewhere_is_named_and_never_replaced_by_the_catalog() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);
    host.catalog_view(false).await;
    // The same package from a file: the consent screen names the catalog's extension of that id.
    let file = dir.path().join("demo.catalog-1.0.0.sextant-ext");
    std::fs::write(&file, PACKAGE).unwrap();
    let pending = host.inspect_file(&file).unwrap();
    let namesake = pending.listed_in_catalog.clone().unwrap();
    assert_eq!(
        (namesake.name.as_str(), namesake.author.as_str()),
        ("Catalog demo", "Sextant tests")
    );
    host.install(&pending.token).unwrap();
    // The catalog does not replace it, and the reverse.
    let err = host.inspect_catalog("demo.catalog").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(
        err.message
            .contains("already installed from the file demo.catalog-1.0.0.sextant-ext"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn withdrawn_and_unknown_entries_are_not_installed() {
    let served = Served::new();
    let dir = tempfile::tempdir().unwrap();
    let host = host_with(dir.path(), fake_github(served.clone()).await);
    host.catalog_view(false).await;
    let err = host.inspect_catalog("demo.withdrawn").await.unwrap_err();
    assert_eq!(
        err.message,
        "Withdrawn demo was withdrawn from the catalog: A known-bad release"
    );
    let err = host.inspect_catalog("nobody.here").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    // Neither download was attempted.
    assert_eq!(served.requests.load(Ordering::SeqCst), 1);
    let _ = Duration::ZERO;
}

#[test]
fn neither_agents_nor_extensions_get_the_catalog() {
    let tools = crate::mcp::server::all_tools().names();
    assert!(tools.len() > 10, "{tools:?}");
    assert!(!tools.iter().any(|t| t.contains("catalog")), "{tools:?}");
    let methods = crate::extensions::api::METHODS;
    assert!(
        !methods
            .iter()
            .any(|m| m.contains("catalog") || m.contains("install")),
        "{methods:?}"
    );
}
