//! The image file viewer (#216, ADR-0103): opening an image from its registry (credentials, manifests, every layer
//! indexed or taken from the index cache, the merged tree), the open images (`AppState.image_files`), and reading one
//! file's data again from its layer. Window only: no MCP tool, no extension method.

pub mod registry;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sextant_core::cloud::CloudCli;
use sextant_core::image_fs::auth::{Credential, registry_key};
use sextant_core::image_fs::cache::IndexCache;
use sextant_core::image_fs::layer::{Budget, LayerIndex, StreamOptions, extract_file, index_layer};
use sextant_core::image_fs::manifest::{
    Compression, ImagePlatform, Parsed, choose_platform, compression_of, layer_history,
    parse_manifest, sha256_digest,
};
use sextant_core::image_fs::reference::ImageRef;
use sextant_core::image_fs::tree::MergedTree;
use sextant_core::image_fs::{ImageCredentials, ImageFileText, limits, pull_secrets};
use sextant_core::{ClusterId, ClusterManager, CoreError, CoreResult, ErrorCode};
use ts_rs::TS;

use self::registry::{BodyReader, Registry};
use crate::download::Connect;

/// What to open: a typed reference, or a container of a pod (its image, pinned to the digest the node runs, with the
/// pod's pull secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ImageSource {
    #[serde(rename_all = "camelCase")]
    Reference { reference: String },
    #[serde(rename_all = "camelCase")]
    Pod {
        cluster_id: ClusterId,
        namespace: String,
        pod: String,
        container: String,
    },
}

/// One layer of an opened image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageLayer {
    pub digest: String,
    /// Compressed bytes.
    #[ts(type = "number")]
    pub size: u64,
    pub media_type: String,
    /// The image config's `created_by` for it, clipped.
    pub created_by: Option<String>,
    /// Its index came from the cache (nothing was downloaded).
    pub cached: bool,
    /// Entries it adds (whiteouts not counted).
    pub files: u32,
}

/// An opened image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageSummary {
    pub session_id: String,
    /// The reference as opened (normalised).
    pub reference: String,
    /// The digest the reference resolved to (an index's or a manifest's).
    pub digest: String,
    pub platform: ImagePlatform,
    /// Every platform of a multi-platform image; empty for a single one.
    pub platforms: Vec<ImagePlatform>,
    pub layers: Vec<ImageLayer>,
    /// Entries of the merged tree.
    pub files: u32,
    /// Entries left out (unsafe or over-long paths).
    pub skipped: u32,
    pub credentials: ImageCredentials,
    /// Pull secrets named by the pod or its ServiceAccount that could not be read.
    pub unreadable_secrets: Vec<String>,
}

/// A layer's state while an image opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LayerState {
    Cached,
    Downloading,
    Indexed,
}

/// What opening an image reports through its channel.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ImageOpenEvent {
    /// Credentials and manifests.
    Resolving,
    Layer {
        index: u32,
        layers: u32,
        state: LayerState,
        #[ts(type = "number")]
        bytes: u64,
        #[ts(type = "number")]
        total: u64,
    },
    Opened {
        summary: Box<ImageSummary>,
    },
    Error {
        error: CoreError,
    },
}

/// What reading a file for the viewer reports.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ImageReadEvent {
    /// Compressed bytes of the file's layer read so far.
    Progress {
        #[ts(type = "number")]
        bytes: u64,
        #[ts(type = "number")]
        total: u64,
    },
    Text {
        file: ImageFileText,
    },
    Error {
        error: CoreError,
    },
}

/// A layer of an open image, enough to read it again.
#[derive(Debug, Clone)]
pub struct LayerRef {
    pub digest: String,
    pub size: u64,
    pub compression: Compression,
}

impl LayerRef {
    pub fn options(&self, cancel: Arc<AtomicBool>) -> StreamOptions {
        StreamOptions {
            compression: self.compression,
            digest: self.digest.clone(),
            max_compressed: self.size,
            cancel,
        }
    }
}

/// An open image: its tree, its layers, and its registry (credentials and token) for reading files.
pub struct ImageSession {
    /// The cluster whose pull secrets opened it; closing the cluster closes it.
    pub cluster: Option<ClusterId>,
    pub registry: Arc<Registry>,
    pub tree: MergedTree,
    pub layers: Vec<LayerRef>,
}

