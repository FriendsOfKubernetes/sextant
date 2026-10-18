//! The cluster-wide half of the "Cleanup" page's checks (#147), in one bounded read:
//!
//! - which API group versions do not answer their discovery request (an aggregated API whose backend is down): the
//!   kinds they serve are invisible to the page, so a namespace may hold objects of them;
//! - which of the caller's ConfigMaps and Secrets (`targets`, by namespace and name) some object of the given
//!   cluster-scoped kinds names: a string anywhere in the object equal to the name or to `namespace/name` counts
//!   (conservative: a false match only keeps an object). Crossplane `ProviderConfig`, Kyverno `ClusterPolicy`,
//!   admission policy bindings, `GatewayClass` parameters and the like are found without knowing their schemas.
//!
//! Every object is read in the core and dropped after the match; only targets the caller sent come back, so no value
//! of a cluster-scoped object reaches the window. At most [`MAX_SCANNED_OBJECTS`] objects per kind are read: a kind
//! with more, or one that cannot be listed, is returned in `unread`, and the page then offers no ConfigMap or Secret.

use std::collections::{HashMap, HashSet};

use futures::{StreamExt, stream};
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::KindRef;
use super::get::resolve_kind;
use super::mutate::STEP_TIMEOUT;
use super::sample::MAX_SAMPLED_KINDS;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;

/// Objects read per kind, at most.
pub const MAX_SCANNED_OBJECTS: u32 = 500;
/// ConfigMaps and Secrets one call may look for.
pub const MAX_TARGETS: usize = 20_000;
/// Requests in flight at once.
const PARALLEL: usize = 8;
/// Depth and size of the walk of one object.
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 200_000;

/// A ConfigMap or Secret looked for.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NamedObject {
    /// `ConfigMap` or `Secret`.
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

/// A kind whose objects were not all read: `too_many` over [`MAX_SCANNED_OBJECTS`], else `error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnreadKind {
    pub kind: KindRef,
    pub too_many: bool,
    pub error: Option<CoreError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterCheck {
    /// Group versions (`group/version`) whose discovery request failed.
    pub unavailable_groups: Vec<String>,
    /// The targets some object names.
    pub referenced: Vec<NamedObject>,
    pub unread: Vec<UnreadKind>,
}

fn validate(kinds: &[KindRef], targets: &[NamedObject]) -> CoreResult<()> {
    if kinds.len() > MAX_SAMPLED_KINDS {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("at most {MAX_SAMPLED_KINDS} kinds can be read at once"),
        ));
    }
    if targets.len() > MAX_TARGETS {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("at most {MAX_TARGETS} objects can be looked for at once"),
        ));
    }
    if let Some(bad) = targets.iter().find(|t| {
        !matches!(t.kind.as_str(), "ConfigMap" | "Secret")
            || t.name.is_empty()
            || t.namespace.is_empty()
    }) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "{} {}/{} cannot be looked for",
                bad.kind, bad.namespace, bad.name
            ),
        ));
    }
    Ok(())
}

