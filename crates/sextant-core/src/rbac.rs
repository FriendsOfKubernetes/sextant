//! RBAC questions the API server answers for the current user (#140): "can I …" ([`can_i`], one
//! SelfSubjectAccessReview per question) and "what may I do in this namespace" ([`rules_review`], a
//! SelfSubjectRulesReview). Both are `create` calls of review objects that the server evaluates and discards: nothing
//! in the cluster changes, and every authorizer of the cluster (RBAC, webhook, Node, ABAC, `system:masters`) takes part,
//! so these answers are authoritative for the user, unlike permissions computed from Roles and bindings.

use futures::StreamExt;
use k8s_openapi::api::authentication::v1::SelfSubjectReview;
use k8s_openapi::api::authorization::v1::{
    NonResourceAttributes, ResourceAttributes, SelfSubjectAccessReview,
    SelfSubjectAccessReviewSpec, SelfSubjectRulesReview, SelfSubjectRulesReviewSpec,
};
use kube::Api;
use kube::api::PostParams;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;
use crate::resources::STEP_TIMEOUT;

/// At most this many questions per [`can_i`] call.
pub const MAX_QUERIES: usize = 64;
/// Questions of one [`can_i`] call sent at the same time.
const PARALLEL_QUERIES: usize = 8;

/// One "can I …" question: a verb on a resource (`resource`, optionally its `subresource`, `name` and `namespace`) or
/// on a non-resource URL (`nonResourceUrl`, e.g. `/healthz`); exactly one of `resource` and `nonResourceUrl`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AccessQuery {
    pub verb: String,
    /// API group, `""` for the core group, `"*"` for all.
    pub group: String,
    /// Plural resource name (`pods`), `"*"` for all; empty for a non-resource URL.
    pub resource: String,
    /// `exec`, `log`, `scale`, … ; empty for none.
    pub subresource: String,
    /// One object's name; empty for any (and for `list`, `create`).
    pub name: String,
    /// Empty for all namespaces (or a cluster-scoped resource).
    pub namespace: String,
    /// A non-resource URL (`/healthz`, `/metrics`); empty for a resource question.
    pub non_resource_url: String,
}

/// The API server's answer to one [`AccessQuery`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccessAnswer {
    pub allowed: bool,
    /// An authorizer said no explicitly (not just "no opinion").
    pub denied: bool,
    /// Why, as the authorizer put it (RBAC names the binding and role that allowed it); empty when it said nothing.
    pub reason: String,
    /// The authorizer could not evaluate part of the question (e.g. a webhook failed): the answer may be incomplete.
    pub evaluation_error: String,
}

/// One rule of a [`RulesReview`] on resources (the shape of an RBAC PolicyRule).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewResourceRule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    pub resource_names: Vec<String>,
}

/// One rule of a [`RulesReview`] on non-resource URLs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewNonResourceRule {
    pub verbs: Vec<String>,
    pub non_resource_urls: Vec<String>,
}

/// What the current user may do in a namespace, as the API server lists it (SelfSubjectRulesReview).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RulesReview {
    pub namespace: String,
    pub resource_rules: Vec<ReviewResourceRule>,
    pub non_resource_rules: Vec<ReviewNonResourceRule>,
    /// Some authorizer cannot list rules (webhook, Node): the list may miss permissions the user has.
    pub incomplete: bool,
    pub evaluation_error: String,
}

/// Who the API server says the current user is (SelfSubjectReview, #285): the user name, and for a ServiceAccount
/// token the ServiceAccount's namespace. Groups and extra attributes are not passed on: the window needs only these.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelfSubject {
    pub username: String,
    /// `<ns>` of a `system:serviceaccount:<ns>:<name>` user; `None` for any other user.
    pub service_account_namespace: Option<String>,
}

/// The ServiceAccount namespace of a user name `system:serviceaccount:<namespace>:<name>`, as the API server names
/// ServiceAccount users (`k8s.io/apiserver/pkg/authentication/serviceaccount`, `MakeUsername`); `None` for any other
/// name or a namespace that is not a DNS-1123 label.
fn service_account_namespace(username: &str) -> Option<String> {
    let rest = username.strip_prefix("system:serviceaccount:")?;
    let (namespace, name) = rest.split_once(':')?;
    let label = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = namespace.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(label)
        && bytes.last().is_some_and(label)
        && bytes.iter().all(|b| label(b) || *b == b'-');
    (valid && !name.is_empty() && !name.contains(':')).then(|| namespace.to_owned())
}

