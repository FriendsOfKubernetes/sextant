//! What is installed and what the user granted: `AppSettings::extensions`.
//!
//! The list is written only by the backend (install, consent, enable, remove); `settings_update` keeps the stored
//! list whatever the frontend sends, so a page — or an extension that got hold of one — cannot widen its own rights.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::agent_tools::{AgentToolContribution, agent_tools_within};
use super::commands::{CommandContribution, commands_within};
use super::kinds_from::{KindsFrom, kinds_from_within};
use super::manifest::{BackendManifest, ExtensionManifest};
use super::metric_queries::{MetricQuery, metric_queries_within};
use super::permissions::ExtensionPermissions;
use super::problems::problems_within;
use super::services::{ServiceContribution, services_within};
use crate::access::KindPattern;

/// Where an installed extension came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ExtensionSource {
    /// Loaded unpacked from a folder (development mode): it runs from that folder and reloads when files change.
    Folder { path: String },
    /// Installed from a `.zip` / `.sextant-ext` file; `name` is the file name, for the list.
    File { name: String },
    /// Downloaded from a GitHub Release.
    Url { url: String },
    /// Installed from the extension catalog (ADR-0130): the repository and the publisher's minisign key are pinned
    /// here at install, and an update must come from the same repository with the same key.
    #[serde(rename_all = "camelCase")]
    Catalog {
        /// `<owner>/<repository>` on GitHub.
        repository: String,
        /// The key's id, as minisign prints it.
        key_id: String,
        /// The base64 line of the publisher's public key.
        public_key: String,
    },
}

/// One installed extension (`AppSettings::extensions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledExtension {
    /// The manifest's `id`; unique in the list.
    pub id: String,
    /// The installed version: its files are in `<extensions dir>/<id>/<version>/` (not for a folder source).
    pub version: String,
    /// The manifest's `name`, for the list when the manifest cannot be read.
    pub name: String,
    pub source: ExtensionSource,
    /// A disabled extension shows nothing and its calls are refused.
    pub enabled: bool,
    /// What the user agreed to; API calls are decided against this, never against the manifest.
    pub granted: ExtensionPermissions,
    /// When it was installed or last updated, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub installed_at: u64,
    /// What the user agreed to of its backend (ADR-0131): the hosts it may call and the credentials it may read.
    /// `None`: no backend was agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_backend: Option<BackendGrant>,
    /// The kinds the user agreed to have the extension's problem rules judge (ADR-0137); only their rules run. `None`:
    /// no rules were agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_problems: Option<Vec<KindPattern>>,
    /// The metric queries the user agreed to (ADR-0138), word for word; only these run. `None`: none were agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_metric_queries: Option<Vec<MetricQuery>>,
    /// The commands the user agreed to (ADR-0147), word for word; only these run. `None`: none were agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_commands: Option<Vec<CommandContribution>>,
    /// The services the user agreed to (ADR-0158), word for word; only these are reached. `None`: none were agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_services: Option<Vec<ServiceContribution>>,
    /// The agent tools the user agreed to (ADR-0159), word for word; only these are offered. `None`: none were agreed
    /// to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_agent_tools: Option<Vec<AgentToolContribution>>,
    /// Where the rules' kinds come from that the user agreed to (`kindsFrom`, ADR-0137/ADR-0144 amendment), word for
    /// word: "the kinds <definition kind>s define". `None`: none were agreed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub granted_kinds_from: Option<Vec<KindsFrom>>,
}

/// The part of a backend the user agrees to: hosts and credential ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackendGrant {
    pub hosts: Vec<String>,
    pub credentials: Vec<String>,
}

impl BackendGrant {
    /// Everything `backend` asks for.
    pub fn of(backend: &BackendManifest) -> Self {
        Self {
            hosts: backend.network.hosts.clone(),
            credentials: backend.credentials.iter().map(|c| c.id.clone()).collect(),
        }
    }
}

/// What was granted to an extension beyond its permissions, as `asks_within` compares it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Granted<'a> {
    pub backend: Option<&'a BackendGrant>,
    pub problems: Option<&'a [KindPattern]>,
    pub metric_queries: Option<&'a [MetricQuery]>,
    pub commands: Option<&'a [CommandContribution]>,
    pub services: Option<&'a [ServiceContribution]>,
    pub agent_tools: Option<&'a [AgentToolContribution]>,
    pub kinds_from: Option<&'a [KindsFrom]>,
}

impl<'a> Granted<'a> {
    /// What `installed` was granted.
    pub fn of(installed: &'a InstalledExtension) -> Self {
        Self {
            backend: installed.granted_backend.as_ref(),
            problems: installed.granted_problems.as_deref(),
            metric_queries: installed.granted_metric_queries.as_deref(),
            commands: installed.granted_commands.as_deref(),
            services: installed.granted_services.as_deref(),
            agent_tools: installed.granted_agent_tools.as_deref(),
            kinds_from: installed.granted_kinds_from.as_deref(),
        }
    }
}

