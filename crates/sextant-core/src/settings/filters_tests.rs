use super::{AppSettings, ClusterSettings, SavedView};
use serde_json::{Value, json};

fn rule() -> Value {
    json!({"type": "rule", "column": "ready", "condition": {"operator": "eq", "value": false}})
}

fn table() -> Value {
    json!({"columns": {"name": {"values": null, "condition": {"operator": "contains", "value": "web"}}}, "advanced": null})
}

fn read_table(table: Value) -> Value {
    let settings: ClusterSettings =
        serde_json::from_value(json!({"tableFilters": {"kind:/Pod": table}})).unwrap();
    serde_json::to_value(settings).unwrap()["tableFilters"]["kind:/Pod"].clone()
}

fn with_condition(condition: Value) -> Value {
    json!({"columns": {"name": {"values": null, "condition": condition}}, "advanced": null})
}

#[test]
fn old_settings_have_no_filters_and_do_not_write_empty_fields() {
    let cluster: ClusterSettings = serde_json::from_value(json!({"color": "blue"})).unwrap();
    let written = serde_json::to_value(cluster).unwrap();
    assert_eq!(written["color"], "blue");
    assert!(written.get("tableFilters").is_none());
    let view: SavedView =
        serde_json::from_value(json!({"id": "pods", "name": "Pods", "kind": "Pod"})).unwrap();
    assert!(
        serde_json::to_value(view)
            .unwrap()
            .get("tableFilters")
            .is_none()
    );
}

#[test]
fn filters_and_version_025_known_namespaces_roundtrip_together() {
    let cluster: ClusterSettings = serde_json::from_value(json!({
        "knownNamespaces": ["demo", "team-a"],
        "tableFilters": {"kind:/Pod": table()}
    }))
    .unwrap();
    let written = serde_json::to_value(cluster).unwrap();
    assert_eq!(written["knownNamespaces"], json!(["demo", "team-a"]));
    assert_eq!(written["tableFilters"]["kind:/Pod"], table());
    let reopened: ClusterSettings = serde_json::from_value(written.clone()).unwrap();
    assert_eq!(serde_json::to_value(reopened).unwrap(), written);
}

