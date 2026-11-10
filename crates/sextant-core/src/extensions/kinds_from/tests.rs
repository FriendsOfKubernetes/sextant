use serde_json::{Value, json};

use super::*;
use crate::access::{AccessAction, AccessRule, KindScope};
use crate::extensions::parse_manifest;
use crate::extensions::permissions::ExtensionPermissions;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const XRD: (&str, &str) = ("apiextensions.crossplane.io", "CompositeResourceDefinition");

fn from() -> Value {
    json!({
        "kind": { "group": XRD.0, "kind": XRD.1 },
        "groupPath": ".spec.group",
        "kindPaths": [".spec.names.kind", ".spec.claimNames.kind"],
        "max": 20
    })
}

fn rule(id: &str) -> Value {
    json!({
        "id": id, "title": format!("Not synced {id}"), "kindsFrom": from(),
        "when": { "type": "condition", "conditionType": "Synced", "status": "False" },
        "graceMinutes": 2,
        "message": "{{.metadata.name}} is not synced"
    })
}

fn manifest_json(problems: Value) -> Value {
    json!({
        "id": "crossplane", "name": "Crossplane", "version": "1.0.0", "description": "", "author": "Me",
        "sextantApi": 4, "entry": "index.html",
        "permissions": { "clusters": { "type": "all" }, "rules": [] },
        "contributes": { "problems": problems }
    })
}

fn parsed(value: Value) -> Result<ExtensionManifest, ManifestError> {
    parse_manifest(value.to_string().as_bytes())
}

fn refusal(value: Value) -> String {
    let err = parsed(value).unwrap_err();
    format!("{}: {}", err.path, err.message)
}

#[test]
fn a_rule_may_take_its_kinds_from_definitions() {
    let m = parsed(manifest_json(json!([rule("a"), rule("b")]))).unwrap();
    let rule = &m.contributes.problems[0];
    assert_eq!(rule.kind, KindPattern::new("", ""));
    let from = rule.kinds_from.clone().unwrap();
    assert_eq!(from.kind, KindPattern::new(XRD.0, XRD.1));
    assert_eq!(from.max, 20);
    // The definition kind is what the user agrees to have read, with the `kindsFrom` itself.
    assert_eq!(problem_kinds(&m), vec![KindPattern::new(XRD.0, XRD.1)]);
    assert_eq!(kinds_from_of(&m), vec![from.clone()]);
    assert!(kinds_from_within(&m, Some(std::slice::from_ref(&from))));
    assert!(!kinds_from_within(&m, None));
    let mut other = from;
    other.max = 5;
    assert!(!kinds_from_within(&m, Some(&[other])));
    // Serialized with an empty kind, so the window's `kind` stays a kind.
    let written = serde_json::to_value(rule).unwrap();
    assert_eq!(written["kind"], json!({ "group": "", "kind": "" }));
    assert_eq!(
        written["kindsFrom"]["kindPaths"][1],
        ".spec.claimNames.kind"
    );
}

#[test]
fn what_a_rule_of_kinds_from_definitions_may_not_be() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut r = rule("a");
        change(&mut r);
        refusal(manifest_json(json!([r])))
    };
    // Neither a kind nor `kindsFrom`, or both.
    assert_eq!(
        with(&|r| {
            r.as_object_mut().unwrap().remove("kindsFrom");
        }),
        "contributes.problems[0]: names its `kind`, or its kinds with `kindsFrom`"
    );
    assert!(
        with(&|r| r["kind"] = json!({ "group": "x.io", "kind": "X" }))
            .contains("goes without `kindsFrom`")
    );
    // Its API version, its definition kind, its paths and its limits.
    let mut old = manifest_json(json!([rule("a")]));
    old["sextantApi"] = json!(3);
    assert!(refusal(old).contains("needs sextantApi 4"));
    assert!(
        with(&|r| r["kindsFrom"]["kind"] = json!({ "group": "", "kind": "Secret" }))
            .contains("never a Secret")
    );
    assert!(
        with(&|r| r["kindsFrom"]["kind"] = json!({ "group": "*", "kind": "*" }))
            .contains("not a pattern")
    );
    assert!(
        with(&|r| r["kindsFrom"]["groupPath"] = json!(".spec.versions[*].name"))
            .contains("keys and indexes only")
    );
    assert!(
        with(&|r| r["kindsFrom"]["kindPaths"] = json!([]))
            .starts_with("contributes.problems[0].kindsFrom.kindPaths")
    );
    assert!(with(&|r| r["kindsFrom"]["kindPaths"] = json!([".a", ".a"])).contains("named twice"));
    assert!(
        with(&|r| r["kindsFrom"]["max"] = json!(21))
            .starts_with("contributes.problems[0].kindsFrom.max")
    );
    assert!(
        with(&|r| r["kindsFrom"]["max"] = json!(0))
            .starts_with("contributes.problems[0].kindsFrom.max")
    );
    // Judged by the object's own fields only.
    assert!(with(&|r| r["toldThroughOwner"] = json!(true)).contains("own fields"));
    assert!(with(&|r| r["newestPer"] = json!("app")).contains("own fields"));
    assert!(
        with(&|r| r["when"] = json!({ "type": "missing", "path": ".spec.x", "kind": { "group": "", "kind": "ConfigMap" } }))
            .contains("own fields")
    );
    assert!(
        with(&|r| r["source"] = json!({ "fieldSelector": "metadata.name=a" }))
            .contains("each kind's own")
    );
    // Every rule's is the same one.
    let mut second = rule("b");
    second["kindsFrom"]["max"] = json!(5);
    assert_eq!(
        refusal(manifest_json(json!([rule("a"), second]))),
        "contributes.problems[0].kindsFrom: is the same in every rule with `kindsFrom` (as contributes.problems[1])"
    );
}

