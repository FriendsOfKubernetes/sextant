//! Helm releases read natively from `sh.helm.release.v1.*` Secrets; changes go through the `helm` binary
//! (`cli`, behind the `desktop` feature).
//!
//! Helm 3 and Helm 4 store a release revision the same way: a Secret of type `helm.sh/release.v1` named
//! `sh.helm.release.v1.<release>.v<revision>`, labelled `owner=helm, name=<release>, version=<revision>,
//! status=<status>`, whose `data.release` is base64 text of the gzipped release JSON. Helm 4 adds fields
//! (`apply_method`, `modtime`), which are ignored.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::{LazyLock, Mutex};

use base64::Engine as _;
use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

#[cfg(feature = "desktop")]
pub mod cli;

/// The Secret type Helm gives release revisions.
pub const RELEASE_SECRET_TYPE: &str = "helm.sh/release.v1";

/// Label selector of every release Secret.
const OWNER_SELECTOR: &str = "owner=helm";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: i32,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub status: String,
    pub updated: String,
    /// In the release list: the latest revision, when its Secret cannot be decoded; the other fields then
    /// describe the last readable revision (or nothing, see `unreadable`).
    #[serde(default)]
    pub unreadable_revision: Option<i32>,
    /// No readable data: a history row of a revision that cannot be decoded, or a listed release none of whose
    /// revisions can be. Only `name`, `namespace` and `revision` are meaningful.
    #[serde(default)]
    pub unreadable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmReleaseDetail {
    pub release: HelmRelease,
    pub values_yaml: String,
    pub manifest: String,
    pub notes: String,
}

/// One release revision as Helm stores it. Only the fields Sextant reads; unknown fields are ignored.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StoredRelease {
    pub name: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub version: i32,
    #[serde(default)]
    pub info: StoredInfo,
    /// The whole chart: `metadata`, `templates`, `values`, `schema`, `files` (subcharts are not kept).
    #[serde(default)]
    pub chart: Value,
    /// Values the user supplied (`-f`, `--set`), without the chart's defaults.
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub manifest: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StoredInfo {
    #[serde(default)]
    pub first_deployed: String,
    #[serde(default)]
    pub last_deployed: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub description: String,
}

impl HelmRelease {
    /// A revision whose Secret cannot be decoded.
    fn unreadable(name: &str, namespace: &str, revision: i32) -> Self {
        Self {
            name: name.to_owned(),
            namespace: namespace.to_owned(),
            revision,
            chart: String::new(),
            chart_version: String::new(),
            app_version: String::new(),
            status: String::new(),
            updated: String::new(),
            unreadable_revision: None,
            unreadable: true,
        }
    }
}

impl StoredRelease {
    fn chart_field(&self, field: &str) -> String {
        self.chart
            .get("metadata")
            .and_then(|m| m.get(field))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    pub fn summary(&self) -> HelmRelease {
        HelmRelease {
            name: self.name.clone(),
            namespace: self.namespace.clone(),
            revision: self.version,
            chart: self.chart_field("name"),
            chart_version: self.chart_field("version"),
            app_version: self.chart_field("appVersion"),
            status: self.info.status.clone(),
            updated: self.info.last_deployed.clone(),
            unreadable_revision: None,
            unreadable: false,
        }
    }

    /// The release with the user's values as YAML (empty when there are none).
    pub fn detail(&self) -> CoreResult<HelmReleaseDetail> {
        Ok(HelmReleaseDetail {
            release: self.summary(),
            values_yaml: values_to_yaml(&self.config)?,
            manifest: self.manifest.clone(),
            notes: self.info.notes.clone(),
        })
    }
}

/// User values (or a chart's defaults) as block YAML for the user to read and edit; `null` and `{}` give an empty
/// text.
///
/// The text goes back to `helm` (upgrade, a stored chart's `values.yaml`), which reads YAML 1.1: there a bare
/// `yes`, `off`, `0644` or `1_000` is not text. So a string is written bare only when YAML 1.1 and 1.2 both read it
/// back as that same string; anything else is double-quoted.
pub(crate) fn values_to_yaml(values: &Value) -> CoreResult<String> {
    match values {
        Value::Null => Ok(String::new()),
        Value::Object(map) if map.is_empty() => Ok(String::new()),
        other => {
            let mut out = String::new();
            write_block(other, 0, &mut out);
            Ok(out)
        }
    }
}

/// `value` as block YAML at `indent`: a mapping as `key: value` lines, a list as `- item` lines, a scalar as one
/// line.
fn write_block(value: &Value, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, item) in map {
                out.push_str(&pad);
                write_string(key, out);
                out.push(':');
                match item {
                    Value::Object(m) if !m.is_empty() => {
                        out.push('\n');
                        write_block(item, indent + 2, out);
                    }
                    // A list under a key sits at the key's indent, as serde_yaml and Helm write it.
                    Value::Array(a) if !a.is_empty() => {
                        out.push('\n');
                        write_block(item, indent, out);
                    }
                    _ => {
                        out.push(' ');
                        write_scalar(item, out);
                        out.push('\n');
                    }
                }
            }
        }
        Value::Array(items) if !items.is_empty() => {
            for item in items {
                out.push_str(&pad);
                out.push('-');
                match item {
                    Value::Object(m) if !m.is_empty() => write_nested_after_dash(item, indent, out),
                    Value::Array(a) if !a.is_empty() => write_nested_after_dash(item, indent, out),
                    _ => {
                        out.push(' ');
                        write_scalar(item, out);
                        out.push('\n');
                    }
                }
            }
        }
        _ => {
            out.push_str(&pad);
            write_scalar(value, out);
            out.push('\n');
        }
    }
}

