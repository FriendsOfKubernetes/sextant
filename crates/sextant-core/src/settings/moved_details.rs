//! The open or closed choices of details blocks, and the column widths of tables, of views that moved into Sextant's
//! own extensions (ADR-0162; ADR-0167 amendment): carried over once by the version-3 migration, so a block the user
//! closed in a built-in view stays closed in its extension, and a table keeps its widths.
//!
//! `moved_details.json` maps each path the built-in view wrote (`<section>/<block>[/<nested block>]`, Sextant 0.29.2)
//! to the extension's (`ext:<extension>:<section>/<section>/<block>`, the frame's block bank), only under the kinds it
//! names where the extension split one section by kind; and each table id to the extension's (`ext:<extension>:<table>`).
//! A choice or width already kept under the new key wins.

use std::sync::OnceLock;

use serde::Deserialize;

use super::appearance::DetailsSections;
use super::columns::ColumnWidths;

#[derive(Deserialize)]
struct Moved {
    blocks: Vec<MovedBlock>,
    tables: Vec<MovedTable>,
}

#[derive(Deserialize)]
struct MovedBlock {
    old: String,
    new: String,
    /// The kinds (`<group>/<Kind>`) it holds for; every kind when absent.
    #[serde(default)]
    kinds: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct MovedTable {
    old: String,
    new: String,
    /// The core still draws the old table too (an HPA's metrics, a node's events): the widths are copied, not moved.
    #[serde(default)]
    copy: bool,
}

fn moved() -> &'static Moved {
    static MOVED: OnceLock<Moved> = OnceLock::new();
    MOVED.get_or_init(|| {
        serde_json::from_str(include_str!("moved_details.json")).expect("moved_details.json reads")
    })
}

/// The new path of `path` under `kind`, if it moved.
fn moved_path(kind: &str, path: &str) -> Option<&'static str> {
    moved()
        .blocks
        .iter()
        .find(|b| b.old == path && b.kinds.as_ref().is_none_or(|k| k.iter().any(|k| k == kind)))
        .map(|b| b.new.as_str())
}

