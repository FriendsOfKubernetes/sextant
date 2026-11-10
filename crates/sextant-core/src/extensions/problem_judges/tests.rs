use serde_json::json;

use super::*;
use crate::extensions::parse_manifest;
use crate::extensions::problems::problem_kinds;

const VS: (&str, &str) = ("networking.istio.io", "VirtualService");

fn judge() -> Value {
    json!({
        "id": "routing",
        "reads": [
            { "kind": { "group": VS.0, "kind": VS.1 }, "paths": [".spec.hosts", ".spec.http[*].route[*].destination.host"] },
            { "kind": { "group": "", "kind": "Service" }, "paths": [".metadata.labels"] }
        ],
        "facts": [{ "id": "unknown-host", "values": ["host"] }, { "id": "conflict" }]
    })
}

fn rule(when: Value, message: &str) -> Value {
    json!({ "id": "r", "title": "Unknown host", "kind": { "group": VS.0, "kind": VS.1 }, "when": when, "message": message })
}

fn manifest_json(judges: Value, problems: Value) -> Value {
    json!({
        "id": "mesh", "name": "Mesh", "version": "1.0.0", "description": "", "author": "Me",
        "sextantApi": 4, "entry": "index.html",
        "permissions": { "clusters": { "type": "all" }, "rules": [] },
        "backend": { "module": "backend.wasm" },
        "contributes": { "problemJudges": judges, "problems": problems }
    })
}

fn parsed(value: Value) -> Result<ExtensionManifest, ManifestError> {
    parse_manifest(value.to_string().as_bytes())
}

fn judged() -> Value {
    json!({ "type": "judged", "judge": "routing", "fact": "unknown-host" })
}

fn refusal(value: Value) -> String {
    let err = parsed(value).unwrap_err();
    format!("{}: {}", err.path, err.message)
}

#[test]
fn a_judge_and_its_rule_read_and_its_kinds_are_agreed_to_with_the_rules() {
    let m = parsed(manifest_json(
        json!([judge()]),
        json!([rule(
            judged(),
            "{{fact:host}} is not a known host ({{.metadata.name}})"
        )]),
    ))
    .unwrap();
    let j = &m.contributes.problem_judges[0];
    assert_eq!(j.facts[0].values, vec!["host".to_owned()]);
    assert!(j.facts[1].values.is_empty());
    assert_eq!(
        problem_kinds(&m),
        vec![
            KindPattern::new(VS.0, VS.1),
            KindPattern::new("", "Service")
        ]
    );
    assert_eq!(
        serde_json::to_value(&m.contributes.problems[0].when).unwrap(),
        judged()
    );
    // Inside `all`, beside other conditions.
    parsed(manifest_json(
        json!([judge()]),
        json!([rule(
            json!({ "type": "all", "of": [judged(), { "type": "exists", "path": ".spec" }] }),
            "m"
        )]),
    ))
    .unwrap();
}

