//! What an AI agent connected through the MCP server may do in a cluster: rules, presets and the one decision
//! function. Pure — no I/O; the MCP server reads the cluster's [`ClusterAccess`] from fresh settings on every call.
//!
//! A rule covers namespaces × kinds × actions. A call is allowed when at least one rule covers its namespace, kind
//! and action; it needs the user's confirmation when any covering rule asks for it (only for the actions that can
//! change something, [`AccessAction::can_ask`]). Objects without a namespace (Node, Namespace, CRD, …) are covered
//! only by rules for all namespaces.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// API group of the pseudo-kind of Helm releases in rules.
pub const HELM_RELEASE_GROUP: &str = "helm.sh";
/// Kind of the pseudo-kind of Helm releases in rules (`helm.sh/Release`).
pub const HELM_RELEASE_KIND: &str = "Release";

/// What the agent does with an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AccessAction {
    /// List and read objects (Secrets without their values).
    Read,
    /// Create, change, apply, scale, restart, suspend, sync…
    Modify,
    Delete,
    /// Pod logs.
    Logs,
    /// Commands in a container.
    Exec,
    PortForward,
    /// Values of Secrets and the values/manifest of Helm releases. In no preset: only an explicit rule gives it.
    SecretValues,
}

impl AccessAction {
    /// Every action, in the order the interface lists them.
    pub const ALL: [AccessAction; 7] = [
        AccessAction::Read,
        AccessAction::Modify,
        AccessAction::Delete,
        AccessAction::Logs,
        AccessAction::Exec,
        AccessAction::PortForward,
        AccessAction::SecretValues,
    ];

    /// Whether "Ask before running" applies to this action: only to actions that change something or reach inside
    /// a container. Reads are never asked about.
    pub fn can_ask(self) -> bool {
        matches!(
            self,
            AccessAction::Modify
                | AccessAction::Delete
                | AccessAction::Exec
                | AccessAction::PortForward
        )
    }
}

/// The set of rules chosen in the cluster settings. Every preset but `Custom` acts by its own rules
/// ([`preset_rules`]); `Custom` acts by [`ClusterAccess::rules`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AccessPreset {
    /// No access at all (the default).
    #[default]
    Off,
    /// Read and logs everywhere.
    ReadOnly,
    /// Everything but delete and secret values; changes are asked about.
    ReadWrite,
    /// Everything but secret values; changes are asked about.
    Full,
    /// The user's own rules.
    Custom,
}

/// Namespaces a rule covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum NamespaceScope {
    /// Every namespace, and objects without a namespace.
    All,
    /// Only these namespaces; never objects without a namespace. An empty or blank name covers nothing (the core
    /// reads an empty namespace as "all namespaces").
    Only { namespaces: Vec<String> },
}

/// Whether a namespace name in a rule names a namespace at all.
fn is_namespace_name(name: &str) -> bool {
    !name.trim().is_empty()
}

impl NamespaceScope {
    fn covers(&self, namespace: Option<&str>) -> bool {
        match (self, namespace) {
            (NamespaceScope::All, _) => true,
            (NamespaceScope::Only { .. }, None) => false,
            (NamespaceScope::Only { namespaces }, Some(ns)) => {
                is_namespace_name(ns) && namespaces.iter().any(|n| n == ns)
            }
        }
    }
}

/// A kind in rules: API group (`""` for the core group) and kind, without a version. Compared ignoring ASCII case.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindPattern {
    pub group: String,
    pub kind: String,
}

impl KindPattern {
    pub fn new(group: impl Into<String>, kind: impl Into<String>) -> Self {
        Self {
            group: group.into(),
            kind: kind.into(),
        }
    }

    /// The pseudo-kind of Helm releases, `helm.sh/Release`.
    pub fn helm_release() -> Self {
        Self::new(HELM_RELEASE_GROUP, HELM_RELEASE_KIND)
    }