/// The open images, by the id of the stream that opened them; at most [`limits::MAX_OPEN_IMAGES`].
#[derive(Default)]
pub struct ImageSessions {
    map: Mutex<HashMap<String, Arc<ImageSession>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl ImageSessions {
    pub fn insert(&self, id: String, session: ImageSession) -> CoreResult<()> {
        let mut map = lock(&self.map);
        if map.len() >= limits::MAX_OPEN_IMAGES && !map.contains_key(&id) {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!(
                    "at most {} images can be open at once: close one first",
                    limits::MAX_OPEN_IMAGES
                ),
            ));
        }
        map.insert(id, Arc::new(session));
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Arc<ImageSession>> {
        lock(&self.map)
            .get(id)
            .cloned()
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "the image is no longer open"))
    }

    pub fn remove(&self, id: &str) -> bool {
        lock(&self.map).remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        lock(&self.map).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn close_cluster(&self, cluster: &ClusterId) {
        lock(&self.map).retain(|_, s| s.cluster.as_ref() != Some(cluster));
    }

    pub fn clear(&self) {
        lock(&self.map).clear();
    }
}

/// Where the user's Docker credentials are, when the settings allow them.
#[derive(Debug, Clone)]
pub struct DockerAccess {
    pub config: PathBuf,
    pub cli: CloudCli,
}

/// What opening needs from the app.
pub struct OpenContext {
    pub clusters: ClusterManager,
    pub docker: Option<DockerAccess>,
    pub cache: IndexCache,
    /// Tests: where requests really go.
    pub connect: Option<Connect>,
    pub cancel: Arc<AtomicBool>,
}

fn joined<T>(result: Result<CoreResult<T>, tokio::task::JoinError>) -> CoreResult<T> {
    result.unwrap_or_else(|e| Err(CoreError::other(format!("the work stopped: {e}"))))
}

/// Sends events from a blocking thread at most every 100 ms (the last one always goes through the caller).
struct Throttle {
    last: Option<std::time::Instant>,
}

impl Throttle {
    fn due(&mut self) -> bool {
        if self
            .last
            .is_none_or(|t| t.elapsed() >= std::time::Duration::from_millis(100))
        {
            self.last = Some(std::time::Instant::now());
            true
        } else {
            false
        }
    }
}

pub type Emit<E> = Arc<dyn Fn(E) + Send + Sync>;

struct Resolved {
    image: ImageRef,
    credential: Option<Credential>,
    origin: ImageCredentials,
    unreadable: Vec<String>,
    cluster: Option<ClusterId>,
}

async fn resolve(ctx: &OpenContext, source: &ImageSource) -> CoreResult<Resolved> {
    let (image, secrets, unreadable, cluster) = match source {
        ImageSource::Reference { reference } => {
            (ImageRef::parse(reference)?, Vec::new(), Vec::new(), None)
        }
        ImageSource::Pod {
            cluster_id,
            namespace,
            pod,
            container,
        } => {
            let found =
                pull_secrets::pod_image(&ctx.clusters, cluster_id, namespace, pod, container)
                    .await?;
            let mut image = ImageRef::parse(&found.image)?;
            if let Some(digest) = &found.digest {
                image = image.with_digest(digest)?;
            }
            (
                image,
                found.pull_secrets,
                found.unreadable,
                Some(cluster_id.clone()),
            )
        }
    };
    let key = registry_key(&image.registry);
    if let Some((name, credential)) = pull_secrets::credential_for(&secrets, &key) {
        return Ok(Resolved {
            image,
            credential: Some(credential),
            origin: ImageCredentials::PullSecret { name },
            unreadable,
            cluster,
        });
    }
    if let Some(docker) = &ctx.docker
        && let Some(credential) =
            sextant_core::image_fs::helper::docker_credential(&docker.config, &docker.cli, &key)
                .await?
    {
        return Ok(Resolved {
            image,
            credential: Some(credential),
            origin: ImageCredentials::DockerConfig,
            unreadable,
            cluster,
        });
    }
    Ok(Resolved {
        image,
        credential: None,
        origin: ImageCredentials::Anonymous,
        unreadable,
        cluster,
    })
}

fn verify_manifest(bytes: &[u8], digest: &str) -> CoreResult<()> {
    if sha256_digest(bytes) == digest {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            "the image was refused: a manifest does not match its digest",
        ))
    }
}