#[test]
fn what_a_judge_and_a_judged_rule_may_not_be() {
    let base = |judges: Value, when: Value, message: &str| {
        manifest_json(judges, json!([rule(when, message)]))
    };
    let mut old = base(json!([judge()]), judged(), "m");
    old["sextantApi"] = json!(3);
    assert!(refusal(old).contains("needs sextantApi 4"));
    let mut no_backend = base(json!([judge()]), judged(), "m");
    no_backend.as_object_mut().unwrap().remove("backend");
    assert_eq!(
        refusal(no_backend),
        "contributes.problemJudges: needs a `backend`: the extension's backend decides the judges' facts"
    );
    let mut secret = judge();
    secret["reads"][1] =
        json!({ "kind": { "group": "", "kind": "Secret" }, "paths": [".metadata.name"] });
    assert_eq!(
        refusal(base(json!([secret]), judged(), "m")),
        "contributes.problemJudges[0].reads[1].kind: Secrets are never given to a judge"
    );
    // An inline secret field (a Route's TLS key) and anything holding it.
    let mut inline = judge();
    inline["reads"][1] =
        json!({ "kind": { "group": "route.openshift.io", "kind": "Route" }, "paths": [".spec"] });
    assert!(
        refusal(base(json!([inline]), judged(), "m"))
            .starts_with("contributes.problemJudges[0].reads[1].paths[0]: reads secret values")
    );
    assert_eq!(
        refusal(base(
            json!([judge()]),
            json!({ "type": "judged", "judge": "other", "fact": "conflict" }),
            "m"
        )),
        "contributes.problems[0].when.judge: is not the id of one of `contributes.problemJudges`"
    );
    assert_eq!(
        refusal(base(
            json!([judge()]),
            json!({ "type": "judged", "judge": "routing", "fact": "nope" }),
            "m"
        )),
        "contributes.problems[0].when.fact: is not a fact of the judge `routing`"
    );
    assert_eq!(
        refusal(base(
            json!([judge()]),
            json!({ "type": "not", "of": judged() }),
            "m"
        )),
        "contributes.problems[0].when.of.type: `judged` cannot be inside `any` or `not`: a judge that cannot tell would make it unknown"
    );
    assert!(
        refusal(base(json!([judge()]), judged(), "{{fact:other}}"))
            .contains("which no fact of the rule's `judged` conditions gives")
    );
    // A rule of a kind the judge does not read.
    let mut other_kind = manifest_json(json!([judge()]), json!([rule(judged(), "m")]));
    other_kind["contributes"]["problems"][0]["kind"] =
        json!({ "group": "networking.istio.io", "kind": "Gateway" });
    assert_eq!(
        refusal(other_kind),
        "contributes.problems[0].when.judge: does not read the rule's kind networking.istio.io/Gateway"
    );
    // A judge no rule uses.
    assert_eq!(
        refusal(base(
            json!([judge()]),
            json!({ "type": "exists", "path": ".spec" }),
            "m"
        )),
        "contributes.problemJudges[0].id: no rule judges with it (a `judged` condition naming it)"
    );
    let mut twice = judge();
    twice["facts"][1]["id"] = json!("unknown-host");
    assert!(
        refusal(base(json!([twice]), judged(), "m"))
            .ends_with("is the id of another fact of the judge")
    );
}

#[test]
fn a_read_may_be_optional_and_a_rule_judged_each_is_its_whole_when() {
    let mut optional = judge();
    optional["reads"][1]["optional"] = json!(true);
    let each =
        json!({ "type": "judged", "judge": "routing", "fact": "unknown-host", "each": true });
    let m = parsed(manifest_json(
        json!([optional]),
        json!([rule(each.clone(), "{{fact:host}} is not known")]),
    ))
    .unwrap();
    assert_eq!(
        m.contributes.problem_judges[0].reads[1].optional,
        Some(true)
    );
    assert_eq!(m.contributes.problem_judges[0].reads[0].optional, None);
    assert!(matches!(
        m.contributes.problems[0].when,
        ProblemCondition::Judged {
            each: Some(true),
            ..
        }
    ));
    // Not beside other conditions: which of the facts stand would be decided by them.
    assert_eq!(
        refusal(manifest_json(
            json!([judge()]),
            json!([rule(
                json!({ "type": "all", "of": [each, { "type": "exists", "path": ".spec" }] }),
                "m"
            )])
        )),
        "contributes.problems[0].when.of[0].each: is only for a `judged` that is the rule's whole `when` (not inside `all`)"
    );
    let mut bad = judge();
    bad["reads"][1]["optional"] = json!("yes");
    assert!(
        refusal(manifest_json(json!([bad]), json!([rule(judged(), "m")])))
            .starts_with("contributes.problemJudges[0].reads[1].optional")
    );
}