/// A collection inside a list item: its first line follows the `- `, the rest is indented under it.
fn write_nested_after_dash(item: &Value, indent: usize, out: &mut String) {
    let mut nested = String::new();
    write_block(item, indent + 2, &mut nested);
    out.push(' ');
    out.push_str(&nested[indent + 2..]);
}

/// An empty collection, `null`, a boolean, a number or a string on one line.
fn write_scalar(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => out.push_str(&i.to_string()),
            (None, Some(u), _) => out.push_str(&u.to_string()),
            // `{:?}` always has a `.` or an exponent ("8.0", "1e300"): a float in YAML 1.1 and 1.2.
            (None, None, Some(f)) => out.push_str(&format!("{f:?}")),
            _ => out.push_str(&n.to_string()),
        },
        Value::String(s) => write_string(s, out),
        Value::Array(_) => out.push_str("[]"),
        Value::Object(_) => out.push_str("{}"),
    }
}

/// Words that are not text when bare: booleans of YAML 1.1 (Helm) and 1.2, and null.
const BARE_WORDS: &[&str] = &[
    "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "on", "On", "ON", "off", "Off",
    "OFF", "true", "True", "TRUE", "false", "False", "FALSE", "null", "Null", "NULL", "~",
];

/// A string bare when that is unambiguous, otherwise double-quoted. Bare: starts with an ASCII letter, `/` or `_`
/// (so it can be no number, timestamp or indicator), is not one of [`BARE_WORDS`], has only letters, digits,
/// spaces and `._/-+@=:,()%`, no `: ` and no trailing space or `:`.
fn write_string(s: &str, out: &mut String) {
    let bare = s
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '/' || c == '_')
        && !BARE_WORDS.contains(&s)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || " ._/-+@=:,()%".contains(c))
        && !s.contains(": ")
        && !s.ends_with([' ', ':']);
    if bare {
        out.push_str(s);
    } else {
        write_quoted(s, out);
    }
}

/// A YAML double-quoted string (read the same by YAML 1.1 and 1.2); characters YAML does not allow raw are escaped.
pub(crate) fn write_quoted(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            // C0, DEL, C1 (with NEL, U+0085), the line and paragraph separators — line breaks to YAML 1.1 — and
            // what YAML does not allow raw.
            c if (c as u32) < 0x20
                || (0x7f..=0x9f).contains(&(c as u32))
                || matches!(
                    c,
                    '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{fffe}' | '\u{ffff}'
                ) =>
            {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Decodes `data.release` of a release Secret (the bytes Kubernetes returns after its own base64): base64 text
/// of gzipped JSON. Plain (not gzipped) JSON is accepted too.
pub fn decode_release(data: &[u8]) -> CoreResult<StoredRelease> {
    let text: Vec<u8> = data
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&text)
        .map_err(|e| invalid(format!("the release is not base64: {e}")))?;
    let json = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut out)
            .map_err(|e| invalid(format!("the release is not valid gzip: {e}")))?;
        out
    } else {
        bytes
    };
    serde_json::from_slice(&json)
        .map_err(|e| invalid(format!("the release is not valid JSON: {e}")))
}

fn invalid(message: String) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// Release names Helm accepts: lowercase letters, digits, `-` and `.`. Anything else would change the meaning of a
/// label selector or a Secret name built from it.
pub(crate) fn check_release_name(name: &str) -> CoreResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.');
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{name:?} is not a valid Helm release name"
        )))
    }
}

fn decode_secret(secret: &Secret) -> CoreResult<StoredRelease> {
    let name = secret.metadata.name.as_deref().unwrap_or_default();
    let data = secret
        .data
        .as_ref()
        .and_then(|d| d.get("release"))
        .ok_or_else(|| invalid(format!("Secret {name} has no release data")))?;
    decode_release(&data.0).map_err(|e| invalid(format!("Secret {name}: {}", e.message)))
}

fn is_release_secret(secret: &Secret) -> bool {
    secret.type_.as_deref() == Some(RELEASE_SECRET_TYPE)
}

fn label<'a>(meta: &'a ObjectMeta, key: &str) -> Option<&'a str> {
    meta.labels
        .as_ref()
        .and_then(|l| l.get(key))
        .map(String::as_str)
}

async fn list_secrets(
    client: &kube::Client,
    namespace: Option<&str>,
    selector: &str,
) -> CoreResult<Vec<Secret>> {
    let api: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let list = api.list(&ListParams::default().labels(selector)).await?;
    Ok(list.items.into_iter().filter(is_release_secret).collect())
}