/// Whether `manifest` asks for nothing beyond what was granted: its permissions within `granted`, its backend (if
/// any) agreed to with every host and credential it names, every kind its problem rules judge, every metric query and
/// every command and every `kindsFrom` agreed to. A new backend, host, credential, judged kind or a new or changed
/// metric query, command or `kindsFrom` needs consent again.
pub fn asks_within(
    manifest: &ExtensionManifest,
    granted: &ExtensionPermissions,
    also: Granted<'_>,
) -> bool {
    let Granted {
        backend: granted_backend,
        problems: granted_problems,
        metric_queries: granted_metric_queries,
        commands: granted_commands,
        services: granted_services,
        agent_tools: granted_agent_tools,
        kinds_from: granted_kinds_from,
    } = also;
    let backend_within = match (&manifest.backend, granted_backend) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(asked), Some(granted)) => {
            asked
                .network
                .hosts
                .iter()
                .all(|h| granted.hosts.contains(h))
                && asked
                    .credentials
                    .iter()
                    .all(|c| granted.credentials.contains(&c.id))
        }
    };
    backend_within
        && problems_within(manifest, granted_problems)
        && metric_queries_within(manifest, granted_metric_queries)
        && commands_within(manifest, granted_commands)
        && services_within(manifest, granted_services)
        && agent_tools_within(manifest, granted_agent_tools)
        && kinds_from_within(manifest, granted_kinds_from)
        && manifest.permissions.is_within(granted)
}

/// `#[serde(with)]` for `AppSettings::extensions`: written as a plain list; read without ever failing the settings
/// file and failing closed — a value that is not a list reads as an empty list; an entry that does not parse,
/// repeats an id, has an id that is not an extension id or (unless it runs from a folder) a version that is not a
/// semantic version is left out, its files staying on disk until it is installed again; an entry with a field this
/// version does not know is kept disabled with nothing granted.
pub(crate) mod lenient_list {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::{ExtensionSource, InstalledExtension};
    use crate::extensions::manifest::{is_extension_id, is_semver};
    use crate::extensions::permissions::{ExtensionPermissions, only_known_fields};

    pub(crate) fn serialize<S: Serializer>(
        list: &[InstalledExtension],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        list.serialize(serializer)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<InstalledExtension>, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let serde_json::Value::Array(entries) = value else {
            return Ok(Vec::new());
        };
        let mut installed: Vec<InstalledExtension> = Vec::new();
        for entry in entries {
            let Ok(mut extension) = serde_json::from_value::<InstalledExtension>(entry.clone())
            else {
                continue;
            };
            // The id and version name folders on disk: never read one that could point elsewhere.
            let folder_source = matches!(extension.source, ExtensionSource::Folder { .. });
            if !is_extension_id(&extension.id)
                || (!folder_source && !is_semver(&extension.version))
                || installed.iter().any(|e| e.id == extension.id)
            {
                continue;
            }
            // A field this version does not know (e.g. written by a newer Sextant) could narrow what was granted:
            // the entry stays listed, disabled and with nothing granted, until the user consents again.
            let known = serde_json::to_value(&extension)
                .is_ok_and(|written| only_known_fields(&entry, &written));
            if !known {
                extension.enabled = false;
                extension.granted = ExtensionPermissions::none();
            }
            installed.push(extension);
        }
        Ok(installed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[derive(Deserialize)]
    struct Holder {
        #[serde(with = "lenient_list")]
        list: Vec<InstalledExtension>,
    }

    fn read(entries: Vec<Value>) -> Vec<InstalledExtension> {
        serde_json::from_value::<Holder>(json!({ "list": entries }))
            .unwrap()
            .list
    }

    fn entry(id: &str, version: &str, source: Value) -> Value {
        json!({
            "id": id, "version": version, "name": id, "source": source, "enabled": true, "installedAt": 1,
            "granted": { "clusters": { "type": "all" }, "rules": [
                { "namespaces": { "type": "all" }, "kinds": { "type": "all" }, "actions": ["read"], "confirm": false }
            ] }
        })
    }

    fn file() -> Value {
        json!({ "type": "file", "name": "w.sextant-ext" })
    }

    #[test]
    fn a_good_entry_reads_as_written() {
        let list = read(vec![entry("widgets", "1.0.0", file())]);
        assert_eq!(list.len(), 1);
        assert!(list[0].enabled);
        assert_eq!(
            list[0].granted.clusters,
            crate::extensions::ClusterScope::All
        );
    }

    #[test]
    fn an_unknown_field_anywhere_in_an_entry_disables_it_and_closes_its_permissions() {
        let mut top = entry("top", "1.0.0", file());
        top["pinnedPermissions"] = json!(true);
        let mut in_source = entry("source", "1.0.0", file());
        in_source["source"]["sha256"] = json!("abc");
        let mut in_rule = entry("rule", "1.0.0", file());
        in_rule["granted"]["rules"][0]["onlyIf"] = json!("x");
        for list in [read(vec![top]), read(vec![in_source]), read(vec![in_rule])] {
            assert_eq!(list.len(), 1, "kept, so its files and id stay known");
            assert!(!list[0].enabled, "{:?}", list[0]);
            assert_eq!(list[0].granted, ExtensionPermissions::none());
        }
    }

    #[test]
    fn entries_with_an_id_or_version_that_is_not_a_safe_folder_name_are_left_out() {
        let folder = json!({ "type": "folder", "path": "/src/dev" });
        let url =
            json!({ "type": "url", "url": "https://github.com/o/r/releases/download/v1/w.zip" });
        let list = read(vec![
            entry("../escape", "1.0.0", file()),
            entry("Widgets", "1.0.0", file()),
            entry("nul", "1.0.0", file()),
            entry("", "1.0.0", file()),
            entry("bad-version", "../../x", file()),
            entry("bad-url-version", "latest", url.clone()),
            entry("good", "1.0.0", url),
            entry("dev", "not-semver", folder),
        ]);
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["good", "dev"],
            "a folder source is not stored by version"
        );
    }
}
