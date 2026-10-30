use serde_json::{Value, json};

use super::*;
use crate::extensions::parse_manifest;

fn base(translations: Value) -> Value {
    json!({
        "id": "ceph", "name": "Ceph", "version": "1.0.0", "description": "Ceph at a glance", "author": "Me",
        "sextantApi": 2, "entry": "index.html",
        "permissions": { "clusters": { "type": "all" }, "rules": [] },
        "contributes": {
            "pages": [{ "id": "overview", "title": "Ceph", "section": "storage" }],
            "columns": [{ "kind": { "group": "ceph.rook.io", "kind": "CephCluster" }, "id": "version",
                          "title": "Version", "jsonPath": ".status.version.version" }],
            "problems": [
                { "id": "error", "title": "Ceph error", "kind": { "group": "ceph.rook.io", "kind": "CephCluster" },
                  "when": { "type": "exists", "path": ".status" },
                  "message": "{{.status.ceph.health}} in {{.metadata.name}}" },
                { "id": "warn", "title": "Ceph warning", "kind": { "group": "ceph.rook.io", "kind": "CephCluster" },
                  "when": { "type": "exists", "path": ".status" }, "message": "warning" }
            ],
            "metricQueries": [{ "id": "health", "title": "Health", "query": "up" }]
        },
        "translations": translations
    })
}

fn parse(value: &Value) -> Result<ExtensionManifest, ManifestError> {
    parse_manifest(value.to_string().as_bytes())
}

fn error_of(translations: Value) -> (String, String) {
    let err = parse(&base(translations)).unwrap_err();
    (err.path, err.message)
}

#[test]
fn translations_of_every_text_are_read() {
    let manifest = parse(&base(json!({
        "ru": {
            "name": "Ceph", "description": "Ceph с первого взгляда", "pages.overview.title": "Ceph",
            "columns.version.title": "Версия", "problems.error.title": "Ошибка Ceph",
            "problems.error.message": "{{.metadata.name}}: {{.status.ceph.health}}",
            "metricQueries.health.title": "Состояние"
        },
        "pt-BR": { "problems.warn.title": "Aviso do Ceph" }
    })))
    .unwrap();
    assert_eq!(
        manifest.translations["ru"]["columns.version.title"],
        "Версия"
    );
    assert_eq!(manifest.translations.len(), 2);
}

#[test]
fn a_manifest_without_translations_has_none() {
    let mut value = base(json!({}));
    value.as_object_mut().unwrap().remove("translations");
    assert!(parse(&value).unwrap().translations.is_empty());
}

#[test]
fn only_texts_of_the_manifest_can_be_translated() {
    assert_eq!(
        error_of(json!({ "de": { "pages.missing.title": "x" } })),
        (
            "translations.de.pages.missing.title".to_owned(),
            "`pages.missing.title` is not a text of this manifest".to_owned()
        )
    );
    // A query is never translated, only its title.
    assert_eq!(
        error_of(json!({ "de": { "metricQueries.health.query": "x" } })).1,
        "`metricQueries.health.query` is not a text of this manifest"
    );
    // A section title only where the page has one.
    assert_eq!(
        error_of(json!({ "de": { "pages.overview.sectionTitle": "x" } })).1,
        "`pages.overview.sectionTitle` is not a text of this manifest"
    );
}

#[test]
fn a_message_keeps_the_english_placeholders() {
    let (path, message) =
        error_of(json!({ "de": { "problems.error.message": "{{.metadata.name}}" } }));
    assert_eq!(path, "translations.de.problems.error.message");
    assert_eq!(
        message,
        "must have the same `{{…}}` placeholders as the English message"
    );
    assert_eq!(
        error_of(json!({ "de": { "problems.error.message": "{{.metadata.name}} {{.status.ceph.health}} {{.spec.x}}" } })).1,
        "must have the same `{{…}}` placeholders as the English message"
    );
    assert_eq!(
        error_of(json!({ "de": { "problems.warn.message": "Warnung {{.metadata.name}}" } })).1,
        "must have the same `{{…}}` placeholders as the English message"
    );
}

#[test]
fn translations_keep_the_limits_of_their_texts() {
    let long = "x".repeat(81);
    assert_eq!(
        error_of(json!({ "de": { "columns.version.title": long } })).1,
        "must be at most 80 characters"
    );
    assert_eq!(
        error_of(json!({ "de": { "name": "   " } })).1,
        "must not be blank"
    );
    assert!(parse(&base(json!({ "de": { "description": "x".repeat(500) } }))).is_ok());
    assert_eq!(
        error_of(json!({ "de": { "description": "x".repeat(501) } })).1,
        "must be at most 500 characters"
    );
}

#[test]
fn language_tags_are_checked_and_english_is_the_manifest() {
    for tag in ["de", "pt-BR", "zh-CN", "zh-TW", "sr-Latn", "es-419", "fil"] {
        assert!(is_language_tag(tag), "{tag}");
    }
    for tag in [
        "DE",
        "pt-br",
        "pt_BR",
        "e",
        "deutsch",
        "zh-cn-x",
        "",
        "zh-Hans-CN-x",
    ] {
        assert!(!is_language_tag(tag), "{tag}");
    }
    assert_eq!(
        error_of(json!({ "pt_BR": { "name": "x" } })),
        (
            "translations.pt_BR".to_owned(),
            "must be a language tag such as `de`, `pt-BR` or `zh-CN`".to_owned()
        )
    );
    assert_eq!(
        error_of(json!({ "en": { "name": "x" } })).1,
        "English is the manifest itself: translate to other languages only"
    );
}

#[test]
fn rule_titles_stay_unique_in_every_language() {
    assert_eq!(
        error_of(json!({ "de": { "problems.warn.title": "Ceph error" } })),
        (
            "translations.de.problems.warn.title".to_owned(),
            "is also the title of the rule `error` in this language".to_owned()
        )
    );
}

#[test]
fn translations_need_api_2() {
    let mut value = base(json!({ "de": { "name": "Ceph" } }));
    value["sextantApi"] = json!(1);
    value["contributes"]["problems"] = json!([]);
    value["contributes"]["metricQueries"] = json!([]);
    let err = parse(&value).unwrap_err();
    assert_eq!(
        (err.path.as_str(), err.message.as_str()),
        ("translations", "needs sextantApi 2 or later")
    );
}

#[test]
fn the_schema_bounds_languages_and_texts() {
    let many: serde_json::Map<String, Value> = (0..=MAX_LANGUAGES)
        .map(|i| {
            (
                format!("l{}", char::from(b'a' + (i % 26) as u8)).repeat(1) + &"x".repeat(i / 26),
                json!({}),
            )
        })
        .collect();
    let err = parse(&base(Value::Object(many))).unwrap_err();
    assert_eq!(err.path, "translations");
    assert_eq!(
        err.message,
        format!("must have at most {MAX_LANGUAGES} entries")
    );
    let err = parse(&base(json!({ "de": { "name": "" } }))).unwrap_err();
    assert_eq!(
        (err.path.as_str(), err.message.as_str()),
        ("translations.de.name", "must not be empty")
    );
    let err = parse(&base(json!({ "de": { "name": 1 } }))).unwrap_err();
    assert_eq!(err.message, "must be a string");
}
