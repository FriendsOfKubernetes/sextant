//! The diagnostic tools (ADR-0094): offered as reads with strict arguments, checked by the rules before the window is
//! asked, and their answers filtered again — an agent allowed only in `team-a` gets nothing about `team-b`, whatever
//! the window sends. Without a cluster: the filters with a fake kind lookup; with a fake API server (only `/api`, to
//! connect): the whole call through the MCP handler and a fake window.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use sextant_core::access::{
    AccessAction, AccessPreset, AccessRule, ClusterAccess, KindPattern, KindScope, NamespaceScope,
};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{ClusterId, ClusterSettings};

use super::super::audit::AuditDecision;
use super::super::context::McpEvent;
use super::super::diagnose_answers::{self as answers, ObjectRef, ReadFilter};
use super::super::guard::KindLookup;
use super::super::server::all_tools;
use super::super::tools::to_call_result;
use super::super::window::{DiagnosticAnswer, DiagnosticRequest, DiagnosticTool};
use super::DIAGNOSTIC_TOOLS;
use crate::state::AppState;

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/// Kinds as a cluster serves them: namespaced or not; anything else cannot be looked up.
struct FakeKinds(HashMap<String, bool>);

impl FakeKinds {
    fn new() -> Arc<Self> {
        let namespaced = [
            "Pod",
            "Event",
            "Service",
            "Secret",
            "Deployment",
            "ReplicaSet",
            "HorizontalPodAutoscaler",
            "NetworkPolicy",
            "Role",
            "RoleBinding",
            "ScaledObject",
            "VirtualService",
            "DestinationRule",
            "ServiceEntry",
            "PersistentVolumeClaim",
            "HorizontalPodAutoscaler",
        ];
        let cluster = ["Node", "Namespace", "ClusterRole", "ClusterRoleBinding"];
        let mut map: HashMap<String, bool> =
            namespaced.iter().map(|k| ((*k).to_owned(), true)).collect();
        map.extend(cluster.iter().map(|k| ((*k).to_owned(), false)));
        Arc::new(Self(map))
    }
}

impl KindLookup for FakeKinds {
    fn namespaced<'a>(
        &'a self,
        _cluster: &'a ClusterId,
        kind: &'a KindPattern,
    ) -> BoxFuture<'a, Option<bool>> {
        Box::pin(async move { self.0.get(&kind.kind).copied() })
    }
}

fn rule(namespaces: &[&str], kinds: &[(&str, &str)], actions: &[AccessAction]) -> AccessRule {
    AccessRule {
        namespaces: if namespaces.is_empty() {
            NamespaceScope::All
        } else {
            NamespaceScope::Only {
                namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
            }
        },
        kinds: if kinds.is_empty() {
            KindScope::All
        } else {
            KindScope::Only {
                kinds: kinds
                    .iter()
                    .map(|(g, k)| KindPattern::new(*g, *k))
                    .collect(),
            }
        },
        actions: actions.to_vec(),
        confirm: false,
    }
}

fn custom(rules: Vec<AccessRule>) -> ClusterAccess {
    ClusterAccess {
        preset: AccessPreset::Custom,
        rules,
    }
}

/// Read (and logs) on every kind in `team-a` only.
fn team_a() -> ClusterAccess {
    custom(vec![rule(
        &["team-a"],
        &[],
        &[AccessAction::Read, AccessAction::Logs],
    )])
}

fn filter(access: ClusterAccess) -> ReadFilter {
    ReadFilter::new(access, FakeKinds::new(), ClusterId::from("c"))
}

fn obj(group: &str, kind: &str, namespace: Option<&str>, name: &str) -> Value {
    json!({ "group": group, "kind": kind, "namespace": namespace, "name": name })
}

fn object(group: &str, kind: &str, namespace: Option<&str>, name: &str) -> ObjectRef {
    serde_json::from_value(obj(group, kind, namespace, name)).unwrap()
}