#[test]
fn malformed_filter_maps_or_entries_preserve_other_settings_and_valid_siblings() {
    for raw in [json!(false), json!(null), json!([]), json!("bad")] {
        let cluster: ClusterSettings = serde_json::from_value(
            json!({"displayName": "Prod", "color": "blue", "tableFilters": raw}),
        )
        .unwrap();
        let written = serde_json::to_value(cluster).unwrap();
        assert_eq!(written["displayName"], "Prod");
        assert_eq!(written["color"], "blue");
        assert!(written.get("tableFilters").is_none());
    }
    let settings: AppSettings = serde_json::from_value(json!({
        "theme": "dark", "clusters": {"prod": {"color": "blue", "tableFilters": {
            "kind:/Pod": table(), "kind:apps/Deployment": {"advanced": {"type": "unknown"}}, "bad": table()
        }}}
    })).unwrap();
    let written = serde_json::to_value(settings).unwrap();
    assert_eq!(written["theme"], "dark");
    assert_eq!(written["clusters"]["prod"]["color"], "blue");
    assert_eq!(
        written["clusters"]["prod"]["tableFilters"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        written["clusters"]["prod"]["tableFilters"]["kind:/Pod"],
        table()
    );
}

#[test]
fn an_invalid_nested_or_is_rejected_as_a_whole() {
    let mut bad = rule();
    bad["condition"] = json!({"operator": "gt", "value": "bad"});
    let filters = json!({"columns": {}, "advanced": {"type": "group", "operator": "or", "children": [rule(), {"type": "group", "operator": "or", "children": [rule(), bad]}]}});
    assert_eq!(read_table(filters), Value::Null);
}

#[test]
fn filter_operators_require_their_exact_operands() {
    for condition in [
        json!({"operator": "eq", "value": 0}),
        json!({"operator": "neq", "value": false}),
        json!({"operator": "contains", "value": "web"}),
        json!({"operator": "notContains", "value": "web"}),
        json!({"operator": "startsWith", "value": "web"}),
        json!({"operator": "endsWith", "value": "web"}),
        json!({"operator": "gt", "value": 0}),
        json!({"operator": "gte", "value": -1}),
        json!({"operator": "lt", "value": 0.5}),
        json!({"operator": "lte", "value": 2}),
        json!({"operator": "between", "value": 0, "upper": 0}),
        json!({"operator": "empty"}),
        json!({"operator": "notEmpty"}),
    ] {
        let filters = with_condition(condition);
        assert_eq!(read_table(filters.clone()), filters);
    }
    for condition in [
        json!({"operator": "eq"}),
        json!({"operator": "eq", "value": null}),
        json!({"operator": "neq", "value": []}),
        json!({"operator": "contains", "value": 0}),
        json!({"operator": "notContains", "value": false}),
        json!({"operator": "startsWith", "value": null}),
        json!({"operator": "endsWith", "value": 1}),
        json!({"operator": "gt", "value": "1"}),
        json!({"operator": "gte", "value": false}),
        json!({"operator": "lt", "value": null}),
        json!({"operator": "lte", "value": {}}),
        json!({"operator": "between", "value": 2, "upper": 1}),
        json!({"operator": "between", "value": 1}),
        json!({"operator": "between", "value": 1, "upper": "2"}),
        json!({"operator": "eq", "value": 0, "upper": 1}),
        json!({"operator": "empty", "value": null}),
        json!({"operator": "notEmpty", "upper": 0}),
    ] {
        assert_eq!(
            read_table(with_condition(condition.clone())),
            Value::Null,
            "{condition}"
        );
    }
}

#[test]
fn unknown_filter_fields_are_rejected() {
    let cases = [
        json!({"columns": {}, "advanced": rule(), "uiId": "x"}),
        json!({"columns": {"name": {"values": null, "condition": null, "uiId": "x"}}}),
        json!({"columns": {"name": {"values": {"mode": "include", "values": [0], "uiId": "x"}, "condition": null}}}),
        with_condition(json!({"operator": "eq", "value": 0, "units": "CPU"})),
        json!({"columns": {}, "advanced": {"type": "rule", "column": "name", "condition": {"operator": "empty"}, "uiId": "x"}}),
        json!({"columns": {}, "advanced": {"type": "group", "operator": "and", "children": [rule()], "uiId": "x"}}),
    ];
    for case in cases {
        assert_eq!(read_table(case.clone()), Value::Null, "{case}");
    }
}

#[test]
fn empty_restrictions_normalize_and_single_child_groups_collapse() {
    let empty = json!({"columns": {"name": {"values": {"mode": "include", "values": []}, "condition": null}}, "advanced": {"type": "group", "operator": "and", "children": []}});
    assert_eq!(read_table(empty), Value::Null);
    let filters = json!({"columns": {"unused": {}, "name": table()["columns"]["name"]}, "advanced": {"type": "group", "operator": "or", "children": [rule()]}});
    assert_eq!(
        read_table(filters),
        json!({"columns": table()["columns"], "advanced": rule()})
    );
}

#[test]
fn nested_empty_groups_are_rejected_atomically() {
    let filters = json!({"columns": {}, "advanced": {"type": "group", "operator": "or", "children": [rule(), {"type": "group", "operator": "and", "children": []}]}});
    assert_eq!(read_table(filters), Value::Null);
}

#[test]
fn filter_caps_accept_the_boundary_and_reject_oversized_entries() {
    let mut values = json!({"columns": {"name": {"values": {"mode": "exclude", "values": vec![json!(null); 1000]}, "condition": null}}, "advanced": null});
    assert_eq!(read_table(values.clone()), values);
    values["columns"]["name"]["values"]["values"]
        .as_array_mut()
        .unwrap()
        .push(json!(0));
    assert_eq!(read_table(values), Value::Null);

    let columns: serde_json::Map<String, Value> = (0..200)
        .map(|i| {
            (
                format!("c{i}"),
                json!({"values": null, "condition": {"operator": "empty"}}),
            )
        })
        .collect();
    let mut filters = json!({"columns": columns, "advanced": null});
    assert_eq!(read_table(filters.clone()), filters);
    filters["advanced"] = rule();
    assert_eq!(read_table(filters.clone()), Value::Null, "201 predicates");
    filters["advanced"] = Value::Null;
    filters["columns"]["overflow"] = json!({"values": null, "condition": null});
    assert_eq!(
        read_table(filters),
        Value::Null,
        "201 columns before normalization"
    );

    let mut filters = json!({"columns": {}, "advanced": {"type": "group", "operator": "or", "children": vec![rule(); 199]}});
    assert_eq!(read_table(filters.clone()), filters);
    filters["advanced"]["children"]
        .as_array_mut()
        .unwrap()
        .push(rule());
    assert_eq!(read_table(filters), Value::Null, "201 expression nodes");
}

#[test]
fn oversized_containers_are_rejected_before_deserializing_their_contents() {
    use super::{FilterExpression, TableFilters};

    // The malformed first element would cause a schema error if typed conversion ran before the size check.
    let columns: serde_json::Map<String, Value> =
        (0..201).map(|i| (format!("c{i}"), json!(false))).collect();
    let error = serde_json::from_value::<TableFilters>(json!({"columns": columns}))
        .unwrap_err()
        .to_string();
    assert!(error.contains("too many table filter columns"), "{error}");

    let error = serde_json::from_value::<TableFilters>(json!({
        "columns": {"name": {"values": {"mode": "include", "values": vec![json!({"bad": []}); 1001]}}}
    }))
    .unwrap_err()
    .to_string();
    assert!(error.contains("too many table filter values"), "{error}");

    let error = serde_json::from_value::<FilterExpression>(json!({
        "type": "group", "operator": "invalid", "children": vec![rule(); 200]
    }))
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("too many table filter expression nodes"),
        "{error}"
    );

    let error = serde_json::from_value::<FilterExpression>(json!({
        "type": "group", "operator": "or", "children": [rule(), {
            "type": "group", "operator": "invalid", "children": vec![rule(); 198]
        }]
    }))
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("too many table filter expression nodes"),
        "{error}"
    );
}

