//! Helm releases read natively from `sh.helm.release.v1.*` Secrets; changes go through the `helm` binary
//! (`cli`, behind the `desktop` feature).
//!
//! Helm 3 and Helm 4 store a release revision the same way: a Secret of type `helm.sh/release.v1` named
//! `sh.helm.release.v1.<release>.v<revision>`, labelled `owner=helm, name=<release>, version=<revision>,
//! status=<status>`, whose `data.release` is base64 text of the gzipped release JSON. Helm 4 adds fields
//! (`apply_method`, `modtime`), which are ignored.

use std::collections::BTreeMap;
use std::io::Read;

use base64::Engine as _;
use k8s_openapi::api::core::v1::Secret;
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

/// `null` and `{}` give an empty text; anything else is YAML.
pub(crate) fn values_to_yaml(values: &Value) -> CoreResult<String> {
    match values {
        Value::Null => Ok(String::new()),
        Value::Object(map) if map.is_empty() => Ok(String::new()),
        other => Ok(serde_yaml::to_string(other)?),
    }
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

fn label<'a>(secret: &'a Secret, key: &str) -> Option<&'a str> {
    secret
        .metadata
        .labels
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

/// Latest revision of every release. `None` (or an empty list) means every namespace. Releases whose latest
/// revision is `uninstalled` (kept with `--keep-history`) are left out, as `helm list` does.
pub async fn list_releases(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespaces: Option<Vec<String>>,
) -> CoreResult<Vec<HelmRelease>> {
    let client = mgr.client(cluster)?;
    let mut secrets = Vec::new();
    match namespaces.filter(|ns| !ns.is_empty()) {
        None => secrets = list_secrets(&client, None, OWNER_SELECTOR).await?,
        Some(list) => {
            for ns in list {
                secrets.extend(list_secrets(&client, Some(&ns), OWNER_SELECTOR).await?);
            }
        }
    }

    // The latest revision of each release, found by the labels; only that one is decoded.
    let mut latest: BTreeMap<(String, String), (i32, &Secret)> = BTreeMap::new();
    let mut unlabelled = Vec::new();
    for secret in &secrets {
        let ns = secret.metadata.namespace.clone().unwrap_or_default();
        match (
            label(secret, "name"),
            label(secret, "version").and_then(|v| v.parse::<i32>().ok()),
        ) {
            (Some(name), Some(version)) => {
                let entry = latest
                    .entry((ns, name.to_owned()))
                    .or_insert((version, secret));
                if version > entry.0 {
                    *entry = (version, secret);
                }
            }
            _ => unlabelled.push(secret),
        }
    }

    let mut by_release: BTreeMap<(String, String), StoredRelease> = BTreeMap::new();
    let decoded = latest
        .into_values()
        .map(|(_, s)| s)
        .chain(unlabelled)
        .filter_map(|s| decode_secret(s).ok());
    for release in decoded {
        let key = (release.namespace.clone(), release.name.clone());
        match by_release.get(&key) {
            Some(known) if known.version >= release.version => {}
            _ => {
                by_release.insert(key, release);
            }
        }
    }
    Ok(by_release
        .into_values()
        .filter(|r| r.info.status != "uninstalled")
        .map(|r| r.summary())
        .collect())
}

/// Every stored revision of a release, oldest first. No revision at all is `notFound`.
pub(crate) async fn stored_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
) -> CoreResult<Vec<StoredRelease>> {
    check_release_name(name)?;
    let client = mgr.client(cluster)?;
    let secrets = list_secrets(&client, Some(ns), &format!("{OWNER_SELECTOR},name={name}")).await?;
    let mut revisions = secrets
        .iter()
        .map(decode_secret)
        .collect::<CoreResult<Vec<_>>>()?;
    if revisions.is_empty() {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("Helm release {name} not found in namespace {ns}"),
        ));
    }
    revisions.sort_by_key(|r| r.version);
    Ok(revisions)
}

/// One revision of a release, the latest when `revision` is `None`.
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
            let secret = api
                .get(&format!("sh.helm.release.v1.{name}.v{rev}"))
                .await?;
            decode_secret(&secret)
        }
        None => Ok(stored_history(mgr, cluster, ns, name)
            .await?
            .pop()
            .expect("history is not empty")),
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

/// Every revision of a release, oldest first (as `helm history`).
pub async fn release_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
) -> CoreResult<Vec<HelmRelease>> {
    Ok(stored_history(mgr, cluster, ns, name)
        .await?
        .iter()
        .map(StoredRelease::summary)
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
