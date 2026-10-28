//! Terminal tools against a fake of their sources, served under the real hosts' paths.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

type Files = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn fake_sources(files: Files) -> Connect {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let files = Arc::clone(&files);
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
                let body = files.lock().unwrap().get(&path).cloned();
                let response = match body {
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
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                };
                let _ = socket.write_all(&response).await;
            });
        }
    });
    Arc::new(move |url: &Url| {
        let mut target = Url::parse(&format!("http://{addr}/")).unwrap();
        target.set_path(&format!("{}{}", url.host_str().unwrap_or(""), url.path()));
        target
    })
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A gzipped ustar archive of regular files.
fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (path, data) in files {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path.as_bytes());
        header[100..107].copy_from_slice(b"0000755");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        header[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        header[136..147].copy_from_slice(b"00000000000");
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].copy_from_slice(b"        ");
        let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
        header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        tar.extend_from_slice(&header);
        tar.extend_from_slice(data);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.resize(tar.len() + 1024, 0);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap()
}

fn platform() -> Platform {
    Platform::current().expect("the tests run on a platform with tools")
}

/// The paths of the real sources for this platform, served by the fake.
fn sources() -> Files {
    let p = platform();
    let mut files = HashMap::new();
    let put = |files: &mut HashMap<String, Vec<u8>>, url: &str, body: Vec<u8>| {
        let url = Url::parse(url).unwrap();
        files.insert(format!("/{}{}", url.host_str().unwrap(), url.path()), body);
    };
    put(
        &mut files,
        &tools::kubectl_stable_url(1, 37),
        b"v1.37.2\n".to_vec(),
    );
    let (kubectl, _) = tools::downloads(Tool::Kubectl, Version::parse("v1.37.2").unwrap(), p);
    let binary = b"#!/bin/sh\necho kubectl\n".to_vec();
    put(
        &mut files,
        &format!("{}.sha256", kubectl[0].url),
        sha(&binary).into_bytes(),
    );
    put(&mut files, &kubectl[0].url, binary);

    put(&mut files, HELM_LATEST_URL, b"v4.3.1".to_vec());
    let (helm, _) = tools::downloads(Tool::Helm, Version::parse("v4.3.1").unwrap(), p);
    let member = helm[0].binaries[0].0.clone();
    let archive = tar_gz(&[
        ("README.md", b"readme"),
        (member.as_str(), b"#!/bin/sh\necho helm\n"),
    ]);
    put(
        &mut files,
        &format!("{}.sha256sum", helm[0].url),
        format!("{}  {}\n", sha(&archive), helm[0].name).into_bytes(),
    );
    put(&mut files, &helm[0].url, archive);

    put(
        &mut files,
        &tools::latest_release_url("derailed/k9s"),
        br#"{"tag_name":"v0.51.0","assets":[]}"#.to_vec(),
    );
    let (k9s, sums) = tools::downloads(Tool::K9s, Version::parse("v0.51.0").unwrap(), p);
    let archive = tar_gz(&[("k9s", b"#!/bin/sh\necho k9s\n"), ("LICENSE", b"license")]);
    if let Checksums::Release(url) = sums {
        put(
            &mut files,
            &url,
            format!(
                "{}  other\n{}  {}\n",
                "0".repeat(64),
                sha(&archive),
                k9s[0].name
            )
            .into_bytes(),
        );
    }
    put(&mut files, &k9s[0].url, archive);
    Arc::new(Mutex::new(files))
}

