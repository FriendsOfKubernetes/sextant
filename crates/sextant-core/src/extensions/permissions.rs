//! What an extension may do in clusters, in the AI agent's access model ([`crate::access`]) with one more dimension:
//! the clusters, by kubeconfig context name. The manifest asks ([`ExtensionManifest::permissions`]), the user grants
//! at install ([`InstalledExtension::granted`]), and every API call of the extension is decided by
//! [`decide_extension`] against what was granted.
//!
//! An extension never gets Exec or Port forward: only [`EXTENSION_ACTIONS`]. Secret values are their own action, as for
//! the agent.
//!
//! [`ExtensionManifest::permissions`]: super::ExtensionManifest::permissions
//! [`InstalledExtension::granted`]: super::InstalledExtension::granted

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::access::{
    self, AccessAction, AccessPreset, AccessRule, ClusterAccess, Decision, KindPattern, KindScope,
    NamespaceScope,
};

/// The actions an extension may ask for. Exec and Port forward are not available to extensions.
pub const EXTENSION_ACTIONS: [AccessAction; 5] = [
    AccessAction::Read,
    AccessAction::Modify,
    AccessAction::Delete,
    AccessAction::Logs,
    AccessAction::SecretValues,
];

/// Clusters an extension may reach, by kubeconfig context name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ClusterScope {
    /// Every cluster Sextant knows, now and later.
    All,
    /// Only these contexts (exact names); a blank name covers nothing.
    Only { names: Vec<String> },
}

impl ClusterScope {
    /// Whether the cluster with this context name is in scope.
    pub fn covers(&self, cluster_name: &str) -> bool {
        match self {
            ClusterScope::All => !cluster_name.trim().is_empty(),
            ClusterScope::Only { names } => {
                !cluster_name.trim().is_empty() && names.iter().any(|n| n == cluster_name)
            }
        }
    }
}

/// Permissions an extension asks for (manifest) or was granted (settings).
///
/// Read from settings, a value that does not parse — an unknown field, action or shape, e.g. written by a newer
/// Sextant or edited by hand — reads as [`ExtensionPermissions::none`], so access stays closed. In a manifest such a
/// value never gets here: the manifest is checked against the schema first and the error names the field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionPermissions {
    pub clusters: ClusterScope,
    /// Rules as in AI agent access; `confirm` asks the user before the rule's Modify and Delete.
    pub rules: Vec<AccessRule>,
}

impl ExtensionPermissions {
    /// No cluster, no rule.
    pub fn none() -> Self {
        Self {
            clusters: ClusterScope::Only { names: Vec::new() },
            rules: Vec::new(),
        }
    }

    /// Whether everything `self` asks for is already given by `granted`: for every cluster, namespace, kind and action,
    /// [`decide_extension`] with `self` is never wider than with `granted` — never allowed where `granted` denies, and
    /// never without a confirmation `granted` asks for (rules decide together: any covering rule that asks wins).
    ///
    /// Exact: the rules are compared at one point per namespace and kind they name, plus one they do not name and no
    /// namespace. Permissions too large to compare that way (more than [`MAX_COMPARED_POINTS`]) count as wider, so the
    /// user is asked again.
    pub fn is_within(&self, granted: &ExtensionPermissions) -> bool {
        if !self.grants_anything() {
            return true;
        }
        clusters_within(&self.clusters, &granted.clusters)
            && rules_within(&self.rules, &granted.rules)
    }

    /// Whether some cluster and some object is covered at all.
    fn grants_anything(&self) -> bool {
        let some_cluster = match &self.clusters {
            ClusterScope::All => true,
            ClusterScope::Only { names } => names.iter().any(|n| !n.trim().is_empty()),
        };
        some_cluster
            && self.rules.iter().any(|rule| {
                rule.actions.iter().any(|a| EXTENSION_ACTIONS.contains(a))
                    && match &rule.namespaces {
                        NamespaceScope::All => true,
                        NamespaceScope::Only { namespaces } => {
                            namespaces.iter().any(|n| !n.trim().is_empty())
                        }
                    }
                    && match &rule.kinds {
                        KindScope::All => true,
                        KindScope::Only { kinds } => !kinds.is_empty(),
                    }
            })
    }
}

