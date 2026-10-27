//! Known namespaces of a cluster (#285, ADR-0124): the namespaces the user typed or selected in the namespace filter,
//! or added in the cluster settings ("Accessible namespaces"). A user who may not list Namespaces sees them in the
//! filter even when unticked, and "All namespaces" means these (with the ones found when connecting) instead of a
//! cluster-wide list the API server refuses. Written by the frontend; carried over by a context rename and dropped
//! with a deleted context like the rest of `ClusterSettings`.
//!
//! Read leniently like the other frontend-written settings: a value that is not a list reads as none, and an entry
//! that is not a namespace name (DNS-1123 label), a repeated one and the ones past [`MAX_KNOWN_NAMESPACES`] are left
//! out instead of failing the file.

/// Known namespaces kept per cluster.
pub const MAX_KNOWN_NAMESPACES: usize = 200;

/// A DNS-1123 label (a namespace name): lowercase letters, digits and `-`, at most 63, alphanumeric at both ends.
fn is_dns_label(text: &str) -> bool {
    let bytes = text.as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(alnum)
        && bytes.last().is_some_and(alnum)
        && bytes.iter().all(|b| alnum(b) || *b == b'-')
}

/// Reads a stored `knownNamespaces` leniently (see the module's header); `None` when nothing is left.
pub fn read(value: &serde_json::Value) -> Option<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    for entry in value.as_array()? {
        if names.len() == MAX_KNOWN_NAMESPACES {
            break;
        }
        let Some(name) = entry.as_str().map(str::trim) else {
            continue;
        };
        if is_dns_label(name) && !names.iter().any(|n| n == name) {
            names.push(name.to_owned());
        }
    }
    (!names.is_empty()).then_some(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn names_are_kept_in_order_without_repeats_or_what_is_not_a_namespace() {
        let stored = json!([
            "team-a",
            "Team-B",
            "team-a",
            7,
            null,
            "",
            "-x",
            "a.b",
            " team-c ",
            "x".repeat(64),
            "y".repeat(63)
        ]);
        assert_eq!(
            read(&stored),
            Some(vec![
                "team-a".to_owned(),
                "team-c".to_owned(),
                "y".repeat(63)
            ])
        );
    }

    #[test]
    fn nothing_usable_reads_as_none_and_the_list_is_capped() {
        assert_eq!(read(&json!("team-a")), None);
        assert_eq!(read(&json!({"0": "team-a"})), None);
        assert_eq!(read(&json!([])), None);
        assert_eq!(read(&json!(["NOPE"])), None);
        let many: Vec<String> = (0..MAX_KNOWN_NAMESPACES + 50)
            .map(|i| format!("ns-{i}"))
            .collect();
        let kept = read(&json!(many)).unwrap();
        assert_eq!(kept.len(), MAX_KNOWN_NAMESPACES);
        assert_eq!(kept[0], "ns-0");
    }

    #[test]
    fn a_cluster_keeps_its_known_namespaces_and_a_bad_value_does_not_fail_the_file() {
        let text = json!({
            "clusters": {
                "a": { "displayName": "A", "knownNamespaces": ["team-a", "BAD", "team-b"] },
                "b": { "displayName": "B", "knownNamespaces": { "team-a": true } },
                "c": { "displayName": "C" }
            }
        })
        .to_string();
        let settings: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(
            settings.clusters["a"].known_namespaces.as_deref(),
            Some(&["team-a".to_owned(), "team-b".to_owned()][..])
        );
        assert_eq!(settings.clusters["b"].display_name.as_deref(), Some("B"));
        assert_eq!(settings.clusters["b"].known_namespaces, None);
        assert_eq!(settings.clusters["c"].known_namespaces, None);
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            written["clusters"]["a"]["knownNamespaces"],
            json!(["team-a", "team-b"])
        );
        assert!(written["clusters"]["b"].get("knownNamespaces").is_none());
        // Written and read again: the same.
        let back: AppSettings = serde_json::from_value(written).unwrap();
        assert_eq!(back.clusters["a"], settings.clusters["a"]);
    }

    #[test]
    fn known_namespaces_move_with_a_renamed_context_and_go_with_a_deleted_one() {
        use crate::kubeconfig::ClusterId;
        use crate::kubeconfig::edit::{forget_cluster_settings, move_cluster_settings};
        let mut settings = AppSettings::default();
        let known = Some(vec!["team-a".to_owned()]);
        settings.clusters.insert(
            "old".into(),
            crate::settings::ClusterSettings {
                known_namespaces: known.clone(),
                ..Default::default()
            },
        );
        move_cluster_settings(
            &mut settings,
            &ClusterId::from("old"),
            &ClusterId::from("new"),
        );
        assert!(!settings.clusters.contains_key("old"));
        assert_eq!(settings.clusters["new"].known_namespaces, known);
        forget_cluster_settings(&mut settings, &ClusterId::from("new"));
        assert!(!settings.clusters.contains_key("new"));
    }
}
