//! The extension catalog (ADR-0130): `index.json` of `FriendsOfKubernetes/sextant-extensions`, written by that
//! repository's workflow with the SDK's rules (`sdk/scripts/catalog.mjs`), and the checks of a package downloaded
//! from it. Nothing the index says is trusted on its own:
//! - every entry is read by the same rules the workflow checks it with, and one that breaks them is left out (the rest
//!   of the index still reads); a release block that does not read leaves its entry without a release;
//! - a downloaded package must have the size and SHA-256 the index lists and a prehashed minisign signature by the
//!   entry's `publisherKey`, checked here, before it is unpacked;
//! - its manifest must carry the entry's id and the release's version;
//! - an installed catalog extension is updated only from the repository and key pinned at its install.
//!
//! The network and the cache are the Tauri layer's (`src-tauri/src/extensions/catalog.rs`).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::installed::{ExtensionSource, InstalledExtension};
use super::manifest::{ExtensionManifest, apply_defaults, is_extension_id, supports_api};
use super::permissions::ExtensionPermissions;
use crate::{CoreError, CoreResult, ErrorCode};

/// The index format this Sextant reads.
pub const INDEX_SCHEMA_VERSION: u64 = 1;
/// The index is refused when larger.
pub const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024;
/// Entries read at most; the rest are left out.
pub const MAX_ENTRIES: usize = 2000;
/// A `.minisig` is refused when larger.
pub const MAX_SIGNATURE_BYTES: usize = 4096;
/// The start of the error message for an index written for a newer Sextant (the window says "update Sextant").
pub const NEWER_INDEX: &str = "catalog::NEWER_INDEX";

const PACKAGE_SUFFIX: &str = ".sextant-ext";
/// The `.minisig` of a package is its URL with this added.
pub const SIGNATURE_SUFFIX: &str = ".minisig";

/// What an extension is about: the catalog's fixed list (`CATEGORIES` in the SDK), translated in the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogCategory {
    Observability,
    Cost,
    Security,
    Gitops,
    Networking,
    Storage,
    Workloads,
    Developer,
    Other,
}

/// How many contributions of each type a release's manifest has (the details view only).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContributionCounts {
    pub pages: u32,
    pub details_sections: u32,
    pub actions: u32,
    pub columns: u32,
    pub dock_actions: u32,
    pub settings: u32,
}

/// The release the catalog lists for an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogRelease {
    /// `X.Y.Z`.
    pub version: String,
    /// The manifest's `sextantApi`; one this Sextant does not support is shown as "needs a newer Sextant".
    pub sextant_api: u64,
    pub tag: String,
    /// `<id>-<version>.sextant-ext`.
    pub asset: String,
    #[ts(type = "number")]
    pub size: u64,
    /// Lower-case hex.
    pub sha256: String,
    /// The minisign key id of the signature the workflow checked.
    pub key_id: String,
    pub published_at: Option<String>,
    /// As the manifest asks, copied by the workflow: shown "as published in the catalog" only. `None` when they do
    /// not read by this Sextant's rules. The consent screen shows the downloaded manifest's own.
    pub permissions: Option<ExtensionPermissions>,
    pub contributes: ContributionCounts,
    /// Its backend (ADR-0131), as the manifest declares it: shown in the details only.
    pub backend: Option<CatalogBackend>,
}

/// A release's backend as the catalog lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogBackend {
    /// The hosts it may call.
    pub hosts: Vec<String>,
    /// The labels of the credentials it asks for.
    pub credentials: Vec<String>,
}

/// A `backend` block of the index: at most 20 hosts and 10 labels, each checked; `None` when it does not read (the
/// entry then shows no backend details; the consent screen shows the package's own).
fn read_backend(value: &Value) -> Option<CatalogBackend> {
    let hosts = value.get("hosts")?.as_array()?;
    let credentials = value.get("credentials")?.as_array()?;
    if hosts.len() > 20 || credentials.len() > 10 {
        return None;
    }
    Some(CatalogBackend {
        hosts: hosts
            .iter()
            .map(|h| {
                h.as_str()
                    .filter(|h| super::manifest::is_host_name(h))
                    .map(str::to_owned)
            })
            .collect::<Option<_>>()?,
        credentials: credentials
            .iter()
            .map(|c| text_of(c, 80))
            .collect::<Option<_>>()?,
    })
}

/// One extension of the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub categories: Vec<CatalogCategory>,
    /// `<owner>/<repository>` on GitHub: where the releases are.
    pub repository: String,
    /// The base64 line of the publisher's minisign public key.
    pub publisher_key: String,
    /// That key's id, as minisign prints it.
    pub key_id: String,
    /// Why the catalog no longer offers it.
    pub withdrawn: Option<String>,
    /// `None`: no release passed the workflow's checks yet, or its block does not read.
    pub latest: Option<CatalogRelease>,
}