#[test]
fn the_rules_of_one_judge_belong_to_one_category() {
    let mut m = manifest_json(
        json!([judge()]),
        json!([rule(judged(), "a"), { "id": "s", "title": "Conflict", "kind": { "group": VS.0, "kind": VS.1 },
                "when": { "type": "judged", "judge": "routing", "fact": "conflict" }, "message": "b", "category": "own" }]),
    );
    m["contributes"]["problemCategories"] = json!([{ "id": "own", "title": "Own" }]);
    assert_eq!(
        refusal(m),
        "contributes.problems[1].category: the rules of the judge `routing` belong to one problem category (as contributes.problems[0])"
    );
}

fn scope_all() -> Vec<ProblemScope> {
    vec![
        ProblemScope {
            kind: KindPattern::new(VS.0, VS.1),
            namespaces: NamespaceScope::Only {
                namespaces: vec!["shop".into()],
            },
            defined_by: None,
            more_definitions: false,
        },
        ProblemScope {
            kind: KindPattern::new("", "Service"),
            namespaces: NamespaceScope::All,
            defined_by: None,
            more_definitions: false,
        },
    ]
}

fn the_judge() -> ProblemJudgeContribution {
    serde_json::from_value(judge()).unwrap()
}

#[test]
fn objects_are_projected_again_in_rust() {
    let objects = vec![json!({
        "apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
        "metadata": { "name": "web", "namespace": "shop", "uid": "u1", "creationTimestamp": "2026-01-01T00:00:00Z",
                      "labels": { "a": "b" }, "annotations": { "x": "y" } },
        "values": { ".spec.hosts": ["web"], ".spec.gateways": ["mesh"] },
        "spec": { "hosts": ["web"] }
    })];
    let projected = project_objects(&the_judge(), objects, &scope_all()).unwrap();
    assert_eq!(
        serde_json::to_value(&projected).unwrap(),
        json!([{
            "apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
            "metadata": { "name": "web", "namespace": "shop", "uid": "u1", "creationTimestamp": "2026-01-01T00:00:00Z" },
            "values": { ".spec.hosts": ["web"] }
        }])
    );
}

