use std::io::Write as _;

use super::*;

const LINUX: Platform = Platform {
    os: Os::Linux,
    arch: Arch::X86_64,
};
const MAC_ARM: Platform = Platform {
    os: Os::MacOs,
    arch: Arch::Arm64,
};
const WINDOWS: Platform = Platform {
    os: Os::Windows,
    arch: Arch::X86_64,
};

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

#[test]
fn versions_are_read_strictly_and_compared_by_skew() {
    assert_eq!(
        v("v1.37.2"),
        Version {
            major: 1,
            minor: 37,
            patch: 2
        }
    );
    for bad in [
        "1.37.2",
        "v1.37",
        "v1.37.2.1",
        "v01.37.2",
        "v1.37.2-rc.1",
        "v1.x.2",
        "",
    ] {
        assert_eq!(Version::parse(bad), None, "{bad}");
    }
    assert_eq!(
        Version::minor_of_server("v1.30.5-eks-abc123"),
        Some((1, 30))
    );
    assert_eq!(Version::minor_of_server("v1.29.3+k3s1"), Some((1, 29)));
    assert!(v("v1.37.2").in_skew((1, 36)));
    assert!(v("v1.37.2").in_skew((1, 38)));
    assert!(!v("v1.37.2").in_skew((1, 35)));
    assert!(!v("v2.0.0").in_skew((1, 99)));
    assert!(v("v1.10.0") > v("v1.9.9"));
}

#[test]
fn the_urls_and_names_are_the_projects_own() {
    let (files, sums) = downloads(Tool::Kubectl, v("v1.37.2"), LINUX);
    assert_eq!(
        files[0].url,
        "https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl"
    );
    assert_eq!(files[0].packing, Packing::Plain);
    assert_eq!(sums, Checksums::PerFile(".sha256"));
    let (files, _) = downloads(Tool::Kubectl, v("v1.37.2"), WINDOWS);
    assert_eq!(
        files[0].url,
        "https://dl.k8s.io/release/v1.37.2/bin/windows/amd64/kubectl.exe"
    );

    let (files, sums) = downloads(Tool::Helm, v("v4.3.1"), LINUX);
    assert_eq!(
        files[0].url,
        "https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz"
    );
    assert_eq!(
        files[0].binaries,
        [("linux-amd64/helm".to_owned(), "helm".to_owned())]
    );
    assert_eq!(sums, Checksums::PerFile(".sha256sum"));
    let (files, _) = downloads(Tool::Helm, v("v4.3.1"), WINDOWS);
    assert_eq!(
        files[0].url,
        "https://get.helm.sh/helm-v4.3.1-windows-amd64.zip"
    );
    assert_eq!(files[0].binaries[0].0, "windows-amd64/helm.exe");

    let (files, sums) = downloads(Tool::K9s, v("v0.51.0"), MAC_ARM);
    assert_eq!(
        files[0].url,
        "https://github.com/derailed/k9s/releases/download/v0.51.0/k9s_Darwin_arm64.tar.gz"
    );
    assert_eq!(
        sums,
        Checksums::Release(
            "https://github.com/derailed/k9s/releases/download/v0.51.0/checksums.sha256".into()
        )
    );

    let (files, sums) = downloads(Tool::Kubectx, v("v0.11.0"), LINUX);
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "kubectx_v0.11.0_linux_x86_64.tar.gz",
            "kubens_v0.11.0_linux_x86_64.tar.gz"
        ]
    );
    assert_eq!(
        sums,
        Checksums::Release(
            "https://github.com/ahmetb/kubectx/releases/download/v0.11.0/checksums.txt".into()
        )
    );
    assert_eq!(
        kubectl_stable_url(1, 37),
        "https://dl.k8s.io/release/stable-1.37.txt"
    );
}

#[test]
fn checksum_files_in_every_shape_are_read() {
    let digest = "0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b";
    assert_eq!(
        checksum_for(&format!("{digest}\n"), "kubectl").as_deref(),
        Some(digest)
    );
    let file = format!("{digest}  helm-v4.3.1-linux-amd64.tar.gz\n");
    assert_eq!(
        checksum_for(&file, "helm-v4.3.1-linux-amd64.tar.gz").as_deref(),
        Some(digest)
    );
    let release = format!(
        "{}  other.tar.gz\n{digest} *k9s_Linux_amd64.tar.gz\n",
        "a".repeat(64)
    );
    assert_eq!(
        checksum_for(&release, "k9s_Linux_amd64.tar.gz").as_deref(),
        Some(digest)
    );
    assert_eq!(checksum_for(&release, "missing.tar.gz"), None);
    assert_eq!(checksum_for("not a digest", "x"), None);
    assert!(matches_checksum(
        b"",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ));
    assert!(!matches_checksum(
        b"x",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ));
}

