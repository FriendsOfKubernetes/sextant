//! Extensions released by earlier Sextants and SDKs keep working (ADR-0142): the frozen packages and settings of
//! `sdk/test/fixtures/compat/` are read by today's checks exactly as they were then.
use super::*;
use crate::settings::AppSettings;
use std::path::{Path, PathBuf};

fn compat_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdk/test/fixtures/compat")
}

/// Every frozen package, sorted.
fn frozen_packages() -> Vec<PathBuf> {
    let mut found = Vec::new();
    for era in std::fs::read_dir(compat_dir()).unwrap() {
        let era = era.unwrap().path();
        if !era.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(&era).unwrap() {
            let file = file.unwrap().path();
            if file.extension().is_some_and(|e| e == "sextant-ext") {
                found.push(file);
            }
        }
    }
    found.sort();
    found
}

fn inspect(path: &Path) -> Package {
    inspect_zip(&std::fs::read(path).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn every_frozen_package_is_accepted_and_installs() {
    let packages = frozen_packages();
    assert!(packages.len() >= 7, "{packages:?}");
    let dir = tempfile::tempdir().unwrap();
    for path in packages {
        let package = inspect(&path);
        assert!(
            supports_api(package.manifest.sextant_api.into()),
            "{}",
            path.display()
        );
        install(&package, dir.path()).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    }
}

#[test]
fn grants_stored_by_earlier_sextants_are_read_and_still_cover_their_packages() {
    let packages: Vec<Package> = frozen_packages().iter().map(|p| inspect(p)).collect();
    let mut files: Vec<PathBuf> = std::fs::read_dir(compat_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("settings-")
        })
        .collect();
    files.sort();
    assert!(files.len() >= 4, "{files:?}");
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        let written: serde_json::Value = serde_json::from_str(&text).unwrap();
        let settings: AppSettings = serde_json::from_str(&text).unwrap();
        // None left out, none disabled: every entry is one this Sextant reads as it was.
        assert_eq!(
            settings.extensions.len(),
            written["extensions"].as_array().unwrap().len(),
            "{}",
            file.display()
        );
        for entry in &settings.extensions {
            assert!(entry.enabled, "{}: {}", file.display(), entry.id);
            let package = packages
                .iter()
                .find(|p| p.manifest.id == entry.id && p.manifest.version == entry.version)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: no package {} {}",
                        file.display(),
                        entry.id,
                        entry.version
                    )
                });
            // The same package asks for nothing beyond what was granted then: no consent again.
            assert!(
                asks_within(&package.manifest, &entry.granted, Granted::of(entry)),
                "{}: {} {} needs consent again",
                file.display(),
                entry.id,
                entry.version
            );
        }
    }
}