/// [`ExtensionPermissions::is_within`] gives up (answers "wider") above this many compared points.
pub const MAX_COMPARED_POINTS: usize = 50_000;

fn clusters_within(asked: &ClusterScope, granted: &ClusterScope) -> bool {
    match (asked, granted) {
        (_, ClusterScope::All) => true,
        (ClusterScope::All, ClusterScope::Only { .. }) => false,
        (ClusterScope::Only { names }, ClusterScope::Only { names: given }) => names
            .iter()
            .filter(|n| !n.trim().is_empty())
            .all(|n| given.contains(n)),
    }
}

/// A name none of `taken` is (compared as `same` does).
fn unlisted(taken: &[String], same: impl Fn(&str, &str) -> bool) -> String {
    let mut name = "\u{1}unlisted".to_owned();
    while taken.iter().any(|t| same(t, &name)) {
        name.push('~');
    }
    name
}

fn custom(rules: &[AccessRule]) -> ClusterAccess {
    // `..default()` keeps this building when the agent's access gains fields; the rules are all an extension has.
    #[allow(clippy::needless_update)]
    ClusterAccess {
        preset: AccessPreset::Custom,
        rules: rules.to_vec(),
        ..ClusterAccess::default()
    }
}

/// The decision only changes at the namespaces and kinds the rules name, so one point per named namespace and kind,
/// one for any other and one for "no namespace" cover every case.
fn rules_within(asked: &[AccessRule], granted: &[AccessRule]) -> bool {
    let all_rules = || asked.iter().chain(granted);
    let mut namespaces: Vec<String> = Vec::new();
    let mut kinds: Vec<KindPattern> = Vec::new();
    for rule in all_rules() {
        if let NamespaceScope::Only { namespaces: listed } = &rule.namespaces {
            for n in listed.iter().filter(|n| !n.trim().is_empty()) {
                if !namespaces.contains(n) {
                    namespaces.push(n.clone());
                }
            }
        }
        if let KindScope::Only { kinds: listed } = &rule.kinds {
            for k in listed {
                if !kinds.iter().any(|known| same_kind(known, k)) {
                    kinds.push(k.clone());
                }
            }
        }
    }
    let other_namespace = unlisted(&namespaces, |a, b| a == b);
    let groups: Vec<String> = kinds.iter().map(|k| k.group.clone()).collect();
    let other_group = unlisted(&groups, |a, b| a.eq_ignore_ascii_case(b));
    kinds.push(KindPattern::new(other_group, "Unlisted"));
    let mut namespace_points: Vec<Option<&str>> =
        namespaces.iter().map(|n| Some(n.as_str())).collect();
    namespace_points.push(Some(&other_namespace));
    namespace_points.push(None);

    let points = namespace_points
        .len()
        .saturating_mul(kinds.len())
        .saturating_mul(EXTENSION_ACTIONS.len());
    if points > MAX_COMPARED_POINTS {
        return false;
    }
    let asked = custom(asked);
    let granted = custom(granted);
    for namespace in &namespace_points {
        for kind in &kinds {
            for action in EXTENSION_ACTIONS {
                match (
                    access::decide(&asked, *namespace, kind, action),
                    access::decide(&granted, *namespace, kind, action),
                ) {
                    (Decision::Denied, _) => {}
                    (Decision::Allowed { .. }, Decision::Denied) => return false,
                    (
                        Decision::Allowed { confirm: asks },
                        Decision::Allowed {
                            confirm: granted_asks,
                        },
                    ) => {
                        if granted_asks && !asks {
                            return false;
                        }
                    }
                }
            }
        }
    }
    true
}

impl Default for ExtensionPermissions {
    fn default() -> Self {
        Self::none()
    }
}

fn same_kind(a: &KindPattern, b: &KindPattern) -> bool {
    a.group.eq_ignore_ascii_case(&b.group) && a.kind.eq_ignore_ascii_case(&b.kind)
}

/// Same shape as [`ExtensionPermissions`]; the strict reading behind its lenient `Deserialize`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionsRepr {
    clusters: ClusterScope,
    rules: Vec<AccessRule>,
}

