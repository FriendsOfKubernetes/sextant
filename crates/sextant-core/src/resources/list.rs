//! One-shot reads for callers that do not keep a watch open (the tools of an AI agent): the kind the cluster really
//! serves, a page of objects of a kind, the events of an object or a namespace.

use k8s_openapi::jiff::Timestamp;
use std::time::Duration;

use futures::StreamExt;
use kube::api::{DynamicObject, ListParams, PartialObjectMeta};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::get::{is_built_in, resolve_kind, to_json};
use super::{KindRef, ObjectRef, ResourceKind};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;

/// Objects of one `list`: at most `limit` of them; `truncated` when the cluster has more.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub items: Vec<Value>,
    pub truncated: bool,
}

/// How many objects of a kind there are (`resource_count`, #157): the window's sidebar counts and its check before
/// a watch of every namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectCount {
    /// The number of objects; with `exact` false, at least this many.
    pub count: u64,
    pub exact: bool,
}

/// Metadata pages read by [`count`] when the API server does not say how many objects remain.
const COUNT_PAGE: u32 = 500;
/// How long one request of [`count`] may take: a count is a hint, never worth a long wait.
const COUNT_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};
/// Namespaces [`count`] counts at the same time.
const COUNT_PARALLEL: usize = 8;

/// Events are read in pages of this size before they are sorted.
const EVENT_PAGE: u32 = 500;

/// The kind the cluster serves for `kind`: the version asked for when the cluster serves it, else the version the
/// cluster serves (see `resolve_kind`); an unknown kind is `notFound`. A built-in kind is answered without discovery,
/// so its `verbs` are empty; `printer_columns` are always empty.
pub async fn resolve(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
) -> CoreResult<ResourceKind> {
    mgr.client(cluster)?;
    let resolved = resolve_kind(mgr, cluster, kind).await?;
    let verbs = if is_built_in(&kind.group, &kind.kind) {
        Vec::new()
    } else {
        mgr.kinds(cluster)
            .await?
            .into_iter()
            .find(|k| {
                k.kind_ref.group == kind.group
                    && k.kind_ref.kind == kind.kind
                    && k.kind_ref.version == resolved.resource.version
            })
            .map(|k| k.verbs)
            .unwrap_or_default()
    };
    Ok(ResourceKind {
        kind_ref: KindRef {
            group: resolved.resource.group.clone(),
            version: resolved.resource.version.clone(),
            kind: resolved.resource.kind.clone(),
        },
        plural: resolved.resource.plural.clone(),
        namespaced: resolved.namespaced,
        verbs,
        printer_columns: Vec::new(),
    })
}

/// Up to `limit` objects of `kind` (at least 1), in `namespace` or in all namespaces (`None`; a cluster-scoped kind
/// ignores the namespace), filtered by the label and field selectors. Objects come as `get` gives them: without
/// `managedFields`, a Secret without its values. `truncated` when the cluster holds more matching objects.
pub async fn list(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
    namespace: Option<&str>,
    label_selector: Option<&str>,
    field_selector: Option<&str>,
    limit: u32,
) -> CoreResult<ListPage> {
    if limit == 0 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "the limit must be at least 1",
        ));
    }
    let client = mgr.client(cluster)?;
    let resolved = resolve_kind(mgr, cluster, kind).await?;
    let api = resolved.api(client, namespace.filter(|ns| !ns.is_empty()));
    let mut items = Vec::new();
    let mut params = ListParams {
        label_selector: label_selector.filter(|s| !s.is_empty()).map(str::to_owned),
        field_selector: field_selector.filter(|s| !s.is_empty()).map(str::to_owned),
        ..ListParams::default()
    };
    // A server filtering by fields may answer a page with fewer objects than asked and a continue token: the next
    // pages fill the rest.
    loop {
        let wanted = limit - u32::try_from(items.len()).unwrap_or(u32::MAX);
        params.limit = Some(wanted);
        let page = api.list(&params).await?;
        let more = page.metadata.continue_.filter(|token| !token.is_empty());
        let mut objects = page.items;
        let over = objects.len() > wanted as usize;
        objects.truncate(wanted as usize);
        for obj in objects {
            items.push(to_json(obj, &resolved.resource)?);
        }
        let full = items.len() >= limit as usize;
        match more {
            Some(token) if !full => params.continue_token = Some(token),
            more => {
                return Ok(ListPage {
                    items,
                    truncated: over || more.is_some(),
                });
            }
        }
    }
}

