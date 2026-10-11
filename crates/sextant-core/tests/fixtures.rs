//! The test cluster from `scripts/test-cluster.sh up` has what the feature tests rely on.

mod common;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::CronJob;
use k8s_openapi::api::core::v1::{ConfigMap, Secret, Service};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};

#[tokio::test]
async fn demo_namespace_has_the_fixtures() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let ns = common::DEMO_NAMESPACE;

    let nginx = Api::<Deployment>::namespaced(client.clone(), ns)
        .get("nginx")
        .await
        .unwrap();
    assert_eq!(nginx.spec.unwrap().replicas, Some(2));
    Api::<Service>::namespaced(client.clone(), ns)
        .get("nginx")
        .await
        .unwrap();
    Api::<CronJob>::namespaced(client.clone(), ns)
        .get("hello")
        .await
        .unwrap();
    Api::<ConfigMap>::namespaced(client.clone(), ns)
        .get("demo-config")
        .await
        .unwrap();
    Api::<Secret>::namespaced(client.clone(), ns)
        .get("demo-secret")
        .await
        .unwrap();

    let crd = Api::<CustomResourceDefinition>::all(client.clone())
        .get("widgets.demo.sextant.dev")
        .await
        .unwrap();
    let columns = crd.spec.versions[0]
        .additional_printer_columns
        .clone()
        .unwrap_or_default();
    let names: Vec<_> = columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Size", "Replicas", "Age"]);

    let gvk = GroupVersionKind::gvk("demo.sextant.dev", "v1", "Widget");
    let widgets: Api<DynamicObject> =
        Api::namespaced_with(client, ns, &ApiResource::from_gvk(&gvk));
    let widget = widgets.get("demo-widget").await.unwrap();
    assert_eq!(widget.data["spec"]["size"], "large");
}

#[tokio::test]
async fn limited_service_account_cannot_list_secrets() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.limited_client().await;
    let ns = common::DEMO_NAMESPACE;

    // Token authentication works and ordinary reads are allowed …
    Api::<ConfigMap>::namespaced(client.clone(), ns)
        .list(&Default::default())
        .await
        .unwrap();
    // … but Secrets are forbidden.
    let err = Api::<Secret>::namespaced(client, ns)
        .list(&Default::default())
        .await
        .unwrap_err();
    let core = sextant_core::CoreError::from(err);
    assert_eq!(core.code, sextant_core::ErrorCode::Forbidden, "{core}");
}