    fn matches(&self, other: &KindPattern) -> bool {
        self.group.eq_ignore_ascii_case(&other.group) && self.kind.eq_ignore_ascii_case(&other.kind)
    }
}

/// Kinds a rule covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum KindScope {
    /// Every kind: built-in, custom (Flux, Argo CD, …) and Helm releases.
    All,
    Only {
        kinds: Vec<KindPattern>,
    },
}

impl KindScope {
    fn covers(&self, kind: &KindPattern) -> bool {
        match self {
            KindScope::All => true,
            KindScope::Only { kinds } => kinds.iter().any(|k| k.matches(kind)),
        }
    }
}

/// One rule: namespaces × kinds × actions, and whether to ask the user before running the covered changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccessRule {
    pub namespaces: NamespaceScope,
    pub kinds: KindScope,
    pub actions: Vec<AccessAction>,
    /// "Ask before running": applies to the rule's Modify, Delete, Exec and Port forward.
    pub confirm: bool,
}

impl AccessRule {
    fn covers(&self, namespace: Option<&str>, kind: &KindPattern, action: AccessAction) -> bool {
        self.actions.contains(&action)
            && self.kinds.covers(kind)
            && self.namespaces.covers(namespace)
    }
}

/// The agent's access to one cluster (`ClusterSettings::agent_access`). Default: `Off`, no rules.
///
/// A value that does not parse — e.g. a preset, action or any field written by a newer Sextant (an unknown field
/// could narrow a rule, so it is never dropped) — reads as the default, so access stays closed and the rest of the
/// settings file is kept.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterAccess {
    pub preset: AccessPreset,
    /// The `Custom` rules; kept, but ignored, while another preset is chosen.
    pub rules: Vec<AccessRule>,
}

/// Same shape as [`ClusterAccess`]; the strict reading behind its lenient `Deserialize`.
#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClusterAccessRepr {
    preset: AccessPreset,
    rules: Vec<AccessRule>,
}

impl Default for ClusterAccessRepr {
    fn default() -> Self {
        let ClusterAccess { preset, rules } = ClusterAccess::default();
        Self { preset, rules }
    }
}

impl<'de> Deserialize<'de> for ClusterAccess {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let Ok(ClusterAccessRepr { preset, rules }) =
            serde_json::from_value::<ClusterAccessRepr>(value.clone())
        else {
            return Ok(ClusterAccess::default());
        };
        let access = ClusterAccess { preset, rules };
        // serde drops unknown fields (and `deny_unknown_fields` misses extra fields of a tagged unit variant such as
        // `{"type":"all", …}`): every field read must survive writing the result back, or access stays closed.
        match serde_json::to_value(&access) {
            Ok(written) if only_known_fields(&value, &written) => Ok(access),
            _ => Ok(ClusterAccess::default()),
        }
    }
}

/// Whether every object key in `read` (recursively, arrays element by element) is also in `written`.
fn only_known_fields(read: &serde_json::Value, written: &serde_json::Value) -> bool {
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

/// Whether a call may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Allowed; `confirm` — only after the user approves it.
    Allowed {
        confirm: bool,
    },
    Denied,
}

impl Decision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Decision::Allowed { .. })
    }
}

/// The rules a preset stands for. `Off` and `Custom` have none (`Custom` acts by the saved rules).
pub fn preset_rules(preset: AccessPreset) -> Vec<AccessRule> {
    let everywhere = |actions: Vec<AccessAction>, confirm: bool| AccessRule {
        namespaces: NamespaceScope::All,
        kinds: KindScope::All,
        actions,
        confirm,
    };
    use AccessAction::*;
    match preset {
        AccessPreset::Off | AccessPreset::Custom => Vec::new(),
        AccessPreset::ReadOnly => vec![everywhere(vec![Read, Logs], false)],
        AccessPreset::ReadWrite => vec![everywhere(
            vec![Read, Logs, Modify, Exec, PortForward],
            true,
        )],
        AccessPreset::Full => vec![everywhere(
            vec![Read, Logs, Modify, Delete, Exec, PortForward],
            true,
        )],
    }
}

