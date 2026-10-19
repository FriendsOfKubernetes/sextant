//! The cluster's OpenAPI v3 schema for the YAML editor (#151): completion, validation and documentation of fields.
//!
//! `/openapi/v3` (the index) names one document per group/version (`api/v1`, `apis/apps/v1`, a CRD's group); a
//! document is fetched only when the editor asks for a kind of it, with a timeout and a size cap
//! ([`MAX_DOCUMENT_BYTES`]). A fetched document is read one schema at a time and each is reduced at once to compact
//! definitions ([`SchemaNode`]: types, formats, enums, defaults, required fields, descriptions clipped to
//! [`DESCRIPTION_LIMIT`] bytes), so the whole document is never one parsed tree; the compact form of the last [`MAX_GROUP_VERSIONS`] group/versions of the last [`MAX_CLUSTERS`]
//! clusters is kept. A reconnect (a new [`ClusterManager::connection`]) or [`ClusterManager::refresh_kinds`] (a CRD
//! changed) drops a cluster's cache.
//!
//! The window gets one kind at a time ([`KindSchema`]): its root and only the definitions reachable from it, so a
//! whole OpenAPI document never reaches the WebView. References stay references by name ([`SchemaNode::reference`])
//! so a recursive type (`JSONSchemaProps`) and a shared one (`ObjectMeta`, `Container`) are sent once.
//!
//! Only reads, and a window command only: neither the MCP server nor the extension API offers it.

mod compact;
mod stream;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::AsyncReadExt;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;

pub use compact::GroupVersionSchemas;

/// A document larger than this is refused (`/openapi/v3/api/v1` is about 1.6 MB).
pub const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
/// The index is a list of paths; a few kilobytes.
pub const MAX_INDEX_BYTES: usize = 1024 * 1024;
/// How long one request may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Group/versions kept per cluster (least recently used dropped first).
pub const MAX_GROUP_VERSIONS: usize = 12;
/// Clusters whose schemas are kept.
pub const MAX_CLUSTERS: usize = 4;
/// A description longer than this many bytes is clipped (on a character boundary) and ends with `…`.
pub const DESCRIPTION_LIMIT: usize = 2048;
/// Inline nesting deeper than this is cut ([`SchemaNode::truncated`]); CRD schemas are inline.
pub const MAX_DEPTH: usize = 40;
/// Nodes made from one document at most; past it the rest is cut.
pub const MAX_NODES: usize = 200_000;
/// Definitions sent with one kind at most; the ones past it are cut.
pub const MAX_DEFINITIONS: usize = 600;

/// One schema node, compact: what completion, validation and documentation need, nothing else.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SchemaNode {
    /// The definition (a key of [`KindSchema::definitions`]) this node stands for; the node's own description and
    /// default win over the definition's.
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<String>,
    /// The JSON types allowed (`object`, `array`, `string`, `integer`, `number`, `boolean`); none: any.
    /// `int-or-string` is `["integer", "string"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default: Option<Value>,
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enum_values: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub required: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub properties: Option<BTreeMap<String, SchemaNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub items: Option<Box<SchemaNode>>,
    /// The schema of keys not in `properties` (a map such as `labels`); an empty node allows anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub additional_properties: Option<Box<SchemaNode>>,
    /// `x-kubernetes-preserve-unknown-fields`: fields not in `properties` are kept, so none is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preserve_unknown: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nullable: Option<bool>,
    /// The schema below this node was cut (depth or size): anything is accepted there.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<bool>,
}

/// The schema of one kind: `root` is the kind's own definition, `definitions` every definition reachable from it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindSchema {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub root: SchemaNode,
    pub definitions: BTreeMap<String, SchemaNode>,
}

/// The schemas fetched so far, per cluster. Kept by [`ClusterManager::openapi`].
#[derive(Default)]
pub struct SchemaCache {
    state: Mutex<CacheState>,
}

#[derive(Default)]
struct CacheState {
    /// Least recently used first.
    clusters: Vec<(ClusterId, ClusterSchemas)>,
    /// Per cluster, grows with every [`SchemaCache::forget`] of it: a fetch of that cluster that started before one
    /// does not store its result. One entry per cluster id ever forgotten (a few dozen numbers at most).
    generations: HashMap<ClusterId, u64>,
}

impl CacheState {
    fn generation(&self, id: &ClusterId) -> u64 {
        self.generations.get(id).copied().unwrap_or_default()
    }
}