/// The index as read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogIndex {
    pub generated_at: Option<String>,
    pub entries: Vec<CatalogEntry>,
    /// Entries left out because they do not read (or past [`MAX_ENTRIES`]).
    pub skipped: u32,
}

/// Where an installed catalog extension stands against the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogStatus {
    /// The listed release is the installed one or older.
    UpToDate,
    /// A newer release can be installed.
    UpdateAvailable { version: String },
    /// A newer release needs a newer Sextant (its `sextantApi`).
    NeedsNewerSextant { version: String },
    /// The entry now names another key: updates are refused until it is installed again.
    KeyChanged,
    /// The entry now names another repository: updates are refused until it is installed again.
    RepositoryChanged,
    /// Withdrawn from the catalog, with the reason. Sextant never disables it itself.
    Withdrawn { reason: String },
    /// The index has no entry of this id (any more).
    NotListed,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// Rust's `char::is_control` or a text-direction control: never in a shown name or description.
fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// 1 to `max` characters, not only spaces, no control or text-direction characters (as the SDK's `isText`).
fn text_of(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?;
    (!text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(is_hidden))
        .then(|| text.to_owned())
}

/// `owner/repo` as GitHub allows them.
pub fn is_repository(text: &str) -> bool {
    let Some((owner, repo)) = text.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=39).contains(&owner.len())
        && owner
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let repo_ok = (1..=100).contains(&repo.len())
        && repo != "."
        && repo != ".."
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    owner_ok && repo_ok
}