fn xrd(name: &str, group: &str, kind: &str, claim: Option<&str>) -> Value {
    let mut spec = json!({ "group": group, "names": { "kind": kind } });
    if let Some(claim) = claim {
        spec["claimNames"] = json!({ "kind": claim });
    }
    json!({ "apiVersion": "apiextensions.crossplane.io/v1", "kind": XRD.1, "metadata": { "name": name }, "spec": spec })
}

fn the_from() -> KindsFrom {
    serde_json::from_value(from()).unwrap()
}

#[test]
fn the_kinds_definitions_define_are_custom_kinds_of_the_first_by_name() {
    let definitions = vec![
        xrd("b", "example.org", "XDatabase", Some("Database")),
        xrd("a", "example.org", "XBucket", None),
        // Kubernetes' own group, a group without a dot, a kind that is no kind name, an inline-secret kind, a kind
        // the manifest names itself, the same kind again.
        xrd("c", "apps", "Deployment", None),
        xrd("d", "storage.k8s.io", "XStorage", None),
        xrd("e", "example.org", "not-a-kind", Some("Fine")),
        xrd("f", "route.openshift.io", "Route", None),
        xrd("g", "example.org", "XNamed", None),
        xrd("h", "Example.Org", "XUpper", None),
        xrd("i", "example.org", "XBucket", None),
        json!({ "metadata": { "name": "j" }, "spec": { "group": 3 } }),
    ];
    let named = [KindPattern::new("example.org", "XNamed")];
    assert_eq!(
        defined_kinds(&the_from(), &definitions, &named),
        vec![
            KindPattern::new("example.org", "XBucket"),
            KindPattern::new("example.org", "XDatabase"),
            KindPattern::new("example.org", "Database"),
            KindPattern::new("example.org", "Fine"),
        ]
    );
    // Only the first `max` by name are read.
    let mut two = the_from();
    two.max = 1;
    assert_eq!(
        defined_kinds(&two, &definitions, &named),
        vec![KindPattern::new("example.org", "XBucket")]
    );
}

fn reading(kinds: KindScope) -> ExtensionPermissions {
    serde_json::from_value(json!({
        "clusters": { "type": "all" },
        "rules": [serde_json::to_value(AccessRule {
            namespaces: NamespaceScope::All,
            kinds,
            actions: vec![AccessAction::Read],
            confirm: false,
        }).unwrap()]
    }))
    .unwrap()
}

/// A cluster serving XRDs that define two kinds.
fn with_xrds(req: &Request) -> Reply {
    match req.path.as_str() {
        "/api" => Reply::json(200, r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#),
        "/api/v1" => Reply::json(200, r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#),
        "/apis" => Reply::json(
            200,
            r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
            {"name":"apiextensions.crossplane.io","versions":[{"groupVersion":"apiextensions.crossplane.io/v1","version":"v1"}],
             "preferredVersion":{"groupVersion":"apiextensions.crossplane.io/v1","version":"v1"}}]}"#,
        ),
        "/apis/apiextensions.crossplane.io/v1" => Reply::json(
            200,
            r#"{"kind":"APIResourceList","groupVersion":"apiextensions.crossplane.io/v1","resources":[
            {"name":"compositeresourcedefinitions","singularName":"compositeresourcedefinition","namespaced":false,
             "kind":"CompositeResourceDefinition","verbs":["get","list","watch"]}]}"#,
        ),
        "/apis/apiextensions.crossplane.io/v1/compositeresourcedefinitions" => Reply::json(
            200,
            json!({ "kind": "CompositeResourceDefinitionList", "apiVersion": "apiextensions.crossplane.io/v1",
                    "metadata": {}, "items": [xrd("db", "example.org", "XDatabase", Some("Database"))] })
            .to_string(),
        ),
        _ => Reply::not_found(),
    }
}

