//! The Services that select a target's pods (for ingress-nginx, whose metrics name the backend Service): the pod's
//! labels (a workload's pod template labels) against every Service selector of the namespace, as the endpoints
//! controller matches them. One GET and one list, each under `STEP_TIMEOUT`; at most [`MAX_SELECTING_SERVICES`] names,
//! each a DNS-1123 label.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, PodTemplateSpec, Service};
use kube::Api;
use kube::api::ListParams;

use super::{MAX_SELECTING_SERVICES, RequestTarget};
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::metrics::history::is_dns_label;
use crate::resources::STEP_TIMEOUT;

async fn bounded<T>(future: impl Future<Output = Result<T, kube::Error>>) -> CoreResult<T> {
    tokio::time::timeout(STEP_TIMEOUT, future)
        .await
        .map_err(|_| CoreError::new(ErrorCode::Timeout, "the API server did not answer in time"))?
        .map_err(|e| kube_error(e, None))
}

fn template_labels(template: Option<&PodTemplateSpec>) -> BTreeMap<String, String> {
    template
        .and_then(|t| t.metadata.as_ref())
        .and_then(|m| m.labels.clone())
        .unwrap_or_default()
}

/// The labels the target's pods carry.
async fn pod_labels(
    client: &kube::Client,
    target: &RequestTarget,
) -> CoreResult<BTreeMap<String, String>> {
    match target {
        RequestTarget::Pod { namespace, name } => {
            let pod = bounded(Api::<Pod>::namespaced(client.clone(), namespace).get(name)).await?;
            Ok(pod.metadata.labels.unwrap_or_default())
        }
        RequestTarget::Workload {
            namespace,
            kind,
            name,
        } => Ok(match kind.as_str() {
            "Deployment" => {
                let d = bounded(Api::<Deployment>::namespaced(client.clone(), namespace).get(name))
                    .await?;
                template_labels(d.spec.as_ref().map(|s| &s.template))
            }
            "StatefulSet" => {
                let s =
                    bounded(Api::<StatefulSet>::namespaced(client.clone(), namespace).get(name))
                        .await?;
                template_labels(s.spec.as_ref().map(|s| &s.template))
            }
            _ => {
                let d = bounded(Api::<DaemonSet>::namespaced(client.clone(), namespace).get(name))
                    .await?;
                template_labels(d.spec.as_ref().map(|s| &s.template))
            }
        }),
    }
}

/// A Service selects the pods when its selector is not empty and every pair of it is among the labels.
pub(crate) fn selects(
    selector: &BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> bool {
    !selector.is_empty() && selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

/// The names of the namespace's Services that select the target's pods, sorted, at most [`MAX_SELECTING_SERVICES`].
pub(crate) async fn selecting(
    client: &kube::Client,
    target: &RequestTarget,
) -> CoreResult<Vec<String>> {
    let labels = pod_labels(client, target).await?;
    if labels.is_empty() {
        return Ok(Vec::new());
    }
    let api = Api::<Service>::namespaced(client.clone(), target.namespace());
    let services = bounded(api.list(&ListParams::default())).await?;
    let mut names: Vec<String> = services
        .items
        .into_iter()
        .filter(|s| {
            s.spec
                .as_ref()
                .and_then(|spec| spec.selector.as_ref())
                .is_some_and(|selector| selects(selector, &labels))
        })
        .filter_map(|s| s.metadata.name)
        .filter(|name| is_dns_label(name))
        .collect();
    names.sort();
    names.truncate(MAX_SELECTING_SERVICES);
    Ok(names)
}