struct ClusterSchemas {
    /// The [`ClusterManager::connection`] these were fetched over.
    connection: u64,
    /// One fetch at a time per cluster, so two editors asking for the same group/version download it once.
    fetching: Arc<tokio::sync::Mutex<()>>,
    /// The index: path (`apis/apps/v1`) → the URL to fetch it from.
    index: Option<Arc<HashMap<String, String>>>,
    /// Least recently used first.
    group_versions: Vec<(String, Arc<GroupVersionSchemas>)>,
}

impl SchemaCache {
    /// Drops everything kept for `id` (a CRD changed, the cluster was disconnected).
    pub fn forget(&self, id: &ClusterId) {
        let mut state = self.lock();
        *state.generations.entry(id.clone()).or_default() += 1;
        state.clusters.retain(|(cluster, _)| cluster != id);
    }

    /// The group/versions kept for `id`, least recently used first (for tests and diagnostics).
    pub fn kept(&self, id: &ClusterId) -> Vec<String> {
        let state = self.lock();
        state
            .clusters
            .iter()
            .find(|(cluster, _)| cluster == id)
            .map(|(_, c)| c.group_versions.iter().map(|(p, _)| p.clone()).collect())
            .unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` on the cluster's entry (made, or replaced when `connection` differs), marking it used.
    fn with<T>(
        &self,
        id: &ClusterId,
        connection: u64,
        f: impl FnOnce(&mut ClusterSchemas, u64) -> T,
    ) -> T {
        let mut state = self.lock();
        let generation = state.generation(id);
        let at = state.clusters.iter().position(|(c, _)| c == id);
        let (cluster, mut entry) = match at {
            Some(at) => state.clusters.remove(at),
            None => (id.clone(), ClusterSchemas::new(connection)),
        };
        if entry.connection != connection {
            entry = ClusterSchemas::new(connection);
        }
        let out = f(&mut entry, generation);
        state.clusters.push((cluster, entry));
        if state.clusters.len() > MAX_CLUSTERS {
            state.clusters.remove(0);
        }
        out
    }

    /// Stores what a fetch that started at `generation` got, unless the cache was forgotten since.
    fn store(
        &self,
        id: &ClusterId,
        connection: u64,
        generation: u64,
        f: impl FnOnce(&mut ClusterSchemas),
    ) {
        if self.lock().generation(id) != generation {
            return;
        }
        self.with(id, connection, |entry, now| {
            if now == generation {
                f(entry);
            }
        });
    }
}

impl ClusterSchemas {
    fn new(connection: u64) -> Self {
        Self {
            connection,
            fetching: Arc::default(),
            index: None,
            group_versions: Vec::new(),
        }
    }

    fn group_version(&mut self, path: &str) -> Option<Arc<GroupVersionSchemas>> {
        let at = self.group_versions.iter().position(|(p, _)| p == path)?;
        let used = self.group_versions.remove(at);
        let schemas = Arc::clone(&used.1);
        self.group_versions.push(used);
        Some(schemas)
    }

    fn keep(&mut self, path: String, schemas: Arc<GroupVersionSchemas>) {
        self.group_versions.retain(|(p, _)| *p != path);
        self.group_versions.push((path, schemas));
        if self.group_versions.len() > MAX_GROUP_VERSIONS {
            self.group_versions.remove(0);
        }
    }
}

/// The schema of `group/version/kind` as the cluster publishes it; `None` when the cluster publishes none for it (no
/// OpenAPI v3, a group/version it does not serve, a kind its document does not define).
pub async fn kind_schema(
    mgr: &ClusterManager,
    id: &ClusterId,
    group: &str,
    version: &str,
    kind: &str,
) -> CoreResult<Option<KindSchema>> {
    check_name(
        group,
        "group",
        |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-',
        true,
    )?;
    check_name(
        version,
        "version",
        |c| c.is_ascii_lowercase() || c.is_ascii_digit(),
        false,
    )?;
    check_name(kind, "kind", |c| c.is_ascii_alphanumeric(), false)?;
    let client = mgr.client(id)?;
    let connection = mgr.connection(id)?;
    let cache = mgr.openapi();
    let path = document_path(group, version);
    let lookup = |entry: &mut ClusterSchemas| {
        entry
            .group_version(&path)
            .map(|gv| gv.kind(group, version, kind))
    };
    let (fetching, generation) = cache.with(id, connection, |entry, generation| {
        (Arc::clone(&entry.fetching), generation)
    });
    if let Some(found) = cache.with(id, connection, |entry, _| lookup(entry)) {
        return Ok(found);
    }
    let _fetching = fetching.lock().await;
    // Another call may have fetched it while this one waited.
    let (cached, index) = cache.with(id, connection, |entry, _| {
        (lookup(entry), entry.index.clone())
    });
    if let Some(found) = cached {
        return Ok(found);
    }
    let index = match index {
        Some(index) => index,
        None => {
            let index = Arc::new(fetch_index(&client).await?);
            let kept = Arc::clone(&index);
            cache.store(id, connection, generation, |entry| entry.index = Some(kept));
            index
        }
    };
    let Some(url) = index.get(&path) else {
        return Ok(None);
    };
    let Some(bytes) = fetch(&client, url, MAX_DOCUMENT_BYTES, &path).await? else {
        return Ok(None);
    };
    let schemas = tokio::task::spawn_blocking(move || -> CoreResult<GroupVersionSchemas> {
        GroupVersionSchemas::from_slice(&bytes).map_err(|e| {
            CoreError::new(
                ErrorCode::Invalid,
                format!("the OpenAPI document is not JSON: {e}"),
            )
        })
    })
    .await
    .map_err(|e| CoreError::other(e.to_string()))??;
    let schemas = Arc::new(schemas);
    let found = schemas.kind(group, version, kind);
    cache.store(id, connection, generation, |entry| {
        entry.keep(path, schemas)
    });
    Ok(found)
}

/// `api/v1` for the core group, `apis/<group>/<version>` for the others: the keys of the index.
pub fn document_path(group: &str, version: &str) -> String {
    if group.is_empty() {
        format!("api/{version}")
    } else {
        format!("apis/{group}/{version}")
    }
}

fn check_name(
    value: &str,
    what: &str,
    allowed: impl Fn(char) -> bool,
    may_be_empty: bool,
) -> CoreResult<()> {
    let ok =
        (may_be_empty || !value.is_empty()) && value.len() <= 253 && value.chars().all(allowed);
    if ok {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("not a valid {what}: {value:?}"),
        ))
    }
}

/// The index: path → URL (`serverRelativeURL`, which carries the document's hash). A server without OpenAPI v3
/// (404) has an empty index.
async fn fetch_index(client: &kube::Client) -> CoreResult<HashMap<String, String>> {
    let Some(bytes) = fetch(client, "/openapi/v3", MAX_INDEX_BYTES, "index").await? else {
        return Ok(HashMap::new());
    };
    let index: Value = serde_json::from_slice(&bytes).map_err(|e| {
        CoreError::new(
            ErrorCode::Invalid,
            format!("the OpenAPI v3 index is not JSON: {e}"),
        )
    })?;
    let mut paths = HashMap::new();
    for (path, entry) in index
        .get("paths")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let own = format!("/openapi/v3/{path}");
        // Only a URL of the same document is followed; anything else falls back to the plain path.
        let url = entry
            .get("serverRelativeURL")
            .and_then(Value::as_str)
            .filter(|u| {
                u.strip_prefix(own.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('?'))
            })
            .map_or(own.clone(), str::to_owned);
        paths.insert(path.clone(), url);
    }
    Ok(paths)
}

/// `GET url`, at most `limit` bytes, within [`REQUEST_TIMEOUT`]; `None` on 404.
async fn fetch(
    client: &kube::Client,
    url: &str,
    limit: usize,
    what: &str,
) -> CoreResult<Option<Vec<u8>>> {
    let request = http::Request::get(url)
        .body(Vec::new())
        .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
    let read = async {
        let body = match client.request_stream(request).await {
            Ok(body) => body,
            Err(err) => {
                let err = kube_error(err, None);
                return if err.code == ErrorCode::NotFound {
                    Ok(None)
                } else {
                    Err(err)
                };
            }
        };
        let mut bytes = Vec::new();
        Box::pin(body)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    format!("reading the OpenAPI {what}: {e}"),
                )
            })?;
        if bytes.len() > limit {
            return Err(CoreError::other(format!(
                "the OpenAPI document {what} is larger than {} MiB",
                limit / (1024 * 1024)
            )));
        }
        Ok(Some(bytes))
    };
    tokio::time::timeout(REQUEST_TIMEOUT, read)
        .await
        .map_err(|_| {
            CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "the OpenAPI {what} did not arrive in {} seconds",
                    REQUEST_TIMEOUT.as_secs()
                ),
            )
        })?
}
