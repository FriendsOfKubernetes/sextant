use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use super::auth::{
    Challenge, Credential, DockerConfig, key_matches, parse_challenge, parse_helper_output,
    parse_token,
};
use super::cache::IndexCache;
use super::fixtures::{self, Blob, Image, dir, file, hardlink, symlink};
use super::layer::{Budget, LayerIndex, StreamOptions, extract_file, index_layer, normalize};
use super::manifest::{
    Compression, ImagePlatform, Parsed, choose_platform, compression_of, layer_history,
    parse_manifest,
};
use super::reference::{ImageRef, check_host, digest_of_image_id, forbidden_ip};
use super::tree::MergedTree;
use super::*;

fn options(blob: &Blob) -> StreamOptions {
    StreamOptions {
        compression: compression_of(&blob.media_type).unwrap(),
        digest: blob.digest(),
        max_compressed: blob.bytes.len() as u64,
        cancel: Arc::new(AtomicBool::new(false)),
    }
}

fn index(blob: &Blob) -> CoreResult<LayerIndex> {
    index_layer(
        &blob.bytes[..],
        &options(blob),
        &mut Budget::default(),
        &mut |_| {},
    )
}

use crate::CoreResult;

#[test]
fn references_are_read_as_docker_reads_them() {
    let r = ImageRef::parse("nginx").unwrap();
    assert_eq!(
        (r.registry.as_str(), r.repository.as_str()),
        ("docker.io", "library/nginx")
    );
    assert_eq!(r.api_host(), "registry-1.docker.io");
    assert_eq!(r.manifest_reference(), "latest");
    let r = ImageRef::parse(&format!("ghcr.io/org/app:1.2@sha256:{}", "a".repeat(64))).unwrap();
    assert_eq!(r.registry, "ghcr.io");
    assert_eq!(r.tag.as_deref(), Some("1.2"));
    assert!(r.manifest_reference().starts_with("sha256:"));
    let r = ImageRef::parse("registry.internal:5000/team/app:v1").unwrap();
    assert_eq!(
        (r.registry.as_str(), r.repository.as_str(), r.tag.as_deref()),
        ("registry.internal:5000", "team/app", Some("v1"))
    );
    let r = ImageRef::parse("index.docker.io/user/app").unwrap();
    assert_eq!(
        (r.registry.as_str(), r.repository.as_str()),
        ("docker.io", "user/app")
    );
    for bad in [
        "",
        "https://ghcr.io/a",
        "Upper/Case",
        "a@sha512:00",
        "a:-bad",
        "localhost:5000/x",
        "127.0.0.1/x",
        "169.254.169.254/x",
        "[::1]:5000/x",
    ] {
        assert!(ImageRef::parse(bad).is_err(), "{bad}");
    }
    assert!(
        ImageRef::parse("10.0.0.5:5000/x").is_ok(),
        "private ranges are allowed"
    );
}