/// The metadata of every release Secret in `namespace` (`None` = all namespaces), without the release data: one
/// request.
async fn list_revision_metadata(
    client: &kube::Client,
    namespace: Option<&str>,
) -> CoreResult<Vec<ObjectMeta>> {
    let api: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let params = ListParams::default()
        .labels(OWNER_SELECTOR)
        .fields(&format!("type={RELEASE_SECRET_TYPE}"));
    let list = api.list_metadata(&params).await?;
    Ok(list.items.into_iter().map(|item| item.metadata).collect())
}

/// A release Secret by name, `None` when it does not exist. When the GET is refused (RBAC may grant `list` on
/// Secrets without `get`, and Helm itself only lists them), the same Secret is read through a list with a field
/// selector on its name.
async fn get_release_secret(api: &Api<Secret>, name: &str) -> CoreResult<Option<Secret>> {
    let refused = match api.get_opt(name).await {
        Ok(found) => return Ok(found),
        Err(e) => CoreError::from(e),
    };
    if refused.code != ErrorCode::Forbidden {
        return Err(refused);
    }
    let params = ListParams::default().fields(&format!("metadata.name={name}"));
    match api.list(&params).await {
        Ok(list) => Ok(list
            .items
            .into_iter()
            .find(|s| s.metadata.name.as_deref() == Some(name))),
        Err(e) => {
            let err = CoreError::from(e);
            // Not even listed by name: the GET's refusal says more.
            Err(if err.code == ErrorCode::Forbidden {
                refused
            } else {
                err
            })
        }
    }
}

/// The release and revision a release Secret holds: its `name` and `version` labels, else its name
/// `sh.helm.release.v1.<release>.v<revision>`.
fn release_of(meta: &ObjectMeta) -> Option<(String, i32)> {
    let from_name = meta
        .name
        .as_deref()
        .and_then(|n| n.strip_prefix("sh.helm.release.v1."))
        .and_then(|n| n.rsplit_once(".v"))
        .and_then(|(release, revision)| Some((release, revision.parse().ok()?)));
    let release = label(meta, "name").or(from_name.map(|(release, _)| release))?;
    let revision = label(meta, "version")
        .and_then(|v| v.parse().ok())
        .or(from_name.map(|(_, revision)| revision))?;
    Some((release.to_owned(), revision))
}

/// The revision a release Secret holds: its `version` label, else the `.v<N>` ending of its name.
fn revision_of(secret: &Secret) -> Option<i32> {
    label(&secret.metadata, "version")
        .and_then(|v| v.parse().ok())
        .or_else(|| {
            secret
                .metadata
                .name
                .as_deref()?
                .rsplit_once(".v")?
                .1
                .parse()
                .ok()
        })
}

/// How many release Secrets `list_releases` reads at the same time.
const PARALLEL_READS: usize = 8;

/// One stored revision of a release, known from the metadata list.
struct RevisionMeta {
    revision: i32,
    /// The Secret's name.
    secret: String,
    /// The Secret's uid and resourceVersion: the same pair is the same content.
    version_key: Option<(String, String)>,
    /// Its `status` label.
    status: Option<String>,
}

/// A release in the list: its last readable revision, and its latest revision.
struct Listed {
    release: Option<HelmRelease>,
    latest: i32,
}

/// Release Secrets read before, by cluster, uid and resourceVersion: the summary of the release, or `None` when it
/// cannot be decoded. A list made again reads only the revisions that are new or changed.
type ReadRevisions = HashMap<(ClusterId, String, String), Option<HelmRelease>>;

static READ_REVISIONS: LazyLock<Mutex<ReadRevisions>> = LazyLock::new(Default::default);

/// Above this many entries `READ_REVISIONS` starts over (summaries are small; this only bounds a long session).
const MAX_READ_REVISIONS: usize = 10_000;

fn read_before(cluster: &ClusterId, key: &(String, String)) -> Option<Option<HelmRelease>> {
    let cache = READ_REVISIONS.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .get(&(cluster.clone(), key.0.clone(), key.1.clone()))
        .cloned()
}

fn remember_read(cluster: &ClusterId, secret: &Secret, release: Option<HelmRelease>) {
    let (Some(uid), Some(version)) = (
        secret.metadata.uid.clone(),
        secret.metadata.resource_version.clone(),
    ) else {
        return;
    };
    let mut cache = READ_REVISIONS.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= MAX_READ_REVISIONS {
        cache.clear();
    }
    cache.insert((cluster.clone(), uid, version), release);
}

