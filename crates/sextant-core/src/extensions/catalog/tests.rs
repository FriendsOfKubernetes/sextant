//! The fixtures are the SDK's (`sdk/test/fixtures/catalog/`): a package signed by the SDK's minisign code and the index
//! the SDK's `buildIndex` writes for it, so the app reads exactly what the catalog workflow produces.

use serde_json::{Value, json};

use super::*;
use crate::extensions::{ExtensionPermissions, parse_manifest};

const INDEX: &[u8] = include_bytes!("../../../../../sdk/test/fixtures/catalog/index.json");
const PACKAGE: &[u8] =
    include_bytes!("../../../../../sdk/test/fixtures/catalog/demo.catalog-1.0.0.sextant-ext");
const SIGNATURE: &[u8] = include_bytes!(
    "../../../../../sdk/test/fixtures/catalog/demo.catalog-1.0.0.sextant-ext.minisig"
);
const OTHER_KEY: &str = include_str!("../../../../../sdk/test/fixtures/catalog/other.pub");

fn index() -> CatalogIndex {
    parse_index(INDEX).unwrap()
}

fn demo() -> CatalogEntry {
    index()
        .entries
        .into_iter()
        .find(|e| e.id == "demo.catalog")
        .unwrap()
}

fn index_value() -> Value {
    serde_json::from_slice(INDEX).unwrap()
}

