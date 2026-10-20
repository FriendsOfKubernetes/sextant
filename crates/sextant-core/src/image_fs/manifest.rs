//! Image indexes, manifests and configs (OCI image spec, Docker manifest v2 schema 2), the platform choice, layer
//! media types and digests.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::reference::check_digest;
use super::{limits, refused};
use crate::CoreResult;

pub const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
pub const DOCKER_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
pub const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
pub const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";

/// The `Accept` header of a manifest request: the four kinds Sextant reads.
pub const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/// An image's platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImagePlatform {
    pub os: String,
    pub architecture: String,
    pub variant: Option<String>,
}

impl ImagePlatform {
    pub fn linux_amd64() -> Self {
        Self {
            os: "linux".into(),
            architecture: "amd64".into(),
            variant: None,
        }
    }
}

/// A content descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Descriptor {
    pub media_type: String,
    pub digest: String,
    pub size: u64,
}

/// One image of an index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEntry {
    pub platform: ImagePlatform,
    pub manifest: Descriptor,
}

/// An image manifest: its config and its layers, base first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageManifest {
    pub config: Descriptor,
    pub layers: Vec<Descriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Index(Vec<PlatformEntry>),
    Image(ImageManifest),
}

/// How a layer's tar stream is compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Compression {
    None,
    Gzip,
    Zstd,
}

/// `sha256:<hex>` of `bytes`.
pub fn sha256_digest(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

pub fn hex_digest(hash: &[u8]) -> String {
    let mut out = String::with_capacity(7 + hash.len() * 2);
    out.push_str("sha256:");
    for b in hash {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn descriptor(value: &Value) -> CoreResult<Descriptor> {
    let media_type = value
        .get("mediaType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let digest = value
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| refused("a descriptor has no digest"))?;
    check_digest(digest).map_err(|_| refused("a descriptor's digest is not sha256"))?;
    let size = value
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| refused("a descriptor has no size"))?;
    Ok(Descriptor {
        media_type,
        digest: digest.to_owned(),
        size,
    })
}

/// Reads a manifest or an index; `content_type` is the response's media type, the document's own `mediaType` wins.
pub fn parse_manifest(bytes: &[u8], content_type: Option<&str>) -> CoreResult<Parsed> {
    if bytes.len() as u64 > limits::MAX_MANIFEST_BYTES {
        return Err(refused("the manifest is larger than 4 MiB"));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| refused("the manifest is not JSON"))?;
    if value.get("schemaVersion").and_then(Value::as_u64) == Some(1) {
        return Err(refused("Docker manifest schema 1 is not supported"));
    }
    let content_type = content_type.map(|c| c.split(';').next().unwrap_or("").trim());
    let media_type = value
        .get("mediaType")
        .and_then(Value::as_str)
        .or(content_type)
        .unwrap_or("");
    let is_index = match media_type {
        OCI_INDEX | DOCKER_LIST => true,
        OCI_MANIFEST | DOCKER_MANIFEST => false,
        // An OCI document may leave `mediaType` out: tell by its fields.
        _ => value.get("manifests").is_some() && value.get("layers").is_none(),
    };
    if is_index {
        let list = value
            .get("manifests")
            .and_then(Value::as_array)
            .ok_or_else(|| refused("the index lists no manifests"))?;
        let mut entries = Vec::new();
        for item in list {
            let manifest = descriptor(item)?;
            let platform = item.get("platform");
            let text = |key: &str| {
                platform
                    .and_then(|p| p.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let os = text("os").unwrap_or_default();
            let architecture = text("architecture").unwrap_or_default();
            // Attestations and signatures are listed as `unknown/unknown`.
            if os.is_empty() || os == "unknown" || architecture == "unknown" {
                continue;
            }
            entries.push(PlatformEntry {
                platform: ImagePlatform {
                    os,
                    architecture,
                    variant: text("variant").filter(|v| !v.is_empty()),
                },
                manifest,
            });
        }
        if entries.is_empty() {
            return Err(refused("the index has no image for any platform"));
        }
        return Ok(Parsed::Index(entries));
    }
    let config = descriptor(
        value
            .get("config")
            .ok_or_else(|| refused("the manifest has no config"))?,
    )?;
    let layers = value
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| refused("the manifest has no layers"))?;
    if layers.len() > limits::MAX_LAYERS {
        return Err(refused(format!(
            "the image has more than {} layers",
            limits::MAX_LAYERS
        )));
    }
    let layers = layers
        .iter()
        .map(descriptor)
        .collect::<CoreResult<Vec<_>>>()?;
    for layer in &layers {
        compression_of(&layer.media_type)?;
        if layer.size > limits::MAX_LAYER_COMPRESSED {
            return Err(refused("a layer is larger than 4 GiB"));
        }
    }
    Ok(Parsed::Image(ImageManifest { config, layers }))
}

/// The image of `wanted` (default `linux/amd64`), else the first one when nothing was asked for.
pub fn choose_platform<'a>(
    entries: &'a [PlatformEntry],
    wanted: Option<&ImagePlatform>,
) -> CoreResult<&'a PlatformEntry> {
    let matches = |p: &ImagePlatform, w: &ImagePlatform| {
        p.os == w.os
            && p.architecture == w.architecture
            && (w.variant.is_none() || p.variant == w.variant)
    };
    match wanted {
        Some(w) => entries
            .iter()
            .find(|e| matches(&e.platform, w))
            .ok_or_else(|| refused("the image has no such platform")),
        None => Ok(entries
            .iter()
            .find(|e| matches(&e.platform, &ImagePlatform::linux_amd64()))
            .unwrap_or(&entries[0])),
    }
}

/// The compression of a layer media type; foreign (non-distributable), encrypted and unknown layers are refused.
pub fn compression_of(media_type: &str) -> CoreResult<Compression> {
    match media_type {
        "application/vnd.oci.image.layer.v1.tar"
        | "application/vnd.docker.image.rootfs.diff.tar" => Ok(Compression::None),
        "application/vnd.oci.image.layer.v1.tar+gzip"
        | "application/vnd.docker.image.rootfs.diff.tar.gzip" => Ok(Compression::Gzip),
        "application/vnd.oci.image.layer.v1.tar+zstd" => Ok(Compression::Zstd),
        t if t.contains("foreign") || t.contains("nondistributable") => Err(refused(
            "the image has a non-distributable (foreign) layer, which registries do not serve",
        )),
        t if t.contains("encrypted") => Err(refused("the image has an encrypted layer")),
        _ => Err(refused("a layer has a media type Sextant cannot read")),
    }
}

/// `created_by` of the config's history entries that made a layer (empty layers skipped), clipped to 500
/// characters; `None` when the config has no such history.
pub fn layer_history(config: &[u8], layers: usize) -> Vec<Option<String>> {
    let mut out = vec![None; layers];
    let Ok(value) = serde_json::from_slice::<Value>(config) else {
        return out;
    };
    let Some(history) = value.get("history").and_then(Value::as_array) else {
        return out;
    };
    let mut index = 0;
    for item in history {
        if item.get("empty_layer").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if index >= layers {
            break;
        }
        out[index] = item
            .get("created_by")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(500).collect());
        index += 1;
    }
    out
}