/// The rules in force: the preset's own, or the saved ones for `Custom`.
fn rules_in_force(access: &ClusterAccess) -> Vec<AccessRule> {
    match access.preset {
        AccessPreset::Custom => access.rules.clone(),
        preset => preset_rules(preset),
    }
}

/// May the agent do `action` with an object of `kind` in `namespace` (`None` — an object without a namespace, or
/// all namespaces at once), and must the user approve it first.
pub fn decide(
    access: &ClusterAccess,
    namespace: Option<&str>,
    kind: &KindPattern,
    action: AccessAction,
) -> Decision {
    let mut allowed = false;
    let mut confirm = false;
    for rule in rules_in_force(access)
        .iter()
        .filter(|rule| rule.covers(namespace, kind, action))
    {
        allowed = true;
        confirm |= rule.confirm;
    }
    if allowed {
        Decision::Allowed {
            confirm: confirm && action.can_ask(),
        }
    } else {
        Decision::Denied
    }
}

/// Namespaces where `action` on `kind` is allowed — for listing across namespaces: `All`, or the union of the
/// namespaces named by covering rules (sorted, without empty or blank names; empty — nowhere).
pub fn allowed_namespaces(
    access: &ClusterAccess,
    kind: &KindPattern,
    action: AccessAction,
) -> NamespaceScope {
    let mut namespaces: Vec<String> = Vec::new();
    for rule in rules_in_force(access) {
        if !(rule.actions.contains(&action) && rule.kinds.covers(kind)) {
            continue;
        }
        match rule.namespaces {
            NamespaceScope::All => return NamespaceScope::All,
            NamespaceScope::Only { namespaces: more } => {
                namespaces.extend(more.into_iter().filter(|n| is_namespace_name(n)))
            }
        }
    }
    namespaces.sort();
    namespaces.dedup();
    NamespaceScope::Only { namespaces }
}

