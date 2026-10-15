use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::*;

/// What the fake GitHub answers for a path (`/<host>/<path>?<query>`).
type Answer = Arc<dyn Fn(&str) -> Response + Send + Sync>;

/// A local HTTP server standing in for GitHub; returns its address and the `Accept` headers it saw, by path.
async fn fake_github(
    answer: impl Fn(&str) -> Response + Send + Sync + 'static,
) -> (std::net::SocketAddr, Arc<Mutex<Vec<(String, String)>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let answer: Answer = Arc::new(answer);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let app = axum::Router::new().fallback(move |uri: Uri, headers: HeaderMap| {
        let answer = Arc::clone(&answer);
        let log = Arc::clone(&log);
        async move {
            let path = uri
                .path_and_query()
                .map(|p| p.as_str().to_owned())
                .unwrap_or_default();
            let accept = headers
                .get(header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            log.lock().unwrap().push((path.clone(), accept));
            if path.contains("/slow/") {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            answer(&path)
        }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, seen)
}

/// Every request goes to the fake server, keeping the original host as the first part of the path.
fn via(addr: std::net::SocketAddr, max_manifest: u64, timeout: Duration) -> GitopsDownloader {
    GitopsDownloader::redirected(
        Arc::new(move |url: &Url| {
            let mut target = Url::parse(&format!("http://{addr}/")).unwrap();
            target.set_path(&format!("{}{}", url.host_str().unwrap_or(""), url.path()));
            target.set_query(url.query());
            target
        }),
        timeout,
        max_manifest,
        MAX_RELEASES_BYTES,
    )
}

fn ok(body: impl Into<String>) -> Response {
    (StatusCode::OK, body.into()).into_response()
}

fn redirect(to: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, to.to_owned())]).into_response()
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

const MANIFEST: &str = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: flux-system\n";
/// `sha256sum` of [`MANIFEST`], computed outside the code under test.
const MANIFEST_SHA256: &str = "90a121a66298cc2ed41cb51791ead22e98705f346c12717590216b58872a3025";

#[test]
fn the_sha256_is_the_one_sha256sum_prints() {
    assert_eq!(sha256_hex(MANIFEST.as_bytes()), MANIFEST_SHA256);
}

#[test]
fn only_the_official_sources_are_allowed() {
    for good in [
        "https://api.github.com/repos/fluxcd/flux2/releases?per_page=30",
        "https://api.github.com/repos/argoproj/argo-cd/releases?per_page=30",
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/flux_2.9.6_checksums.txt",
        "https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml",
    ] {
        assert!(is_allowed_source(&Url::parse(good).unwrap()), "{good}");
    }
    for bad in [
        // Another owner or repository.
        "https://api.github.com/repos/evil/flux2/releases?per_page=30",
        "https://github.com/fluxcd/flux3/releases/download/v2.9.6/install.yaml",
        "https://github.com/argoproj/argo-cd/releases/download/v3.5.5/install.yaml",
        "https://raw.githubusercontent.com/argoproj/argo-rollouts/v3.5.5/manifests/install.yaml",
        // A tag that is not vX.Y.Z.
        "https://github.com/fluxcd/flux2/releases/download/main/install.yaml",
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6-rc.1/install.yaml",
        "https://raw.githubusercontent.com/argoproj/argo-cd/master/manifests/install.yaml",
        // Another file, the wrong checksums file.
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/manifests.tar.gz",
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/flux_2.9.5_checksums.txt",
        "https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/ha/install.yaml",
        // Not HTTPS, another port, a user, a query.
        "http://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
        "https://github.com:8443/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
        "https://u@github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml?x=1",
        "https://api.github.com/repos/fluxcd/flux2/releases?per_page=100",
        // Another host.
        "https://github.com.evil.example/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
    ] {
        assert!(!is_allowed_source(&Url::parse(bad).unwrap()), "{bad}");
    }
}

#[tokio::test]
async fn versions_are_the_stable_tags_newest_first_asked_with_the_github_media_type() {
    let releases = serde_json::json!([
        {"tag_name": "v3.5.5", "prerelease": false, "draft": false},
        {"tag_name": "v3.4.11", "prerelease": false, "draft": false},
        {"tag_name": "v3.6.0-rc2", "prerelease": true, "draft": false},
        {"tag_name": "v3.6.0", "prerelease": false, "draft": true},
        {"tag_name": "v3.10.0", "prerelease": false, "draft": false},
        {"tag_name": "helm-chart-1.0.0", "prerelease": false, "draft": false},
        {"tag_name": "v3.5.10", "prerelease": false, "draft": false},
    ])
    .to_string();
    let (addr, seen) = fake_github(move |path| match path {
        "/api.github.com/repos/argoproj/argo-cd/releases?per_page=30" => ok(releases.clone()),
        _ => not_found(),
    })
    .await;
    let found = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .versions(GitopsTool::ArgoCd)
        .await;
    assert_eq!(
        found,
        GitopsVersions {
            versions: vec![
                "v3.10.0".into(),
                "v3.5.10".into(),
                "v3.5.5".into(),
                "v3.4.11".into()
            ],
            latest: "v3.10.0".into(),
            error: None,
        }
    );
    assert_eq!(seen.lock().unwrap()[0].1, "application/vnd.github+json");
}

#[tokio::test]
async fn without_github_the_bundled_version_is_offered_with_the_reason() {
    let (addr, _) = fake_github(|path| match path {
        // GitHub's answer when the rate limit is spent.
        "/api.github.com/repos/fluxcd/flux2/releases?per_page=30" => (
            StatusCode::FORBIDDEN,
            r#"{"message":"API rate limit exceeded"}"#,
        )
            .into_response(),
        _ => ok("[]"),
    })
    .await;
    let downloader = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT);
    let flux = downloader.versions(GitopsTool::Flux).await;
    assert_eq!(flux.versions, ["v2.9.6"]);
    assert_eq!(flux.latest, "v2.9.6");
    assert!(flux.error.as_deref().unwrap().contains("403"), "{flux:?}");

    // An empty list is no better.
    let argo = downloader.versions(GitopsTool::ArgoCd).await;
    assert_eq!(argo.versions, ["v3.5.5"]);
    assert!(argo.error.is_some());

    // No server at all.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let gone = closed.local_addr().unwrap();
    drop(closed);
    let offline = via(gone, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .versions(GitopsTool::ArgoCd)
        .await;
    assert_eq!(offline.versions, ["v3.5.5"]);
    assert!(offline.error.is_some());
}

/// Flux's release as GitHub serves it: the asset links redirect to the asset host.
fn flux_release(path: &str, manifest: &'static str, sums: String) -> Response {
    match path {
        "/github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml" => {
            redirect("https://release-assets.githubusercontent.com/a/install?sig=1")
        }
        "/github.com/fluxcd/flux2/releases/download/v2.9.6/flux_2.9.6_checksums.txt" => {
            redirect("https://release-assets.githubusercontent.com/a/sums?sig=1")
        }
        "/release-assets.githubusercontent.com/a/install?sig=1" => ok(manifest),
        "/release-assets.githubusercontent.com/a/sums?sig=1" => ok(sums),
        _ => not_found(),
    }
}

#[tokio::test]
async fn a_flux_manifest_is_checked_against_the_checksums_of_its_release() {
    let sums = format!("aaaa  flux_2.9.6_linux_amd64.tar.gz\n{MANIFEST_SHA256}  install.yaml\n");
    let (addr, _) = fake_github(move |path| flux_release(path, MANIFEST, sums.clone())).await;
    let manifest = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::Flux, "v2.9.6")
        .await
        .unwrap();
    assert_eq!(
        manifest,
        Manifest {
            text: MANIFEST.into(),
            url: "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml".into(),
            sha256: MANIFEST_SHA256.into(),
            checksum_verified: true,
        }
    );
}