/// The revisions of one release, newest first, until one can be decoded (normally only the latest is read whole;
/// one read before with the same resourceVersion is not read again). A revision deleted meanwhile does not count;
/// `None` when none is left.
async fn read_latest(
    client: &kube::Client,
    cluster: &ClusterId,
    namespace: &str,
    mut revisions: Vec<RevisionMeta>,
) -> CoreResult<Option<Listed>> {
    revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
    let api: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let mut latest = None;
    for meta in revisions {
        let known = meta
            .version_key
            .as_ref()
            .and_then(|key| read_before(cluster, key));
        let release = match known {
            Some(release) => release,
            None => {
                let Some(secret) = get_release_secret(&api, &meta.secret).await? else {
                    continue;
                };
                let release = is_release_secret(&secret)
                    .then(|| decode_secret(&secret).ok())
                    .flatten()
                    .map(|r| r.summary());
                remember_read(cluster, &secret, release.clone());
                release
            }
        };
        let latest = *latest.get_or_insert(meta.revision);
        if release.is_some() {
            return Ok(Some(Listed { release, latest }));
        }
    }
    Ok(latest.map(|latest| Listed {
        release: None,
        latest,
    }))
}

/// Latest revision of every release. `None` (or an empty list) means every namespace. Releases whose latest
/// revision is `uninstalled` (kept with `--keep-history`) are left out, as `helm list` does.
///
/// The revisions are found from the metadata of the release Secrets (one list per namespace, or one for all) and
/// their labels `name`, `version`, `status`; only the latest revision of each release is read whole, several
/// releases at a time.
///
/// A release whose latest revision cannot be decoded stays in the list with its last readable revision and
/// `unreadable_revision` set; when no revision can be read, it is an `unreadable` row.
pub async fn list_releases(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespaces: Option<Vec<String>>,
) -> CoreResult<Vec<HelmRelease>> {
    let client = mgr.client(cluster)?;
    let metadata = match namespaces.filter(|ns| !ns.is_empty()) {
        None => list_revision_metadata(&client, None).await?,
        Some(mut list) => {
            list.sort();
            list.dedup();
            futures::future::try_join_all(
                list.iter()
                    .map(|ns| list_revision_metadata(&client, Some(ns))),
            )
            .await?
            .concat()
        }
    };

    // The revisions of each release, found by the labels (or the Secret names).
    let mut by_release: BTreeMap<(String, String), Vec<RevisionMeta>> = BTreeMap::new();
    for meta in metadata {
        let (Some(ns), Some(secret)) = (meta.namespace.clone(), meta.name.clone()) else {
            continue;
        };
        let Some((name, revision)) = release_of(&meta) else {
            continue;
        };
        by_release
            .entry((ns, name))
            .or_default()
            .push(RevisionMeta {
                revision,
                secret,
                version_key: meta.uid.clone().zip(meta.resource_version.clone()),
                status: label(&meta, "status").map(str::to_owned),
            });
    }
    // Uninstalled with the history kept: nothing to read.
    by_release.retain(|_, revisions| {
        revisions
            .iter()
            .max_by_key(|r| r.revision)
            .is_some_and(|latest| latest.status.as_deref() != Some("uninstalled"))
    });

    let client = &client;
    let listed: Vec<((String, String), Option<Listed>)> = futures::stream::iter(
        by_release
            .into_iter()
            .map(|((ns, name), revisions)| async move {
                let listed = read_latest(client, cluster, &ns, revisions).await?;
                CoreResult::Ok(((ns, name), listed))
            }),
    )
    .buffer_unordered(PARALLEL_READS)
    .try_collect()
    .await?;

    let mut releases: Vec<HelmRelease> = listed
        .into_iter()
        .filter_map(|((ns, name), listed)| {
            let l = listed?;
            match l.release {
                Some(release) => {
                    let unreadable_revision = (l.latest > release.revision).then_some(l.latest);
                    if unreadable_revision.is_none() && release.status == "uninstalled" {
                        return None;
                    }
                    Some(HelmRelease {
                        unreadable_revision,
                        ..release
                    })
                }
                None => Some(HelmRelease {
                    unreadable_revision: Some(l.latest),
                    ..HelmRelease::unreadable(&name, &ns, l.latest)
                }),
            }
        })
        .collect();
    releases.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    Ok(releases)
}

/// One stored revision of a release: the release, or why its Secret cannot be decoded.
pub(crate) struct StoredRevision {
    pub revision: i32,
    pub release: CoreResult<StoredRelease>,
}

/// Every stored revision of a release, oldest first, readable or not. No revision at all is `notFound`.
pub(crate) async fn stored_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
) -> CoreResult<Vec<StoredRevision>> {
    check_release_name(name)?;
    let client = mgr.client(cluster)?;
    let secrets = list_secrets(&client, Some(ns), &format!("{OWNER_SELECTOR},name={name}")).await?;
    let mut revisions: Vec<StoredRevision> = secrets
        .iter()
        .filter_map(|secret| {
            let release = decode_secret(secret);
            let revision = match &release {
                Ok(r) => r.version,
                Err(_) => revision_of(secret)?,
            };
            Some(StoredRevision { revision, release })
        })
        .collect();
    if revisions.is_empty() {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("Helm release {name} not found in namespace {ns}"),
        ));
    }
    revisions.sort_by_key(|r| r.revision);
    Ok(revisions)
}