/// The fixture index with its first entry changed by `edit`.
fn with_entry(edit: impl FnOnce(&mut serde_json::Map<String, Value>)) -> CatalogIndex {
    let mut value = index_value();
    edit(value["extensions"][0].as_object_mut().unwrap());
    parse_index(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn installed(version: &str, source: ExtensionSource) -> InstalledExtension {
    InstalledExtension {
        id: "demo.catalog".into(),
        version: version.into(),
        name: "Catalog demo".into(),
        source,
        enabled: true,
        granted: ExtensionPermissions::none(),
        installed_at: 0,
    }
}

#[test]
fn the_index_the_sdk_writes_reads_whole() {
    let index = index();
    assert_eq!(index.skipped, 0);
    assert_eq!(
        index.generated_at.as_deref(),
        Some("2026-10-28T12:00:00.000Z")
    );
    let demo = &index.entries[0];
    assert_eq!(demo.id, "demo.catalog");
    assert_eq!(
        demo.categories,
        [CatalogCategory::Developer, CatalogCategory::Workloads]
    );
    assert_eq!(demo.repository, "FriendsOfKubernetes/demo");
    let latest = demo.latest.as_ref().unwrap();
    assert_eq!(latest.version, "1.0.0");
    assert_eq!(latest.key_id, demo.key_id);
    assert_eq!(latest.size, PACKAGE.len() as u64);
    assert_eq!(latest.contributes.pages, 1);
    assert!(latest.permissions.is_some());
    let withdrawn = &index.entries[1];
    assert_eq!(withdrawn.withdrawn.as_deref(), Some("A known-bad release"));
    assert!(withdrawn.latest.is_none());
}

#[test]
fn a_package_is_accepted_only_as_listed_and_signed_by_the_entrys_key() {
    let entry = demo();
    let release = entry.latest.clone().unwrap();
    verify_package(&entry, &release, PACKAGE, SIGNATURE).unwrap();

    let mut changed = PACKAGE.to_vec();
    let at = changed.len() - 30;
    changed[at] ^= 1;
    let err = verify_package(&entry, &release, &changed, SIGNATURE).unwrap_err();
    assert_eq!(
        err.message,
        "The downloaded package of demo.catalog 1.0.0 is not the one the catalog lists"
    );

    // The index lists the changed package (a compromised index): its signature still fails.
    let mut listed = release.clone();
    listed.sha256 = hex(&Sha256::digest(&changed));
    let err = verify_package(&entry, &listed, &changed, SIGNATURE).unwrap_err();
    assert!(
        err.message.starts_with(
            "The package of demo.catalog 1.0.0 is not signed with the publisher's key "
        ),
        "{}",
        err.message
    );

    // Another key in the entry: refused.
    let mut other = entry.clone();
    other.publisher_key = OTHER_KEY.lines().nth(1).unwrap().to_owned();
    assert!(verify_package(&other, &release, PACKAGE, SIGNATURE).is_err());

    assert_eq!(
        verify_package(&entry, &release, PACKAGE, b"not a signature")
            .unwrap_err()
            .message,
        "The package's signature cannot be read"
    );
    assert!(verify_package(&entry, &release, PACKAGE, &vec![b'a'; 5000]).is_err());
}

#[test]
fn the_manifest_must_be_the_listed_one() {
    let entry = demo();
    let release = entry.latest.clone().unwrap();
    let package = crate::extensions::inspect_zip(PACKAGE).unwrap();
    check_manifest(&entry, &release, &package.manifest).unwrap();
    let mut later = release.clone();
    later.version = "1.0.1".into();
    assert_eq!(
        check_manifest(&entry, &later, &package.manifest)
            .unwrap_err()
            .message,
        "The package says it is demo.catalog 1.0.0, but the catalog lists demo.catalog 1.0.1"
    );
    let _ = parse_manifest;
}

#[test]
fn urls_are_built_from_checked_parts_only() {
    let entry = demo();
    let release = entry.latest.clone().unwrap();
    let (package, signature) = release_urls(&entry, &release).unwrap();
    assert_eq!(
        package,
        "https://github.com/FriendsOfKubernetes/demo/releases/download/v1.0.0/demo.catalog-1.0.0.sextant-ext"
    );
    assert_eq!(signature, format!("{package}.minisig"));
    let mut bad = release.clone();
    bad.tag = "../x".into();
    assert!(release_urls(&entry, &bad).is_err());
    let mut elsewhere = entry.clone();
    elsewhere.repository = "a/b/c".into();
    assert!(release_urls(&elsewhere, &release).is_err());
}

#[test]
fn an_entry_that_breaks_a_rule_is_left_out_and_the_rest_still_reads() {
    type Edit = Box<dyn Fn(&mut serde_json::Map<String, Value>)>;
    let cases: Vec<(&str, Edit)> = vec![
        (
            "unknown field",
            Box::new(|e| {
                e.insert("homepage".into(), json!("https://x"));
            }),
        ),
        (
            "bad id",
            Box::new(|e| {
                e.insert("id".into(), json!("Demo"));
            }),
        ),
        (
            "bad repository",
            Box::new(|e| {
                e.insert("repository".into(), json!("https://github.com/a/b"));
            }),
        ),
        (
            "bidi in the name",
            Box::new(|e| {
                e.insert("name".into(), json!("Demo\u{202e}txt.exe"));
            }),
        ),
        (
            "long description",
            Box::new(|e| {
                e.insert("description".into(), json!("x".repeat(501)));
            }),
        ),
        (
            "unknown category",
            Box::new(|e| {
                e.insert("categories".into(), json!(["games"]));
            }),
        ),
        (
            "twice a category",
            Box::new(|e| {
                e.insert("categories".into(), json!(["cost", "cost"]));
            }),
        ),
        (
            "not a key",
            Box::new(|e| {
                e.insert("publisherKey".into(), json!("RWQ="));
            }),
        ),
        (
            "withdrawn with more",
            Box::new(|e| {
                e.insert("withdrawn".into(), json!({"reason": "x", "by": "y"}));
            }),
        ),
    ];
    for (what, edit) in cases {
        let index = with_entry(|e| edit(e));
        assert_eq!(index.skipped, 1, "{what}");
        assert_eq!(index.entries.len(), 1, "{what}");
        assert_eq!(index.entries[0].id, "demo.withdrawn", "{what}");
    }

    let mut value = index_value();
    let first = value["extensions"][0].clone();
    value["extensions"].as_array_mut().unwrap().push(first);
    let doubled = parse_index(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!((doubled.entries.len(), doubled.skipped), (2, 1));
}

#[test]
fn a_release_block_that_does_not_read_leaves_the_entry_without_a_release() {
    let tag = with_entry(|e| {
        e["latest"]["tag"] = json!("release/1");
    });
    assert!(tag.entries[0].latest.is_none());
    let version = with_entry(|e| {
        e["latest"]["version"] = json!("1.0.1");
    });
    assert!(version.entries[0].latest.is_none());
    let digest = with_entry(|e| {
        e["latest"]["sha256"] = json!("ABC");
    });
    assert!(digest.entries[0].latest.is_none());
    // Permissions this Sextant cannot read are not shown as asking for nothing.
    let permissions = with_entry(|e| {
        e["latest"]["permissions"]["rules"][0]["actions"] = json!(["exec"]);
    });
    let latest = permissions.entries[0].latest.as_ref().unwrap();
    assert!(latest.permissions.is_none());
    // A contribution type of a newer workflow is ignored, not an error.
    let counts = with_entry(|e| {
        e["latest"]["contributes"] = json!({"pages": 2, "widgets": 1});
    });
    assert_eq!(
        counts.entries[0].latest.as_ref().unwrap().contributes.pages,
        2
    );
}

#[test]
fn an_index_of_another_format_is_refused_with_a_reason() {
    let mut value = index_value();
    value["schemaVersion"] = json!(2);
    let err = parse_index(&serde_json::to_vec(&value).unwrap()).unwrap_err();
    assert!(err.message.starts_with(NEWER_INDEX), "{}", err.message);
    value["schemaVersion"] = json!("1");
    assert!(parse_index(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(parse_index(b"<html>").is_err());
    assert!(parse_index(&vec![b' '; MAX_INDEX_BYTES as usize + 1]).is_err());
}

#[test]
fn an_installed_catalog_extension_is_judged_against_its_pinned_repository_and_key() {
    let entry = demo();
    let pinned = catalog_source(&entry);
    let index = index();
    assert_eq!(
        status_of(&installed("1.0.0", pinned.clone()), &index),
        Some(CatalogStatus::UpToDate)
    );
    assert_eq!(
        status_of(&installed("0.9.0", pinned.clone()), &index),
        Some(CatalogStatus::UpdateAvailable {
            version: "1.0.0".into()
        })
    );
    // A pre-release of the listed version is not newer than it.
    assert_eq!(
        status_of(&installed("1.0.0-beta.1", pinned.clone()), &index),
        Some(CatalogStatus::UpToDate)
    );
    let newer_api = with_entry(|e| {
        e["latest"]["sextantApi"] = json!(2);
    });
    assert_eq!(
        status_of(&installed("0.9.0", pinned.clone()), &newer_api),
        Some(CatalogStatus::NeedsNewerSextant {
            version: "1.0.0".into()
        })
    );
    let rekeyed = with_entry(|e| {
        e["publisherKey"] = json!(OTHER_KEY.lines().nth(1).unwrap());
    });
    assert_eq!(
        status_of(&installed("0.9.0", pinned.clone()), &rekeyed),
        Some(CatalogStatus::KeyChanged)
    );
    let moved = with_entry(|e| {
        e["repository"] = json!("someone/else");
    });
    assert_eq!(
        status_of(&installed("0.9.0", pinned.clone()), &moved),
        Some(CatalogStatus::RepositoryChanged)
    );
    let withdrawn = with_entry(|e| {
        e.insert("withdrawn".into(), json!({"reason": "Bad"}));
    });
    assert_eq!(
        status_of(&installed("1.0.0", pinned.clone()), &withdrawn),
        Some(CatalogStatus::Withdrawn {
            reason: "Bad".into()
        })
    );
    assert_eq!(
        status_of(&installed("1.0.0", pinned), &CatalogIndex::default()),
        Some(CatalogStatus::NotListed)
    );
    let file = ExtensionSource::File {
        name: "x.sextant-ext".into(),
    };
    assert_eq!(status_of(&installed("1.0.0", file), &index), None);
}

#[test]
fn an_update_must_come_from_the_pinned_repository_and_key_and_not_go_back() {
    let entry = demo();
    let release = entry.latest.clone().unwrap();
    let pinned = catalog_source(&entry);
    check_update(&installed("0.9.0", pinned.clone()), &entry, &release).unwrap();
    check_update(&installed("1.0.0", pinned.clone()), &entry, &release).unwrap();
    let err = check_update(&installed("1.2.0", pinned.clone()), &entry, &release).unwrap_err();
    assert_eq!(
        err.message,
        "The catalog lists demo.catalog 1.0.0, older than the installed 1.2.0"
    );

    let mut rekeyed = entry.clone();
    rekeyed.publisher_key = OTHER_KEY.lines().nth(1).unwrap().to_owned();
    let err = check_update(&installed("0.9.0", pinned.clone()), &rekeyed, &release).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(
        err.message,
        "The publisher's key changed in the catalog. Remove the extension and install it again to trust the new key."
    );
    let mut moved = entry.clone();
    moved.repository = "someone/else".into();
    let err = check_update(&installed("0.9.0", pinned), &moved, &release).unwrap_err();
    assert!(
        err.message
            .starts_with("The publisher's repository changed"),
        "{}",
        err.message
    );
}

#[test]
fn the_key_id_is_minisigns() {
    assert_eq!(
        public_key_id(&demo().publisher_key).as_deref(),
        Some("C0F4B41AA942C166")
    );
    assert_eq!(public_key_id("RWQ="), None);
    assert!(is_repository("FriendsOfKubernetes/sextant-extensions"));
    assert!(!is_repository("a/.."));
    assert!(is_release_tag("v1.2.3+build.4"));
    assert!(!is_release_tag("v1/2"));
    assert_eq!(
        asset_version("a.b", "a.b-1.2.3.sextant-ext").as_deref(),
        Some("1.2.3")
    );
    assert_eq!(asset_version("a.b", "a.b-1.2.3-rc.1.sextant-ext"), None);
    assert_eq!(asset_version("a.b", "a.b-01.2.3.sextant-ext"), None);
    let _ = ExtensionPermissions::none();
}