/// The group versions (the preferred one of each group) whose resource list does not come.
async fn unavailable_groups(client: &kube::Client) -> CoreResult<Vec<String>> {
    let groups = with_timeout(STEP_TIMEOUT, "the discovery", async {
        client.list_api_groups().await.map_err(CoreError::from)
    })
    .await?;
    let versions: Vec<String> = groups
        .groups
        .iter()
        .filter_map(|g| {
            g.preferred_version
                .as_ref()
                .map(|p| p.group_version.clone())
                .or_else(|| g.versions.first().map(|v| v.group_version.clone()))
        })
        .collect();
    let failed: Vec<Option<String>> = stream::iter(versions)
        .map(|gv| async move {
            let result = with_timeout(STEP_TIMEOUT, "the discovery", async {
                client
                    .list_api_group_resources(&gv)
                    .await
                    .map_err(CoreError::from)
            })
            .await;
            result.is_err().then_some(gv)
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    Ok(failed.into_iter().flatten().collect())
}

/// Marks every target named by a string of `value`.
struct Matcher<'a> {
    by_name: HashMap<&'a str, Vec<usize>>,
    by_qualified: HashMap<String, Vec<usize>>,
    found: HashSet<usize>,
}

impl<'a> Matcher<'a> {
    fn new(targets: &'a [NamedObject]) -> Self {
        let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut by_qualified: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, t) in targets.iter().enumerate() {
            by_name.entry(t.name.as_str()).or_default().push(i);
            by_qualified
                .entry(format!("{}/{}", t.namespace, t.name))
                .or_default()
                .push(i);
        }
        Self {
            by_name,
            by_qualified,
            found: HashSet::new(),
        }
    }

    fn walk(&mut self, value: &Value) {
        let mut nodes = 0;
        self.visit(value, 0, &mut nodes);
    }

    fn visit(&mut self, value: &Value, depth: usize, nodes: &mut usize) {
        *nodes += 1;
        if depth > MAX_DEPTH || *nodes > MAX_NODES {
            return;
        }
        match value {
            Value::String(s) => {
                for list in [self.by_name.get(s.as_str()), self.by_qualified.get(s)]
                    .into_iter()
                    .flatten()
                {
                    self.found.extend(list.iter().copied());
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.visit(item, depth + 1, nodes);
                }
            }
            Value::Object(map) => {
                for (key, item) in map {
                    if key == "managedFields" {
                        continue;
                    }
                    self.visit(item, depth + 1, nodes);
                }
            }
            _ => {}
        }
    }
}

/// Reads every object of one cluster-scoped kind (at most [`MAX_SCANNED_OBJECTS`]) into the matcher.
async fn scan_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
    matcher: &mut Matcher<'_>,
) -> Result<(), UnreadKind> {
    let unread = |too_many: bool, error: Option<CoreError>| UnreadKind {
        kind: kind.clone(),
        too_many,
        error,
    };
    let list = with_timeout(STEP_TIMEOUT, "the list", async {
        let client = mgr.client(cluster)?;
        let resolved = resolve_kind(mgr, cluster, kind).await?;
        if resolved.namespaced {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("{} is a namespaced kind", kind.kind),
            ));
        }
        let params = ListParams {
            limit: Some(MAX_SCANNED_OBJECTS + 1),
            ..ListParams::default()
        };
        Ok(resolved.api(client, None).list(&params).await?)
    })
    .await
    .map_err(|err| unread(false, Some(err)))?;
    let more = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|t| !t.is_empty());
    if more || list.items.len() > MAX_SCANNED_OBJECTS as usize {
        return Err(unread(true, None));
    }
    for item in list.items {
        if let Ok(value) = serde_json::to_value(&item) {
            matcher.walk(&value);
        }
    }
    Ok(())
}