#[test]
fn objects_outside_the_judge_or_its_scope_are_refused() {
    let vs = |ns: &str| {
        json!({ "apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
                                 "metadata": { "name": "web", "namespace": ns, "uid": ns } })
    };
    let err = project_objects(&the_judge(), vec![vs("other")], &scope_all()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    let gateway = json!({ "apiVersion": "networking.istio.io/v1", "kind": "Gateway", "metadata": { "name": "g", "uid": "g" } });
    assert_eq!(
        project_objects(&the_judge(), vec![gateway], &scope_all())
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
    // A cluster-scoped object only where the kind may be read everywhere.
    let bare = json!({ "apiVersion": "networking.istio.io/v1", "kind": "VirtualService", "metadata": { "name": "w", "uid": "w" } });
    assert_eq!(
        project_objects(&the_judge(), vec![bare], &scope_all())
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    // The same uid twice.
    assert!(project_objects(&the_judge(), vec![vs("shop"), vs("shop")], &scope_all()).is_err());
    // A kind not granted has no scope.
    assert!(project_objects(&the_judge(), vec![vs("shop")], &[]).is_err());
    // More than the cap of one kind.
    let many: Vec<Value> = (0..=MAX_JUDGED_OBJECTS_PER_KIND)
        .map(|i| json!({ "apiVersion": "v1", "kind": "Service", "metadata": { "name": "s", "namespace": "a", "uid": i.to_string() } }))
        .collect();
    assert!(
        project_objects(&the_judge(), many, &scope_all())
            .unwrap_err()
            .message
            .contains("at most 5000")
    );
}

#[test]
fn an_answer_keeps_only_declared_facts_about_sent_objects() {
    let sent = project_objects(
        &the_judge(),
        vec![
            json!({ "apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
                     "metadata": { "name": "web", "namespace": "shop", "uid": "u1" } }),
        ],
        &scope_all(),
    )
    .unwrap();
    let long = "x".repeat(MAX_FACT_VALUE_CHARS + 5);
    let (facts, left_out) = read_answer(
        &the_judge(),
        &sent,
        json!([
            { "uid": "u1", "fact": "unknown-host", "values": { "host": "reviews\u{7}.shop", "extra": "no" } },
            { "uid": "u1", "fact": "unknown-host", "values": { "host": "second" } },
            { "uid": "u1", "fact": "unknown-host", "values": { "host": "second", "extra": "again" } },
            { "uid": "u1", "fact": "conflict", "values": { "host": long } },
            { "uid": "u1", "fact": "conflict" },
            { "uid": "u2", "fact": "conflict" },
            { "uid": "u1", "fact": "undeclared" },
            "not an object"
        ]),
    )
    .unwrap();
    assert_eq!(left_out, 3);
    assert_eq!(
        facts,
        vec![
            JudgedFact {
                uid: "u1".into(),
                fact: "unknown-host".into(),
                values: Some(BTreeMap::from([("host".into(), "reviews .shop".into())])),
                needs: None
            },
            // The same fact again with other texts is kept (a rule judged `each` tells it); the very same is not.
            JudgedFact {
                uid: "u1".into(),
                fact: "unknown-host".into(),
                values: Some(BTreeMap::from([("host".into(), "second".into())])),
                needs: None
            },
            JudgedFact {
                uid: "u1".into(),
                fact: "conflict".into(),
                values: None,
                needs: None
            },
        ]
    );
    assert!(read_answer(&the_judge(), &sent, json!({ "facts": [] })).is_err());
    let many: Vec<Value> = (0..=MAX_JUDGED_FACTS)
        .map(|_| json!({ "uid": "u1", "fact": "conflict" }))
        .collect();
    assert!(read_answer(&the_judge(), &sent, Value::Array(many)).is_err());
}

#[test]
fn a_fact_text_is_cleaned_and_clipped() {
    assert_eq!(
        shown("https://user:pw@example.com/a?token=1 is bad"),
        "https://example.com/a is bad"
    );
    assert_eq!(
        shown(&"é".repeat(MAX_FACT_VALUE_CHARS + 1)).chars().count(),
        MAX_FACT_VALUE_CHARS + 1
    );
}

fn partial_judge() -> ProblemJudgeContribution {
    let mut judge = the_judge();
    judge.reads[1].partial = Some(true);
    judge
}

fn service(ns: &str, uid: &str) -> Value {
    json!({ "apiVersion": "v1", "kind": "Service", "metadata": { "name": "s", "namespace": ns, "uid": uid } })
}

#[test]
fn a_partial_read_says_where_it_was_not_read() {
    let judge = partial_judge();
    // Read everywhere but where the API server refused it.
    let sent = project_objects(&judge, vec![service("a", "s1")], &scope_all()).unwrap();
    let partial = project_partial(
        &judge,
        vec![json!({ "kind": { "group": "", "kind": "service" }, "unreadNamespaces": ["c", "b", "c"] })],
        &scope_all(),
        &sent,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&partial).unwrap(),
        json!([{ "kind": { "group": "", "kind": "Service" }, "unreadNamespaces": ["b", "c"] }])
    );
    // Nothing read in part, nothing said: an old judge gets what it always got.
    assert!(
        project_partial(&judge, vec![], &scope_all(), &sent)
            .unwrap()
            .is_empty()
    );

    // A scope of some namespaces: read only there, even when the window says more or nothing.
    let only = vec![ProblemScope {
        kind: KindPattern::new("", "Service"),
        namespaces: NamespaceScope::Only {
            namespaces: vec!["b".into(), "a".into()],
        },
        defined_by: None,
        more_definitions: false,
    }];
    let said = project_partial(
        &judge,
        vec![json!({ "kind": { "group": "", "kind": "Service" }, "readNamespaces": ["a", "z"] })],
        &only,
        &sent,
    )
    .unwrap();
    assert_eq!(said[0].read_namespaces, Some(vec!["a".to_owned()]));
    let unsaid = project_partial(&judge, vec![], &only, &sent).unwrap();
    assert_eq!(
        unsaid[0].read_namespaces,
        Some(vec!["a".to_owned(), "b".to_owned()])
    );
}

#[test]
fn what_a_partial_read_may_not_say() {
    let judge = partial_judge();
    let sent = project_objects(&judge, vec![service("b", "s1")], &scope_all()).unwrap();
    let refused = |given: Value| {
        project_partial(&judge, vec![given], &scope_all(), &sent)
            .unwrap_err()
            .message
    };
    // A read not marked `partial`, a kind not read, twice, a name that is no namespace.
    assert!(
        refused(json!({ "kind": { "group": VS.0, "kind": VS.1 }, "unreadNamespaces": [] }))
            .contains("in part")
    );
    assert!(refused(json!({ "kind": { "group": "", "kind": "Pod" } })).contains("does not read"));
    assert!(refused(json!({ "kind": { "group": "", "kind": "Service" }, "unreadNamespaces": ["Not A Name"] }))
        .contains("no namespace"));
    assert!(
        project_partial(
            &judge,
            vec![
                json!({ "kind": { "group": "", "kind": "Service" } }),
                json!({ "kind": { "group": "", "kind": "Service" } })
            ],
            &scope_all(),
            &[]
        )
        .is_err()
    );
    // An object in a namespace said not to be read.
    assert!(
        refused(json!({ "kind": { "group": "", "kind": "Service" }, "unreadNamespaces": ["b"] }))
            .contains("not to be read")
    );
    assert!(
        refused(json!({ "kind": { "group": "", "kind": "Service" }, "readNamespaces": ["a"] }))
            .contains("not to be read")
    );
    let many: Vec<String> = (0..=MAX_PARTIAL_NAMESPACES)
        .map(|i| format!("n{i}"))
        .collect();
    assert!(
        refused(json!({ "kind": { "group": "", "kind": "Service" }, "unreadNamespaces": many }))
            .contains("at most")
    );
}

#[test]
fn a_fact_keeps_what_it_rests_on_only_of_kinds_the_judge_read() {
    let judge = the_judge();
    let sent = project_objects(
        &judge,
        vec![
            json!({ "apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
                     "metadata": { "name": "web", "namespace": "shop", "uid": "u1" } }),
        ],
        &scope_all(),
    )
    .unwrap();
    let needs_of_answer = |needs: Value| {
        let (facts, _) = read_answer(
            &judge,
            &sent,
            json!([{ "uid": "u1", "fact": "conflict", "needs": needs }]),
        )
        .unwrap();
        facts[0].needs.clone()
    };
    assert_eq!(
        needs_of_answer(json!([
            { "kind": { "group": VS.0, "kind": "virtualservice" }, "namespace": "shop", "name": "web" },
            { "kind": { "group": "", "kind": "Service" }, "namespace": "shop" },
            { "kind": { "group": "", "kind": "Service" }, "namespace": "shop" },
            // A kind the judge does not read: it rests on nothing the judge saw.
            { "kind": { "group": "", "kind": "Pod" } }
        ])),
        Some(vec![
            JudgedNeed {
                kind: KindPattern::new(VS.0, VS.1),
                namespace: Some("shop".into()),
                name: Some("web".into())
            },
            JudgedNeed {
                kind: KindPattern::new("", "Service"),
                namespace: Some("shop".into()),
                name: None
            },
        ])
    );
    // On the object alone.
    assert_eq!(needs_of_answer(json!([])), Some(vec![]));
    // Not said, too many, or one that is no need: the stricter rule (every kind the judge read).
    assert_eq!(needs_of_answer(Value::Null), None);
    let many: Vec<Value> = (0..=MAX_FACT_NEEDS)
        .map(|_| json!({ "kind": { "group": "", "kind": "Service" } }))
        .collect();
    assert_eq!(needs_of_answer(Value::Array(many)), None);
    assert_eq!(
        needs_of_answer(
            json!([{ "kind": { "group": "", "kind": "Service" }, "namespace": "Bad Name" }])
        ),
        None
    );
    assert_eq!(needs_of_answer(json!([{ "kind": "Service" }])), None);
    assert_eq!(needs_of_answer(json!("all")), None);
}