/// The text of every string in `value`, for "nothing about team-b" checks.
fn all_text(value: &Value) -> String {
    value.to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// Without a cluster

#[test]
fn the_diagnostic_tools_are_offered_as_reads_with_strict_arguments() {
    let tools = all_tools();
    for name in DIAGNOSTIC_TOOLS {
        let tool = tools
            .find(name)
            .unwrap_or_else(|| panic!("{name} is missing"))
            .tool
            .clone();
        let hints = tool.annotations.clone().unwrap();
        assert_eq!(hints.read_only_hint, Some(true), "{name}");
        assert_eq!(hints.destructive_hint, Some(false), "{name}");
        // `deny_unknown_fields`: the schema says so, and so does every nested argument object.
        let schema = serde_json::to_value(&*tool.input_schema).unwrap();
        assert_eq!(
            schema["additionalProperties"],
            json!(false),
            "{name}: {schema}"
        );
        for (key, def) in schema
            .get("$defs")
            .or_else(|| schema.get("definitions"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if def["type"] == "object" {
                assert_eq!(def["additionalProperties"], json!(false), "{name}.{key}");
            }
        }
    }
}

#[test]
fn problem_categories_are_the_windows() {
    let model = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/problems/model.ts"),
    )
    .unwrap();
    let list = |start: &str| -> Vec<String> {
        let from = model
            .find(start)
            .unwrap_or_else(|| panic!("{start} not found"))
            + start.len();
        let body = &model[from..from + model[from..].find(']').unwrap()];
        body.split(',')
            .map(|s| s.trim().trim_matches('"').to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    };
    assert_eq!(
        list("export const PROBLEM_CATEGORIES = ["),
        answers::PROBLEM_CATEGORIES
    );
    assert_eq!(
        list("export const OPT_IN_CATEGORIES: readonly ProblemCategory[] = ["),
        answers::OPT_IN_CATEGORIES
    );
}

#[tokio::test]
async fn problems_keep_the_agents_namespaces_and_the_categories_that_are_on() {
    let problem = |category: &str, kind: &str, ns: Option<&str>, name: &str| {
        json!({
            "category": category, "reason": "CrashLoopBackOff", "message": "back-off",
            "object": obj("", kind, ns, name), "source": { "group": "", "kind": kind },
            "needsAttention": true,
        })
    };
    let answer: answers::ProblemsAnswer = serde_json::from_value(json!({
        "problems": [
            problem("pods", "Pod", Some("team-a"), "web-1"),
            problem("pods", "Pod", Some("team-b"), "secret-project"),
            problem("nodes", "Node", None, "node-1"),
            problem("security", "Pod", Some("team-a"), "privileged"),
            problem("credentials", "Pod", Some("team-a"), "kubeconfig"),
            problem("made-up", "Pod", Some("team-a"), "x"),
            // A Warning event about a team-a object, found in the Event list.
            { "category": "events", "reason": "BackOff", "object": obj("", "Pod", Some("team-a"), "web-2"),
              "source": { "group": "", "kind": "Event" }, "extra": "dropped" },
        ],
        "categories": ["pods", "nodes", "security", "credentials"],
        "loading": ["security"],
    }))
    .unwrap();
    let mut f = filter(team_a());
    let kept = answers::problems(answer.clone(), &mut f, &[], None, 100).await;
    let names: Vec<&str> = kept
        .problems
        .iter()
        .map(|p| p.object.name.as_str())
        .collect();
    assert_eq!(names, ["web-1", "web-2"]);
    assert_eq!(kept.categories, ["pods", "nodes"]);
    assert!(kept.loading.is_empty());
    assert!(!all_text(&answers::to_value(&kept)).contains("team-b"));

    // Security turned on by the user; credentials never; a namespace narrows; the limit truncates.
    let on = vec!["security".to_owned(), "credentials".to_owned()];
    let kept = answers::problems(answer.clone(), &mut f, &on, Some("team-a"), 100).await;
    let names: Vec<&str> = kept
        .problems
        .iter()
        .map(|p| p.object.name.as_str())
        .collect();
    assert_eq!(names, ["web-1", "privileged", "web-2"]);
    let cut = answers::problems(answer.clone(), &mut f, &on, None, 1).await;
    assert_eq!((cut.problems.len(), cut.truncated), (1, true));

    // Read on everything: nodes too, team-b too.
    let mut all = filter(custom(vec![rule(&[], &[], &[AccessAction::Read])]));
    let kept = answers::problems(answer, &mut all, &[], None, 100).await;
    assert_eq!(kept.problems.len(), 4);
}

#[tokio::test]
async fn a_diagnosis_names_only_what_the_agent_may_read() {
    let answer: answers::DiagnoseAnswer = serde_json::from_value(json!({
        "status": "broken",
        "summary": "No pod is ready",
        "chain": {
            "object": obj("", "Service", Some("team-b"), "not-the-checked-one"),
            "findings": [
                { "id": "service.selector", "status": "ok", "text": "selects 2 pods",
                  "objects": [obj("", "Pod", Some("team-a"), "web-1"), obj("", "Pod", Some("team-b"), "other")] },
                { "id": "service.ready", "status": "weird", "text": "?" },
            ],
            "chains": [
                { "title": "to team-b", "object": obj("", "Service", Some("team-b"), "db"), "findings": [] },
                { "title": "to team-a", "object": obj("", "Service", Some("team-a"), "cache"), "findings": [] },
            ],
        },
    }))
    .unwrap();
    let checked = object("", "Service", Some("team-a"), "web");
    let out = answers::diagnosis(answer, &mut filter(team_a()), checked.clone(), true).await;
    assert_eq!(out.chain.object, Some(checked));
    assert_eq!(out.chain.findings[0].objects.len(), 1);
    assert_eq!(out.chain.findings[1].status, "unknown");
    assert_eq!(out.chain.chains.len(), 1);
    assert_eq!(out.chain.chains[0].title.as_deref(), Some("to team-a"));
    assert!(!all_text(&answers::to_value(&out)).contains("team-b"));
}

#[tokio::test]
async fn a_problem_resting_on_another_namespace_says_nothing_about_it() {
    // Mesh findings are judged across objects: a team-a VirtualService whose subset lives in a team-b
    // DestinationRule, a host judged unknown against every namespace's ServiceEntries, a conflict with a team-b
    // VirtualService. The window sends what each rests on (`refs`); a team-a agent gets none of them.
    let mesh = |reason: &str, refs: Value| {
        json!({
            "category": "mesh", "reason": reason, "message": "a subset is missing",
            "object": obj("networking.istio.io", "VirtualService", Some("team-a"), "reviews"),
            "source": { "group": "networking.istio.io", "kind": "VirtualService" },
            "refs": refs,
        })
    };
    let dr = |ns: Option<&str>, name: Option<&str>| json!({ "group": "networking.istio.io", "kind": "DestinationRule", "namespace": ns, "name": name });
    let answer: answers::ProblemsAnswer = serde_json::from_value(json!({
        "problems": [
            mesh("MissingSubset", json!([dr(Some("team-a"), None), dr(Some("team-b"), None), dr(Some("team-b"), Some("reviews"))])),
            mesh("UnknownHost", json!([{ "group": "networking.istio.io", "kind": "ServiceEntry" }])),
            mesh("ConflictingVirtualService", json!([{ "group": "networking.istio.io", "kind": "VirtualService" }])),
            mesh("MissingDestinationRule", json!([dr(Some("team-a"), None)])),
            // Best practices judged against the Nodes (cluster-scoped).
            { "category": "practices", "reason": "ReplicasOnOneNode", "object": obj("apps", "Deployment", Some("team-a"), "web"),
              "source": { "group": "apps", "kind": "Deployment" },
              "refs": [{ "group": "", "kind": "Pod", "namespace": "team-a" }, { "group": "", "kind": "Node" }] },
        ],
        "categories": ["mesh", "practices"],
        "notChecked": ["disk", "made-up"],
    }))
    .unwrap();
    let on = vec!["practices".to_owned(), "disk".to_owned()];
    let kept = answers::problems(answer.clone(), &mut filter(team_a()), &on, None, 100).await;
    let reasons: Vec<&str> = kept.problems.iter().map(|p| p.reason.as_str()).collect();
    assert_eq!(reasons, ["MissingDestinationRule"]);
    assert_eq!(kept.not_checked, ["disk"]);
    // What a finding rests on is checked, never shown.
    let text = all_text(&answers::to_value(&kept));
    assert!(!text.contains("team-b") && !text.contains("refs"), "{text}");

    let mut all = filter(custom(vec![rule(&[], &[], &[AccessAction::Read])]));
    let kept = answers::problems(answer, &mut all, &on, None, 100).await;
    assert_eq!(kept.problems.len(), 5);
}

#[tokio::test]
async fn a_diagnosis_reports_the_status_and_summary_of_what_is_left() {
    // The only broken step is in a branch about team-b: once it is dropped, neither the status nor the summary may
    // still say "broken" (that alone would tell about team-b).
    let answer: answers::DiagnoseAnswer = serde_json::from_value(json!({
        "status": "broken",
        "summary": "Service team-b/db has no ready pod",
        "chain": {
            "findings": [{ "id": "service.selector", "status": "ok", "text": "selects 2 pods" },
                         { "id": "service.ports", "status": "warn", "text": "a port has no name" }],
            "chains": [
                { "title": "to team-b", "object": obj("", "Service", Some("team-b"), "db"),
                  "findings": [{ "id": "service.ready", "status": "broken", "text": "Service team-b/db has no ready pod" }] },
                { "title": "to team-a", "object": obj("", "Service", Some("team-a"), "cache"),
                  "findings": [{ "id": "service.ready", "status": "unknown", "text": "cannot tell" }] },
            ],
        },
    }))
    .unwrap();
    let checked = object("", "Service", Some("team-a"), "web");
    let out =
        answers::diagnosis(answer.clone(), &mut filter(team_a()), checked.clone(), true).await;
    assert_eq!(out.status, "warn");
    assert_eq!(out.summary, None);
    assert!(!all_text(&answers::to_value(&out)).contains("team-b"));
    let mut all = filter(custom(vec![rule(&[], &[], &[AccessAction::Read])]));
    let out = answers::diagnosis(answer, &mut all, checked, true).await;
    assert_eq!(out.status, "broken");
    assert_eq!(
        out.summary.as_deref(),
        Some("Service team-b/db has no ready pod")
    );
}

#[tokio::test]
async fn a_tls_step_without_secret_values_is_not_checked() {
    let answer: answers::DiagnoseAnswer = serde_json::from_value(json!({
        "status": "broken",
        "summary": "The certificate in Secret web-tls does not cover shop.example.com",
        "chain": { "findings": [
            { "id": "ingress.class", "status": "ok", "text": "class nginx" },
            { "id": "ingress.tls.0", "status": "broken",
              "text": "The certificate in Secret web-tls does not cover shop.example.com. It covers: internal.corp.",
              "notes": ["only a common name"], "objects": [obj("", "Secret", Some("team-a"), "web-tls")] },
        ] },
    }))
    .unwrap();
    let checked = object("networking.k8s.io", "Ingress", Some("team-a"), "web");
    let out = answers::diagnosis(answer, &mut filter(team_a()), checked, false).await;
    let tls = &out.chain.findings[1];
    assert_eq!(tls.status, "unknown");
    assert_eq!(tls.text, answers::CERTIFICATE_NOT_CHECKED);
    assert!(tls.notes.is_empty());
    assert_eq!(out.status, "unknown");
    assert_eq!(out.summary, None);
    assert!(!all_text(&answers::to_value(&out)).contains("internal.corp"));

    // Read on Secrets is not enough: the names and dates come from tls.crt, a Secret value.
    let secrets =
        |actions: &[AccessAction]| custom(vec![rule(&["team-a"], &[("", "Secret")], actions)]);
    assert!(!super::certificates_allowed(&team_a(), "team-a"));
    assert!(!super::certificates_allowed(
        &secrets(&[AccessAction::Read]),
        "team-a"
    ));
    assert!(super::certificates_allowed(
        &secrets(&[AccessAction::Read, AccessAction::SecretValues]),
        "team-a"
    ));
    assert!(!super::certificates_allowed(
        &secrets(&[AccessAction::Read, AccessAction::SecretValues]),
        "team-b"
    ));
}

#[tokio::test]
async fn a_connectivity_verdict_resting_on_a_hidden_policy_is_unknown() {
    let side = |ns: &str| {
        json!({
            "direction": "ingress", "verdict": "denied", "why": "selected by policies none of whose rules match",
            "deniedBy": [{ "policy": obj("networking.k8s.io", "NetworkPolicy", Some(ns), "deny-all"), "text": "rule 1" }],
            "policies": [{ "policy": obj("networking.k8s.io", "NetworkPolicy", Some(ns), "deny-all"), "rules": [] }],
        })
    };
    let answer = |ns: &str| -> answers::ConnectivityAnswer {
        serde_json::from_value(json!({
            "verdict": "denied", "summary": "Denied",
            "ingress": side(ns),
            "backends": [{ "pod": obj("", "Pod", Some("team-a"), "db-0"), "port": 5432, "verdict": "denied" },
                         { "pod": obj("", "Pod", Some("team-b"), "db-1"), "port": 5432, "verdict": "denied" }],
        }))
        .unwrap()
    };
    let readable = answers::connectivity(answer("team-a"), &mut filter(team_a())).await;
    assert_eq!(readable.verdict, "denied");
    assert_eq!(readable.backends.len(), 1);
    let hidden = answers::connectivity(answer("team-b"), &mut filter(team_a())).await;
    assert_eq!(hidden.verdict, "unknown");
    let ingress = hidden.ingress.unwrap();
    assert_eq!(ingress.verdict, "unknown");
    assert!(ingress.denied_by.is_empty() && ingress.policies.is_empty());
    assert_eq!(ingress.unknown, [answers::HIDDEN_POLICY]);
}

#[tokio::test]
async fn permissions_are_labelled_computed_and_keep_only_readable_bindings() {
    let rb = |ns: &str| json!({ "kind": "RoleBinding", "name": "ci", "namespace": ns });
    let rule = json!({ "verbs": ["get"], "apiGroups": [""], "resources": ["pods"] });
    let answer: answers::PermissionsAnswer = serde_json::from_value(json!({
        "computed": "from the window, replaced",
        "grants": [
            { "rule": rule, "role": { "kind": "Role", "name": "read", "namespace": "team-a" }, "binding": rb("team-a"), "scope": "team-a" },
            { "rule": rule, "role": { "kind": "Role", "name": "read", "namespace": "team-b" }, "binding": rb("team-b"), "scope": "team-b" },
            { "rule": rule, "role": { "kind": "ClusterRole", "name": "view" }, "binding": { "kind": "ClusterRoleBinding", "name": "all" } },
            { "rule": rule, "role": { "kind": "ClusterRole", "name": "view" }, "binding": { "kind": "Mystery", "name": "x" } },
        ],
        "missingRoles": [{ "binding": rb("team-b"), "role": { "kind": "Role", "name": "gone", "namespace": "team-b" } }],
    }))
    .unwrap();
    // A team-a agent: its namespace's RoleBinding, to a Role there; nothing cluster-wide (ClusterRoles need "all
    // namespaces"), nothing of team-b.
    let out = answers::permissions(answer.clone(), &mut filter(team_a()), None).await;
    assert_eq!(out.computed, answers::COMPUTED);
    assert_eq!(out.grants.len(), 1);
    assert_eq!(out.grants[0].scope.as_deref(), Some("team-a"));
    assert!(out.missing_roles.is_empty());
    assert!(!all_text(&answers::to_value(&out)).contains("team-b"));
    // Everything readable, narrowed to team-b: its grant and the cluster-wide one.
    let all = custom(vec![rule_all_read()]);
    let out = answers::permissions(answer, &mut filter(all), Some("team-b")).await;
    assert_eq!(out.grants.len(), 2);
    assert_eq!(out.missing_roles.len(), 1);
}

fn rule_all_read() -> AccessRule {
    rule(&[], &[], &[AccessAction::Read])
}

#[tokio::test]
async fn recent_changes_keep_readable_objects_and_never_a_secrets_values() {
    let change = |kind: &str, ns: &str, name: &str| {
        json!({
            "at": "2026-10-20T10:00:00Z", "action": "updated", "object": obj("", kind, Some(ns), name),
            "changes": [{ "path": "data.password", "op": "changed", "before": "old", "after": "new" }],
            "who": ["kubectl apply"],
            "soonAfter": [
                { "type": "problem", "reason": "CrashLoopBackOff", "object": obj("", "Pod", Some(ns), "web-1"), "afterSeconds": 60, "via": "dependent" },
                { "type": "problem", "reason": "Failed", "object": obj("", "Pod", Some("team-b"), "x"), "afterSeconds": 61, "via": "dependent" },
            ],
        })
    };
    let answer: answers::ChangesAnswer = serde_json::from_value(json!({
        "changes": [change("Secret", "team-a", "db"), change("ConfigMap", "team-b", "cfg"), change("Service", "team-a", "web")],
    }))
    .unwrap();
    let out = answers::changes(answer, &mut filter(team_a()), None, 10).await;
    assert_eq!(out.changes.len(), 2);
    let secret = &out.changes[0];
    assert_eq!(secret.changes[0].path, "data.password");
    assert_eq!(
        (
            secret.changes[0].before.as_deref(),
            secret.changes[0].after.as_deref()
        ),
        (None, None)
    );
    assert_eq!(out.changes[1].changes[0].after.as_deref(), Some("new"));
    assert!(out.changes.iter().all(|c| c.soon_after.len() == 1));
    let text = all_text(&answers::to_value(&out));
    assert!(!text.contains("team-b"), "{text}");
    let secret = all_text(&answers::to_value(&out.changes[0]));
    assert!(
        !secret.contains("old") && !secret.contains("new"),
        "{secret}"
    );
}

#[tokio::test]
async fn autoscaling_keeps_the_asked_namespace() {
    let hpa = |ns: &str| {
        json!({ "object": obj("autoscaling", "HorizontalPodAutoscaler", Some(ns), "web"),
                "target": obj("apps", "Deployment", Some(ns), "web"),
                "min": 1, "max": 5, "current": 2, "verdict": "steady" })
    };
    let answer: answers::AutoscalingAnswer = serde_json::from_value(json!({
        "hpas": [hpa("team-a"), hpa("team-b")],
        "pendingPods": [{ "object": obj("", "Pod", Some("team-b"), "p"), "reasons": [] }],
    }))
    .unwrap();
    let out = answers::autoscaling(answer, &mut filter(team_a()), "team-a").await;
    assert_eq!(out.hpas.len(), 1);
    assert!(out.hpas[0].target.is_some());
    assert!(out.pending_pods.is_empty());
}

#[test]
fn every_text_is_clipped_and_every_list_capped() {
    let long = "é".repeat(5000);
    let value = answers::finish(json!({ "a": [long.clone()], "b": (0..2000).collect::<Vec<_>>() }));
    assert!(value["a"][0].as_str().unwrap().chars().count() < 300);
    assert_eq!(value["b"].as_array().unwrap().len(), answers::MAX_ITEMS);
}

#[test]
fn a_malformed_answer_is_an_error_not_a_partial_one() {
    let error =
        answers::parse::<answers::ProblemsAnswer>(json!({ "problems": "all fine" })).unwrap_err();
    assert!(error.message.contains("wrong shape"), "{}", error.message);
}

// ---------------------------------------------------------------------------------------------------------------
// Through the MCP handler, with a fake API server and a fake window

/// A Kubernetes API server that only lets Sextant connect (`/api`); everything else is 404.
async fn fake_cluster() -> String {
    use axum::http::{StatusCode, Uri, header};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new().fallback(|uri: Uri| async move {
        let (status, body) = match uri.path() {
            "/api" => (
                StatusCode::OK,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            _ => (
                StatusCode::NOT_FOUND,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#,
            ),
        };
        (status, [(header::CONTENT_TYPE, "application/json")], body)
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    url
}

/// What the fake window does with a diagnostic request.
#[derive(Clone)]
struct Window {
    asked: Arc<Mutex<Vec<DiagnosticRequest>>>,
    confirms: Arc<Mutex<usize>>,
    /// The answer per tool; `None`: there is no window.
    answers: Arc<Mutex<Option<HashMap<&'static str, Value>>>>,
}

impl Window {
    fn asked(&self) -> Vec<DiagnosticRequest> {
        self.asked.lock().unwrap().clone()
    }
}

fn tool_key(tool: DiagnosticTool) -> &'static str {
    match tool {
        DiagnosticTool::Problems => "problems",
        DiagnosticTool::DiagnoseService => "diagnose",
        DiagnosticTool::Connectivity => "connectivity",
        DiagnosticTool::Permissions => "permissions",
        DiagnosticTool::RecentChanges => "changes",
        DiagnosticTool::Autoscaling => "autoscaling",
    }
}

/// State whose only cluster (`ctx-a`) is served by `server`, with a window answering from `answers`.
fn state_at(
    dir: &Path,
    server: &str,
    answers: HashMap<&'static str, Value>,
) -> (AppState, Window, ClusterId) {
    let state = AppState::new(&dir.join("config"), &dir.join("data"));
    let path = dir.join("kubeconfig");
    std::fs::write(
        &path,
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: a\n  cluster:\n    server: {server}\n\
             contexts:\n- name: ctx-a\n  context:\n    cluster: a\n    user: a\n\
             users:\n- name: a\n  user: {{}}\ncurrent-context: ctx-a\n"
        ),
    )
    .unwrap();
    state.registry.write().unwrap().set_env(KubeconfigEnv {
        kubeconfig: Some(path.into_os_string()),
        home: Some(dir.join("home")),
    });
    let window = Window {
        asked: Arc::new(Mutex::new(Vec::new())),
        confirms: Arc::new(Mutex::new(0)),
        answers: Arc::new(Mutex::new(Some(answers))),
    };
    let (seen, weak) = (window.clone(), Arc::downgrade(state.mcp.context()));
    state.mcp.set_emitter(Arc::new(move |event| match event {
        McpEvent::Diagnostic(request) => {
            let Some(answers) = seen.answers.lock().unwrap().clone() else {
                return false;
            };
            seen.asked.lock().unwrap().push(request.clone());
            let result = answers
                .get(tool_key(request.tool))
                .cloned()
                .unwrap_or(json!({}));
            if let Some(ctx) = weak.upgrade() {
                ctx.window
                    .answer(&request.id, DiagnosticAnswer::Ok { result })
                    .unwrap();
            }
            true
        }
        McpEvent::Confirm(_) => {
            *seen.confirms.lock().unwrap() += 1;
            false
        }
        _ => true,
    }));
    let cluster = state.registry.read().unwrap().clusters().unwrap()[0]
        .id
        .clone();
    (state, window, cluster)
}

fn set_access(state: &AppState, cluster: &ClusterId, access: ClusterAccess) {
    state
        .settings
        .update(|s| {
            s.clusters.insert(
                cluster.0.clone(),
                ClusterSettings {
                    agent_access: access,
                    ..ClusterSettings::default()
                },
            );
        })
        .unwrap();
}

async fn call(state: &AppState, name: &str, args: Value) -> Result<Value, String> {
    let Value::Object(args) = args else {
        unreachable!()
    };
    let result = state.mcp.handler().call("test", name, args).await;
    let rendered = to_call_result(&result);
    let text = rendered.content[0]
        .as_text()
        .map(|t| t.text.clone())
        .unwrap_or_default();
    if rendered.is_error == Some(true) {
        Err(text)
    } else {
        Ok(serde_json::from_str(&text).unwrap())
    }
}

/// One valid call of every diagnostic tool, about `ns`.
fn calls(cluster: &ClusterId, ns: &str) -> Vec<(&'static str, Value)> {
    let c = cluster.0.clone();
    vec![
        ("get_problems", json!({ "cluster": c, "namespace": ns })),
        (
            "diagnose_service",
            json!({ "cluster": c, "kind": "Service", "namespace": ns, "name": "web" }),
        ),
        (
            "check_connectivity",
            json!({ "cluster": c, "from": { "namespace": ns, "pod": "a" },
            "to": { "namespace": ns, "service": "web" } }),
        ),
        (
            "get_permissions",
            json!({ "cluster": c, "namespace": ns,
            "subject": { "kind": "ServiceAccount", "name": "ci", "namespace": ns } }),
        ),
        (
            "get_recent_changes",
            json!({ "cluster": c, "namespace": ns }),
        ),
        (
            "get_autoscaling_status",
            json!({ "cluster": c, "namespace": ns }),
        ),
    ]
}

fn window_answers() -> HashMap<&'static str, Value> {
    let problem = |ns: &str, name: &str| {
        json!({ "category": "pods", "reason": "CrashLoopBackOff", "object": obj("", "Pod", Some(ns), name),
                "source": { "group": "", "kind": "Pod" } })
    };
    HashMap::from([
        (
            "problems",
            json!({ "problems": [problem("team-a", "web-1"), problem("team-b", "hidden-1")],
                             "categories": ["pods"] }),
        ),
        (
            "diagnose",
            json!({ "status": "ok", "chain": { "findings": [] } }),
        ),
        (
            "connectivity",
            json!({ "verdict": "allowed", "summary": "Allowed" }),
        ),
        ("permissions", json!({ "grants": [] })),
        ("changes", json!({ "changes": [] })),
        ("autoscaling", json!({})),
    ])
}

#[tokio::test]
async fn a_team_a_agent_gets_nothing_about_team_b() {
    let dir = tempfile::tempdir().unwrap();
    let (state, window, cluster) = state_at(dir.path(), &fake_cluster().await, window_answers());
    set_access(&state, &cluster, team_a());

    for (tool, args) in calls(&cluster, "team-b") {
        let error = call(&state, tool, args).await.unwrap_err();
        assert!(error.contains("denied"), "{tool}: {error}");
    }
    assert!(
        window.asked().is_empty(),
        "the window was asked about team-b"
    );

    for (tool, args) in calls(&cluster, "team-a") {
        let answer = call(&state, tool, args)
            .await
            .unwrap_or_else(|e| panic!("{tool}: {e}"));
        // Every answer says that the cluster's words are data, not instructions.
        assert_eq!(answer["dataNotice"], json!(super::DATA_NOTICE), "{tool}");
    }
    let asked = window.asked();
    assert_eq!(asked.len(), DIAGNOSTIC_TOOLS.len());
    for request in &asked {
        assert_eq!(request.cluster_id, cluster);
        assert_eq!(request.reads.len(), 1);
        assert_eq!(
            request.reads[0].namespaces,
            NamespaceScope::Only {
                namespaces: vec!["team-a".to_owned()]
            }
        );
        assert!(request.args.get("cluster").is_none(), "{}", request.args);
    }
    // Read on everything in team-a, but not "Secret values": the window is told not to read certificates.
    let diagnose = asked
        .iter()
        .find(|r| r.tool == DiagnosticTool::DiagnoseService)
        .unwrap();
    assert_eq!(diagnose.args["checkCertificates"], json!(false));

    // Over every namespace it may read: the window's team-b problem is dropped.
    let all = call(&state, "get_problems", json!({ "cluster": cluster.0 }))
        .await
        .unwrap();
    let text = all.to_string();
    assert!(text.contains("web-1") && !text.contains("team-b"), "{text}");

    // Journaled, summary only; reads are never asked about.
    let journal = state.mcp.context().audit.list(None);
    assert_eq!(journal.len(), 2 * DIAGNOSTIC_TOOLS.len() + 1);
    let denied = journal
        .iter()
        .filter(|e| e.decision == AuditDecision::Denied)
        .count();
    assert_eq!(denied, DIAGNOSTIC_TOOLS.len());
    assert!(journal.iter().all(|e| !e.target.contains("web-1")));
    assert_eq!(*window.confirms.lock().unwrap(), 0);
    state.close_all();
}

#[tokio::test]
async fn without_read_nothing_is_computed_whatever_else_is_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let (state, window, cluster) = state_at(dir.path(), &fake_cluster().await, window_answers());
    let everything_but_read: Vec<AccessAction> = AccessAction::ALL
        .into_iter()
        .filter(|a| *a != AccessAction::Read)
        .collect();
    let mut asking = rule(&[], &[], &everything_but_read);
    asking.confirm = true;
    set_access(&state, &cluster, custom(vec![asking]));
    for (tool, args) in calls(&cluster, "team-a") {
        let error = call(&state, tool, args).await.unwrap_err();
        assert!(error.contains("denied read"), "{tool}: {error}");
    }
    assert!(window.asked().is_empty());
    assert_eq!(*window.confirms.lock().unwrap(), 0);
    state.close_all();
}

#[tokio::test]
async fn unknown_fields_are_refused_before_anything_and_without_a_window_the_tools_say_so() {
    let dir = tempfile::tempdir().unwrap();
    let (state, window, cluster) = state_at(dir.path(), &fake_cluster().await, window_answers());
    set_access(&state, &cluster, custom(vec![rule_all_read()]));
    for (tool, mut args) in calls(&cluster, "team-a") {
        args["dryRun"] = json!(false);
        let error = call(&state, tool, args).await.unwrap_err();
        assert!(error.contains("invalid arguments"), "{tool}: {error}");
    }
    assert!(window.asked().is_empty());
    let journal = state.mcp.context().audit.list(None);
    assert!(
        journal
            .iter()
            .all(|e| e.decision == AuditDecision::NotChecked)
    );

    *window.answers.lock().unwrap() = None;
    for (tool, args) in calls(&cluster, "team-a") {
        let error = call(&state, tool, args).await.unwrap_err();
        assert_eq!(error, super::super::window::NO_WINDOW, "{tool}");
    }
    assert_eq!(state.mcp.context().window.pending(), 0);
    state.close_all();
}

#[tokio::test]
async fn opt_in_problem_categories_are_computed_only_while_the_user_has_them_on() {
    let dir = tempfile::tempdir().unwrap();
    let (state, window, cluster) = state_at(dir.path(), &fake_cluster().await, window_answers());
    set_access(&state, &cluster, custom(vec![rule_all_read()]));
    let ask = json!({ "cluster": cluster.0, "categories": ["security"] });
    let off = call(&state, "get_problems", ask.clone()).await.unwrap();
    assert_eq!(off["off"], json!(["security"]));
    assert_eq!(off["problems"], json!([]));
    assert!(window.asked().is_empty());
    let credentials = json!({ "cluster": cluster.0, "categories": ["credentials"] });
    assert!(
        call(&state, "get_problems", credentials)
            .await
            .unwrap_err()
            .contains("unknown problem categories")
    );

    state
        .settings
        .update(|s| s.notifications.enabled_categories = vec!["security".to_owned()])
        .unwrap();
    call(&state, "get_problems", ask).await.unwrap();
    assert_eq!(window.asked()[0].args["categories"], json!(["security"]));
    // By default every category that is on, never credentials.
    call(&state, "get_problems", json!({ "cluster": cluster.0 }))
        .await
        .unwrap();
    let categories = window.asked()[1].args["categories"].clone();
    assert!(categories.as_array().unwrap().contains(&json!("security")));
    assert!(
        !categories
            .as_array()
            .unwrap()
            .contains(&json!("credentials"))
    );
    assert!(!categories.as_array().unwrap().contains(&json!("practices")));
    state.close_all();
}

/// Traefik's broken references (#232) are a window view: agents get none of them, even when the category is on.
#[test]
fn traefik_problems_are_never_given_to_agents() {
    assert!(answers::PROBLEM_CATEGORIES.contains(&"traefik"));
    assert!(!answers::category_for_agents(
        "traefik",
        &["traefik".to_owned()]
    ));
}

/// Sealed Secrets problems (#240) are a window view: agents get none of them, even when the opt-in category is on
/// (ADR-0109, amended).
#[test]
fn sealed_secrets_problems_are_never_given_to_agents() {
    assert!(answers::PROBLEM_CATEGORIES.contains(&"sealedSecrets"));
    assert!(answers::OPT_IN_CATEGORIES.contains(&"sealedSecrets"));
    assert!(!answers::category_for_agents(
        "sealedSecrets",
        &["sealedSecrets".to_owned()]
    ));
}

/// Reflector mirror problems (#241) are a window view: agents get none of them, even when the category is on.
#[test]
fn reflector_problems_are_never_given_to_agents() {
    assert!(answers::PROBLEM_CATEGORIES.contains(&"reflector"));
    assert!(answers::OPT_IN_CATEGORIES.contains(&"reflector"));
    assert!(!answers::category_for_agents(
        "reflector",
        &["reflector".to_owned()]
    ));
}

/// Vertical Pod Autoscaler problems (#242) are a window view: agents get none of them, though the category is on by
/// default (ADR-0111).
#[test]
fn vpa_problems_are_never_given_to_agents() {
    assert!(answers::PROBLEM_CATEGORIES.contains(&"vpa"));
    assert!(!answers::OPT_IN_CATEGORIES.contains(&"vpa"));
    assert!(!answers::category_for_agents("vpa", &["vpa".to_owned()]));
}

/// Cluster API problems (#243) are a window view: agents get none of them, though the category is on by default
/// (ADR-0113).
#[test]
fn cluster_api_problems_are_never_given_to_agents() {
    assert!(answers::PROBLEM_CATEGORIES.contains(&"clusterApi"));
    assert!(!answers::OPT_IN_CATEGORIES.contains(&"clusterApi"));
    assert!(!answers::category_for_agents(
        "clusterApi",
        &["clusterApi".to_owned()]
    ));
}
