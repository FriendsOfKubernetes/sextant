//! Extensions: UI add-ons written in HTML/JS that run in an isolated frame and reach clusters only through Sextant's
//! own API, within the permissions the user granted at install.
//!
//! The core knows the package and the rules, nothing about frames or windows:
//! - [`manifest`]: `sextant-extension.json` — strict reading with errors that name the field
//!   ([`parse_manifest`]), checked against `manifest.schema.json` ([`MANIFEST_SCHEMA`]) plus what a schema cannot say;
//! - [`permissions`]: clusters × namespaces × kinds × actions in the AI agent's access model ([`decide_extension`]);
//! - [`package`]: a `.zip` / `.sextant-ext` archive or a folder checked before the user is asked, and installed into
//!   `<extensions dir>/<id>/<version>/` atomically;
//! - [`installed`]: what is installed and what was granted (`AppSettings::extensions`, written only by the backend);
//! - [`catalog`]: the catalog's index and the checks of a package downloaded from it (ADR-0130).

pub mod catalog;
pub mod installed;
pub mod manifest;
pub mod metric_queries;
pub mod package;
pub mod permissions;
pub mod problems;
mod schema;
pub mod translations;

pub use installed::{BackendGrant, ExtensionSource, InstalledExtension, asks_within};
pub use manifest::{
    ActionContribution, BackendCredential, BackendManifest, BackendNetwork, ColumnContribution,
    Contributions, DetailsPlacement, DetailsSectionContribution, DockActionContribution,
    ExtensionManifest, MANIFEST_FILE, ManifestError, PageContribution, SUPPORTED_API,
    SettingsContribution, parse_manifest, supports_api,
};
pub use package::{
    InstalledFiles, MAX_FILES, MAX_UNPACKED_BYTES, Package, PackageFile, inspect_folder,
    inspect_zip, install, prune_versions, remove, resolve_package_file, sweep_leftovers,
    version_dir,
};
pub use permissions::{ClusterScope, EXTENSION_ACTIONS, ExtensionPermissions, decide_extension};
pub use schema::MANIFEST_SCHEMA;