#[tokio::test]
async fn a_flux_manifest_whose_checksum_differs_or_is_missing_is_refused() {
    let wrong = format!("{}  install.yaml\n", "0".repeat(64));
    let (addr, _) = fake_github(move |path| flux_release(path, MANIFEST, wrong.clone())).await;
    let err = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::Flux, "v2.9.6")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(
        err.message.contains("flux_2.9.6_checksums.txt"),
        "{}",
        err.message
    );

    let none = "aaaa  flux_2.9.6_linux_amd64.tar.gz\n".to_owned();
    let (addr, _) = fake_github(move |path| flux_release(path, MANIFEST, none.clone())).await;
    let err = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::Flux, "v2.9.6")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
}

#[tokio::test]
async fn an_argocd_manifest_comes_from_its_tag_and_is_shown_with_its_sha256_unverified() {
    let (addr, _) = fake_github(|path| match path {
        "/raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml" => ok(MANIFEST),
        _ => not_found(),
    })
    .await;
    let manifest = via(addr, MAX_MANIFEST_BYTES, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::ArgoCd, "v3.5.5")
        .await
        .unwrap();
    assert_eq!(manifest.sha256, MANIFEST_SHA256);
    assert!(!manifest.checksum_verified);
    assert_eq!(
        manifest.url,
        "https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml"
    );
}