/// One revision of a release; with `revision` `None`, the latest one that can be read.
pub(crate) async fn stored_release(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
    revision: Option<i32>,
) -> CoreResult<StoredRelease> {
    check_release_name(name)?;
    match revision {
        Some(rev) => {
            let client = mgr.client(cluster)?;
            let api: Api<Secret> = Api::namespaced(client, ns);
            let secret_name = format!("sh.helm.release.v1.{name}.v{rev}");
            let secret = get_release_secret(&api, &secret_name)
                .await?
                .ok_or_else(|| {
                    CoreError::new(
                        ErrorCode::NotFound,
                        format!(
                            "revision {rev} of Helm release {name} not found in namespace {ns}"
                        ),
                    )
                })?;
            decode_secret(&secret)
        }
        None => {
            let mut latest_error = None;
            for stored in stored_history(mgr, cluster, ns, name)
                .await?
                .into_iter()
                .rev()
            {
                match stored.release {
                    Ok(release) => return Ok(release),
                    Err(e) => {
                        latest_error.get_or_insert(e);
                    }
                }
            }
            let reason = latest_error.map(|e| e.message).unwrap_or_default();
            Err(invalid(format!(
                "no revision of Helm release {name} can be read ({reason})"
            )))
        }
    }
}

pub async fn release_detail(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
    revision: Option<i32>,
) -> CoreResult<HelmReleaseDetail> {
    stored_release(mgr, cluster, ns, name, revision)
        .await?
        .detail()
}

