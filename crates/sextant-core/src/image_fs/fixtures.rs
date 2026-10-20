//! Small images built in memory for tests (the core's and the app's fake registry): tar layers with any entry kind,
//! gzip and zstd compression, OCI manifests, configs and indexes. Not used by the app itself.

use std::io::Write;

use serde_json::json;

use super::manifest::{OCI_INDEX, OCI_MANIFEST, sha256_digest};

/// One tar entry: `kind` is the type flag (`b'0'` file, `b'5'` folder, `b'2'` symlink, `b'1'` hard link).
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub kind: u8,
    pub data: Vec<u8>,
    pub link: String,
    pub mode: u32,
    pub uid: u64,
    pub user: String,
}

pub fn file(path: &str, data: &[u8]) -> Entry {
    Entry {
        path: path.into(),
        kind: b'0',
        data: data.to_vec(),
        link: String::new(),
        mode: 0o644,
        uid: 0,
        user: "root".into(),
    }
}

pub fn dir(path: &str) -> Entry {
    Entry {
        kind: b'5',
        mode: 0o755,
        ..file(path, b"")
    }
}

pub fn symlink(path: &str, target: &str) -> Entry {
    Entry {
        kind: b'2',
        link: target.into(),
        mode: 0o777,
        ..file(path, b"")
    }
}

pub fn hardlink(path: &str, target: &str) -> Entry {
    Entry {
        kind: b'1',
        link: target.into(),
        ..file(path, b"")
    }
}

fn octal(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    field[..digits].copy_from_slice(&text.as_bytes()[text.len() - digits..]);
}

fn header(name: &[u8], size: u64, kind: u8, entry: &Entry) -> [u8; 512] {
    let mut h = [0u8; 512];
    h[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
    octal(&mut h[100..108], u64::from(entry.mode));
    octal(&mut h[108..116], entry.uid);
    octal(&mut h[116..124], entry.uid);
    octal(&mut h[124..136], size);
    octal(&mut h[136..148], 1_700_000_000);
    h[156] = kind;
    let link = entry.link.as_bytes();
    h[157..157 + link.len().min(100)].copy_from_slice(&link[..link.len().min(100)]);
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let user = entry.user.as_bytes();
    h[265..265 + user.len().min(32)].copy_from_slice(&user[..user.len().min(32)]);
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    let text = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(text.as_bytes());
    h
}

fn padded(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(data);
    out.resize(out.len().div_ceil(512) * 512, 0);
}

/// A tar stream of `entries` (GNU long names for paths over 100 bytes) with its end marker.
pub fn tar(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in entries {
        out.extend_from_slice(&entry_bytes(entry));
    }
    out.extend_from_slice(&[0u8; 1024]);
    out
}

/// A tar stream where each entry may be preceded by a pax extended header of its `records` (`key`, `value`).
pub fn tar_with_pax(entries: &[(Entry, Vec<(String, String)>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (entry, records) in entries {
        if !records.is_empty() {
            let mut data = Vec::new();
            for (key, value) in records {
                data.extend_from_slice(&pax_record(key, value));
            }
            out.extend_from_slice(&header(b"././@PaxHeader", data.len() as u64, b'x', entry));
            padded(&mut out, &data);
        }
        out.extend_from_slice(&entry_bytes(entry));
    }
    out.extend_from_slice(&[0u8; 1024]);
    out
}

/// One pax record, `"<length> <key>=<value>\n"`, the length counting itself.
fn pax_record(key: &str, value: &str) -> Vec<u8> {
    let body = format!(" {key}={value}\n");
    let mut len = body.len() + 1;
    while format!("{len}").len() + body.len() != len {
        len = format!("{len}").len() + body.len();
    }
    format!("{len}{body}").into_bytes()
}

/// One entry's headers and data (no end marker).
fn entry_bytes(entry: &Entry) -> Vec<u8> {
    let mut out = Vec::new();
    let name = entry.path.as_bytes();
    if name.len() > 100 {
        let mut long = name.to_vec();
        long.push(0);
        out.extend_from_slice(&header(b"././@LongLink", long.len() as u64, b'L', entry));
        padded(&mut out, &long);
    }
    let size = if entry.kind == b'0' {
        entry.data.len() as u64
    } else {
        0
    };
    out.extend_from_slice(&header(name, size, entry.kind, entry));
    if size > 0 {
        padded(&mut out, &entry.data);
    }
    out
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

pub fn zstd(data: &[u8]) -> Vec<u8> {
    ruzstd::encoding::compress_to_vec(data, ruzstd::encoding::CompressionLevel::Fastest)
}

/// A layer blob and its media type.
#[derive(Debug, Clone)]
pub struct Blob {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

impl Blob {
    pub fn digest(&self) -> String {
        sha256_digest(&self.bytes)
    }
    pub fn gzip_layer(entries: &[Entry]) -> Self {
        Self {
            media_type: "application/vnd.oci.image.layer.v1.tar+gzip".into(),
            bytes: gzip(&tar(entries)),
        }
    }
    pub fn zstd_layer(entries: &[Entry]) -> Self {
        Self {
            media_type: "application/vnd.oci.image.layer.v1.tar+zstd".into(),
            bytes: zstd(&tar(entries)),
        }
    }
    pub fn tar_layer(entries: &[Entry]) -> Self {
        Self {
            media_type: "application/vnd.oci.image.layer.v1.tar".into(),
            bytes: tar(entries),
        }
    }
}

/// An image: its config, its layers, and its manifest's bytes.
#[derive(Debug, Clone)]
pub struct Image {
    pub config: Vec<u8>,
    pub layers: Vec<Blob>,
    pub manifest: Vec<u8>,
}

impl Image {
    pub fn new(layers: Vec<Blob>) -> Self {
        let history: Vec<_> = (0..layers.len())
            .map(|i| json!({ "created_by": format!("RUN step {i}") }))
            .collect();
        let config = serde_json::to_vec(&json!({
            "architecture": "amd64", "os": "linux",
            "rootfs": { "type": "layers", "diff_ids": [] },
            "history": history,
        }))
        .unwrap();
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": OCI_MANIFEST,
            "config": { "mediaType": "application/vnd.oci.image.config.v1+json", "digest": sha256_digest(&config), "size": config.len() },
            "layers": layers.iter().map(|l| json!({ "mediaType": l.media_type, "digest": l.digest(), "size": l.bytes.len() })).collect::<Vec<_>>(),
        }))
        .unwrap();
        Self {
            config,
            layers,
            manifest,
        }
    }

    pub fn digest(&self) -> String {
        sha256_digest(&self.manifest)
    }
}

/// An index of `images` with their platforms (`os`, `architecture`) plus an attestation entry.
pub fn index(images: &[(&Image, &str, &str)]) -> Vec<u8> {
    let mut manifests: Vec<_> = images
        .iter()
        .map(|(image, os, arch)| {
            json!({ "mediaType": OCI_MANIFEST, "digest": image.digest(), "size": image.manifest.len(),
                    "platform": { "os": os, "architecture": arch } })
        })
        .collect();
    manifests.push(json!({ "mediaType": OCI_MANIFEST, "digest": format!("sha256:{}", "0".repeat(64)), "size": 10,
                           "platform": { "os": "unknown", "architecture": "unknown" } }));
    serde_json::to_vec(
        &json!({ "schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": manifests }),
    )
    .unwrap()
}
