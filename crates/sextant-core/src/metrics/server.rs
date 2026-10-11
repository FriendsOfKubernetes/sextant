//! Current usage from metrics-server (`metrics.k8s.io/v1beta1`).

use std::collections::BTreeMap;

use futures::future::try_join_all;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams};
use serde_json::Value;

use super::quantity::parse_quantity;
use super::{NodeUsage, PodUsage, Usage};
use crate::error::{CoreError, CoreResult, kube_error};

const GROUP: &str = "metrics.k8s.io";
const VERSION: &str = "v1beta1";

fn resource(kind: &str, plural: &str) -> ApiResource {
    ApiResource {
        group: GROUP.to_owned(),
        version: VERSION.to_owned(),
        api_version: format!("{GROUP}/{VERSION}"),
        kind: kind.to_owned(),
        plural: plural.to_owned(),
    }
}

/// Whether the aggregated API is served (and its backend answers): `GET /apis/metrics.k8s.io/v1beta1`.
pub(crate) async fn available(client: &kube::Client) -> bool {
    client
        .list_api_group_resources(&format!("{GROUP}/{VERSION}"))
        .await
        .is_ok()
}

fn usage_of(value: Option<&Value>) -> Usage {
    let field = |name: &str| {
        value
            .and_then(|u| u.get(name))
            .and_then(Value::as_str)
            .and_then(parse_quantity)
            .unwrap_or(0.0)
    };
    Usage {
        cpu_millicores: field("cpu") * 1000.0,
        memory_bytes: field("memory"),
    }
}

fn pod_from(obj: DynamicObject) -> Option<PodUsage> {
    let namespace = obj.metadata.namespace?;
    let name = obj.metadata.name?;
    let mut containers: Vec<(String, Usage)> = obj
        .data
        .get("containers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?.to_owned();
            Some((name, usage_of(c.get("usage"))))
        })
        .collect();
    containers.sort_by(|a, b| a.0.cmp(&b.0));
    let usage = containers
        .iter()
        .fold(Usage::default(), |acc, (_, u)| Usage {
            cpu_millicores: acc.cpu_millicores + u.cpu_millicores,
            memory_bytes: acc.memory_bytes + u.memory_bytes,
        });
    Some(PodUsage {
        namespace,
        name,
        usage,
        containers,
    })
}

/// Pod metrics of the given namespaces (`None` = all).
pub(crate) async fn pod_usage(
    client: &kube::Client,
    namespaces: Option<&[String]>,
) -> CoreResult<Vec<PodUsage>> {
    let ar = resource("PodMetrics", "pods");
    let apis: Vec<Api<DynamicObject>> = match namespaces {
        None => vec![Api::all_with(client.clone(), &ar)],
        Some(list) => list
            .iter()
            .map(|ns| Api::namespaced_with(client.clone(), ns, &ar))
            .collect(),
    };
    let params = ListParams::default();
    let lists = try_join_all(apis.iter().map(|api| api.list(&params)))
        .await
        .map_err(|e| unavailable(kube_error(e, None)))?;
    let mut pods: BTreeMap<(String, String), PodUsage> = BTreeMap::new();
    for pod in lists.into_iter().flat_map(|l| l.items).filter_map(pod_from) {
        pods.insert((pod.namespace.clone(), pod.name.clone()), pod);
    }
    Ok(pods.into_values().collect())
}

pub(crate) async fn node_usage(client: &kube::Client) -> CoreResult<Vec<NodeUsage>> {
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &resource("NodeMetrics", "nodes"));
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| unavailable(kube_error(e, None)))?;
    let mut nodes: Vec<NodeUsage> = list
        .items
        .into_iter()
        .filter_map(|obj| {
            Some(NodeUsage {
                name: obj.metadata.name?,
                usage: usage_of(obj.data.get("usage")),
            })
        })
        .collect();
    nodes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(nodes)
}

fn unavailable(err: CoreError) -> CoreError {
    CoreError::new(err.code, format!("metrics-server: {}", err.message))
}