/// The unavailable group versions, and which `targets` an object of `kinds` (cluster-scoped) names.
pub async fn cluster_check(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kinds: &[KindRef],
    targets: &[NamedObject],
) -> CoreResult<ClusterCheck> {
    validate(kinds, targets)?;
    let client = mgr.client(cluster)?;
    let unavailable_groups = unavailable_groups(&client).await?;
    let mut matcher = Matcher::new(targets);
    let mut unread = Vec::new();
    if !targets.is_empty() {
        // Lists are fetched `PARALLEL` at a time; each is matched as it comes and dropped.
        let mut lists = stream::iter(kinds.iter().cloned())
            .map(|kind| async move {
                let mut local = Matcher::new(targets);
                let result = scan_kind(mgr, cluster, &kind, &mut local).await;
                (result, local.found)
            })
            .buffered(PARALLEL);
        while let Some((result, found)) = lists.next().await {
            matcher.found.extend(found);
            if let Err(kind) = result {
                unread.push(kind);
            }
        }
    }
    let mut found: Vec<usize> = matcher.found.into_iter().collect();
    found.sort_unstable();
    Ok(ClusterCheck {
        unavailable_groups,
        referenced: found.into_iter().map(|i| targets[i].clone()).collect(),
        unread,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CORE: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
        {"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["list"]}]}"#;
    const GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
        {"name":"pkg.crossplane.io","versions":[{"groupVersion":"pkg.crossplane.io/v1","version":"v1"}],
         "preferredVersion":{"groupVersion":"pkg.crossplane.io/v1","version":"v1"}},
        {"name":"metrics.example.com","versions":[{"groupVersion":"metrics.example.com/v1beta1","version":"v1beta1"}],
         "preferredVersion":{"groupVersion":"metrics.example.com/v1beta1","version":"v1beta1"}}]}"#;
    const CROSSPLANE: &str = r#"{"kind":"APIResourceList","groupVersion":"pkg.crossplane.io/v1","resources":[
        {"name":"providerconfigs","singularName":"providerconfig","namespaced":false,"kind":"ProviderConfig","verbs":["list"]},
        {"name":"bigs","singularName":"big","namespaced":false,"kind":"Big","verbs":["list"]}]}"#;

    fn answer(req: &Request) -> Reply {
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE),
            "/apis" => Reply::json(200, GROUPS),
            "/apis/pkg.crossplane.io/v1" => Reply::json(200, CROSSPLANE),
            "/apis/metrics.example.com/v1beta1" => Reply::json(
                503,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"ServiceUnavailable","code":503}"#,
            ),
            "/apis/pkg.crossplane.io/v1/providerconfigs" => Reply::json(
                200,
                r#"{"apiVersion":"pkg.crossplane.io/v1","kind":"ProviderConfigList","metadata":{},"items":[
                  {"apiVersion":"pkg.crossplane.io/v1","kind":"ProviderConfig","metadata":{"name":"aws"},
                   "spec":{"credentials":{"source":"Secret","secretRef":{"namespace":"crossplane","name":"aws-creds","key":"k"}},
                           "token":"s3cr3t-value"}}]}"#,
            ),
            "/apis/pkg.crossplane.io/v1/bigs" => Reply::json(
                200,
                r#"{"apiVersion":"pkg.crossplane.io/v1","kind":"BigList","metadata":{"continue":"more"},"items":[]}"#,
            ),
            _ => Reply::not_found(),
        }
    }

    fn kind(group: &str, version: &str, kind: &str) -> KindRef {
        KindRef {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
        }
    }

    fn target(kind: &str, namespace: &str, name: &str) -> NamedObject {
        NamedObject {
            kind: kind.into(),
            namespace: namespace.into(),
            name: name.into(),
        }
    }

    #[tokio::test]
    async fn cluster_scoped_objects_name_targets_and_a_failing_group_is_reported() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let targets = [
            target("Secret", "crossplane", "aws-creds"),
            target("Secret", "crossplane", "unused"),
            target("ConfigMap", "team", "settings"),
        ];
        let check = cluster_check(
            &mgr,
            &id,
            &[
                kind("pkg.crossplane.io", "v1", "ProviderConfig"),
                kind("pkg.crossplane.io", "v1", "Big"),
                kind("", "v1", "ConfigMap"),
            ],
            &targets,
        )
        .await
        .unwrap();
        assert_eq!(check.unavailable_groups, ["metrics.example.com/v1beta1"]);
        assert_eq!(check.referenced, [targets[0].clone()]);
        // Only what was asked for comes back: never another value of the object.
        let text = serde_json::to_string(&check).unwrap();
        assert!(!text.contains("s3cr3t"), "{text}");
        assert_eq!(check.unread.len(), 2, "{:?}", check.unread);
        assert!(
            check
                .unread
                .iter()
                .any(|u| u.kind.kind == "Big" && u.too_many)
        );
        assert!(check.unread.iter().any(|u| u.kind.kind == "ConfigMap"
            && u.error.as_ref().map(|e| e.code) == Some(ErrorCode::Invalid)));
    }

    #[test]
    fn bad_targets_are_refused() {
        assert!(validate(&[], &[target("Pod", "a", "b")]).is_err());
        assert!(validate(&[], &[target("Secret", "", "b")]).is_err());
        assert!(validate(&[], &[target("Secret", "a", "b")]).is_ok());
    }
}
