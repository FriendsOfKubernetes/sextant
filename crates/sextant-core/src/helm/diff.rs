//! What a Helm upgrade (or an install over an existing release) would change, like `helm diff upgrade`: the release's
//! current manifest against the manifest Helm renders for the new chart and values (#141).
//!
//! Both manifests are cut into their documents and put in one order (kind, namespace, name), so the same object
//! lines up on both sides whatever order the chart's templates gave. A core/v1 Secret document is shown the way
//! Sextant shows every Secret — each value `""` and the hidden-values marker — and what changes in its values is told
//! by key names only ([`ManifestSecretChange`]); so is a Secret inside a `List`, whose items are shown one by one. A
//! document or item that cannot be read or has no `kind` is not shown at all, so a value never slips through one that
//! could not be classified.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::resources::{SecretKeyChanges, hide_secret_values, secret_key_changes, secret_values};

/// The two manifests of a Helm change, ready to show side by side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmManifestDiff {
    /// The release's current manifest; empty when there is no release yet.
    pub current: String,
    /// The manifest Helm would apply.
    pub proposed: String,
    /// Secrets whose values would change, by key name; in object order.
    pub secret_changes: Vec<ManifestSecretChange>,
    /// Documents left out because they could not be read (on either side).
    pub unreadable: u32,
    /// Helm rendered the proposed side without the cluster (a Helm before 3.13 has no `--dry-run=server`): `lookup`
    /// found nothing, so Secrets a chart reuses may show as changed. Hooks are never part of the diff.
    pub client_side: bool,
}