/// Moves the choices of moved blocks in one bank of choices (global or a cluster's).
pub(crate) fn move_details_choices(sections: &mut DetailsSections) {
    for (kind, choices) in sections.iter_mut() {
        let moves: Vec<(String, &'static str)> = choices
            .keys()
            .filter_map(|path| moved_path(kind, path).map(|new| (path.clone(), new)))
            .collect();
        for (old, new) in moves {
            if let Some(open) = choices.remove(&old) {
                choices.entry(new.to_owned()).or_insert(open);
            }
        }
    }
}

/// Moves the widths of moved tables.
pub(crate) fn move_column_widths(widths: &mut ColumnWidths) {
    for table in &moved().tables {
        let entry = if table.copy {
            widths.get(&table.old).cloned()
        } else {
            widths.remove(&table.old)
        };
        if let Some(entry) = entry {
            widths.entry(table.new.clone()).or_insert(entry);
        }
    }
}

/// Old → new paths, for tests.
#[cfg(test)]
pub(crate) fn moved_blocks() -> std::collections::BTreeMap<(String, Option<Vec<String>>), String> {
    moved()
        .blocks
        .iter()
        .map(|b| ((b.old.clone(), b.kinds.clone()), b.new.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::settings::columns::TableColumnWidths;

    fn bank(kind: &str, entries: &[(&str, bool)]) -> DetailsSections {
        let mut sections = DetailsSections::new();
        sections.insert(
            kind.to_owned(),
            entries.iter().map(|(p, o)| ((*p).to_owned(), *o)).collect(),
        );
        sections
    }

    #[test]
    fn the_map_reads_and_every_new_path_is_an_extensions_block_bank() {
        let blocks = moved_blocks();
        assert!(blocks.len() > 150);
        for ((old, _), new) in &blocks {
            assert!(!old.starts_with("ext:"), "{old}");
            let ok = new.starts_with("tlsCertificate/") || {
                // `ext:<extension>:<section>/<section>/<block>`
                let mut parts = new.splitn(3, '/');
                let (scope, again, block) = (parts.next().unwrap(), parts.next(), parts.next());
                let section = scope.rsplit(':').next().unwrap();
                scope.starts_with("ext:sextant.")
                    && again == Some(section)
                    && block.is_some_and(|b| !b.contains('/'))
            };
            assert!(ok, "{new}");
        }
    }

    #[test]
    fn a_closed_block_of_a_built_in_view_stays_closed_in_its_extension() {
        let mut sections = bank(
            "apiextensions.crossplane.io/CompositeResourceDefinition",
            &[
                ("crossplane/details:sections.fields", false),
                ("summary/x", true),
                ("*", false),
            ],
        );
        sections.extend(bank(
            "example.org/XDatabase",
            &[("crossplaneResource/crossplane:chain.title", false)],
        ));
        move_details_choices(&mut sections);
        assert_eq!(
            sections["apiextensions.crossplane.io/CompositeResourceDefinition"],
            BTreeMap::from([
                (
                    "ext:sextant.crossplane:crossplane/crossplane/fields".to_owned(),
                    false
                ),
                ("summary/x".to_owned(), true),
                ("*".to_owned(), false),
            ])
        );
        assert_eq!(
            sections["example.org/XDatabase"],
            BTreeMap::from([(
                "ext:sextant.crossplane:crossplane-resource/crossplane-resource/chain".to_owned(),
                false
            )])
        );
    }

    #[test]
    fn a_path_split_by_kind_moves_only_under_its_kinds_and_a_newer_choice_wins() {
        let mut sections = bank(
            "cert-manager.io/Certificate",
            &[(
                "certManager/details:sections.fields/certmanager:lastFailure.title",
                false,
            )],
        );
        sections.extend(bank(
            "cert-manager.io/Issuer",
            &[(
                "certManager/details:sections.fields/certmanager:lastFailure.title",
                false,
            )],
        ));
        sections.extend(bank(
            "apiextensions.crossplane.io/Composition",
            &[
                ("crossplane/details:sections.fields", false),
                ("ext:sextant.crossplane:crossplane/crossplane/fields", true),
            ],
        ));
        move_details_choices(&mut sections);
        assert_eq!(
            sections["cert-manager.io/Certificate"],
            BTreeMap::from([(
                "ext:sextant.cert-manager:certmanager/certmanager/lastFailure".to_owned(),
                false
            )])
        );
        assert_eq!(
            sections["cert-manager.io/Issuer"],
            BTreeMap::from([(
                "certManager/details:sections.fields/certmanager:lastFailure.title".to_owned(),
                false
            )])
        );
        assert_eq!(
            sections["apiextensions.crossplane.io/Composition"],
            BTreeMap::from([(
                "ext:sextant.crossplane:crossplane/crossplane/fields".to_owned(),
                true
            )])
        );
    }

    #[test]
    fn the_moved_tables_widths_move_to_their_extensions() {
        let entry = TableColumnWidths {
            columns: BTreeMap::from([("1".to_owned(), 240)]),
            used: 5,
        };
        let mut widths = ColumnWidths::from([
            ("crossplane.composites".to_owned(), entry.clone()),
            ("details:hpa.metrics".to_owned(), entry.clone()),
            ("helm.releases".to_owned(), entry.clone()),
        ]);
        move_column_widths(&mut widths);
        assert_eq!(
            widths.keys().cloned().collect::<Vec<_>>(),
            [
                "details:hpa.metrics",
                "ext:sextant.crossplane:composites",
                "ext:sextant.keda:hpaMetrics",
                "helm.releases"
            ]
        );
        assert_eq!(widths["ext:sextant.crossplane:composites"], entry);
        // The core's HPA section still draws its metrics table: copied, not moved.
        assert_eq!(widths["ext:sextant.keda:hpaMetrics"], entry);
    }
}