/// Whether any action at all is allowed on `kind` somewhere (for `list_kinds`).
pub fn has_any_permission(access: &ClusterAccess, kind: &KindPattern) -> bool {
    rules_in_force(access)
        .iter()
        .any(|rule| !rule.actions.is_empty() && rule.kinds.covers(kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use AccessAction::*;
    use serde_json::json;

    fn pod() -> KindPattern {
        KindPattern::new("", "Pod")
    }

    fn custom(rules: Vec<AccessRule>) -> ClusterAccess {
        ClusterAccess {
            preset: AccessPreset::Custom,
            rules,
        }
    }

    fn rule(namespaces: &[&str], kinds: &[KindPattern], actions: &[AccessAction]) -> AccessRule {
        AccessRule {
            namespaces: if namespaces.is_empty() {
                NamespaceScope::All
            } else {
                NamespaceScope::Only {
                    namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
                }
            },
            kinds: if kinds.is_empty() {
                KindScope::All
            } else {
                KindScope::Only {
                    kinds: kinds.to_vec(),
                }
            },
            actions: actions.to_vec(),
            confirm: false,
        }
    }

    const ALLOWED: Decision = Decision::Allowed { confirm: false };
    const ASK: Decision = Decision::Allowed { confirm: true };

    #[test]
    fn off_and_no_rules_deny_everything() {
        let off = ClusterAccess::default();
        assert_eq!(off.preset, AccessPreset::Off);
        let empty_custom = custom(Vec::new());
        for access in [&off, &empty_custom] {
            for action in AccessAction::ALL {
                assert_eq!(
                    decide(access, Some("default"), &pod(), action),
                    Decision::Denied
                );
                assert_eq!(decide(access, None, &pod(), action), Decision::Denied);
            }
            assert!(!has_any_permission(access, &pod()));
            assert_eq!(
                allowed_namespaces(access, &pod(), Read),
                NamespaceScope::Only { namespaces: vec![] }
            );
        }
    }

    #[test]
    fn off_ignores_saved_rules() {
        let access = ClusterAccess {
            preset: AccessPreset::Off,
            rules: vec![rule(&[], &[], &AccessAction::ALL)],
        };
        assert_eq!(decide(&access, Some("a"), &pod(), Read), Decision::Denied);
    }

    #[test]
    fn a_rule_covers_only_its_namespaces_kinds_and_actions() {
        let deploy = KindPattern::new("apps", "Deployment");
        let access = custom(vec![rule(
            &["team-a"],
            std::slice::from_ref(&deploy),
            &[Read, Modify],
        )]);

        assert_eq!(decide(&access, Some("team-a"), &deploy, Read), ALLOWED);
        assert_eq!(decide(&access, Some("team-a"), &deploy, Modify), ALLOWED);
        assert_eq!(
            decide(&access, Some("team-a"), &deploy, Delete),
            Decision::Denied
        );
        assert_eq!(
            decide(&access, Some("team-b"), &deploy, Read),
            Decision::Denied
        );
        assert_eq!(
            decide(&access, Some("team-a"), &pod(), Read),
            Decision::Denied
        );
        // Same kind name in another group is another kind.
        let other = KindPattern::new("example.com", "Deployment");
        assert_eq!(
            decide(&access, Some("team-a"), &other, Read),
            Decision::Denied
        );
        // Kinds are compared ignoring case.
        let lower = KindPattern::new("apps", "deployment");
        assert_eq!(decide(&access, Some("team-a"), &lower, Read), ALLOWED);
    }

    #[test]
    fn one_covering_rule_is_enough() {
        let access = custom(vec![
            rule(&["a"], &[pod()], &[Logs]),
            rule(&["b"], &[], &[Read]),
        ]);
        assert_eq!(decide(&access, Some("a"), &pod(), Logs), ALLOWED);
        assert_eq!(decide(&access, Some("b"), &pod(), Read), ALLOWED);
        assert_eq!(decide(&access, Some("a"), &pod(), Read), Decision::Denied);
        assert_eq!(decide(&access, Some("b"), &pod(), Logs), Decision::Denied);
    }

    #[test]
    fn objects_without_a_namespace_need_a_rule_for_all_namespaces() {
        let node = KindPattern::new("", "Node");
        let some = custom(vec![rule(&["a", "b"], &[], &[Read])]);
        assert_eq!(decide(&some, None, &node, Read), Decision::Denied);
        let all = custom(vec![rule(&[], std::slice::from_ref(&node), &[Read])]);
        assert_eq!(decide(&all, None, &node, Read), ALLOWED);
    }

    #[test]
    fn confirmation_is_needed_when_any_covering_rule_asks() {
        let mut asking = rule(&["a"], &[], &[Modify, Read]);
        asking.confirm = true;
        let quiet = rule(&[], &[], &[Modify, Delete]);
        let access = custom(vec![quiet, asking]);
        assert_eq!(decide(&access, Some("a"), &pod(), Modify), ASK);
        // The asking rule does not cover namespace b.
        assert_eq!(decide(&access, Some("b"), &pod(), Modify), ALLOWED);
        // Nor delete.
        assert_eq!(decide(&access, Some("a"), &pod(), Delete), ALLOWED);
    }

    #[test]
    fn reads_are_never_asked_about() {
        let mut asking = rule(&[], &[], &[Read, Logs, Modify, Delete, Exec, PortForward]);
        asking.confirm = true;
        let access = custom(vec![asking]);
        for action in [Read, Logs] {
            assert_eq!(
                decide(&access, Some("a"), &pod(), action),
                ALLOWED,
                "{action:?}"
            );
        }
        for action in [Modify, Delete, Exec, PortForward] {
            assert_eq!(
                decide(&access, Some("a"), &pod(), action),
                ASK,
                "{action:?}"
            );
        }
    }

    #[test]
    fn a_preset_other_than_custom_ignores_the_saved_rules() {
        let saved = vec![rule(&[], &[], &AccessAction::ALL)];
        let read_only = ClusterAccess {
            preset: AccessPreset::ReadOnly,
            rules: saved.clone(),
        };
        assert_eq!(decide(&read_only, Some("a"), &pod(), Read), ALLOWED);
        assert_eq!(
            decide(&read_only, Some("a"), &pod(), Modify),
            Decision::Denied
        );
        assert_eq!(
            decide(&read_only, Some("a"), &pod(), SecretValues),
            Decision::Denied
        );
        // The same rules act once Custom is chosen.
        assert_eq!(
            decide(&custom(saved), Some("a"), &pod(), SecretValues),
            ALLOWED
        );
    }

    #[test]
    fn presets_follow_the_spec() {
        // spec «Наборы»: Read-only = all namespaces, all kinds, Read + Logs; Read + write (no delete) = Read, Logs,
        // Modify, Exec, Port forward, asked; Full = all but Secret values, asked.
        let expect = |preset, actions: &[AccessAction], confirm| {
            assert_eq!(
                preset_rules(preset),
                vec![AccessRule {
                    namespaces: NamespaceScope::All,
                    kinds: KindScope::All,
                    actions: actions.to_vec(),
                    confirm,
                }],
                "{preset:?}"
            );
        };
        expect(AccessPreset::ReadOnly, &[Read, Logs], false);
        expect(
            AccessPreset::ReadWrite,
            &[Read, Logs, Modify, Exec, PortForward],
            true,
        );
        expect(
            AccessPreset::Full,
            &[Read, Logs, Modify, Delete, Exec, PortForward],
            true,
        );
        assert!(preset_rules(AccessPreset::Off).is_empty());
        assert!(preset_rules(AccessPreset::Custom).is_empty());

        let full = ClusterAccess {
            preset: AccessPreset::Full,
            rules: vec![],
        };
        assert_eq!(
            decide(&full, None, &KindPattern::new("", "Node"), Delete),
            ASK
        );
        let rw = ClusterAccess {
            preset: AccessPreset::ReadWrite,
            rules: vec![],
        };
        assert_eq!(decide(&rw, Some("a"), &pod(), Exec), ASK);
        assert_eq!(decide(&rw, Some("a"), &pod(), Delete), Decision::Denied);
    }

    #[test]
    fn secret_values_are_in_no_preset() {
        let secret = KindPattern::new("", "Secret");
        for preset in [
            AccessPreset::Off,
            AccessPreset::ReadOnly,
            AccessPreset::ReadWrite,
            AccessPreset::Full,
            AccessPreset::Custom,
        ] {
            assert!(
                preset_rules(preset)
                    .iter()
                    .all(|r| !r.actions.contains(&SecretValues)),
                "{preset:?}"
            );
            let access = ClusterAccess {
                preset,
                rules: vec![],
            };
            assert_eq!(
                decide(&access, Some("a"), &secret, SecretValues),
                Decision::Denied
            );
            assert_eq!(
                decide(
                    &access,
                    Some("a"),
                    &KindPattern::helm_release(),
                    SecretValues
                ),
                Decision::Denied
            );
        }
    }

    #[test]
    fn helm_releases_are_a_kind_of_their_own() {
        let helm = KindPattern::helm_release();
        assert_eq!(
            (helm.group.as_str(), helm.kind.as_str()),
            ("helm.sh", "Release")
        );
        let access = custom(vec![rule(
            &["apps"],
            std::slice::from_ref(&helm),
            &[Read, Modify],
        )]);
        assert_eq!(decide(&access, Some("apps"), &helm, Modify), ALLOWED);
        assert_eq!(
            decide(&access, Some("apps"), &pod(), Read),
            Decision::Denied
        );
        assert_eq!(
            decide(&access, Some("apps"), &helm, Delete),
            Decision::Denied
        );
        // "All kinds" includes Helm releases.
        let all = custom(vec![rule(&[], &[], &[Read])]);
        assert_eq!(decide(&all, Some("apps"), &helm, Read), ALLOWED);
    }

    #[test]
    fn allowed_namespaces_join_the_covering_rules() {
        let access = custom(vec![
            rule(&["b", "a"], &[pod()], &[Read]),
            rule(&["c", "a"], &[], &[Read]),
            rule(&["d"], &[pod()], &[Logs]),
            rule(&[], &[KindPattern::new("", "Node")], &[Read]),
        ]);
        assert_eq!(
            allowed_namespaces(&access, &pod(), Read),
            NamespaceScope::Only {
                namespaces: vec!["a".into(), "b".into(), "c".into()]
            }
        );
        assert_eq!(
            allowed_namespaces(&access, &KindPattern::new("", "Node"), Read),
            NamespaceScope::All
        );
        let read_only = ClusterAccess {
            preset: AccessPreset::ReadOnly,
            rules: vec![],
        };
        assert_eq!(
            allowed_namespaces(&read_only, &pod(), Read),
            NamespaceScope::All
        );
        assert_eq!(
            allowed_namespaces(&read_only, &pod(), Exec),
            NamespaceScope::Only { namespaces: vec![] }
        );
    }

    #[test]
    fn empty_and_blank_namespace_names_cover_nothing() {
        // The core reads an empty namespace as "all namespaces": a rule naming one must not widen access.
        let access = custom(vec![rule(&["", " ", "\t"], &[pod()], &[Read])]);
        for ns in ["", " ", "\t"] {
            assert_eq!(
                decide(&access, Some(ns), &pod(), Read),
                Decision::Denied,
                "{ns:?}"
            );
        }
        assert_eq!(
            allowed_namespaces(&access, &pod(), Read),
            NamespaceScope::Only { namespaces: vec![] }
        );
        // Next to a real name only the real name is left.
        let mixed = custom(vec![rule(&["", "team-a"], &[pod()], &[Read])]);
        assert_eq!(
            allowed_namespaces(&mixed, &pod(), Read),
            NamespaceScope::Only {
                namespaces: vec!["team-a".into()]
            }
        );
        assert_eq!(decide(&mixed, Some("team-a"), &pod(), Read), ALLOWED);
    }

    #[test]
    fn any_permission_on_a_kind_shows_it() {
        let access = custom(vec![
            rule(&["a"], &[pod()], &[Logs]),
            rule(&[], &[KindPattern::new("apps", "Deployment")], &[]),
        ]);
        assert!(has_any_permission(&access, &pod()));
        assert!(!has_any_permission(
            &access,
            &KindPattern::new("apps", "Deployment")
        ));
        assert!(!has_any_permission(
            &access,
            &KindPattern::new("", "Secret")
        ));
        let read_only = ClusterAccess {
            preset: AccessPreset::ReadOnly,
            rules: vec![],
        };
        assert!(has_any_permission(&read_only, &KindPattern::helm_release()));
    }

    #[test]
    fn json_shape_matches_the_contract() {
        let access = ClusterAccess {
            preset: AccessPreset::Custom,
            rules: vec![AccessRule {
                namespaces: NamespaceScope::Only {
                    namespaces: vec!["prod".into()],
                },
                kinds: KindScope::Only {
                    kinds: vec![KindPattern::helm_release()],
                },
                actions: vec![Read, PortForward, SecretValues],
                confirm: true,
            }],
        };
        let expected = json!({
            "preset": "custom",
            "rules": [{
                "namespaces": { "type": "only", "namespaces": ["prod"] },
                "kinds": { "type": "only", "kinds": [{ "group": "helm.sh", "kind": "Release" }] },
                "actions": ["read", "portForward", "secretValues"],
                "confirm": true
            }]
        });
        assert_eq!(serde_json::to_value(&access).unwrap(), expected);
        assert_eq!(
            serde_json::from_value::<ClusterAccess>(expected).unwrap(),
            access
        );
        assert_eq!(
            serde_json::to_value(ClusterAccess {
                preset: AccessPreset::ReadWrite,
                rules: preset_rules(AccessPreset::ReadOnly)
            })
            .unwrap(),
            json!({
                "preset": "readWrite",
                "rules": [{
                    "namespaces": { "type": "all" },
                    "kinds": { "type": "all" },
                    "actions": ["read", "logs"],
                    "confirm": false
                }]
            })
        );
    }

    #[test]
    fn access_that_does_not_parse_reads_as_off() {
        // A complete rule, so only the action it names decides whether it parses.
        let rule_with = |actions: serde_json::Value| {
            json!({ "preset": "custom", "rules": [{
                "namespaces": { "type": "only", "namespaces": ["a"] },
                "kinds": { "type": "only", "kinds": [{ "group": "", "kind": "Pod" }] },
                "actions": actions,
                "confirm": true
            }] })
        };
        assert_ne!(
            serde_json::from_value::<ClusterAccess>(rule_with(json!(["read"]))).unwrap(),
            ClusterAccess::default()
        );
        for broken in [
            json!({ "preset": "fromTheFuture" }),
            rule_with(json!(["read", "teleport"])),
            json!("full"),
        ] {
            assert_eq!(
                serde_json::from_value::<ClusterAccess>(broken.clone()).unwrap(),
                ClusterAccess::default(),
                "{broken}"
            );
        }
        // Missing fields take their defaults.
        assert_eq!(
            serde_json::from_value::<ClusterAccess>(json!({ "preset": "readOnly" })).unwrap(),
            ClusterAccess {
                preset: AccessPreset::ReadOnly,
                rules: vec![]
            }
        );
    }

    #[test]
    fn an_unknown_field_anywhere_in_access_reads_as_off() {
        // A newer Sextant may narrow a rule with a field this version does not know; dropping it would widen access.
        let rule = json!({
            "namespaces": { "type": "only", "namespaces": ["a"] },
            "kinds": { "type": "only", "kinds": [{ "group": "", "kind": "Pod" }] },
            "actions": ["delete"],
            "confirm": false
        });
        let with = |pointer: &str, value: serde_json::Value| {
            let mut access = json!({ "preset": "custom", "rules": [rule.clone()] });
            let target = access
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap();
            target.insert("names".to_owned(), value);
            access
        };
        // Without extra fields the rule reads as written.
        let plain = json!({ "preset": "custom", "rules": [rule.clone()] });
        assert_ne!(
            serde_json::from_value::<ClusterAccess>(plain).unwrap(),
            ClusterAccess::default()
        );
        let mut all_scopes = rule.clone();
        all_scopes["namespaces"] = json!({ "type": "all", "names": ["x"] });
        all_scopes["kinds"] = json!({ "type": "all" });
        let mut all_kinds = rule.clone();
        all_kinds["kinds"] = json!({ "type": "all", "names": ["x"] });
        for broken in [
            with("", json!(["x"])),
            with("/rules/0", json!(["only-this"])),
            with("/rules/0/namespaces", json!(["x"])),
            with("/rules/0/kinds", json!(["x"])),
            with("/rules/0/kinds/kinds/0", json!(["x"])),
            json!({ "preset": "custom", "rules": [all_scopes] }),
            json!({ "preset": "custom", "rules": [all_kinds] }),
        ] {
            assert_eq!(
                serde_json::from_value::<ClusterAccess>(broken.clone()).unwrap(),
                ClusterAccess::default(),
                "{broken}"
            );
        }
    }
}