impl HelmManifestDiff {
    /// The same diff, saying whether Helm rendered against the cluster.
    pub fn rendered(mut self, server_side: bool) -> Self {
        self.client_side = !server_side;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManifestSecretChange {
    /// `Secret namespace/name` (or `Secret name` when the document names no namespace).
    pub object: String,
    pub keys: SecretKeyChanges,
}

/// Sort key of a document: kind, namespace, name.
type Key = (String, String, String);

/// One document of a manifest as shown.
struct Shown {
    key: Key,
    text: String,
    /// The Secret's values, for a core/v1 Secret.
    secret: Option<BTreeMap<String, String>>,
}

/// The diff of a release's `current` manifest against the `proposed` one (both as Helm prints them).
pub fn manifest_diff(current: &str, proposed: &str) -> HelmManifestDiff {
    let mut unreadable = 0;
    let current = shown_documents(current, &mut unreadable);
    let proposed = shown_documents(proposed, &mut unreadable);
    let secrets = |docs: &[Shown]| -> BTreeMap<Key, BTreeMap<String, String>> {
        docs.iter()
            .filter_map(|d| d.secret.clone().map(|s| (d.key.clone(), s)))
            .collect()
    };
    let (before, after) = (secrets(&current), secrets(&proposed));
    let mut keys: Vec<&Key> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    let secret_changes = keys
        .into_iter()
        .filter_map(|key| {
            let changes = secret_key_changes(
                before.get(key).cloned(),
                after.get(key).unwrap_or(&BTreeMap::new()),
            );
            (!changes.is_empty()).then(|| ManifestSecretChange {
                object: describe(key),
                keys: changes,
            })
        })
        .collect();
    HelmManifestDiff {
        current: joined(current),
        proposed: joined(proposed),
        secret_changes,
        unreadable,
        client_side: false,
    }
}

fn describe((kind, namespace, name): &Key) -> String {
    if namespace.is_empty() {
        format!("{kind} {name}")
    } else {
        format!("{kind} {namespace}/{name}")
    }
}

fn joined(docs: Vec<Shown>) -> String {
    docs.into_iter()
        .map(|d| d.text)
        .collect::<Vec<_>>()
        .join("---\n")
}

/// The documents of a manifest in object order, each ending with a newline; Secrets without their values. The items of
/// a `List` (`v1 List`, `SecretList`, …) are shown as documents of their own.
fn shown_documents(manifest: &str, unreadable: &mut u32) -> Vec<Shown> {
    let mut docs = Vec::new();
    for text in split(manifest) {
        let (shown, left_out) = shown(&text);
        docs.extend(shown);
        *unreadable += left_out;
    }
    docs.sort_by(|a, b| a.key.cmp(&b.key));
    docs
}

/// The documents of a multi-document YAML text, split on `---` lines.
fn split(manifest: &str) -> Vec<String> {
    let mut docs = vec![String::new()];
    for line in manifest.lines() {
        if line.trim_end() == "---" || line.starts_with("--- ") {
            docs.push(String::new());
        } else if let Some(doc) = docs.last_mut() {
            doc.push_str(line);
            doc.push('\n');
        }
    }
    docs
}

/// What one document shows, and how many of its objects are left out because they cannot be read or classified.
/// Fails closed: only an object with a `kind` is shown, a Secret (of any API version) only without its values, and
/// a list only item by item, each checked the same way.
fn shown(text: &str) -> (Vec<Shown>, u32) {
    let content = text
        .lines()
        .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'));
    if !content {
        return (Vec::new(), 0);
    }
    let Ok(value) = serde_yaml::from_str::<Value>(text) else {
        return (Vec::new(), 1);
    };
    if value.is_null() {
        return (Vec::new(), 0);
    }
    // Helm's `# Source:` lines stay with what is written again.
    let comments: String = text
        .lines()
        .take_while(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
        .filter(|line| !line.trim().is_empty())
        .map(|line| format!("{line}\n"))
        .collect();
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind.ends_with("List") || value.get("items").is_some() {
        let Some(items) = value.get("items").and_then(Value::as_array) else {
            return (Vec::new(), 1);
        };
        let mut shown = Vec::new();
        let mut left_out = 0;
        for item in items {
            match object(item.clone(), &comments, None) {
                Some(doc) => shown.push(doc),
                None => left_out += 1,
            }
        }
        return (shown, left_out);
    }
    match object(value, &comments, Some(text)) {
        Some(doc) => (vec![doc], 0),
        None => (Vec::new(), 1),
    }
}

/// One object as shown: `raw` (the document's own text) when it is not a Secret, else written again from `value`
/// without the values; `None` when it has no kind or cannot be written.
fn object(value: Value, comments: &str, raw: Option<&str>) -> Option<Shown> {
    let field = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let key = (
        field("/kind"),
        field("/metadata/namespace"),
        field("/metadata/name"),
    );
    if !value.is_object() || key.0.is_empty() {
        return None;
    }
    if key.0 != "Secret" {
        let text = match raw {
            Some(raw) => raw.to_owned(),
            None => format!("{comments}{}", serde_yaml::to_string(&value).ok()?),
        };
        let mut text = text;
        if !text.ends_with('\n') {
            text.push('\n');
        }
        return Some(Shown {
            key,
            text,
            secret: None,
        });
    }
    let secret = secret_values(&value);
    let mut hidden = value;
    hide_secret_values(&mut hidden);
    let body = serde_yaml::to_string(&hidden).ok()?;
    Some(Shown {
        key,
        text: format!("{comments}{body}"),
        secret: Some(secret),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT: &str = "---
# Source: app/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
  - port: 80
---
# Source: app/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: web-creds
data:
  password: b2xkLXBhc3N3b3Jk
  user: YWRtaW4=
---
# Source: app/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
";

    const PROPOSED: &str = "---
# Source: app/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
---
# Source: app/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: web-creds
stringData:
  password: new-password
  user: admin
  token: abc
---
# Source: app/templates/broken.yaml
apiVersion: v1
kind: Secret
data: [: oops
";

    #[test]
    fn manifests_line_up_by_object_and_secrets_show_no_values() {
        let diff = manifest_diff(CURRENT, PROPOSED);
        for secret in [
            "b2xkLXBhc3N3b3Jk",
            "YWRtaW4=",
            "new-password",
            "abc",
            "oops",
        ] {
            assert!(!diff.current.contains(secret), "{}", diff.current);
            assert!(!diff.proposed.contains(secret), "{}", diff.proposed);
        }
        // Deployment, Secret, Service: the same order on both sides.
        let kinds = |text: &str| -> Vec<String> {
            text.lines()
                .filter_map(|l| l.strip_prefix("kind: "))
                .map(str::to_owned)
                .collect()
        };
        assert_eq!(kinds(&diff.current), ["Deployment", "Secret", "Service"]);
        assert_eq!(kinds(&diff.proposed), ["Deployment", "Secret"]);
        assert!(
            diff.current
                .contains("# Source: app/templates/secret.yaml\n")
        );
        assert!(diff.proposed.contains("replicas: 3"));
        assert!(diff.proposed.contains("sextant.dev/values-hidden"));
        assert_eq!(diff.unreadable, 1);
        assert_eq!(
            diff.secret_changes,
            [ManifestSecretChange {
                object: "Secret web-creds".into(),
                keys: SecretKeyChanges {
                    added: vec!["token".into()],
                    // `user` is the same value, once as `data` and once as `stringData`.
                    changed: vec!["password".into()],
                    removed: vec![],
                },
            }]
        );
    }

    #[test]
    fn secrets_inside_a_list_and_unclassified_documents_show_no_values() {
        let proposed = "---
# Source: app/templates/list.yaml
apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: Secret
  metadata: {name: in-list, namespace: apps}
  data: {password: c2VjcmV0LWluLWxpc3Q=}
- apiVersion: v1
  kind: ConfigMap
  metadata: {name: plain, namespace: apps}
  data: {mode: a}
- data: {token: dW5rbm93bi1pdGVt}
---
apiVersion: v1
kind: SecretList
items:
- kind: Secret
  metadata: {name: listed}
  stringData: {token: plain-secret-text}
---
metadata: {name: no-kind}
data: {token: bm8ta2luZA==}
";
        let diff = manifest_diff("", proposed);
        for secret in [
            "c2VjcmV0LWluLWxpc3Q=",
            "dW5rbm93bi1pdGVt",
            "plain-secret-text",
            "bm8ta2luZA==",
        ] {
            assert!(!diff.proposed.contains(secret), "{}", diff.proposed);
        }
        assert!(diff.proposed.contains("name: plain"), "{}", diff.proposed);
        assert!(diff.proposed.contains("# Source: app/templates/list.yaml"));
        assert_eq!(diff.unreadable, 2);
        let objects: Vec<&str> = diff
            .secret_changes
            .iter()
            .map(|c| c.object.as_str())
            .collect();
        assert_eq!(objects, ["Secret listed", "Secret apps/in-list"]);
    }

    #[test]
    fn no_release_yet_is_an_empty_current_side() {
        let diff = manifest_diff("", PROPOSED);
        assert_eq!(diff.current, "");
        assert_eq!(
            diff.secret_changes[0].keys.added,
            ["password", "token", "user"]
        );
    }
}