#[test]
fn depth_and_unicode_id_and_text_caps_are_checked_before_normalization() {
    let mut expression = rule();
    for _ in 0..7 {
        expression = json!({"type": "group", "operator": "and", "children": [expression]});
    }
    assert_eq!(
        read_table(json!({"columns": {}, "advanced": expression.clone()})),
        json!({"columns": {}, "advanced": rule()})
    );
    expression = json!({"type": "group", "operator": "and", "children": [expression]});
    assert_eq!(
        read_table(json!({"columns": {}, "advanced": expression})),
        Value::Null
    );

    let text = with_condition(json!({"operator": "contains", "value": "я".repeat(1000)}));
    assert_eq!(read_table(text.clone()), text);
    assert_eq!(
        read_table(with_condition(
            json!({"operator": "contains", "value": "я".repeat(1001)})
        )),
        Value::Null
    );
    for (id, valid) in [
        ("я".repeat(512), true),
        ("я".repeat(513), false),
        ("x\n".into(), false),
        (" ".into(), false),
    ] {
        let filters = json!({"columns": {}, "advanced": {"type": "rule", "column": id, "condition": {"operator": "empty"}}});
        assert_eq!(!read_table(filters).is_null(), valid);
    }
}

#[test]
fn cluster_tables_are_bounded_and_require_resource_view_ids() {
    let entries: serde_json::Map<String, Value> = (0..513)
        .map(|i| (format!("kind:/Pod{i:03}"), table()))
        .collect();
    let cluster: ClusterSettings =
        serde_json::from_value(json!({"tableFilters": entries})).unwrap();
    let written = serde_json::to_value(cluster).unwrap();
    assert_eq!(written["tableFilters"].as_object().unwrap().len(), 512);
    for (id, valid) in [
        ("kind:/Pod".to_owned(), true),
        ("kind:apps/Deployment".to_owned(), true),
        (format!("kind:/{}", "я".repeat(506)), true),
        (format!("kind:/{}", "я".repeat(507)), false),
        ("kind:/".to_owned(), false),
        ("kind:Pod".to_owned(), false),
        ("kind:apps/Deployment/extra".to_owned(), false),
        ("kind:/Pod\n".to_owned(), false),
        ("helm.releases".to_owned(), false),
    ] {
        let cluster: ClusterSettings =
            serde_json::from_value(json!({"tableFilters": {&id: table()}})).unwrap();
        assert_eq!(
            serde_json::to_value(cluster)
                .unwrap()
                .get("tableFilters")
                .is_some(),
            valid,
            "{id}"
        );
    }
}

#[test]
fn saved_view_filters_are_optional_and_invalid_filters_do_not_drop_the_view() {
    for filters in [
        Value::Null,
        json!(false),
        json!({"advanced": {"type": "unknown"}}),
    ] {
        let settings: AppSettings = serde_json::from_value(json!({"views": [{"id": "pods", "name": "Prod pods", "kind": "Pod", "search": "web", "tableFilters": filters}]})).unwrap();
        let written = serde_json::to_value(settings).unwrap();
        assert_eq!(written["views"][0]["name"], "Prod pods");
        assert_eq!(written["views"][0]["search"], "web");
        assert!(written["views"][0].get("tableFilters").is_none());
    }
    let view: SavedView = serde_json::from_value(
        json!({"id": "pods", "name": "Pods", "kind": "Pod", "tableFilters": table()}),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(view).unwrap()["tableFilters"], table());
}

#[test]
fn renaming_and_deleting_a_cluster_moves_and_removes_its_filters() {
    use crate::ClusterId;
    use crate::kubeconfig::edit::{forget_cluster_settings, move_cluster_settings};
    let mut settings: AppSettings = serde_json::from_value(json!({"clusters": {"old": {"color": "blue", "tableFilters": {"kind:/Pod": table()}}, "other": {"color": "green"}}})).unwrap();
    move_cluster_settings(
        &mut settings,
        &ClusterId::from("old"),
        &ClusterId::from("new"),
    );
    let written = serde_json::to_value(&settings).unwrap();
    assert_eq!(
        written["clusters"]["new"]["tableFilters"]["kind:/Pod"],
        table()
    );
    assert!(written["clusters"].get("old").is_none());
    forget_cluster_settings(&mut settings, &ClusterId::from("new"));
    let written = serde_json::to_value(settings).unwrap();
    assert!(written["clusters"].get("new").is_none());
    assert_eq!(written["clusters"]["other"]["color"], "green");
}