/// A release tag that goes into a download URL as it is: `[A-Za-z0-9][A-Za-z0-9._+-]{0,127}`.
pub fn is_release_tag(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// `X.Y.Z`, no leading zeros, each part at most 9 digits: `[major, minor, patch]`.
fn plain_version(text: &str) -> Option<[u64; 3]> {
    let mut parts = text.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 9
            || !part.bytes().all(|b| b.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The `MAJOR.MINOR.PATCH` of any semantic version (a pre-release or build part is not compared).
fn version_core(text: &str) -> Option<[u64; 3]> {
    let core = text.split(['-', '+']).next()?;
    plain_version(core)
}

/// The version in `<id>-<X.Y.Z>.sextant-ext`.
pub fn asset_version(id: &str, asset: &str) -> Option<String> {
    let version = asset
        .strip_prefix(id)?
        .strip_prefix('-')?
        .strip_suffix(PACKAGE_SUFFIX)?;
    plain_version(version).map(|_| version.to_owned())
}

/// The key id of a minisign public key's base64 line, as minisign prints it; `None` when it is not one.
pub fn public_key_id(base64_line: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_line.trim())
        .ok()?;
    if bytes.len() != 42 || &bytes[..2] != b"Ed" {
        return None;
    }
    minisign_verify::PublicKey::from_base64(base64_line.trim()).ok()?;
    Some(
        bytes[2..10]
            .iter()
            .rev()
            .map(|b| format!("{b:02X}"))
            .collect(),
    )
}

fn read_categories(value: &Value) -> Option<Vec<CatalogCategory>> {
    let list = value.as_array()?;
    if list.is_empty() || list.len() > 3 {
        return None;
    }
    let mut out: Vec<CatalogCategory> = Vec::new();
    for item in list {
        let category: CatalogCategory = serde_json::from_value(item.clone()).ok()?;
        if out.contains(&category) {
            return None;
        }
        out.push(category);
    }
    Some(out)
}

fn read_counts(value: &Value) -> Option<ContributionCounts> {
    let object = value.as_object()?;
    let mut counts = ContributionCounts::default();
    for (key, count) in object {
        let count = u32::try_from(count.as_u64()?).ok()?;
        match key.as_str() {
            "pages" => counts.pages = count,
            "detailsSections" => counts.details_sections = count,
            "actions" => counts.actions = count,
            "columns" => counts.columns = count,
            "dockActions" => counts.dock_actions = count,
            "settings" => counts.settings = count,
            // A contribution type a newer workflow counts: not shown.
            _ => {}
        }
    }
    Some(counts)
}

/// The manifest's permissions as the manifest reads them (a rule's `confirm` is true unless written), strictly.
fn read_permissions(value: &Value) -> Option<ExtensionPermissions> {
    let mut manifest = json!({ "permissions": value });
    apply_defaults(&mut manifest);
    ExtensionPermissions::read_strict(&manifest["permissions"])
}

fn read_release(id: &str, value: &Value) -> Option<CatalogRelease> {
    let field = |name: &str| value.get(name);
    let version = field("version")?.as_str()?.to_owned();
    let asset = field("asset")?.as_str()?.to_owned();
    let tag = field("tag")?.as_str()?.to_owned();
    if asset_version(id, &asset).as_deref() != Some(version.as_str()) || !is_release_tag(&tag) {
        return None;
    }
    let sha256 = field("sha256")?.as_str()?.to_owned();
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let key_id = field("keyId")?.as_str()?.to_owned();
    if key_id.len() != 16
        || !key_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F'))
    {
        return None;
    }
    let published_at = match field("publishedAt") {
        None | Some(Value::Null) => None,
        Some(v) => Some(text_of(v, 64)?),
    };
    Some(CatalogRelease {
        version,
        sextant_api: field("sextantApi")?.as_u64()?,
        tag,
        asset,
        size: field("size")?.as_u64()?,
        sha256,
        key_id,
        published_at,
        permissions: field("permissions").and_then(read_permissions),
        contributes: field("contributes")
            .map_or(Some(ContributionCounts::default()), read_counts)?,
        backend: field("backend")
            .filter(|b| !b.is_null())
            .and_then(read_backend),
    })
}

const ENTRY_FIELDS: [&str; 9] = [
    "id",
    "name",
    "author",
    "description",
    "categories",
    "repository",
    "publisherKey",
    "withdrawn",
    "latest",
];

/// One entry by the workflow's rules (`checkEntry` in the SDK), or `None`.
fn read_entry(value: &Value) -> Option<CatalogEntry> {
    let object = value.as_object()?;
    if object.keys().any(|k| !ENTRY_FIELDS.contains(&k.as_str())) {
        return None;
    }
    let id = object.get("id")?.as_str()?.to_owned();
    if !is_extension_id(&id) {
        return None;
    }
    let repository = object.get("repository")?.as_str()?.to_owned();
    let publisher_key = object.get("publisherKey")?.as_str()?.to_owned();
    if !is_repository(&repository) || publisher_key.trim() != publisher_key {
        return None;
    }
    let key_id = public_key_id(&publisher_key)?;
    let withdrawn = match object.get("withdrawn") {
        None => None,
        Some(w) => {
            let w = w.as_object()?;
            if w.len() != 1 {
                return None;
            }
            Some(text_of(w.get("reason")?, 300)?)
        }
    };
    let latest = object.get("latest").and_then(|l| read_release(&id, l));
    Some(CatalogEntry {
        name: text_of(object.get("name")?, 80)?,
        author: text_of(object.get("author")?, 100)?,
        description: text_of(object.get("description")?, 500)?,
        categories: read_categories(object.get("categories")?)?,
        id,
        repository,
        publisher_key,
        key_id,
        withdrawn,
        latest,
    })
}

/// Reads `index.json`. An index of a newer format is an error starting with [`NEWER_INDEX`]; an entry that does not
/// read, repeats an id or comes past [`MAX_ENTRIES`] is left out and counted.
pub fn parse_index(bytes: &[u8]) -> CoreResult<CatalogIndex> {
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(invalid("The catalog's index is too large"));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| invalid("The catalog's index is not valid JSON"))?;
    let version = value.get("schemaVersion").and_then(Value::as_u64);
    match version {
        Some(INDEX_SCHEMA_VERSION) => {}
        Some(v) if v > INDEX_SCHEMA_VERSION => {
            return Err(invalid(format!(
                "{NEWER_INDEX}: the catalog is written for a newer Sextant (format {v})"
            )));
        }
        _ => {
            return Err(invalid(
                "The catalog's index has no format version this Sextant reads",
            ));
        }
    }
    let Some(list) = value.get("extensions").and_then(Value::as_array) else {
        return Err(invalid("The catalog's index lists no extensions"));
    };
    let mut index = CatalogIndex {
        generated_at: value.get("generatedAt").and_then(|v| text_of(v, 64)),
        ..CatalogIndex::default()
    };
    for item in list {
        match read_entry(item) {
            Some(entry)
                if index.entries.len() < MAX_ENTRIES
                    && !index.entries.iter().any(|e| e.id == entry.id) =>
            {
                index.entries.push(entry);
            }
            _ => index.skipped = index.skipped.saturating_add(1),
        }
    }
    Ok(index)
}

/// The two download URLs of a release: the package and its `.minisig`, built only from checked parts.
pub fn release_urls(
    entry: &CatalogEntry,
    release: &CatalogRelease,
) -> CoreResult<(String, String)> {
    if !is_repository(&entry.repository)
        || !is_release_tag(&release.tag)
        || asset_version(&entry.id, &release.asset).as_deref() != Some(release.version.as_str())
    {
        return Err(invalid(
            "The catalog lists a release Sextant cannot download",
        ));
    }
    let package = format!(
        "https://github.com/{}/releases/download/{}/{}",
        entry.repository, release.tag, release.asset
    );
    let signature = format!("{package}{SIGNATURE_SUFFIX}");
    Ok((package, signature))
}

/// The downloaded package is the one the index lists and is signed by the entry's key. Checked before anything is
/// unpacked.
pub fn verify_package(
    entry: &CatalogEntry,
    release: &CatalogRelease,
    package: &[u8],
    signature: &[u8],
) -> CoreResult<()> {
    if package.len() as u64 != release.size || hex(&Sha256::digest(package)) != release.sha256 {
        return Err(invalid(format!(
            "The downloaded package of {} {} is not the one the catalog lists",
            entry.id, release.version
        )));
    }
    if signature.len() > MAX_SIGNATURE_BYTES {
        return Err(invalid("The package's signature file is too large"));
    }
    let signature = std::str::from_utf8(signature)
        .ok()
        .and_then(|text| minisign_verify::Signature::decode(text).ok())
        .ok_or_else(|| invalid("The package's signature cannot be read"))?;
    let key = minisign_verify::PublicKey::from_base64(&entry.publisher_key)
        .map_err(|_| invalid("The catalog's publisher key cannot be read"))?;
    // Only prehashed signatures (`allow_legacy: false`), as the SDK and `minisign` make them.
    key.verify(package, &signature, false).map_err(|_| {
        invalid(format!(
            "The package of {} {} is not signed with the publisher's key {}",
            entry.id, release.version, entry.key_id
        ))
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The package's manifest is the entry's, at the listed version.
pub fn check_manifest(
    entry: &CatalogEntry,
    release: &CatalogRelease,
    manifest: &ExtensionManifest,
) -> CoreResult<()> {
    if manifest.id != entry.id || manifest.version != release.version {
        return Err(invalid(format!(
            "The package says it is {} {}, but the catalog lists {} {}",
            manifest.id, manifest.version, entry.id, release.version
        )));
    }
    Ok(())
}

/// The source an install from the catalog records: the repository and key it is pinned to.
pub fn catalog_source(entry: &CatalogEntry) -> ExtensionSource {
    ExtensionSource::Catalog {
        repository: entry.repository.clone(),
        key_id: entry.key_id.clone(),
        public_key: entry.publisher_key.clone(),
    }
}

/// Whether `version` (installed) is older than `than` (`X.Y.Z`).
fn older(version: &str, than: &str) -> bool {
    match (version_core(version), plain_version(than)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

/// Refuses a catalog install that the installed one forbids: another pinned repository or key, or an older version.
pub fn check_update(
    existing: &InstalledExtension,
    entry: &CatalogEntry,
    release: &CatalogRelease,
) -> CoreResult<()> {
    if let ExtensionSource::Catalog {
        repository,
        public_key,
        ..
    } = &existing.source
    {
        if repository != &entry.repository || public_key != &entry.publisher_key {
            let what = if repository == &entry.repository {
                "key"
            } else {
                "repository"
            };
            return Err(CoreError::new(
                ErrorCode::Conflict,
                format!(
                    "The publisher's {what} changed in the catalog. Remove the extension and install it again to trust the new {what}."
                ),
            ));
        }
        if older(&release.version, &existing.version) {
            return Err(CoreError::new(
                ErrorCode::Conflict,
                format!(
                    "The catalog lists {} {}, older than the installed {}",
                    entry.id, release.version, existing.version
                ),
            ));
        }
    }
    Ok(())
}

/// Where an installed extension stands against the index; `None` unless it came from the catalog.
pub fn status_of(installed: &InstalledExtension, index: &CatalogIndex) -> Option<CatalogStatus> {
    let ExtensionSource::Catalog {
        repository,
        public_key,
        ..
    } = &installed.source
    else {
        return None;
    };
    let Some(entry) = index.entries.iter().find(|e| e.id == installed.id) else {
        return Some(CatalogStatus::NotListed);
    };
    if let Some(reason) = &entry.withdrawn {
        return Some(CatalogStatus::Withdrawn {
            reason: reason.clone(),
        });
    }
    if repository != &entry.repository {
        return Some(CatalogStatus::RepositoryChanged);
    }
    if public_key != &entry.publisher_key {
        return Some(CatalogStatus::KeyChanged);
    }
    Some(match &entry.latest {
        Some(latest) if older(&installed.version, &latest.version) => {
            if supports_api(latest.sextant_api) {
                CatalogStatus::UpdateAvailable {
                    version: latest.version.clone(),
                }
            } else {
                CatalogStatus::NeedsNewerSextant {
                    version: latest.version.clone(),
                }
            }
        }
        _ => CatalogStatus::UpToDate,
    })
}

#[cfg(test)]
mod tests;