impl<'de> Deserialize<'de> for ExtensionPermissions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let Ok(PermissionsRepr { clusters, rules }) =
            serde_json::from_value::<PermissionsRepr>(value.clone())
        else {
            return Ok(Self::none());
        };
        let permissions = Self { clusters, rules };
        let only_extension_actions = permissions
            .rules
            .iter()
            .all(|r| r.actions.iter().all(|a| EXTENSION_ACTIONS.contains(a)));
        // serde drops unknown fields of nested types (a rule, a scope): every field read must survive writing the
        // result back, or the permissions are closed.
        match serde_json::to_value(&permissions) {
            Ok(written) if only_extension_actions && only_known_fields(&value, &written) => {
                Ok(permissions)
            }
            _ => Ok(Self::none()),
        }
    }
}

/// Whether every object key in `read` (recursively, arrays element by element) is also in `written`.
pub(crate) fn only_known_fields(read: &serde_json::Value, written: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (read, written) {
        (Value::Object(read), Value::Object(written)) => read.iter().all(|(key, value)| {
            written
                .get(key)
                .is_some_and(|w| only_known_fields(value, w))
        }),
        (Value::Array(read), Value::Array(written)) => {
            read.len() == written.len()
                && read
                    .iter()
                    .zip(written)
                    .all(|(r, w)| only_known_fields(r, w))
        }
        (Value::Object(_) | Value::Array(_), _) => false,
        _ => true,
    }
}