fn config_platform(config: &[u8]) -> ImagePlatform {
    let value: serde_json::Value = serde_json::from_slice(config).unwrap_or_default();
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    ImagePlatform {
        os: text("os").unwrap_or_else(|| "linux".into()),
        architecture: text("architecture").unwrap_or_else(|| "amd64".into()),
        variant: text("variant").filter(|v| !v.is_empty()),
    }
}

/// Opens an image: credentials, manifests (the `platform` asked for, else `linux/amd64`, else the first), the config,
/// then every layer from the cache or the registry, merged into one tree. `emit` gets the progress.
pub async fn open(
    ctx: &OpenContext,
    source: &ImageSource,
    platform: Option<ImagePlatform>,
    session_id: &str,
    emit: Emit<ImageOpenEvent>,
) -> CoreResult<(ImageSession, ImageSummary)> {
    emit(ImageOpenEvent::Resolving);
    let resolved = resolve(ctx, source).await?;
    let registry = Arc::new(Registry::new(
        resolved.image.clone(),
        resolved.credential,
        ctx.connect.clone(),
    )?);
    let reference = resolved.image.manifest_reference().to_owned();
    let (bytes, content_type) = registry.manifest(&reference).await?;
    if resolved.image.digest.is_some() {
        verify_manifest(&bytes, &reference)?;
    }
    let digest = sha256_digest(&bytes);
    let (manifest, platforms) = match parse_manifest(&bytes, content_type.as_deref())? {
        Parsed::Image(manifest) => (manifest, Vec::new()),
        Parsed::Index(entries) => {
            let chosen = choose_platform(&entries, platform.as_ref())?;
            let (child, child_type) = registry.manifest(&chosen.manifest.digest).await?;
            verify_manifest(&child, &chosen.manifest.digest)?;
            match parse_manifest(&child, child_type.as_deref())? {
                Parsed::Image(manifest) => (
                    manifest,
                    entries.iter().map(|e| e.platform.clone()).collect(),
                ),
                Parsed::Index(_) => {
                    return Err(CoreError::new(
                        ErrorCode::Invalid,
                        "the image was refused: an index inside an index",
                    ));
                }
            }
        }
    };
    let config = registry
        .blob_bytes(&manifest.config.digest, limits::MAX_MANIFEST_BYTES)
        .await?;
    verify_manifest(&config, &manifest.config.digest).map_err(|_| {
        CoreError::new(
            ErrorCode::Invalid,
            "the image was refused: the config does not match its digest",
        )
    })?;
    let history = layer_history(&config, manifest.layers.len());
    let chosen_platform = match (&platform, platforms.is_empty()) {
        (Some(p), false) => p.clone(),
        _ => config_platform(&config),
    };

    let total = manifest.layers.len() as u32;
    let mut budget = Budget::default();
    let mut downloaded = 0u64;
    let mut tree = MergedTree::new();
    let mut layers = Vec::new();
    let mut infos = Vec::new();
    let mut skipped = 0u32;
    for (i, descriptor) in manifest.layers.iter().enumerate() {
        let index_no = i as u32;
        let layer = LayerRef {
            digest: descriptor.digest.clone(),
            size: descriptor.size,
            compression: compression_of(&descriptor.media_type)?,
        };
        let cache = ctx.cache.clone();
        let digest_key = layer.digest.clone();
        let cached = joined(tokio::task::spawn_blocking(move || Ok(cache.get(&digest_key))).await)?;
        let from_cache = cached.is_some();
        let index: LayerIndex = match cached {
            Some(index) => {
                budget.charge(&index)?;
                emit(ImageOpenEvent::Layer {
                    index: index_no,
                    layers: total,
                    state: LayerState::Cached,
                    bytes: layer.size,
                    total: layer.size,
                });
                index
            }
            None => {
                downloaded = downloaded.saturating_add(layer.size);
                if downloaded > limits::MAX_TOTAL_COMPRESSED {
                    return Err(CoreError::new(
                        ErrorCode::Invalid,
                        "the image was refused: its layers are larger than 8 GiB in all",
                    ));
                }
                emit(ImageOpenEvent::Layer {
                    index: index_no,
                    layers: total,
                    state: LayerState::Downloading,
                    bytes: 0,
                    total: layer.size,
                });
                let reader = BodyReader::start(registry.blob(&layer.digest).await?);
                let options = layer.options(Arc::clone(&ctx.cancel));
                let emit_progress = Arc::clone(&emit);
                let size = layer.size;
                let (index, left) = joined(
                    tokio::task::spawn_blocking(move || {
                        let mut budget = budget;
                        let mut throttle = Throttle { last: None };
                        let mut progress = |bytes: u64| {
                            if throttle.due() {
                                emit_progress(ImageOpenEvent::Layer {
                                    index: index_no,
                                    layers: total,
                                    state: LayerState::Downloading,
                                    bytes,
                                    total: size,
                                });
                            }
                        };
                        index_layer(reader, &options, &mut budget, &mut progress)
                            .map(|index| (index, budget))
                    })
                    .await,
                )?;
                budget = left;
                let cache = ctx.cache.clone();
                let (digest_key, copy) = (layer.digest.clone(), index.clone());
                let _ = tokio::task::spawn_blocking(move || cache.put(&digest_key, &copy)).await;
                index
            }
        };
        skipped += index.skipped;
        let files = index.entries.len() as u32;
        tree = joined(
            tokio::task::spawn_blocking(move || tree.apply(index_no, &index).map(|()| tree)).await,
        )?;
        emit(ImageOpenEvent::Layer {
            index: index_no,
            layers: total,
            state: LayerState::Indexed,
            bytes: layer.size,
            total: layer.size,
        });
        infos.push(ImageLayer {
            digest: layer.digest.clone(),
            size: layer.size,
            media_type: descriptor.media_type.clone(),
            created_by: history.get(i).cloned().flatten(),
            cached: from_cache,
            files,
        });
        layers.push(layer);
    }
    let summary = ImageSummary {
        session_id: session_id.to_owned(),
        reference: resolved.image.display(),
        digest: resolved.image.digest.clone().unwrap_or(digest),
        platform: chosen_platform,
        platforms,
        layers: infos,
        files: tree.len() as u32,
        skipped,
        credentials: resolved.origin,
        unreadable_secrets: resolved.unreadable,
    };
    let session = ImageSession {
        cluster: resolved.cluster,
        registry,
        tree,
        layers,
    };
    Ok((session, summary))
}