/// A ustar archive of `(path, data)` regular files, gzipped.
fn tar_gz(files: &[(&str, &[u8], u8)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (path, data, kind) in files {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path.as_bytes());
        header[100..107].copy_from_slice(b"0000755");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        header[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        header[136..147].copy_from_slice(b"00000000000");
        header[156] = *kind;
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

#[tokio::test]
async fn only_the_named_regular_file_is_taken_from_a_tar_archive() {
    let archive = tar_gz(&[
        ("README.md", b"readme", b'0'),
        ("./linux-amd64/helm", b"ELF helm", b'0'),
        ("k9s", b"", b'2'),
    ]);
    assert_eq!(
        extract_from_tar_gz(&archive, "linux-amd64/helm")
            .await
            .unwrap(),
        b"ELF helm"
    );
    let link = extract_from_tar_gz(&archive, "k9s").await.unwrap_err();
    assert!(
        link.message.contains("not a regular file"),
        "{}",
        link.message
    );
    assert!(extract_from_tar_gz(&archive, "missing").await.is_err());
    assert!(
        extract_from_tar_gz(&archive, "../etc/passwd")
            .await
            .is_err()
    );
    assert!(extract_from_tar_gz(b"not gzip", "helm").await.is_err());
}

#[test]
fn only_the_named_file_is_taken_from_a_zip_archive() {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer
        .start_file("windows-amd64/helm.exe", options)
        .unwrap();
    writer.write_all(b"MZ helm").unwrap();
    let archive = writer.finish().unwrap().into_inner();
    assert_eq!(
        extract_from_zip(&archive, "windows-amd64/helm.exe").unwrap(),
        b"MZ helm"
    );
    assert!(extract_from_zip(&archive, "helm.exe").is_err());
    assert!(extract_from_zip(&archive, "a/../b").is_err());
}

#[test]
fn a_terminal_gets_the_kubectl_of_its_cluster_and_the_newest_of_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let put = |tool: Tool, version: &str| {
        let folder = root.join(tool.dir_name()).join(version);
        std::fs::create_dir_all(&folder).unwrap();
        for binary in tool.binaries() {
            std::fs::write(folder.join(binary), b"bin").unwrap();
        }
    };
    put(Tool::Kubectl, "v1.37.2");
    put(Tool::Kubectl, "v1.30.9");
    put(Tool::Helm, "v4.3.1");
    put(Tool::Helm, "v3.19.0");
    put(Tool::Kubectx, "v0.11.0");
    // Not versions, or incomplete: not listed.
    std::fs::create_dir_all(root.join("kubectl").join("latest")).unwrap();
    std::fs::create_dir_all(root.join("k9s").join("v0.51.0")).unwrap();
    let list = installed(root, LINUX);
    let names: Vec<String> = list
        .iter()
        .map(|i| format!("{} {}", i.tool.dir_name(), i.version))
        .collect();
    assert_eq!(
        names,
        [
            "kubectl v1.37.2",
            "kubectl v1.30.9",
            "helm v4.3.1",
            "helm v3.19.0",
            "kubectx v0.11.0"
        ]
    );
    assert_eq!(list[4].bytes, 6);

    let for_old = path_dirs(root, &list, Some((1, 30)));
    assert_eq!(
        for_old,
        [
            root.join("kubectl/v1.30.9"),
            root.join("helm/v4.3.1"),
            root.join("kubectx/v0.11.0")
        ]
    );
    // A cluster within one minor of an installed kubectl gets it; a local terminal gets the newest.
    assert_eq!(
        path_dirs(root, &list, Some((1, 36)))[0],
        root.join("kubectl/v1.37.2")
    );
    assert_eq!(
        path_dirs(root, &list, None)[0],
        root.join("kubectl/v1.37.2")
    );
    assert_eq!(
        path_dirs(root, &list, Some((1, 20)))[0],
        root.join("kubectl/v1.37.2")
    );
}

#[test]
fn kubectls_own_version_is_read_from_its_json() {
    let json = r#"{"clientVersion":{"major":"1","minor":"37","gitVersion":"v1.37.2","platform":"linux/amd64"},"kustomizeVersion":"v5.7.1"}"#;
    assert_eq!(kubectl_client_version(json), Some(v("v1.37.2")));
    assert_eq!(kubectl_client_version("{}"), None);
}