/// May the extension do `action` with an object of `kind` in `namespace` (`None` — an object without a namespace, or
/// all namespaces at once) in the cluster with context name `cluster_name`, and must the user approve it first.
///
/// Denied when the cluster is not in [`ExtensionPermissions::clusters`] or the action is not one of
/// [`EXTENSION_ACTIONS`]; otherwise the rules decide exactly as [`access::decide`] does for the agent.
pub fn decide_extension(
    permissions: &ExtensionPermissions,
    cluster_name: &str,
    namespace: Option<&str>,
    kind: &KindPattern,
    action: AccessAction,
) -> Decision {
    if !EXTENSION_ACTIONS.contains(&action) || !permissions.clusters.covers(cluster_name) {
        return Decision::Denied;
    }
    let access = custom(&permissions.rules);
    access::decide(&access, namespace, kind, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use AccessAction::*;
    use serde_json::json;

    fn pod() -> KindPattern {
        KindPattern::new("", "Pod")
    }

    fn node() -> KindPattern {
        KindPattern::new("", "Node")
    }

    fn rule(
        namespaces: NamespaceScope,
        kinds: KindScope,
        actions: Vec<AccessAction>,
        confirm: bool,
    ) -> AccessRule {
        AccessRule {
            namespaces,
            kinds,
            actions,
            confirm,
        }
    }

    fn only_ns(names: &[&str]) -> NamespaceScope {
        NamespaceScope::Only {
            namespaces: names.iter().map(|n| n.to_string()).collect(),
        }
    }

    fn only_kinds(kinds: &[KindPattern]) -> KindScope {
        KindScope::Only {
            kinds: kinds.to_vec(),
        }
    }

    fn perms(clusters: ClusterScope, rules: Vec<AccessRule>) -> ExtensionPermissions {
        ExtensionPermissions { clusters, rules }
    }

    fn only_clusters(names: &[&str]) -> ClusterScope {
        ClusterScope::Only {
            names: names.iter().map(|n| n.to_string()).collect(),
        }
    }

    #[test]
    fn a_cluster_outside_the_granted_clusters_is_denied() {
        let p = perms(
            only_clusters(&["kind-dev"]),
            vec![rule(NamespaceScope::All, KindScope::All, vec![Read], false)],
        );
        assert_eq!(
            decide_extension(&p, "prod", Some("default"), &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "kind-dev", Some("default"), &pod(), Read),
            Decision::Allowed { confirm: false }
        );
        // Names are exact: no case folding, no prefix match.
        assert_eq!(
            decide_extension(&p, "Kind-Dev", Some("default"), &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "kind", Some("default"), &pod(), Read),
            Decision::Denied
        );
    }

    #[test]
    fn no_clusters_and_blank_cluster_names_cover_nothing() {
        let everywhere = vec![rule(NamespaceScope::All, KindScope::All, vec![Read], false)];
        let none = perms(only_clusters(&[]), everywhere.clone());
        assert_eq!(
            decide_extension(&none, "kind-dev", None, &pod(), Read),
            Decision::Denied
        );
        let blank = perms(only_clusters(&["", " "]), everywhere.clone());
        assert_eq!(
            decide_extension(&blank, "", None, &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&blank, " ", None, &pod(), Read),
            Decision::Denied
        );
        let all = perms(ClusterScope::All, everywhere);
        assert_eq!(
            decide_extension(&all, "", None, &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&all, "any-context", None, &pod(), Read),
            Decision::Allowed { confirm: false }
        );
    }

    #[test]
    fn rules_decide_namespaces_kinds_actions_and_confirmation_as_for_the_agent() {
        let p = perms(
            ClusterScope::All,
            vec![
                rule(
                    only_ns(&["team-a"]),
                    only_kinds(&[pod()]),
                    vec![Read, Modify],
                    true,
                ),
                rule(
                    NamespaceScope::All,
                    only_kinds(&[node()]),
                    vec![Read],
                    false,
                ),
            ],
        );
        assert_eq!(
            decide_extension(&p, "c", Some("team-a"), &pod(), Read),
            Decision::Allowed { confirm: false },
            "reads are never asked about"
        );
        assert_eq!(
            decide_extension(
                &p,
                "c",
                Some("team-a"),
                &KindPattern::new("", "pod"),
                Modify
            ),
            Decision::Allowed { confirm: true },
            "kinds compare ignoring case; changes are asked about"
        );
        assert_eq!(
            decide_extension(&p, "c", Some("team-b"), &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "c", Some("team-a"), &pod(), Delete),
            Decision::Denied
        );
        // An object without a namespace only under "all namespaces".
        assert_eq!(
            decide_extension(&p, "c", None, &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "c", None, &node(), Read),
            Decision::Allowed { confirm: false }
        );
    }

    #[test]
    fn secret_values_need_their_own_action() {
        let p = perms(
            ClusterScope::All,
            vec![rule(
                NamespaceScope::All,
                KindScope::All,
                vec![Read, Modify, Delete, Logs],
                false,
            )],
        );
        let secret = KindPattern::new("", "Secret");
        assert_eq!(
            decide_extension(&p, "c", Some("a"), &secret, SecretValues),
            Decision::Denied
        );
        let with = perms(
            ClusterScope::All,
            vec![rule(
                NamespaceScope::All,
                only_kinds(std::slice::from_ref(&secret)),
                vec![SecretValues],
                false,
            )],
        );
        assert_eq!(
            decide_extension(&with, "c", Some("a"), &secret, SecretValues),
            Decision::Allowed { confirm: false }
        );
    }

    #[test]
    fn exec_and_port_forward_are_denied_even_if_a_rule_names_them() {
        let p = perms(
            ClusterScope::All,
            vec![rule(
                NamespaceScope::All,
                KindScope::All,
                AccessAction::ALL.to_vec(),
                false,
            )],
        );
        assert_eq!(
            decide_extension(&p, "c", Some("a"), &pod(), Exec),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "c", Some("a"), &pod(), PortForward),
            Decision::Denied
        );
        assert_eq!(
            decide_extension(&p, "c", Some("a"), &pod(), Logs),
            Decision::Allowed { confirm: false }
        );
    }

    #[test]
    fn granted_permissions_read_from_settings_fail_closed() {
        let good = json!({
            "clusters": { "type": "only", "names": ["kind-dev"] },
            "rules": [{ "namespaces": { "type": "all" }, "kinds": { "type": "all" }, "actions": ["read"], "confirm": false }]
        });
        let parsed: ExtensionPermissions = serde_json::from_value(good.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), good, "round trip");

        let mut unknown_rule_field = good.clone();
        unknown_rule_field["rules"][0]["onlyIf"] = json!("label=x");
        let mut unknown_scope_field = good.clone();
        unknown_scope_field["clusters"] = json!({ "type": "all", "except": ["prod"] });
        let mut exec = good.clone();
        exec["rules"][0]["actions"] = json!(["read", "exec"]);
        let mut future_action = good.clone();
        future_action["rules"][0]["actions"] = json!(["read", "scale"]);
        let mut top_level = good.clone();
        top_level["deny"] = json!([]);
        for bad in [
            unknown_rule_field,
            unknown_scope_field,
            exec,
            future_action,
            top_level,
            json!("all"),
        ] {
            let parsed: ExtensionPermissions = serde_json::from_value(bad.clone()).unwrap();
            assert_eq!(parsed, ExtensionPermissions::none(), "{bad}");
        }
    }

    #[test]
    fn is_within_spots_every_widening() {
        let granted = perms(
            only_clusters(&["a", "b"]),
            vec![rule(
                only_ns(&["team-a", "team-b"]),
                only_kinds(&[pod()]),
                vec![Read, Modify],
                true,
            )],
        );
        assert!(granted.is_within(&granted));
        let narrower = perms(
            only_clusters(&["a"]),
            vec![rule(
                only_ns(&["team-a"]),
                only_kinds(&[KindPattern::new("", "POD")]),
                vec![Read],
                true,
            )],
        );
        assert!(narrower.is_within(&granted));
        assert!(ExtensionPermissions::none().is_within(&granted));

        let wider = [
            perms(ClusterScope::All, granted.rules.clone()),
            perms(only_clusters(&["a", "c"]), granted.rules.clone()),
            perms(
                granted.clusters.clone(),
                vec![rule(
                    NamespaceScope::All,
                    only_kinds(&[pod()]),
                    vec![Read],
                    true,
                )],
            ),
            perms(
                granted.clusters.clone(),
                vec![rule(
                    only_ns(&["team-c"]),
                    only_kinds(&[pod()]),
                    vec![Read],
                    true,
                )],
            ),
            perms(
                granted.clusters.clone(),
                vec![rule(only_ns(&["team-a"]), KindScope::All, vec![Read], true)],
            ),
            perms(
                granted.clusters.clone(),
                vec![rule(
                    only_ns(&["team-a"]),
                    only_kinds(&[node()]),
                    vec![Read],
                    true,
                )],
            ),
            perms(
                granted.clusters.clone(),
                vec![rule(
                    only_ns(&["team-a"]),
                    only_kinds(&[pod()]),
                    vec![Delete],
                    true,
                )],
            ),
            perms(
                granted.clusters.clone(),
                vec![rule(
                    only_ns(&["team-a"]),
                    only_kinds(&[pod()]),
                    vec![SecretValues],
                    false,
                )],
            ),
            // Same reach, but changes no longer asked about.
            perms(
                granted.clusters.clone(),
                vec![rule(
                    only_ns(&["team-a"]),
                    only_kinds(&[pod()]),
                    vec![Modify],
                    false,
                )],
            ),
        ];
        for p in wider {
            assert!(!p.is_within(&granted), "{p:?}");
        }
        // Dropping a confirmation on a read-only rule changes nothing.
        let read_without_confirm = perms(
            granted.clusters.clone(),
            vec![rule(
                only_ns(&["team-a"]),
                only_kinds(&[pod()]),
                vec![Read],
                false,
            )],
        );
        assert!(read_without_confirm.is_within(&granted));
    }

    #[test]
    fn is_within_compares_what_the_rules_decide_together() {
        let modify = |namespaces, kinds, confirm| rule(namespaces, kinds, vec![Modify], confirm);
        // Granted: every change asked about, plus a rule for team-a Pods without asking. Together they still ask
        // (any covering rule that asks wins), so the second rule alone asks for less confirmation.
        let granted = perms(
            ClusterScope::All,
            vec![
                modify(NamespaceScope::All, KindScope::All, true),
                modify(only_ns(&["team-a"]), only_kinds(&[pod()]), false),
            ],
        );
        let second_alone = perms(
            ClusterScope::All,
            vec![modify(only_ns(&["team-a"]), only_kinds(&[pod()]), false)],
        );
        assert!(!second_alone.is_within(&granted));
        assert!(granted.is_within(&granted));

        // A rule covered only by two granted rules together is within.
        let granted = perms(
            ClusterScope::All,
            vec![
                rule(only_ns(&["a"]), only_kinds(&[pod()]), vec![Read], false),
                rule(only_ns(&["a"]), only_kinds(&[pod()]), vec![Logs], false),
                rule(
                    only_ns(&["b"]),
                    only_kinds(&[pod()]),
                    vec![Read, Logs],
                    false,
                ),
            ],
        );
        let merged = perms(
            ClusterScope::All,
            vec![rule(
                only_ns(&["a", "b"]),
                only_kinds(&[pod()]),
                vec![Read, Logs],
                true,
            )],
        );
        assert!(merged.is_within(&granted));

        // The new set's own other rule keeps the confirmation.
        let granted = perms(
            ClusterScope::All,
            vec![modify(NamespaceScope::All, KindScope::All, true)],
        );
        let asks_through_another_rule = perms(
            ClusterScope::All,
            vec![
                modify(only_ns(&["team-a"]), only_kinds(&[pod()]), false),
                modify(NamespaceScope::All, KindScope::All, true),
            ],
        );
        assert!(asks_through_another_rule.is_within(&granted));

        // Asking for clusters but no rule, or rules but no cluster, asks for nothing.
        let nothing = perms(ClusterScope::All, vec![]);
        assert!(nothing.is_within(&ExtensionPermissions::none()));
        let no_cluster = perms(
            only_clusters(&[" "]),
            vec![rule(NamespaceScope::All, KindScope::All, vec![Read], false)],
        );
        assert!(no_cluster.is_within(&ExtensionPermissions::none()));
    }

    /// `is_within` agrees with `decide_extension` at every point of a grid that covers every name the rules use and
    /// one they do not, for many generated pairs.
    #[test]
    fn is_within_agrees_with_decide_extension_everywhere() {
        let mut seed: u64 = 0x5eed;
        let mut next = |n: u64| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        let namespaces = ["a", "b"];
        let kinds = [pod(), node()];
        let gen_perms = |next: &mut dyn FnMut(u64) -> u64| {
            let clusters = match next(3) {
                0 => ClusterScope::All,
                1 => only_clusters(&["c1"]),
                _ => only_clusters(&["c1", "c2"]),
            };
            let rules = (0..next(4))
                .map(|_| {
                    let ns = match next(3) {
                        0 => NamespaceScope::All,
                        1 => only_ns(&[namespaces[next(2) as usize]]),
                        _ => only_ns(&namespaces),
                    };
                    let ks = match next(3) {
                        0 => KindScope::All,
                        1 => only_kinds(&[kinds[next(2) as usize].clone()]),
                        _ => only_kinds(&kinds),
                    };
                    let actions: Vec<AccessAction> = EXTENSION_ACTIONS
                        .iter()
                        .copied()
                        .filter(|_| next(3) == 0)
                        .collect();
                    rule(ns, ks, actions, next(2) == 0)
                })
                .collect();
            perms(clusters, rules)
        };
        let clusters = ["c1", "c2", "elsewhere"];
        let points_ns = [Some("a"), Some("b"), Some("other"), None];
        let points_kinds = [pod(), node(), KindPattern::new("x.dev", "Other")];
        let rank = |d: Decision| match d {
            Decision::Denied => 0,
            Decision::Allowed { confirm: true } => 1,
            Decision::Allowed { confirm: false } => 2,
        };
        for _ in 0..2000 {
            let granted = gen_perms(&mut next);
            let asked = gen_perms(&mut next);
            let mut wider = false;
            for cluster in clusters {
                for ns in points_ns {
                    for kind in &points_kinds {
                        for action in AccessAction::ALL {
                            let a = decide_extension(&asked, cluster, ns, kind, action);
                            let g = decide_extension(&granted, cluster, ns, kind, action);
                            wider |= rank(a) > rank(g);
                        }
                    }
                }
            }
            assert_eq!(
                asked.is_within(&granted),
                !wider,
                "asked {asked:?}\ngranted {granted:?}"
            );
        }
    }
}