/// Every revision of a release, oldest first (as `helm history`); a revision that cannot be decoded is an
/// `unreadable` row.
pub async fn release_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
) -> CoreResult<Vec<HelmRelease>> {
    Ok(stored_history(mgr, cluster, ns, name)
        .await?
        .iter()
        .map(|stored| match &stored.release {
            Ok(release) => release.summary(),
            Err(_) => HelmRelease::unreadable(name, ns, stored.revision),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;

    use super::*;

    /// A release revision shaped as Helm 4.3 wrote it in the kind test cluster (`helm install probe … --set
    /// greeting=hi`).
    fn helm4_release() -> Value {
        json!({
            "name": "probe",
            "info": {
                "first_deployed": "2026-10-11T22:19:14.665047041+03:00",
                "last_deployed": "2026-10-11T22:19:14.665047041+03:00",
                "description": "Install complete",
                "status": "deployed",
                "notes": "Release probe says hi.\n"
            },
            "chart": {
                "metadata": { "name": "sextant-demo", "version": "0.1.0", "apiVersion": "v2", "appVersion": "1.0.0", "type": "application" },
                "lock": null,
                "templates": [{ "name": "templates/configmap.yaml", "modtime": "2026-10-11T22:00:00Z", "data": "a2luZDogQ29uZmlnTWFw" }],
                "values": { "greeting": "hello", "replicas": 1 },
                "schema": null,
                "schemamodtime": "0001-01-01T00:00:00Z",
                "files": null,
                "modtime": "2026-10-11T22:00:00Z"
            },
            "config": { "greeting": "hi" },
            "manifest": "---\nkind: ConfigMap\n",
            "version": 1,
            "namespace": "sextant-helm-probe",
            "apply_method": "csa"
        })
    }

    /// The same revision as Helm 3 writes it: no `apply_method` / `modtime`, plus `info.deleted`.
    fn helm3_release() -> Value {
        let mut v = helm4_release();
        let obj = v.as_object_mut().unwrap();
        obj.remove("apply_method");
        obj["chart"].as_object_mut().unwrap().remove("modtime");
        obj["info"]["deleted"] = json!("");
        obj["version"] = json!(3);
        obj["info"]["status"] = json!("superseded");
        v
    }

    /// What Kubernetes hands back for `data.release`: base64 text of gzipped JSON.
    fn encode(release: &Value, gzip: bool) -> Vec<u8> {
        let json = serde_json::to_vec(release).unwrap();
        let bytes = if gzip {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&json).unwrap();
            enc.finish().unwrap()
        } else {
            json
        };
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into_bytes()
    }

    #[test]
    fn decodes_a_helm4_release_secret() {
        let r = decode_release(&encode(&helm4_release(), true)).unwrap();
        assert_eq!(
            r.summary(),
            HelmRelease {
                name: "probe".into(),
                namespace: "sextant-helm-probe".into(),
                revision: 1,
                chart: "sextant-demo".into(),
                chart_version: "0.1.0".into(),
                app_version: "1.0.0".into(),
                status: "deployed".into(),
                updated: "2026-10-11T22:19:14.665047041+03:00".into(),
                unreadable_revision: None,
                unreadable: false,
            }
        );
        let detail = r.detail().unwrap();
        assert_eq!(detail.values_yaml, "greeting: hi\n");
        assert_eq!(detail.manifest, "---\nkind: ConfigMap\n");
        assert_eq!(detail.notes, "Release probe says hi.\n");
    }

    #[test]
    fn decodes_a_helm3_release_and_plain_json() {
        let r = decode_release(&encode(&helm3_release(), true)).unwrap();
        assert_eq!((r.version, r.info.status.as_str()), (3, "superseded"));
        let plain = decode_release(&encode(&helm4_release(), false)).unwrap();
        assert_eq!(plain.summary().chart, "sextant-demo");
    }

    #[test]
    fn empty_user_values_give_empty_text() {
        let mut v = helm4_release();
        v["config"] = json!({});
        assert_eq!(
            decode_release(&encode(&v, true))
                .unwrap()
                .detail()
                .unwrap()
                .values_yaml,
            ""
        );
        v["config"] = Value::Null;
        assert_eq!(
            decode_release(&encode(&v, true))
                .unwrap()
                .detail()
                .unwrap()
                .values_yaml,
            ""
        );
    }

    /// YAML 1.1 (Helm's go-yaml v2) takes U+0085, U+2028 and U+2029 for line breaks: raw in a quoted key they break
    /// the file ("mapping values are not allowed in this context"), raw in a quoted value they fold into spaces. They
    /// are written as `\u` escapes, which helm v4.3 reads back as the same characters.
    #[test]
    fn yaml_11_line_breaks_are_escaped_in_keys_and_values() {
        assert_eq!(
            values_to_yaml(
                &json!({ "a\u{2028}b\u{2029}c\u{85}d": "x \u{2028} y\u{2029}z \u{85} w" })
            )
            .unwrap(),
            "\"a\\u2028b\\u2029c\\u0085d\": \"x \\u2028 y\\u2029z \\u0085 w\"\n"
        );
    }

    #[test]
    fn garbage_is_invalid() {
        assert_eq!(
            decode_release(b"not base64!").unwrap_err().code,
            ErrorCode::Invalid
        );
        let not_json = base64::engine::general_purpose::STANDARD.encode(b"{nope");
        assert_eq!(
            decode_release(not_json.as_bytes()).unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    mod listing {
        //! `list_releases` against a fake API server: what is downloaded and how often.
        use std::sync::{Arc, Mutex};

        use super::*;
        use crate::fake_api::{FakeApi, Reply, Request, connected_to};

        const API_VERSIONS: &str =
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
        /// What kube asks for in a metadata-only list.
        const METADATA_ACCEPT: &str = "as=PartialObjectMetadataList";

        /// One stored revision of a release.
        #[derive(Clone)]
        struct Revision {
            namespace: &'static str,
            release: &'static str,
            revision: i32,
            status: &'static str,
            /// `data.release` is not a release.
            broken: bool,
            resource_version: u32,
        }

        impl Revision {
            fn secret_name(&self) -> String {
                format!("sh.helm.release.v1.{}.v{}", self.release, self.revision)
            }

            fn metadata(&self) -> Value {
                json!({
                    "name": self.secret_name(),
                    "namespace": self.namespace,
                    "uid": format!("uid-{}-{}-{}", self.namespace, self.release, self.revision),
                    "resourceVersion": self.resource_version.to_string(),
                    "labels": {
                        "owner": "helm",
                        "name": self.release,
                        "version": self.revision.to_string(),
                        "status": self.status,
                    },
                })
            }

            /// The whole Secret as the API server sends it (`data` values are base64 once more).
            fn secret(&self) -> Value {
                let stored = if self.broken {
                    b"not a release".to_vec()
                } else {
                    encode(
                        &json!({
                            "name": self.release,
                            "namespace": self.namespace,
                            "version": self.revision,
                            "info": { "status": self.status, "last_deployed": "2026-10-12T10:00:00Z" },
                            "chart": { "metadata": { "name": "demo", "version": "1.0.0", "appVersion": "1" } },
                            "config": {},
                            "manifest": "",
                        }),
                        true,
                    )
                };
                json!({
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "type": RELEASE_SECRET_TYPE,
                    "metadata": self.metadata(),
                    "data": { "release": base64::engine::general_purpose::STANDARD.encode(stored) },
                })
            }
        }

        /// `releases` × `revisions` revisions in each of `namespaces`; the latest is `deployed`, the others
        /// `superseded`.
        fn stored(
            namespaces: &[&'static str],
            releases: &[&'static str],
            revisions: i32,
        ) -> Vec<Revision> {
            let mut out = Vec::new();
            for &namespace in namespaces {
                for &release in releases {
                    for revision in 1..=revisions {
                        out.push(Revision {
                            namespace,
                            release,
                            revision,
                            status: if revision == revisions {
                                "deployed"
                            } else {
                                "superseded"
                            },
                            broken: false,
                            resource_version: 1,
                        });
                    }
                }
            }
            out
        }

        /// Serves `stored` as Secrets: lists (whole, or metadata only when asked so) of a namespace or of all, and
        /// single Secrets.
        async fn serve(stored: Vec<Revision>) -> FakeApi {
            serve_changing(Arc::new(Mutex::new(stored))).await
        }

        /// Like `serve`, with revisions the test may change meanwhile.
        async fn serve_changing(stored: Arc<Mutex<Vec<Revision>>>) -> FakeApi {
            serve_with(stored, true).await
        }

        /// Like `serve`, for a user allowed to list Secrets but not to get them: every single-Secret GET is 403.
        async fn serve_without_get(stored: Vec<Revision>) -> FakeApi {
            serve_with(Arc::new(Mutex::new(stored)), false).await
        }

        /// The value of `fieldSelector=metadata.name=<name>` in a query, if any.
        fn name_selector(query: &str) -> Option<String> {
            query
                .split('&')
                .find_map(|p| p.strip_prefix("fieldSelector="))
                .map(|v| v.replace("%3D", "=").replace("%3d", "="))
                .and_then(|v| v.strip_prefix("metadata.name=").map(str::to_owned))
        }

        async fn serve_with(stored: Arc<Mutex<Vec<Revision>>>, get_allowed: bool) -> FakeApi {
            FakeApi::start(move |req: &Request| {
                let stored = stored.lock().unwrap().clone();
                let path = req.path.as_str();
                if path == "/api" {
                    return Reply::json(200, API_VERSIONS);
                }
                let (namespace, name) = match path.strip_prefix("/api/v1/namespaces/") {
                    Some(rest) => match rest.split_once("/secrets") {
                        Some((ns, "")) => (Some(ns), None),
                        Some((ns, name)) => (Some(ns), name.strip_prefix('/')),
                        None => return Reply::not_found(),
                    },
                    None if path == "/api/v1/secrets" => (None, None),
                    None => return Reply::not_found(),
                };
                let by_name = name_selector(&req.query);
                let in_scope = |r: &&Revision| {
                    namespace.is_none_or(|ns| ns == r.namespace)
                        && by_name.as_ref().is_none_or(|n| *n == r.secret_name())
                };
                if let Some(name) = name {
                    if !get_allowed {
                        return Reply::json(
                            403,
                            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"secrets is forbidden: cannot get resource"}"#,
                        );
                    }
                    return match stored.iter().filter(in_scope).find(|r| r.secret_name() == name) {
                        Some(r) => Reply::json(200, r.secret().to_string()),
                        None => Reply::not_found(),
                    };
                }
                let metadata_only = req.header("accept").contains(METADATA_ACCEPT);
                let items: Vec<Value> = stored
                    .iter()
                    .filter(in_scope)
                    .map(|r| {
                        if metadata_only {
                            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": r.metadata() })
                        } else {
                            r.secret()
                        }
                    })
                    .collect();
                let kind = if metadata_only { "PartialObjectMetadataList" } else { "SecretList" };
                Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": kind, "metadata": { "resourceVersion": "1" }, "items": items })
                        .to_string(),
                )
            })
            .await
        }

        /// Paths of the requests for single Secrets (whole revisions), sorted.
        fn fetched(api: &FakeApi) -> Vec<String> {
            let mut out: Vec<String> = api
                .requests()
                .iter()
                .filter(|r| r.path.contains("/secrets/"))
                .map(|r| r.path.rsplit('/').next().unwrap_or_default().to_owned())
                .collect();
            out.sort();
            out
        }

        /// The list requests: (path, asked for metadata only).
        fn lists(api: &FakeApi) -> Vec<(String, bool)> {
            let mut out: Vec<(String, bool)> = api
                .requests()
                .iter()
                .filter(|r| r.path.ends_with("/secrets"))
                .map(|r| (r.path.clone(), r.header("accept").contains(METADATA_ACCEPT)))
                .collect();
            out.sort();
            out
        }

        fn summary(list: &[HelmRelease]) -> Vec<(&str, &str, i32, &str, Option<i32>)> {
            list.iter()
                .map(|r| {
                    (
                        r.namespace.as_str(),
                        r.name.as_str(),
                        r.revision,
                        r.status.as_str(),
                        r.unreadable_revision,
                    )
                })
                .collect()
        }

        #[tokio::test]
        async fn only_the_latest_revision_of_each_release_is_downloaded_whole() {
            let api = serve(stored(&["a", "b"], &["web", "db"], 4)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let list = list_releases(&mgr, &id, Some(vec!["a".into(), "b".into()]))
                .await
                .unwrap();
            assert_eq!(
                summary(&list),
                [
                    ("a", "db", 4, "deployed", None),
                    ("a", "web", 4, "deployed", None),
                    ("b", "db", 4, "deployed", None),
                    ("b", "web", 4, "deployed", None),
                ]
            );
            assert_eq!(list[0].chart, "demo");
            assert_eq!(
                lists(&api),
                [
                    ("/api/v1/namespaces/a/secrets".to_owned(), true),
                    ("/api/v1/namespaces/b/secrets".to_owned(), true),
                ],
                "one metadata-only list per namespace"
            );
            // 4 releases × 4 revisions: the 4 latest ones are read whole.
            assert_eq!(
                fetched(&api),
                [
                    "sh.helm.release.v1.db.v4",
                    "sh.helm.release.v1.db.v4",
                    "sh.helm.release.v1.web.v4",
                    "sh.helm.release.v1.web.v4",
                ]
            );
        }

        #[tokio::test]
        async fn every_namespace_is_one_metadata_list_of_the_whole_cluster() {
            let api = serve(stored(&["a", "b"], &["web"], 3)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let list = list_releases(&mgr, &id, None).await.unwrap();
            assert_eq!(
                summary(&list),
                [
                    ("a", "web", 3, "deployed", None),
                    ("b", "web", 3, "deployed", None)
                ]
            );
            assert_eq!(lists(&api), [("/api/v1/secrets".to_owned(), true)]);
            assert_eq!(
                fetched(&api),
                ["sh.helm.release.v1.web.v3", "sh.helm.release.v1.web.v3"]
            );
        }

        #[tokio::test]
        async fn an_unreadable_latest_revision_falls_back_to_the_previous_one() {
            let mut revisions = stored(&["a"], &["web", "solo"], 3);
            for r in &mut revisions {
                // web: v3 broken, v2 readable; solo: nothing readable.
                r.broken = (r.release == "web" && r.revision == 3) || r.release == "solo";
            }
            let api = serve(revisions).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let list = list_releases(&mgr, &id, Some(vec!["a".into()]))
                .await
                .unwrap();
            assert_eq!(
                summary(&list),
                [
                    ("a", "solo", 3, "", Some(3)),
                    ("a", "web", 2, "superseded", Some(3))
                ]
            );
            assert!(list[0].unreadable && !list[1].unreadable);
            assert_eq!(
                fetched(&api),
                [
                    "sh.helm.release.v1.solo.v1",
                    "sh.helm.release.v1.solo.v2",
                    "sh.helm.release.v1.solo.v3",
                    "sh.helm.release.v1.web.v2",
                    "sh.helm.release.v1.web.v3",
                ]
            );
        }

        #[tokio::test]
        async fn listing_again_reads_only_the_revisions_that_changed() {
            let stored = Arc::new(Mutex::new(stored(&["a"], &["web", "db"], 2)));
            let api = serve_changing(Arc::clone(&stored)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let ns = Some(vec!["a".to_owned()]);

            list_releases(&mgr, &id, ns.clone()).await.unwrap();
            assert_eq!(fetched(&api).len(), 2);
            // Nothing changed: the list comes from the metadata alone.
            list_releases(&mgr, &id, ns.clone()).await.unwrap();
            assert_eq!(fetched(&api).len(), 2, "nothing read again");

            // `helm upgrade web`: revision 3 is new, revision 2 becomes superseded (a new resourceVersion).
            {
                let mut revisions = stored.lock().unwrap();
                for r in revisions
                    .iter_mut()
                    .filter(|r| r.release == "web" && r.revision == 2)
                {
                    r.status = "superseded";
                    r.resource_version = 2;
                }
                revisions.push(Revision {
                    namespace: "a",
                    release: "web",
                    revision: 3,
                    status: "deployed",
                    broken: false,
                    resource_version: 1,
                });
            }
            let list = list_releases(&mgr, &id, ns).await.unwrap();
            assert_eq!(
                summary(&list),
                [
                    ("a", "db", 2, "deployed", None),
                    ("a", "web", 3, "deployed", None)
                ]
            );
            assert_eq!(
                fetched(&api),
                [
                    "sh.helm.release.v1.db.v2",
                    "sh.helm.release.v1.web.v2",
                    "sh.helm.release.v1.web.v3",
                ]
            );
        }

        #[tokio::test]
        async fn secrets_that_may_be_listed_but_not_got_are_read_through_a_list_by_name() {
            let api = serve_without_get(stored(&["a"], &["web"], 2)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let list = list_releases(&mgr, &id, Some(vec!["a".into()]))
                .await
                .unwrap();
            assert_eq!(summary(&list), [("a", "web", 2, "deployed", None)]);
            assert!(
                api.requests()
                    .iter()
                    .any(|r| r.path == "/api/v1/namespaces/a/secrets"
                        && name_selector(&r.query).as_deref() == Some("sh.helm.release.v1.web.v2")),
                "the latest revision is listed by name"
            );

            let old = release_detail(&mgr, &id, "a", "web", Some(1))
                .await
                .unwrap();
            assert_eq!(old.release.revision, 1);
            let missing = release_detail(&mgr, &id, "a", "web", Some(9))
                .await
                .unwrap_err();
            assert_eq!(missing.code, ErrorCode::NotFound);
        }

        #[tokio::test]
        async fn a_release_uninstalled_with_its_history_kept_is_left_out_unread() {
            let mut revisions = stored(&["a"], &["web", "gone"], 2);
            for r in &mut revisions {
                if r.release == "gone" && r.revision == 2 {
                    r.status = "uninstalled";
                }
            }
            let api = serve(revisions).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let list = list_releases(&mgr, &id, Some(vec!["a".into()]))
                .await
                .unwrap();
            assert_eq!(summary(&list), [("a", "web", 2, "deployed", None)]);
            assert_eq!(fetched(&api), ["sh.helm.release.v1.web.v2"]);
        }
    }

    #[test]
    fn release_names_that_would_break_a_selector_are_rejected() {
        assert!(check_release_name("my-app.v2").is_ok());
        for bad in ["", "a,owner=x", "A", "a b", "../x", "a=b"] {
            assert_eq!(
                check_release_name(bad).unwrap_err().code,
                ErrorCode::Invalid,
                "{bad}"
            );
        }
    }
}