#[tokio::test]
async fn kubectl_is_installed_for_the_servers_minor_version_after_its_checksum() {
    let files = sources();
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::with_connect(dir.path(), Some(fake_sources(Arc::clone(&files)).await));
    let version = tools.latest(Tool::Kubectl, Some((1, 37))).await.unwrap();
    assert_eq!(version.to_string(), "v1.37.2");
    let installed = tools.install(Tool::Kubectl, version).await.unwrap();
    assert_eq!(installed.version, "v1.37.2");
    let binary = tools::version_dir(tools.root(), Tool::Kubectl, version).join(if cfg!(windows) {
        "kubectl.exe"
    } else {
        "kubectl"
    });
    assert_eq!(
        std::fs::read(&binary).unwrap(),
        b"#!/bin/sh\necho kubectl\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    // A terminal of a cluster on 1.37 gets it in front of its PATH.
    tools.remember_server(&ClusterId::from("c"), (1, 37));
    let path = tools
        .terminal_path(
            Some(&ClusterId::from("c")),
            Some(OsString::from("/usr/bin")),
        )
        .unwrap();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    assert_eq!(
        dirs[0],
        tools::version_dir(tools.root(), Tool::Kubectl, version)
    );
    assert_eq!(dirs.last().unwrap(), &PathBuf::from("/usr/bin"));
    tools.remove(Tool::Kubectl, version).unwrap();
    assert!(tools.view().installed.is_empty());
}

#[tokio::test]
async fn a_download_that_is_not_the_published_one_is_never_installed() {
    let files = sources();
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::with_connect(dir.path(), Some(fake_sources(Arc::clone(&files)).await));
    let version = Version::parse("v1.37.2").unwrap();
    let (kubectl, _) = tools::downloads(Tool::Kubectl, version, platform());
    let path = format!("/dl.k8s.io{}", Url::parse(&kubectl[0].url).unwrap().path());
    files
        .lock()
        .unwrap()
        .insert(path, b"something else".to_vec());
    let err = tools.install(Tool::Kubectl, version).await.unwrap_err();
    assert!(
        err.message
            .contains("does not match its published checksum"),
        "{}",
        err.message
    );
    assert!(tools.view().installed.is_empty());
    // No folder is left behind, temporary or not.
    let left: Vec<_> = std::fs::read_dir(tools.root().join("kubectl"))
        .map(|d| d.flatten().collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn helm_and_k9s_come_out_of_their_archives() {
    let files = sources();
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::with_connect(dir.path(), Some(fake_sources(Arc::clone(&files)).await));
    let helm = tools.latest(Tool::Helm, None).await.unwrap();
    tools.install(Tool::Helm, helm).await.unwrap();
    let k9s = tools.latest(Tool::K9s, None).await.unwrap();
    assert_eq!(k9s.to_string(), "v0.51.0");
    tools.install(Tool::K9s, k9s).await.unwrap();
    let names: Vec<String> = tools
        .view()
        .installed
        .iter()
        .map(|i| format!("{} {}", i.tool.dir_name(), i.version))
        .collect();
    assert_eq!(names, ["helm v4.3.1", "k9s v0.51.0"]);
    let exe = if cfg!(windows) { ".exe" } else { "" };
    assert_eq!(
        std::fs::read(
            tools::version_dir(tools.root(), Tool::Helm, helm).join(format!("helm{exe}"))
        )
        .unwrap(),
        b"#!/bin/sh\necho helm\n"
    );
}

#[test]
fn only_the_tools_own_sources_are_fetched() {
    let url = |u: &str| Url::parse(u).unwrap();
    for allowed in [
        "https://dl.k8s.io/release/stable-1.37.txt",
        "https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl",
        "https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz",
        "https://api.github.com/repos/derailed/k9s/releases/latest",
        "https://github.com/ahmetb/kubectx/releases/download/v0.11.0/checksums.txt",
    ] {
        assert!(is_tool_source(&url(allowed)), "{allowed}");
    }
    for refused in [
        "http://dl.k8s.io/release/stable-1.37.txt",
        "https://dl.k8s.io/other/file",
        "https://get.helm.sh.evil.org/helm",
        "https://api.github.com/repos/someone/else/releases/latest",
        "https://github.com/someone/else/releases/download/v1/x",
        "https://github.com/derailed/k9s/releases/download/../../../evil",
        "https://dl.k8s.io/release/v1/kubectl?x=1",
        "https://user@get.helm.sh/helm",
    ] {
        assert!(!is_tool_source(&url(refused)), "{refused}");
    }
    assert!(allowed_redirect(&url(
        "https://cdn.dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl"
    )));
    assert!(!allowed_redirect(&url("https://example.com/kubectl")));
}

#[test]
fn neither_agents_nor_extensions_get_the_tools() {
    let tools = crate::mcp::server::all_tools().names();
    assert!(
        !tools
            .iter()
            .any(|t| t.starts_with("tools_") || t.contains("kubectl")),
        "{tools:?}"
    );
    let methods = crate::extensions::api::METHODS;
    assert!(
        !methods.iter().any(|m| m.starts_with("tools")),
        "{methods:?}"
    );
}