/// Who the current user is, by a SelfSubjectReview (`authentication.k8s.io/v1`, served since Kubernetes 1.28); `None`
/// where the API server does not serve it. Like the access reviews it is a `create` the server evaluates and
/// discards.
pub async fn whoami(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<Option<SelfSubject>> {
    let client = mgr.client(cluster)?;
    let answered = with_timeout(STEP_TIMEOUT, "asking who the user is", async {
        Api::<SelfSubjectReview>::all(client)
            .create(&PostParams::default(), &SelfSubjectReview::default())
            .await
            .map_err(CoreError::from)
    })
    .await;
    let answered = match answered {
        Ok(answered) => answered,
        Err(err) if err.code == ErrorCode::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let username = answered
        .status
        .and_then(|s| s.user_info)
        .and_then(|u| u.username)
        .unwrap_or_default();
    Ok(Some(SelfSubject {
        service_account_namespace: service_account_namespace(&username),
        username,
    }))
}

/// Checks a query before anything is sent.
fn check_query(query: &AccessQuery) -> CoreResult<()> {
    let invalid = |what: &str| Err(CoreError::new(ErrorCode::Invalid, what.to_owned()));
    if query.verb.trim().is_empty() {
        return invalid("an access question needs a verb");
    }
    let resource = !query.resource.trim().is_empty();
    let url = !query.non_resource_url.trim().is_empty();
    if resource == url {
        return invalid("an access question needs either a resource or a non-resource URL");
    }
    if url && !query.non_resource_url.starts_with('/') {
        return invalid("a non-resource URL starts with /");
    }
    Ok(())
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// The review object the API server evaluates for `query`.
fn review_of(query: &AccessQuery) -> SelfSubjectAccessReview {
    let spec = if query.non_resource_url.trim().is_empty() {
        SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: non_empty(&query.verb),
                group: Some(query.group.trim().to_owned()),
                resource: non_empty(&query.resource),
                subresource: non_empty(&query.subresource),
                name: non_empty(&query.name),
                namespace: non_empty(&query.namespace),
                ..Default::default()
            }),
            ..Default::default()
        }
    } else {
        SelfSubjectAccessReviewSpec {
            non_resource_attributes: Some(NonResourceAttributes {
                verb: non_empty(&query.verb),
                path: non_empty(&query.non_resource_url),
            }),
            ..Default::default()
        }
    };
    SelfSubjectAccessReview {
        spec,
        ..Default::default()
    }
}

/// Asks the API server each question (SelfSubjectAccessReview), at most [`MAX_QUERIES`]; answers in the same order.
/// A review the user may not create (`forbidden`) fails the whole call.
pub async fn can_i(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    queries: Vec<AccessQuery>,
) -> CoreResult<Vec<AccessAnswer>> {
    if queries.len() > MAX_QUERIES {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("at most {MAX_QUERIES} access questions at once"),
        ));
    }
    for query in &queries {
        check_query(query)?;
    }
    let client = mgr.client(cluster)?;
    let api = Api::<SelfSubjectAccessReview>::all(client);
    // Owned reviews and a named async fn (no borrowing closure in the stream): the future stays `Send` for Tauri.
    let asks = queries
        .iter()
        .map(review_of)
        .map(|review| ask(api.clone(), review));
    let answers: Vec<CoreResult<AccessAnswer>> = futures::stream::iter(asks)
        .buffered(PARALLEL_QUERIES)
        .collect()
        .await;
    answers.into_iter().collect()
}

/// One SelfSubjectAccessReview.
async fn ask(
    api: Api<SelfSubjectAccessReview>,
    review: SelfSubjectAccessReview,
) -> CoreResult<AccessAnswer> {
    let answered = with_timeout(STEP_TIMEOUT, "checking access", async {
        api.create(&PostParams::default(), &review)
            .await
            .map_err(CoreError::from)
    })
    .await?;
    let status = answered.status.unwrap_or_default();
    Ok(AccessAnswer {
        allowed: status.allowed,
        denied: status.denied.unwrap_or(false),
        reason: status.reason.unwrap_or_default(),
        evaluation_error: status.evaluation_error.unwrap_or_default(),
    })
}