#[tokio::test]
async fn wrong_tags_foreign_redirects_large_and_slow_downloads_are_refused() {
    let (addr, seen) = fake_github(|path| match path {
        // Redirected away from GitHub.
        "/github.com/fluxcd/flux2/releases/download/v1.0.0/install.yaml" => {
            redirect("https://evil.example/install.yaml")
        }
        // Redirected back to a repository that is not allowed.
        "/github.com/fluxcd/flux2/releases/download/v1.0.1/install.yaml" => {
            redirect("https://github.com/evil/flux2/releases/download/v1.0.1/install.yaml")
        }
        "/raw.githubusercontent.com/argoproj/argo-cd/v1.0.0/manifests/install.yaml" => {
            ok("x".repeat(4096))
        }
        _ => not_found(),
    })
    .await;
    let downloader = via(addr, 1024, Duration::from_millis(500));

    for tag in ["main", "v1.0", "v1.0.0-rc1", "../v1.0.0", "1.0.0"] {
        let err = downloader
            .manifest(GitopsTool::Flux, tag)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{tag}");
    }
    assert!(seen.lock().unwrap().is_empty(), "a bad tag sends nothing");

    let err = downloader
        .manifest(GitopsTool::Flux, "v1.0.0")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("evil.example"), "{}", err.message);
    let err = downloader
        .manifest(GitopsTool::Flux, "v1.0.1")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);

    let err = downloader
        .manifest(GitopsTool::ArgoCd, "v1.0.0")
        .await
        .unwrap_err();
    assert!(err.message.contains("larger than"), "{}", err.message);

    let slow = GitopsDownloader::redirected(
        Arc::new(move |url: &Url| {
            Url::parse(&format!("http://{addr}/slow{}", url.path())).unwrap()
        }),
        Duration::from_millis(300),
        MAX_MANIFEST_BYTES,
        MAX_RELEASES_BYTES,
    );
    let err = slow
        .manifest(GitopsTool::ArgoCd, "v3.5.5")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
}

#[tokio::test]
async fn a_chunked_download_without_a_length_is_refused_once_it_grows_past_the_limit() {
    let (addr, _) = fake_github(|path| match path {
        "/raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml" => {
            // No Content-Length: the body is streamed in chunks, so only counting while reading can stop it.
            let chunks =
                (0..4).map(|_| Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b'x'; 512])));
            let response =
                Response::new(axum::body::Body::from_stream(futures::stream::iter(chunks)));
            assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
            response
        }
        _ => not_found(),
    })
    .await;
    let err = via(addr, 1024, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::ArgoCd, "v3.5.5")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("larger than"), "{}", err.message);
    // The same body within the limit is accepted, so the refusal above is the size.
    let fits = via(addr, 4096, DOWNLOAD_TIMEOUT)
        .manifest(GitopsTool::ArgoCd, "v3.5.5")
        .await
        .unwrap();
    assert_eq!(fits.text.len(), 2048);
}
