use super::*;
use crate::settings::{AppSettings, SettingsStore};
use serde_json::json;

fn column(path: &str) -> CustomColumn {
    CustomColumn {
        cluster: Some("c1".to_owned()),
        group: String::new(),
        kind: "Pod".to_owned(),
        source: ColumnSource::Field,
        path: path.to_owned(),
        title: "Node".to_owned(),
    }
}

#[test]
fn field_paths_follow_the_small_grammar() {
    use PathStep::{Index, Key};
    let ok = [
        (
            ".spec.nodeName",
            vec![Key("spec".into()), Key("nodeName".into())],
        ),
        (
            "status.phase",
            vec![Key("status".into()), Key("phase".into())],
        ),
        (
            ".spec.containers[0].image",
            vec![
                Key("spec".into()),
                Key("containers".into()),
                Index(0),
                Key("image".into()),
            ],
        ),
        (
            ".metadata.labels[\"app.kubernetes.io/name\"]",
            vec![
                Key("metadata".into()),
                Key("labels".into()),
                Key("app.kubernetes.io/name".into()),
            ],
        ),
        ("[\"a.b\"].c", vec![Key("a.b".into()), Key("c".into())]),
    ];
    for (path, steps) in ok {
        assert_eq!(parse_field_path(path), Some(steps), "{path}");
    }
    let bad = [
        "",
        ".",
        "..spec",
        "spec.",
        "spec..x",
        ".spec.containers[-1]",
        ".spec.containers[]",
        "$.spec",
        ".items[?(@.x)]",
        "{.spec.nodeName}",
        "spec[\"a\\\"b\"]",
        "spec[\"\"]",
        "spec[\"a\"",
        "spec name",
        "length(spec)",
    ];
    for path in bad {
        assert_eq!(parse_field_path(path), None, "{path}");
    }
    assert!(parse_field_path(&format!(".{}", "a".repeat(MAX_FIELD_PATH_CHARS))).is_none());
}

#[test]
fn label_and_annotation_keys_follow_kubernetes_syntax() {
    for key in [
        "app",
        "app.kubernetes.io/name",
        "a_b-c.d",
        "x/Y9",
        "example.com/a",
    ] {
        assert!(is_metadata_key(key), "{key}");
    }
    for key in [
        "",
        "/app",
        "app/",
        "-app",
        "app-",
        "Example.com/app",
        "a/b/c",
        "a b",
        &"x".repeat(64),
    ] {
        assert!(!is_metadata_key(key), "{key}");
    }
}

#[test]
fn secret_values_are_refused() {
    for path in [
        ".data",
        "data.password",
        ".stringData[\"x\"]",
        "data[\"tls.crt\"]",
    ] {
        assert!(
            !is_valid_spec("", "Secret", ColumnSource::Field, path, ""),
            "{path}"
        );
        // The same path on another kind is just a path.
        assert!(
            is_valid_spec("", "ConfigMap", ColumnSource::Field, path, ""),
            "{path}"
        );
        // A custom kind named Secret is not the core Secret.
        assert!(
            is_valid_spec("example.com", "Secret", ColumnSource::Field, path, ""),
            "{path}"
        );
    }
    assert!(is_valid_spec(
        "",
        "Secret",
        ColumnSource::Field,
        ".type",
        ""
    ));
}

#[test]
fn custom_columns_round_trip_and_are_empty_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let store = SettingsStore::open(path.clone());
    assert!(store.get().custom_columns.is_empty());
    store
        .update(|s| s.custom_columns = vec![column(".spec.nodeName")])
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(json["customColumns"][0]["source"], "field");
    assert_eq!(
        SettingsStore::open(path).get().custom_columns,
        vec![column(".spec.nodeName")]
    );
}