/// What the current user may do in `namespace` (SelfSubjectRulesReview). The list includes the rules of
/// ClusterRoleBindings; `incomplete` is set when an authorizer other than RBAC could not list its rules.
pub async fn rules_review(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<RulesReview> {
    let namespace = namespace.trim();
    if namespace.is_empty() || namespace.contains('/') {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a rules review needs one namespace",
        ));
    }
    let client = mgr.client(cluster)?;
    let review = SelfSubjectRulesReview {
        spec: SelfSubjectRulesReviewSpec {
            namespace: Some(namespace.to_owned()),
        },
        ..Default::default()
    };
    let answered = with_timeout(STEP_TIMEOUT, "listing permissions", async {
        Api::<SelfSubjectRulesReview>::all(client)
            .create(&PostParams::default(), &review)
            .await
            .map_err(CoreError::from)
    })
    .await?;
    let status = answered.status.unwrap_or_default();
    Ok(RulesReview {
        namespace: namespace.to_owned(),
        resource_rules: status
            .resource_rules
            .into_iter()
            .map(|r| ReviewResourceRule {
                verbs: r.verbs,
                api_groups: r.api_groups.unwrap_or_default(),
                resources: r.resources.unwrap_or_default(),
                resource_names: r.resource_names.unwrap_or_default(),
            })
            .collect(),
        non_resource_rules: status
            .non_resource_rules
            .into_iter()
            .map(|r| ReviewNonResourceRule {
                verbs: r.verbs,
                non_resource_urls: r.non_resource_urls.unwrap_or_default(),
            })
            .collect(),
        incomplete: status.incomplete,
        evaluation_error: status.evaluation_error.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use serde_json::Value;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const SSAR: &str = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
    const SSRR: &str = "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews";

    fn body(req: &Request) -> Value {
        serde_json::from_slice(&req.body).unwrap()
    }

    /// Allows `get`, denies `delete` with a reason, has no opinion on the rest.
    fn ssar_answer(req: &Request) -> Reply {
        let spec = &body(req)["spec"];
        let verb = spec["resourceAttributes"]["verb"]
            .as_str()
            .or(spec["nonResourceAttributes"]["verb"].as_str())
            .unwrap_or("");
        let status = match verb {
            "get" => r#"{"allowed":true,"reason":"RBAC: allowed by RoleBinding \"view\""}"#,
            "delete" => r#"{"allowed":false,"denied":true,"reason":"policy says no"}"#,
            _ => r#"{"allowed":false,"evaluationError":"webhook unreachable"}"#,
        };
        Reply::json(
            201,
            format!(
                r#"{{"kind":"SelfSubjectAccessReview","apiVersion":"authorization.k8s.io/v1","spec":{},"status":{status}}}"#,
                spec
            ),
        )
    }

    fn query(verb: &str, resource: &str) -> AccessQuery {
        AccessQuery {
            verb: verb.into(),
            resource: resource.into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn can_i_asks_one_review_per_question_and_answers_in_order() {
        let api = FakeApi::start(
            |req: &Request| match (req.method.as_str(), req.path.as_str()) {
                (_, "/api") => Reply::json(200, API_VERSIONS),
                ("POST", SSAR) => ssar_answer(req),
                _ => Reply::not_found(),
            },
        )
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let mut exec = query("create", "pods");
        exec.subresource = "exec".into();
        exec.namespace = "prod".into();
        exec.name = "web".into();
        let healthz = AccessQuery {
            verb: "get".into(),
            non_resource_url: "/healthz".into(),
            ..Default::default()
        };
        let answers = can_i(
            &mgr,
            &id,
            vec![
                query("get", "secrets"),
                query("delete", "pods"),
                exec,
                healthz,
            ],
        )
        .await
        .unwrap();
        assert_eq!(answers.len(), 4);
        assert!(answers[0].allowed && !answers[0].denied);
        assert!(answers[0].reason.contains("RoleBinding"));
        assert!(!answers[1].allowed && answers[1].denied);
        assert_eq!(answers[2].evaluation_error, "webhook unreachable");
        assert!(answers[3].allowed);

        let sent: Vec<Value> = api
            .requests()
            .iter()
            .filter(|r| r.path == SSAR)
            .map(body)
            .collect();
        assert_eq!(sent.len(), 4);
        let exec = sent
            .iter()
            .find(|b| b["spec"]["resourceAttributes"]["subresource"] == "exec")
            .expect("the exec question");
        assert_eq!(exec["spec"]["resourceAttributes"]["namespace"], "prod");
        assert_eq!(exec["spec"]["resourceAttributes"]["name"], "web");
        assert_eq!(exec["spec"]["resourceAttributes"]["group"], "");
        assert!(
            sent.iter()
                .any(|b| b["spec"]["nonResourceAttributes"]["path"] == "/healthz")
        );
        // Only reviews are created: nothing else is written.
        assert!(
            api.requests()
                .iter()
                .all(|r| r.method == "GET" || r.path == SSAR)
        );
    }

    #[tokio::test]
    async fn malformed_or_too_many_questions_are_refused_before_anything_is_sent() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let cases = vec![
            vec![query("", "pods")],
            vec![AccessQuery {
                verb: "get".into(),
                ..Default::default()
            }],
            vec![AccessQuery {
                verb: "get".into(),
                resource: "pods".into(),
                non_resource_url: "/healthz".into(),
                ..Default::default()
            }],
            vec![AccessQuery {
                verb: "get".into(),
                non_resource_url: "healthz".into(),
                ..Default::default()
            }],
            vec![query("get", "pods"); MAX_QUERIES + 1],
        ];
        for queries in cases {
            let err = can_i(&mgr, &id, queries).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid);
        }
        assert_eq!(api.count(SSAR), 0);
    }

    #[tokio::test]
    async fn a_forbidden_review_is_forbidden() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            SSAR | SSRR => Reply::json(
                403,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = can_i(&mgr, &id, vec![query("get", "pods")])
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        let err = rules_review(&mgr, &id, "default").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
    }

    const SSR: &str = "/apis/authentication.k8s.io/v1/selfsubjectreviews";

    #[test]
    fn a_service_account_user_names_its_namespace() {
        assert_eq!(
            service_account_namespace("system:serviceaccount:team-a:ci").as_deref(),
            Some("team-a")
        );
        for other in [
            "alice@example.com",
            "system:serviceaccount:team-a",
            "system:serviceaccount::ci",
            "system:serviceaccount:Team-A:ci",
            "system:serviceaccount:team-a:",
            "system:serviceaccount:team-a:ci:extra",
            "system:serviceaccounts:team-a:ci",
        ] {
            assert_eq!(service_account_namespace(other), None, "{other}");
        }
    }

    #[tokio::test]
    async fn whoami_asks_a_self_subject_review_and_none_where_it_is_not_served() {
        let api = FakeApi::start(|req: &Request| match (req.method.as_str(), req.path.as_str()) {
            (_, "/api") => Reply::json(200, API_VERSIONS),
            ("POST", SSR) => Reply::json(
                201,
                r#"{"kind":"SelfSubjectReview","apiVersion":"authentication.k8s.io/v1","metadata":{},
                   "status":{"userInfo":{"username":"system:serviceaccount:team-a:ci","uid":"u","groups":["system:serviceaccounts"]}}}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let me = whoami(&mgr, &id).await.unwrap().unwrap();
        assert_eq!(me.username, "system:serviceaccount:team-a:ci");
        assert_eq!(me.service_account_namespace.as_deref(), Some("team-a"));
        assert_eq!(api.count(SSR), 1);

        let old = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(old.url()).await;
        assert_eq!(whoami(&mgr, &id).await.unwrap(), None);
    }

    #[tokio::test]
    async fn rules_review_lists_the_rules_of_a_namespace() {
        let api = FakeApi::start(|req: &Request| match (req.method.as_str(), req.path.as_str()) {
            (_, "/api") => Reply::json(200, API_VERSIONS),
            ("POST", SSRR) => {
                assert_eq!(body(req)["spec"]["namespace"], "team-a");
                Reply::json(
                    201,
                    r#"{"kind":"SelfSubjectRulesReview","apiVersion":"authorization.k8s.io/v1",
                       "spec":{"namespace":"team-a"},
                       "status":{"resourceRules":[{"verbs":["get","list"],"apiGroups":[""],"resources":["pods","pods/log"]},
                                                  {"verbs":["*"],"apiGroups":["apps"],"resources":["deployments"],"resourceNames":["web"]}],
                                 "nonResourceRules":[{"verbs":["get"],"nonResourceURLs":["/healthz","/version"]}],
                                 "incomplete":true,"evaluationError":"webhook: no rules"}}"#,
                )
            }
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let review = rules_review(&mgr, &id, "team-a").await.unwrap();
        assert_eq!(review.namespace, "team-a");
        assert_eq!(review.resource_rules.len(), 2);
        assert_eq!(review.resource_rules[0].resources, ["pods", "pods/log"]);
        assert_eq!(review.resource_rules[1].resource_names, ["web"]);
        assert_eq!(
            review.non_resource_rules[0].non_resource_urls,
            ["/healthz", "/version"]
        );
        assert!(review.incomplete);
        assert_eq!(review.evaluation_error, "webhook: no rules");

        for bad in ["", "  ", "a/b"] {
            let err = rules_review(&mgr, &id, bad).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid);
        }
        assert_eq!(api.count(SSRR), 1);
    }
}