#[test]
fn loopback_link_local_and_mapped_addresses_are_forbidden() {
    for ip in [
        "127.0.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.1.1",
    ] {
        assert!(forbidden_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "10.1.2.3",
        "192.168.1.1",
        "172.16.0.1",
        "100.64.0.1",
        "8.8.8.8",
        "fd00::1",
        "2001:db8::1",
    ] {
        assert!(!forbidden_ip(ip.parse().unwrap()), "{ip}");
    }
    assert!(check_host("sub.localhost").is_err());
    assert!(check_host("registry:0").is_err());
    assert!(check_host("[2001:db8::1]:443").is_ok());
    assert_eq!(
        digest_of_image_id(&format!(
            "docker-pullable://nginx@sha256:{}",
            "b".repeat(64)
        )),
        Some(format!("sha256:{}", "b".repeat(64)))
    );
    assert_eq!(digest_of_image_id("sha256:abc"), None);
}

#[test]
fn challenges_tokens_and_helper_output_parse() {
    assert_eq!(
        parse_challenge(
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull,push""#
        ),
        Some(Challenge::Bearer {
            realm: "https://auth.docker.io/token".into(),
            service: Some("registry.docker.io".into())
        })
    );
    assert_eq!(
        parse_challenge(r#"Basic realm="x""#),
        Some(Challenge::Basic)
    );
    assert_eq!(parse_challenge("Negotiate"), None);
    assert_eq!(parse_token(br#"{"access_token":"abc"}"#).unwrap(), "abc");
    assert!(parse_token(br#"{"token":"a\nb"}"#).is_err());
    assert!(parse_token(b"{}").is_err());
    assert_eq!(
        parse_helper_output(br#"{"Username":"<token>","Secret":"t"}"#),
        Some(Credential::IdentityToken("t".into()))
    );
    assert!(parse_helper_output(br#"{"Username":"u","Secret":""}"#).is_none());
}

#[test]
fn docker_configs_match_registries_and_never_print_credentials() {
    let config = DockerConfig::parse(
        br#"{"auths":{
        "https://index.docker.io/v1/":{"auth":"dXNlcjpwYXNz"},
        "*.example.com":{"username":"w","password":"p"},
        "ghcr.io":{"identitytoken":"idt"}},
        "credHelpers":{"123.dkr.ecr.us-east-1.amazonaws.com":"ecr-login","bad":"../x"},
        "credsStore":"desktop"}"#,
    )
    .unwrap();
    assert_eq!(
        config.auth_for("docker.io"),
        Some(Credential::Basic {
            username: "user".into(),
            password: "pass".into()
        })
    );
    assert!(config.auth_for("a.example.com").is_some());
    assert!(
        config.auth_for("a.b.example.com").is_none(),
        "a wildcard is one label"
    );
    assert_eq!(
        config.auth_for("ghcr.io"),
        Some(Credential::IdentityToken("idt".into()))
    );
    assert_eq!(
        config.helper_for("123.dkr.ecr.us-east-1.amazonaws.com"),
        Some("ecr-login")
    );
    assert_eq!(
        config.helper_for("bad"),
        None,
        "a helper name that is not a plain word is dropped"
    );
    assert_eq!(config.store(), Some("desktop"));
    assert!(!format!("{config:?}{:?}", config.auth_for("docker.io")).contains("pass"));
    // The older .dockercfg form is the map itself.
    let old = DockerConfig::parse(br#"{"quay.io":{"auth":"YTpi"}}"#).unwrap();
    assert!(old.auth_for("quay.io").is_some());
    assert!(key_matches(
        "https://registry.internal:5000/v2/",
        "registry.internal:5000"
    ));
}

#[test]
fn manifests_indexes_and_platforms() {
    let image = Image::new(vec![Blob::gzip_layer(&[file("a", b"1")])]);
    let Parsed::Image(manifest) = parse_manifest(&image.manifest, None).unwrap() else {
        panic!("an image")
    };
    assert_eq!(manifest.layers.len(), 1);
    assert_eq!(
        layer_history(&image.config, 1),
        vec![Some("RUN step 0".into())]
    );
    let arm = Image::new(vec![Blob::tar_layer(&[file("b", b"2")])]);
    let Parsed::Index(entries) = parse_manifest(
        &fixtures::index(&[(&arm, "linux", "arm64"), (&image, "linux", "amd64")]),
        None,
    )
    .unwrap() else {
        panic!("an index")
    };
    assert_eq!(entries.len(), 2, "the attestation entry is skipped");
    assert_eq!(
        choose_platform(&entries, None).unwrap().manifest.digest,
        image.digest()
    );
    let wanted = ImagePlatform {
        os: "linux".into(),
        architecture: "arm64".into(),
        variant: None,
    };
    assert_eq!(
        choose_platform(&entries, Some(&wanted))
            .unwrap()
            .manifest
            .digest,
        arm.digest()
    );
    assert!(parse_manifest(br#"{"schemaVersion":1}"#, None).is_err());
    assert!(compression_of("application/vnd.docker.image.rootfs.foreign.diff.tar.gzip").is_err());
    assert_eq!(
        compression_of("application/vnd.oci.image.layer.v1.tar+zstd").unwrap(),
        Compression::Zstd
    );
    let many = serde_json::json!({ "schemaVersion": 2, "mediaType": manifest::OCI_MANIFEST,
        "config": { "digest": image.digest(), "size": 1 },
        "layers": vec![serde_json::json!({ "mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": image.digest(), "size": 1 }); 129] });
    assert!(parse_manifest(&serde_json::to_vec(&many).unwrap(), None).is_err());
}

fn sample_entries() -> Vec<fixtures::Entry> {
    vec![
        dir("./"),
        dir("etc/"),
        file("etc/os-release", b"NAME=test\n"),
        symlink("etc/alias", "os-release"),
        hardlink("etc/hard", "etc/os-release"),
        file(&format!("deep/{}", "x".repeat(150)), b"long"),
        file("../escape", b"no"),
        file("usr/bin/tool", b"\0\x01binary"),
    ]
}

#[test]
fn layers_index_the_same_from_tar_gzip_and_zstd() {
    let entries = sample_entries();
    let plain = index(&Blob::tar_layer(&entries)).unwrap();
    assert_eq!(plain, index(&Blob::gzip_layer(&entries)).unwrap());
    assert_eq!(plain, index(&Blob::zstd_layer(&entries)).unwrap());
    let paths: Vec<_> = plain.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"etc/os-release"));
    assert!(
        paths.iter().any(|p| p.len() > 150),
        "a GNU long name is read"
    );
    assert_eq!(
        plain.skipped, 1,
        "the `..` entry is skipped, the root entry is not counted"
    );
    let hard = plain.entries.iter().find(|e| e.path == "etc/hard").unwrap();
    assert_eq!(
        (hard.kind, hard.link.as_deref()),
        (EntryKind::Hardlink, Some("etc/os-release"))
    );
    let release = plain
        .entries
        .iter()
        .find(|e| e.path == "etc/os-release")
        .unwrap();
    assert_eq!(
        (release.mode, release.user.as_deref(), release.size),
        (0o644, Some("root"), 10)
    );
    assert_eq!(normalize("./a//b/./c"), Some("a/b/c".into()));
    assert_eq!(normalize("a/../b"), None);
}

#[test]
fn a_layer_that_does_not_match_its_digest_or_size_is_refused() {
    let blob = Blob::gzip_layer(&sample_entries());
    let mut wrong = options(&blob);
    wrong.digest = format!("sha256:{}", "0".repeat(64));
    let err =
        index_layer(&blob.bytes[..], &wrong, &mut Budget::default(), &mut |_| {}).unwrap_err();
    assert!(err.message.contains("digest"), "{}", err.message);
    let mut small = options(&blob);
    small.max_compressed = 10;
    assert!(index_layer(&blob.bytes[..], &small, &mut Budget::default(), &mut |_| {}).is_err());
    let cancelled = options(&blob);
    cancelled
        .cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(
        index_layer(
            &blob.bytes[..],
            &cancelled,
            &mut Budget::default(),
            &mut |_| {}
        )
        .is_err()
    );
}

#[test]
fn compression_bombs_are_stopped_by_the_ratio_limit() {
    // 80 MiB of zeros compress to ~80 KiB: past 64 MiB + 200 × the compressed bytes.
    let zeros = vec![0u8; 80 * 1024 * 1024];
    let bomb = Blob::gzip_layer(&[file("zeros", &zeros)]);
    assert!(bomb.bytes.len() < 200 * 1024);
    let err = index(&bomb).unwrap_err();
    assert!(err.message.contains("compression bomb"), "{}", err.message);
}

#[test]
fn the_entry_budget_and_hostile_tar_streams_are_refused() {
    let entries: Vec<_> = (0..10).map(|i| file(&format!("f{i}"), b"")).collect();
    let blob = Blob::tar_layer(&entries);
    let mut budget = Budget {
        entries: 5,
        bytes: 1_000,
    };
    assert!(
        index_layer(&blob.bytes[..], &options(&blob), &mut budget, &mut |_| {})
            .unwrap_err()
            .message
            .contains("more than")
    );
    let mut garbage = Blob {
        media_type: "application/vnd.oci.image.layer.v1.tar".into(),
        bytes: vec![7u8; 2048],
    };
    garbage.bytes[0] = 1;
    assert!(index(&garbage).is_err());
}

#[test]
fn whiteouts_and_opaque_folders_merge_per_the_oci_spec() {
    let base = index(&Blob::tar_layer(&[
        file("etc/a", b"a"),
        file("etc/b", b"b"),
        file("var/x/1", b"1"),
        file("var/x/2", b"2"),
        dir("opt/"),
        file("opt/keep", b"k"),
    ]))
    .unwrap();
    let upper = index(&Blob::tar_layer(&[
        file("etc/.wh.a", b""),
        file("var/x/.wh..wh..opq", b""),
        file("var/x/3", b"3"),
        file("opt", b"now a file"),
    ]))
    .unwrap();
    let mut tree = MergedTree::new();
    tree.apply(0, &base).unwrap();
    tree.apply(1, &upper).unwrap();
    let names = |p: &str| {
        tree.list(p)
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names("/etc"), vec!["b"]);
    assert_eq!(names("/var/x"), vec!["3"]);
    assert_eq!(
        names("/"),
        vec!["etc", "var", "opt"],
        "folders first, then by name"
    );
    assert_eq!(tree.entry("/opt").unwrap().kind, EntryKind::File);
    assert!(
        tree.entry("/opt/keep").is_err(),
        "a file over a folder hides its subtree"
    );
    assert_eq!(tree.entry("/var/x/3").unwrap().layer, 1);
    assert!(tree.entry("/etc").unwrap().has_children);
}

#[test]
fn listing_finds_siblings_that_sort_around_a_subtree() {
    let layer = index(&Blob::tar_layer(&[
        file("a/b/c", b""),
        file("a/b-x", b""),
        file("a/b0", b""),
        file("a/b", b""),
    ]))
    .unwrap();
    let mut tree = MergedTree::new();
    tree.apply(0, &index(&Blob::tar_layer(&[file("a/b/c", b"")])).unwrap())
        .unwrap();
    tree.apply(1, &layer).unwrap();
    let names: Vec<_> = tree
        .list("/a")
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec!["b", "b-x", "b0"]);
    assert!(tree.list("/a/b").is_err(), "a file is not a folder");
}

#[test]
fn symlinks_resolve_only_inside_the_image() {
    let layer = index(&Blob::tar_layer(&[
        file("etc/os-release", b"x"),
        symlink("etc/alias", "os-release"),
        symlink("bin", "usr/bin"),
        file("usr/bin/sh", b"sh"),
        symlink("escape", "../../../../etc/os-release"),
        symlink("loop1", "loop2"),
        symlink("loop2", "loop1"),
        symlink("abs", "/etc/alias"),
        symlink("gone", "/nowhere"),
    ]))
    .unwrap();
    let mut tree = MergedTree::new();
    tree.apply(0, &layer).unwrap();
    assert_eq!(
        tree.resolve("/etc/alias").unwrap().as_deref(),
        Some("/etc/os-release")
    );
    assert_eq!(
        tree.resolve("/bin/sh").unwrap().as_deref(),
        Some("/usr/bin/sh")
    );
    assert_eq!(
        tree.resolve("/escape").unwrap().as_deref(),
        Some("/etc/os-release"),
        "`..` stops at the root"
    );
    assert_eq!(
        tree.resolve("/abs").unwrap().as_deref(),
        Some("/etc/os-release")
    );
    assert_eq!(tree.resolve("/loop1").unwrap(), None);
    assert_eq!(tree.resolve("/gone").unwrap(), None);
    assert!(
        tree.data_source("/etc/alias").is_err(),
        "a link is never read"
    );
}

#[test]
fn search_finds_paths_case_insensitively_within_its_cap() {
    let entries: Vec<_> = (0..600)
        .map(|i| file(&format!("data/File{i}.txt"), b""))
        .collect();
    let mut tree = MergedTree::new();
    tree.apply(0, &index(&Blob::tar_layer(&entries)).unwrap())
        .unwrap();
    let found = tree.search("file1").unwrap();
    assert!(
        found
            .matches
            .iter()
            .all(|m| m.path.to_lowercase().contains("file1"))
    );
    assert!(!found.truncated);
    assert!(tree.search(".TXT").unwrap().truncated);
    assert!(tree.search(&"x".repeat(300)).is_err());
}

#[test]
fn a_file_is_extracted_from_its_layer_and_hard_links_read_their_target() {
    let blob = Blob::zstd_layer(&sample_entries());
    let mut tree = MergedTree::new();
    tree.apply(0, &index(&blob).unwrap()).unwrap();
    let source = tree.data_source("/etc/hard").unwrap();
    assert_eq!(
        (source.layer, source.path.as_str(), source.size),
        (0, "etc/os-release", 10)
    );
    let mut out = Vec::new();
    let got = extract_file(
        &blob.bytes[..],
        &options(&blob),
        &source.path,
        4,
        false,
        &mut out,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        (got.size, got.written, out.as_slice()),
        (10, 4, &b"NAME"[..])
    );
    let mut out = Vec::new();
    extract_file(
        &blob.bytes[..],
        &options(&blob),
        "etc/os-release",
        100,
        true,
        &mut out,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(out, b"NAME=test\n");
    let mut wrong = options(&blob);
    wrong.digest = format!("sha256:{}", "1".repeat(64));
    assert!(
        extract_file(
            &blob.bytes[..],
            &wrong,
            "etc/os-release",
            100,
            true,
            &mut Vec::new(),
            &mut |_| {}
        )
        .is_err(),
        "a download verifies the layer"
    );
    assert_eq!(
        extract_file(
            &blob.bytes[..],
            &options(&blob),
            "nope",
            100,
            false,
            &mut Vec::new(),
            &mut |_| {}
        )
        .unwrap_err()
        .code,
        crate::ErrorCode::NotFound
    );
}

#[test]
fn the_index_cache_keeps_verified_indexes_within_its_size() {
    let dir = tempfile::tempdir().unwrap();
    let cache = IndexCache::new(dir.path().join("cache"));
    let blob = Blob::tar_layer(&sample_entries());
    let layer = index(&blob).unwrap();
    assert!(cache.get(&blob.digest()).is_none());
    cache.put(&blob.digest(), &layer);
    assert_eq!(cache.get(&blob.digest()), Some(layer.clone()));
    // A damaged file is deleted.
    let file = dir
        .path()
        .join("cache")
        .join(format!("{}.json", &blob.digest()[7..]));
    std::fs::write(&file, b"{").unwrap();
    assert!(cache.get(&blob.digest()).is_none());
    assert!(!file.exists());
    // Past the size, the least recently used go first.
    let small = IndexCache::new(dir.path().join("cache")).with_max_total(1);
    small.put(&blob.digest(), &layer);
    assert!(small.get(&blob.digest()).is_none());
    assert!(cache.get("sha256:../../x").is_none());
}

#[tokio::test]
async fn a_pods_image_and_pull_secrets_come_from_the_pod_and_its_service_account() {
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use base64::Engine;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    let pod = serde_json::json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "web", "namespace": "ns" },
        "spec": { "serviceAccountName": "builder", "imagePullSecrets": [{ "name": "own" }, { "name": "missing" }],
                  "containers": [{ "name": "app", "image": "registry.example.com/team/app:1" }] },
        "status": { "containerStatuses": [{ "name": "app", "image": "x", "imageID": format!("registry.example.com/team/app@sha256:{}", "c".repeat(64)),
                    "ready": true, "restartCount": 0 }] } })
    .to_string();
    let sa = serde_json::json!({ "apiVersion": "v1", "kind": "ServiceAccount", "metadata": { "name": "builder" },
        "imagePullSecrets": [{ "name": "from-sa" }, { "name": "own" }] })
    .to_string();
    let secret = |name: &str, kind: &str, key: &str, value: &str| {
        serde_json::json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": name }, "type": kind,
                            "data": { key: b64(value) } })
        .to_string()
    };
    let own = secret(
        "own",
        "kubernetes.io/dockerconfigjson",
        ".dockerconfigjson",
        r#"{"auths":{"other.io":{"auth":"YTpi"}}}"#,
    );
    let from_sa = secret(
        "from-sa",
        "kubernetes.io/dockercfg",
        ".dockercfg",
        r#"{"https://registry.example.com":{"username":"u","password":"p"}}"#,
    );
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(
            200,
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
        ),
        "/api/v1/namespaces/ns/pods/web" => Reply::json(200, pod.clone()),
        "/api/v1/namespaces/ns/serviceaccounts/builder" => Reply::json(200, sa.clone()),
        "/api/v1/namespaces/ns/secrets/own" => Reply::json(200, own.clone()),
        "/api/v1/namespaces/ns/secrets/from-sa" => Reply::json(200, from_sa.clone()),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let image = pull_secrets::pod_image(&mgr, &id, "ns", "web", "app")
        .await
        .unwrap();
    assert_eq!(image.image, "registry.example.com/team/app:1");
    assert_eq!(image.digest, Some(format!("sha256:{}", "c".repeat(64))));
    let names: Vec<_> = image.pull_secrets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["own", "from-sa"],
        "the pod's first, then the ServiceAccount's, each once"
    );
    assert_eq!(image.unreadable, vec!["missing".to_owned()]);
    let (name, credential) =
        pull_secrets::credential_for(&image.pull_secrets, "registry.example.com").unwrap();
    assert_eq!(name, "from-sa");
    assert_eq!(
        credential,
        Credential::Basic {
            username: "u".into(),
            password: "p".into()
        }
    );
    assert!(
        !format!("{image:?}").contains("\"p\""),
        "pull secrets print no values"
    );
    assert!(
        pull_secrets::pod_image(&mgr, &id, "ns", "web", "nope")
            .await
            .is_err()
    );
    assert!(
        pull_secrets::pod_image(&mgr, &id, "NS/..", "web", "app")
            .await
            .is_err()
    );
}

#[cfg(all(unix, feature = "desktop"))]
#[tokio::test]
async fn docker_credentials_come_from_auths_or_a_helper_run_without_a_shell() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    // The helper echoes the server it was asked about as the user name.
    let script = bin.join("docker-credential-fake");
    std::fs::write(&script, "#!/bin/sh\nread server\nprintf '{\"Username\":\"%s\",\"Secret\":\"s3cret\"}' \"$server\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let slow = bin.join("docker-credential-slow");
    let sleep = ["/bin/sleep", "/usr/bin/sleep"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap();
    std::fs::write(&slow, format!("#!/bin/sh\nexec {sleep} 30\n")).unwrap();
    std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = dir.path().join("config.json");
    std::fs::write(&config, r#"{"auths":{"plain.io":{"auth":"dTpw"}},"credHelpers":{"helped.io":"fake","slow.io":"slow","absent.io":"absent"},"credsStore":"fake"}"#).unwrap();
    let cli = crate::cloud::CloudCli::default().with_env([
        ("PATH", bin.to_string_lossy().into_owned()),
        ("HOME", dir.path().to_string_lossy().into_owned()),
    ]);
    let get = |registry: &'static str| {
        let cli = cli.clone();
        let config = config.clone();
        async move { helper::docker_credential(&config, &cli, registry).await }
    };
    assert_eq!(
        get("plain.io").await.unwrap(),
        Some(Credential::Basic {
            username: "u".into(),
            password: "p".into()
        })
    );
    assert_eq!(
        get("helped.io").await.unwrap(),
        Some(Credential::Basic {
            username: "helped.io".into(),
            password: "s3cret".into()
        })
    );
    assert_eq!(
        get("docker.io").await.unwrap(),
        Some(Credential::Basic {
            username: "https://index.docker.io/v1/".into(),
            password: "s3cret".into()
        }),
        "the store answers the rest, Docker Hub by its legacy server name"
    );
    let missing = get("absent.io").await.unwrap_err();
    assert_eq!(missing.code, crate::ErrorCode::NotFound);
    assert!(!missing.message.contains("s3cret"));
    let started = std::time::Instant::now();
    let slow = helper::docker_credential(&config, &cli, "slow.io");
    assert_eq!(slow.await.unwrap_err().code, crate::ErrorCode::Timeout);
    assert!(
        started.elapsed() < limits::HELPER_TIMEOUT + std::time::Duration::from_secs(5),
        "a hanging helper is stopped"
    );
    assert_eq!(
        helper::docker_credential(&dir.path().join("none.json"), &cli, "x.io")
            .await
            .unwrap(),
        None
    );
}

#[test]
fn a_saved_file_appears_only_after_its_layer_was_verified() {
    let dir = tempfile::tempdir().unwrap();
    let blob = Blob::gzip_layer(&sample_entries());
    let dest = dir.path().join("os-release");
    let bytes = save::save_file(
        &blob.bytes[..],
        &options(&blob),
        "etc/os-release",
        &dest,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(
        (bytes, std::fs::read(&dest).unwrap()),
        (10, b"NAME=test\n".to_vec())
    );
    let mut wrong = options(&blob);
    wrong.digest = format!("sha256:{}", "2".repeat(64));
    let other = dir.path().join("other");
    assert!(
        save::save_file(
            &blob.bytes[..],
            &wrong,
            "etc/os-release",
            &other,
            &mut |_| {}
        )
        .is_err()
    );
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(
        left,
        vec![std::ffi::OsString::from("os-release")],
        "no partial file is left"
    );
    assert!(
        save::save_file(
            &blob.bytes[..],
            &options(&blob),
            "etc/os-release",
            std::path::Path::new("rel"),
            &mut |_| {}
        )
        .is_err()
    );
}

#[test]
fn text_and_binary_files_are_told_apart() {
    assert_eq!(file_text("/a", 5, b"hello").text.as_deref(), Some("hello"));
    assert!(file_text("/b", 3, b"a\0b").binary);
    assert!(file_text("/c", 2, &[0xff, 0xfe]).binary);
    // "é" cut in half by the size limit is dropped, the rest is text.
    let cut = file_text("/d", 100, &[b'a', 0xc3]);
    assert_eq!((cut.text.as_deref(), cut.truncated), (Some("a"), true));
}