#[tokio::test]
async fn rust_lists_the_definitions_to_decide_the_kinds_they_define() {
    let api = FakeApi::start(with_xrds).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let m = parsed(manifest_json(json!([rule("a")]))).unwrap();
    let agreed = kinds_from_of(&m);
    let everything = reading(KindScope::All);
    let scopes = problem_scopes(&everything, "ctx", &problem_kinds(&m));
    let mut defined = scopes.clone();
    defined_scopes(&mgr, &id, "ctx", &everything, &m, &agreed, &mut defined).await;
    assert_eq!(
        defined[..scopes.len()],
        scopes[..],
        "one definition: not more than `max`"
    );
    assert_eq!(
        defined[scopes.len()..],
        ["XDatabase", "Database"]
            .map(|kind| ProblemScope {
                kind: KindPattern::new("example.org", kind),
                namespaces: NamespaceScope::All,
                defined_by: Some(KindPattern::new(XRD.0, XRD.1)),
                more_definitions: false,
            })
            .to_vec()[..]
    );

    // A defined kind the extension may not read is left out; so is everything when the definitions may not be read
    // (no scope of the definition kind: nothing is listed), or when the `kindsFrom` was not agreed to.
    let some = reading(KindScope::Only {
        kinds: vec![
            KindPattern::new(XRD.0, XRD.1),
            KindPattern::new("example.org", "Database"),
        ],
    });
    let scopes_some = problem_scopes(&some, "ctx", &problem_kinds(&m));
    let mut only = scopes_some.clone();
    defined_scopes(&mgr, &id, "ctx", &some, &m, &agreed, &mut only).await;
    assert_eq!(only.len(), scopes_some.len() + 1);
    assert_eq!(
        only.last().unwrap().kind,
        KindPattern::new("example.org", "Database")
    );
    let before = api.requests().len();
    let mut none = Vec::new();
    defined_scopes(&mgr, &id, "ctx", &everything, &m, &agreed, &mut none).await;
    assert!(none.is_empty());
    let mut not_agreed = scopes.clone();
    defined_scopes(&mgr, &id, "ctx", &everything, &m, &[], &mut not_agreed).await;
    assert_eq!(not_agreed, scopes);
    assert_eq!(api.requests().len(), before, "nothing is listed for them");
}

#[tokio::test]
async fn a_list_that_fails_defines_nothing() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/apis/apiextensions.crossplane.io/v1/compositeresourcedefinitions" => Reply::json(
            403,
            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#,
        ),
        _ => with_xrds(req),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let m = parsed(manifest_json(json!([rule("a")]))).unwrap();
    let everything = reading(KindScope::All);
    let scopes = problem_scopes(&everything, "ctx", &problem_kinds(&m));
    let mut defined = scopes.clone();
    defined_scopes(
        &mgr,
        &id,
        "ctx",
        &everything,
        &m,
        &kinds_from_of(&m),
        &mut defined,
    )
    .await;
    assert_eq!(defined, scopes);
}

#[tokio::test]
async fn more_definitions_than_max_are_told_on_the_definition_kinds_scope() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/apis/apiextensions.crossplane.io/v1/compositeresourcedefinitions" => Reply::json(
            200,
            json!({ "kind": "CompositeResourceDefinitionList", "apiVersion": "apiextensions.crossplane.io/v1",
                    "metadata": {}, "items": [
                        xrd("c", "example.org", "XCache", None),
                        xrd("a", "example.org", "XDatabase", Some("Database")),
                        xrd("b", "example.org", "XBucket", None),
                    ] })
            .to_string(),
        ),
        _ => with_xrds(req),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let mut two = rule("a");
    two["kindsFrom"]["max"] = json!(2);
    let m = parsed(manifest_json(json!([two]))).unwrap();
    let everything = reading(KindScope::All);
    let scopes = problem_scopes(&everything, "ctx", &problem_kinds(&m));
    let mut defined = scopes.clone();
    defined_scopes(
        &mgr,
        &id,
        "ctx",
        &everything,
        &m,
        &kinds_from_of(&m),
        &mut defined,
    )
    .await;
    let definition = defined
        .iter()
        .find(|s| s.kind == KindPattern::new(XRD.0, XRD.1))
        .unwrap();
    assert!(definition.more_definitions, "three definitions, two read");
    // The first two by name: a and b, not c.
    let kinds: Vec<&str> = defined
        .iter()
        .filter(|s| s.defined_by.is_some())
        .map(|s| s.kind.kind.as_str())
        .collect();
    assert_eq!(kinds, ["XDatabase", "Database", "XBucket"]);
    assert!(
        defined
            .iter()
            .filter(|s| s.defined_by.is_some())
            .all(|s| !s.more_definitions)
    );
    assert_eq!(
        serde_json::to_value(definition).unwrap()["moreDefinitions"],
        json!(true)
    );
    assert!(
        serde_json::to_value(&defined[defined.len() - 1])
            .unwrap()
            .get("moreDefinitions")
            .is_none()
    );
}