/// Streams the layer that holds `path`'s data; the blocking `work` reads it.
async fn with_layer<T: Send + 'static>(
    session: &ImageSession,
    path: &str,
    cancel: Arc<AtomicBool>,
    work: impl FnOnce(BodyReader, StreamOptions, String, u64) -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    let source = session.tree.data_source(path)?;
    let layer = session
        .layers
        .get(source.layer as usize)
        .ok_or_else(|| CoreError::other("the file's layer is missing"))?;
    let reader = BodyReader::start(session.registry.blob(&layer.digest).await?);
    let options = layer.options(cancel);
    let size = layer.size;
    joined(tokio::task::spawn_blocking(move || work(reader, options, source.path, size)).await)
}

/// The first [`limits::MAX_TEXT_BYTES`] of a file for the viewer; the layer is read only up to the file.
pub async fn read_text(
    session: &ImageSession,
    path: &str,
    cancel: Arc<AtomicBool>,
    emit: Emit<ImageReadEvent>,
) -> CoreResult<ImageFileText> {
    let shown = session.tree.entry(path)?.path;
    with_layer(
        session,
        path,
        cancel,
        move |reader, options, entry, total| {
            let mut throttle = Throttle { last: None };
            let mut progress = |bytes: u64| {
                if throttle.due() {
                    emit(ImageReadEvent::Progress { bytes, total });
                }
            };
            let mut out = Vec::new();
            let found = extract_file(
                reader,
                &options,
                &entry,
                limits::MAX_TEXT_BYTES,
                false,
                &mut out,
                &mut progress,
            )?;
            Ok(sextant_core::image_fs::file_text(&shown, found.size, &out))
        },
    )
    .await
}

/// Saves a file to `destination` (absolute, from the save dialog) once its whole layer was read and verified.
pub async fn save(
    session: &ImageSession,
    path: &str,
    destination: PathBuf,
    cancel: Arc<AtomicBool>,
    progress: Box<dyn FnMut(u64, u64) + Send>,
) -> CoreResult<u64> {
    let mut progress = progress;
    with_layer(
        session,
        path,
        cancel,
        move |reader, options, entry, total| {
            sextant_core::image_fs::save::save_file(
                reader,
                &options,
                &entry,
                &destination,
                &mut |bytes| progress(bytes, total),
            )
        },
    )
    .await
}