/// How many objects of `kind` there are in `namespaces` (all when `None` or empty; a cluster-scoped kind ignores
/// them), counting at most `up_to` exactly. Each namespace costs one metadata-only list of one object, whose
/// `remainingItemCount` gives the rest; when the API server leaves it out (selectors, or an old server), metadata pages
/// are counted up to `up_to` and a larger number is "at least" (`exact: false`). No object body is downloaded.
pub async fn count(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
    namespaces: Option<&[String]>,
    label_selector: Option<&str>,
    up_to: u64,
) -> CoreResult<ObjectCount> {
    let client = mgr.client(cluster)?;
    let resolved = resolve_kind(mgr, cluster, kind).await?;
    let mut scopes: Vec<Option<&str>> = match namespaces {
        Some(list) if resolved.namespaced && !list.is_empty() => {
            list.iter().map(|ns| Some(ns.as_str())).collect()
        }
        _ => vec![None],
    };
    scopes.sort();
    scopes.dedup();
    let labels = label_selector
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned);
    // Namespaces are counted side by side (a few at a time), each request within `COUNT_TIMEOUT`.
    let apis: Vec<kube::Api<PartialObjectMeta<DynamicObject>>> = scopes
        .into_iter()
        .map(|ns| match ns {
            Some(ns) => kube::Api::namespaced_with(client.clone(), ns, &resolved.resource),
            None => kube::Api::all_with(client.clone(), &resolved.resource),
        })
        .collect();
    let counts: Vec<CoreResult<ObjectCount>> = futures::stream::iter(apis)
        .map(|api| count_in(api, labels.clone(), up_to.max(1)))
        .buffer_unordered(COUNT_PARALLEL)
        .collect()
        .await;
    let mut total = ObjectCount {
        count: 0,
        exact: true,
    };
    for one in counts {
        let one = one?;
        total.count += one.count;
        total.exact &= one.exact;
    }
    Ok(total)
}

async fn count_in(
    api: kube::Api<PartialObjectMeta<DynamicObject>>,
    labels: Option<String>,
    up_to: u64,
) -> CoreResult<ObjectCount> {
    let mut params = ListParams {
        label_selector: labels,
        limit: Some(1),
        ..ListParams::default()
    };
    let mut counted = 0u64;
    loop {
        let page = with_timeout(COUNT_TIMEOUT, "counting the objects", async {
            api.list_metadata(&params).await.map_err(CoreError::from)
        })
        .await?;
        counted += page.items.len() as u64;
        let more = page.metadata.continue_.filter(|token| !token.is_empty());
        let Some(token) = more else {
            return Ok(ObjectCount {
                count: counted,
                exact: true,
            });
        };
        if let Some(rest) = page.metadata.remaining_item_count.filter(|n| *n >= 0) {
            return Ok(ObjectCount {
                count: counted + rest as u64,
                exact: true,
            });
        }
        if counted >= up_to {
            return Ok(ObjectCount {
                count: counted,
                exact: false,
            });
        }
        params.continue_token = Some(token);
        params.limit = Some(COUNT_PAGE);
    }
}

/// Up to `limit` events (core/v1 `Event`), newest first: of the object `involved` (by its kind and name, in its
/// namespace when it has one) or, without it, of `namespace` (all namespaces when `None`). Events are ordered by the
/// last time they were seen.
pub async fn events(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: Option<&str>,
    involved: Option<&ObjectRef>,
    limit: u32,
) -> CoreResult<Vec<Value>> {
    let client = mgr.client(cluster)?;
    let event_kind = KindRef {
        group: String::new(),
        version: "v1".into(),
        kind: "Event".into(),
    };
    let resolved = resolve_kind(mgr, cluster, &event_kind).await?;
    let namespace = involved
        .and_then(|r| r.namespace.as_deref())
        .or(namespace)
        .filter(|ns| !ns.is_empty());
    let api = resolved.api(client, namespace);
    let mut params = ListParams {
        field_selector: involved.map(|r| {
            let mut selector = format!(
                "involvedObject.kind={},involvedObject.name={}",
                r.kind.kind, r.name
            );
            if let Some(ns) = r.namespace.as_deref().filter(|ns| !ns.is_empty()) {
                selector.push_str(&format!(",involvedObject.namespace={ns}"));
            }
            selector
        }),
        limit: Some(EVENT_PAGE),
        ..ListParams::default()
    };
    let mut all: Vec<DynamicObject> = Vec::new();
    loop {
        let page = api.list(&params).await?;
        all.extend(page.items);
        match page.metadata.continue_.filter(|token| !token.is_empty()) {
            Some(token) => params.continue_token = Some(token),
            None => break,
        }
    }
    let mut keyed: Vec<(Option<Timestamp>, DynamicObject)> =
        all.into_iter().map(|obj| (last_seen(&obj), obj)).collect();
    keyed.sort_by_key(|(seen, _)| std::cmp::Reverse(*seen));
    keyed
        .into_iter()
        .take(limit as usize)
        .map(|(_, obj)| to_json(obj, &resolved.resource))
        .collect()
}