#[test]
fn bad_entries_are_left_out_without_failing_the_file() {
    let settings: AppSettings = serde_json::from_value(json!({
        "theme": "dark",
        "customColumns": [
            { "cluster": null, "group": "", "kind": "Pod", "source": "label", "path": "app", "title": "", "future": 1 },
            { "cluster": null, "group": "", "kind": "Pod", "source": "label", "path": "app", "title": "Again" },
            { "group": "", "kind": "Pod", "source": "field", "path": ".spec.containers[*]" },
            { "group": "", "kind": "Secret", "source": "field", "path": ".data.password" },
            { "group": "", "kind": "Pod", "source": "selector", "path": "app" },
            { "group": "", "kind": "", "source": "label", "path": "app" },
            { "group": "", "kind": "Pod", "source": "label", "path": "app", "title": "x".repeat(MAX_TITLE_CHARS + 1) },
            { "cluster": "", "group": "", "kind": "Pod", "source": "label", "path": "tier" },
            "not an object"
        ]
    }))
    .unwrap();
    assert_eq!(settings.theme, crate::Theme::Dark);
    assert_eq!(settings.custom_columns.len(), 1);
    assert_eq!(settings.custom_columns[0].path, "app");

    let not_a_list: AppSettings =
        serde_json::from_value(json!({ "customColumns": { "a": 1 } })).unwrap();
    assert!(not_a_list.custom_columns.is_empty());
}

#[test]
fn columns_are_capped_per_kind_and_scope() {
    let pods: Vec<_> = (0..MAX_COLUMNS_PER_KIND + 3)
        .map(|i| json!({ "cluster": "c1", "kind": "Pod", "source": "label", "path": format!("k{i}") }))
        .collect();
    let other = json!({ "cluster": null, "kind": "Pod", "source": "label", "path": "k0" });
    let mut list = pods;
    list.push(other);
    let settings: AppSettings = serde_json::from_value(json!({ "customColumns": list })).unwrap();
    assert_eq!(settings.custom_columns.len(), MAX_COLUMNS_PER_KIND + 1);
    assert_eq!(settings.custom_columns.last().unwrap().cluster, None);
}

#[test]
fn a_saved_view_carries_its_columns_and_reads_without_them() {
    let settings: AppSettings = serde_json::from_value(json!({
        "views": [
            { "id": "old", "name": "Old", "kind": "Pod" },
            { "id": "new", "name": "New", "kind": "Pod", "customColumns": [
                { "source": "field", "path": ".spec.nodeName", "title": "Node" },
                { "source": "field", "path": ".spec.nodeName", "title": "Again" },
                { "source": "field", "path": "spec[*]", "title": "Bad" }
            ] },
            { "id": "leak", "name": "Leak", "kind": "Secret", "customColumns": [
                { "source": "field", "path": ".data.password", "title": "" }
            ] }
        ]
    }))
    .unwrap();
    let ids: Vec<_> = settings.views.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, ["old", "new"]);
    assert!(settings.views[0].custom_columns.is_empty());
    assert_eq!(settings.views[1].custom_columns.len(), 1);
    // A view without columns is written without the field, as before.
    let written = serde_json::to_value(&settings.views[0]).unwrap();
    assert!(written.get("customColumns").is_none());
}

#[test]
fn a_step_picks_a_list_item_by_a_field() {
    use super::MatchPick;
    use PathStep::{Key, Match};
    assert_eq!(
        parse_field_path(".status.conditions[type=\"Ready\"].message"),
        Some(vec![
            Key("status".into()),
            Key("conditions".into()),
            Match {
                pairs: vec![("type".into(), "Ready".into())],
                pick: MatchPick::First
            },
            Key("message".into()),
        ])
    );
    // A value may hold `]` and `=`; the step ends at its closing quote.
    assert_eq!(
        parse_field_path("spec.items[name=\"a]=b\"]"),
        Some(vec![
            Key("spec".into()),
            Key("items".into()),
            Match {
                pairs: vec![("name".into(), "a]=b".into())],
                pick: MatchPick::First
            },
        ])
    );
    // Several pairs, all of which must match (#392).
    assert_eq!(
        parse_field_path(".status.nodes[type=\"Suspend\",phase=\"Running\"]"),
        Some(vec![
            Key("status".into()),
            Key("nodes".into()),
            Match {
                pairs: vec![
                    ("type".into(), "Suspend".into()),
                    ("phase".into(), "Running".into())
                ],
                pick: MatchPick::First
            },
        ])
    );
    assert_eq!(
        parse_field_path("a[b=\"1\",c=\"2\",d=\"3\",e=\"4\",f=\"5\"]"),
        None
    );
    assert_eq!(parse_field_path("a[b=\"1\",]"), None);
    assert_eq!(parse_field_path("a[b=\"1\" c=\"2\"]"), None);
    for bad in [
        "a[type=Ready]",
        "a[=\"x\"]",
        "a[ty pe=\"x\"]",
        "a[type=\"x\\\\y\"]",
        "a[type=\"x\"",
    ] {
        assert_eq!(parse_field_path(bad), None, "{bad}");
    }
}