/// When an event was last seen: the latest of `lastTimestamp`, `eventTime`, `series.lastObservedTime`,
/// `firstTimestamp` and the creation time.
fn last_seen(obj: &DynamicObject) -> Option<Timestamp> {
    let data = &obj.data;
    [
        data.get("lastTimestamp"),
        data.get("eventTime"),
        data.pointer("/series/lastObservedTime"),
        data.get("firstTimestamp"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .filter_map(|s| s.parse::<Timestamp>().ok())
    .chain(obj.metadata.creation_timestamp.as_ref().map(|t| t.0))
    .max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

    fn core(kind: &str) -> KindRef {
        KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: kind.into(),
        }
    }

    /// `%2C` → `,`, `%3D` → `=`, `+` → space.
    fn decoded(query: &str) -> String {
        let mut out = Vec::new();
        let bytes = query.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                    out.push(u8::from_str_radix(hex, 16).unwrap());
                    i += 3;
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        String::from_utf8(out).unwrap()
    }

    fn pod(name: &str) -> Value {
        serde_json::json!({
            "metadata": {
                "name": name, "namespace": "ns", "uid": name,
                "labels": { "app": "web" },
                "managedFields": [{ "manager": "kubectl" }]
            },
            "spec": { "containers": [{ "name": "c", "image": "nginx" }] }
        })
    }

    fn pod_list(names: &[&str], next: Option<&str>) -> String {
        let items: Vec<Value> = names.iter().map(|n| pod(n)).collect();
        let mut meta = serde_json::json!({ "resourceVersion": "7" });
        if let Some(token) = next {
            meta["continue"] = Value::String(token.into());
        }
        serde_json::json!({ "apiVersion": "v1", "kind": "PodList", "metadata": meta, "items": items })
            .to_string()
    }

    #[tokio::test]
    async fn list_returns_up_to_the_limit_marks_the_rest_and_passes_the_selectors() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/ns/pods" => Reply::json(200, pod_list(&["a", "b"], Some("next"))),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let page = list(
            &mgr,
            &id,
            &core("Pod"),
            Some("ns"),
            Some("app=web"),
            Some("status.phase=Running"),
            2,
        )
        .await
        .unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.truncated);
        assert_eq!(page.items[0]["metadata"]["name"], "a");
        assert_eq!(page.items[0]["kind"], "Pod");
        assert_eq!(page.items[0]["apiVersion"], "v1");
        assert!(page.items[0]["metadata"].get("managedFields").is_none());

        let request = api
            .requests()
            .into_iter()
            .find(|r| r.path == "/api/v1/namespaces/ns/pods")
            .expect("a list request");
        let query = decoded(&request.query);
        assert!(query.contains("limit=2"), "{query}");
        assert!(query.contains("labelSelector=app=web"), "{query}");
        assert!(
            query.contains("fieldSelector=status.phase=Running"),
            "{query}"
        );
        assert!(!query.contains("watch"), "{query}");
    }

    #[tokio::test]
    async fn list_of_everything_there_is_is_not_truncated_and_reads_all_namespaces() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/pods" => Reply::json(200, pod_list(&["a", "b"], None)),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let page = list(&mgr, &id, &core("Pod"), None, None, None, 100)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(!page.truncated);
    }

    #[tokio::test]
    async fn a_short_page_with_a_continue_token_is_filled_from_the_next_page() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/ns/pods" if req.query.contains("continue=second") => {
                Reply::json(200, pod_list(&["c", "d"], Some("third")))
            }
            "/api/v1/namespaces/ns/pods" => Reply::json(200, pod_list(&["a"], Some("second"))),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let page = list(&mgr, &id, &core("Pod"), Some("ns"), None, None, 3)
            .await
            .unwrap();
        let names: Vec<&str> = page
            .items
            .iter()
            .map(|i| i["metadata"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["a", "c", "d"]);
        assert!(page.truncated);
        let second = api
            .requests()
            .into_iter()
            .find(|r| r.query.contains("continue=second"))
            .expect("the next page");
        assert!(
            decoded(&second.query).contains("limit=2"),
            "{}",
            second.query
        );
    }

    #[tokio::test]
    async fn listed_secrets_come_without_their_values() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/ns/secrets" => Reply::json(
                200,
                r#"{"apiVersion":"v1","kind":"SecretList","metadata":{},"items":[
                    {"metadata":{"name":"creds","namespace":"ns"},"data":{"token":"c2VjcmV0"}}]}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let page = list(&mgr, &id, &core("Secret"), Some("ns"), None, None, 10)
            .await
            .unwrap();
        assert_eq!(page.items[0]["data"]["token"], "");
        assert!(!page.items[0].to_string().contains("c2VjcmV0"));
    }

    #[tokio::test]
    async fn a_zero_limit_is_invalid() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            _ => Reply::json(200, pod_list(&["a"], None)),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let err = list(&mgr, &id, &core("Pod"), Some("ns"), None, None, 0)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
    }

    fn event(name: &str, last: Option<&str>, event_time: Option<&str>) -> Value {
        let mut e = serde_json::json!({
            "metadata": { "name": name, "namespace": "ns", "creationTimestamp": "2026-01-01T00:00:00Z",
                          "managedFields": [{ "manager": "kubelet" }] },
            "involvedObject": { "kind": "Pod", "name": "web", "namespace": "ns" },
            "reason": "Pulled", "message": name, "type": "Normal"
        });
        if let Some(t) = last {
            e["lastTimestamp"] = Value::String(t.into());
        }
        if let Some(t) = event_time {
            e["eventTime"] = Value::String(t.into());
        }
        e
    }

    fn event_list() -> String {
        serde_json::json!({ "apiVersion": "v1", "kind": "EventList", "metadata": {}, "items": [
            event("old", Some("2026-10-13T10:00:00Z"), None),
            event("newest", None, Some("2026-10-13T12:00:00.500000Z")),
            event("middle", Some("2026-10-13T12:00:00Z"), None),
        ]})
        .to_string()
    }

    #[tokio::test]
    async fn events_of_an_object_are_selected_by_it_and_come_newest_first() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/ns/events" => Reply::json(200, event_list()),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let web = ObjectRef {
            kind: core("Pod"),
            namespace: Some("ns".into()),
            name: "web".into(),
        };

        let found = events(&mgr, &id, None, Some(&web), 2).await.unwrap();
        let names: Vec<&str> = found
            .iter()
            .map(|e| e["metadata"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["newest", "middle"]);
        assert!(found[0]["metadata"].get("managedFields").is_none());
        assert_eq!(found[0]["kind"], "Event");

        let request = api
            .requests()
            .into_iter()
            .find(|r| r.path == "/api/v1/namespaces/ns/events")
            .expect("an event list");
        let query = decoded(&request.query);
        assert!(query.contains("involvedObject.kind=Pod"), "{query}");
        assert!(query.contains("involvedObject.name=web"), "{query}");
    }

    #[tokio::test]
    async fn events_of_a_namespace_are_all_of_its_events() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/ns/events" => Reply::json(200, event_list()),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let found = events(&mgr, &id, Some("ns"), None, 10).await.unwrap();
        assert_eq!(found.len(), 3);
        assert_eq!(found[2]["metadata"]["name"], "old");
        let request = api
            .requests()
            .into_iter()
            .find(|r| r.path == "/api/v1/namespaces/ns/events")
            .expect("an event list");
        assert!(
            !request.query.contains("fieldSelector"),
            "{}",
            request.query
        );
    }

    /// Discovery of a cluster serving `widgets.example.com` only in `v1beta1`.
    fn with_widgets(req: &Request) -> Reply {
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#,
            ),
            "/apis" => Reply::json(
                200,
                r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
                {"name":"example.com","versions":[{"groupVersion":"example.com/v1beta1","version":"v1beta1"}],
                 "preferredVersion":{"groupVersion":"example.com/v1beta1","version":"v1beta1"}}]}"#,
            ),
            "/apis/example.com/v1beta1" => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"example.com/v1beta1","resources":[
                {"name":"widgets","singularName":"widget","namespaced":true,"kind":"Widget","verbs":["get","list","watch"]}]}"#,
            ),
            _ => Reply::not_found(),
        }
    }

    #[tokio::test]
    async fn resolve_gives_the_version_the_cluster_serves() {
        let api = FakeApi::start(with_widgets).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let widget = resolve(
            &mgr,
            &id,
            &KindRef {
                group: "example.com".into(),
                version: "v1".into(),
                kind: "Widget".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(widget.kind_ref.version, "v1beta1");
        assert_eq!(widget.plural, "widgets");
        assert!(widget.namespaced);
        assert_eq!(widget.verbs, ["get", "list", "watch"]);

        let node = resolve(&mgr, &id, &core("Node")).await.unwrap();
        assert_eq!(node.plural, "nodes");
        assert!(!node.namespaced);

        let err = resolve(
            &mgr,
            &id,
            &KindRef {
                group: "example.com".into(),
                version: "v1".into(),
                kind: "Gadget".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