#[test]
fn a_match_picks_a_list_item_or_a_maps_value_in_key_order() {
    use serde_json::json;
    let pairs = vec![
        ("type".to_owned(), "Suspend".to_owned()),
        ("phase".to_owned(), "Running".to_owned()),
    ];
    let nodes = json!({
        "wf-b": { "type": "Suspend", "phase": "Running", "name": "second" },
        "wf-a": { "type": "Suspend", "phase": "Running", "name": "first" },
        "wf-c": { "type": "Pod", "phase": "Running" }
    });
    assert_eq!(PathStep::pick(&pairs, &nodes).unwrap()["name"], "first");
    let list = json!([{ "type": "Suspend", "phase": "Succeeded" }, { "type": "Suspend", "phase": "Running", "n": 2 }]);
    assert_eq!(PathStep::pick(&pairs, &list).unwrap()["n"], 2);
    assert!(PathStep::pick(&pairs, &json!("x")).is_none());
    let mut changed = nodes.clone();
    PathStep::pick_mut(&pairs, &mut changed).unwrap()["name"] = json!("x");
    assert_eq!(changed["wf-a"]["name"], "x");
}

#[test]
fn a_match_takes_the_earliest_by_a_field_or_every_match_as_the_last_step() {
    use serde_json::json;
    let steps =
        parse_field_path(".status.nodes[type=\"Pod\",phase=\"Failed\",<finishedAt].displayName")
            .unwrap();
    assert!(
        matches!(&steps[2], PathStep::Match { pick: MatchPick::Earliest(f), .. } if f == "finishedAt")
    );
    let all = parse_field_path(".status.nodes[type=\"Pod\",*]").unwrap();
    assert!(matches!(
        &all[2],
        PathStep::Match {
            pick: MatchPick::All,
            ..
        }
    ));
    // Steps after `*` read each item (#404); one list per path; `<` needs a name.
    assert!(parse_field_path(".status.nodes[type=\"Pod\",*].name").is_some());
    assert!(parse_field_path(".spec.kafka.listeners[*].name").is_some());
    assert!(matches!(
        &parse_field_path(".spec.containers[<name]").unwrap()[2],
        PathStep::Match { pairs, pick: MatchPick::Earliest(f) } if pairs.is_empty() && f == "name"
    ));
    assert_eq!(parse_field_path(".a[*].b[*]"), None);
    assert_eq!(parse_field_path(".a[b=\"1\",<]"), None);
    assert_eq!(parse_field_path(".a[<]"), None);
    assert_eq!(parse_field_path(".a[b=\"1\",*,c=\"2\"]"), None);
    // A custom column shows one value: no list paths there.
    assert!(!is_valid_spec(
        "",
        "Pod",
        ColumnSource::Field,
        ".spec.containers[*].image",
        ""
    ));
    assert!(is_valid_spec(
        "",
        "Pod",
        ColumnSource::Field,
        ".spec.containers[0].image",
        ""
    ));
    let pairs = vec![("phase".to_owned(), "Failed".to_owned())];
    let nodes = json!({
        "a": { "phase": "Failed", "finishedAt": "2026-11-07T10:05:00Z", "n": "late" },
        "b": { "phase": "Failed", "finishedAt": "2026-11-07T10:01:00Z", "n": "early" },
        "c": { "phase": "Failed", "n": "unfinished" },
        "d": { "phase": "Succeeded", "finishedAt": "2026-11-07T09:00:00Z" }
    });
    assert_eq!(
        PathStep::earliest(&pairs, "finishedAt", &nodes).unwrap()["n"],
        "early"
    );
    assert_eq!(PathStep::matching(&pairs, &nodes).len(), 3);
}
