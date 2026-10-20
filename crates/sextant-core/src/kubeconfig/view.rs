//! The kubeconfig of one cluster (#228): a minimal standalone kubeconfig — the context, its cluster and its user,
//! `current-context` set to it, no `preferences` or `extensions` — built from the files as they are now (names
//! resolve in the merged `KUBECONFIG` like [`KubeconfigRegistry::kubeconfig_for`]).
//!
//! ```ignore
//! let shown = registry.view_kubeconfig(&id)?;   // every credential `<hidden>`: the window may show it
//! let full = registry.full_kubeconfig(&id)?;    // working, with credentials: only for the clipboard, from Rust
//! ```
//!
//! Rules:
//! - [`KubeconfigRegistry::view_kubeconfig`] is masked by [`super::mask`], the same masking as the edit preview.
//! - [`KubeconfigRegistry::full_kubeconfig`] holds the credentials as written in the files; it must never reach the
//!   window, a log or an error (`kubeconfig_copy` puts it on the clipboard from Rust).
//! - File-referenced credentials (`client-key: /path`, `tokenFile`, `certificate-authority`) stay references, made
//!   absolute against their file's directory as kube-rs reads them; no file is read and inlined.
//! - Errors name the cluster or the problem, never any content.

use serde_yaml::{Mapping, Value};

use super::{ClusterId, KubeconfigRegistry, mask};
use crate::error::{CoreError, CoreResult, ErrorCode};

impl KubeconfigRegistry {
    /// The kubeconfig of `id` with every credential [`mask::HIDDEN`], as YAML.
    pub fn view_kubeconfig(&self, id: &ClusterId) -> CoreResult<String> {
        let mut doc = self.standalone(id)?;
        mask::mask_document(&mut doc);
        to_yaml(&doc)
    }

    /// The working kubeconfig of `id`, credentials included, as YAML. Never return it to the window.
    pub fn full_kubeconfig(&self, id: &ClusterId) -> CoreResult<String> {
        to_yaml(&self.standalone(id)?)
    }

    fn standalone(&self, id: &ClusterId) -> CoreResult<Value> {
        let config = self.kubeconfig_for(id)?;
        let value = serde_yaml::to_value(&config).map_err(|_| unreadable())?;
        Ok(ordered(&value))
    }
}

/// The document with its keys in kubectl's order, only the ones a standalone kubeconfig needs.
fn ordered(value: &Value) -> Value {
    let mut doc = Mapping::new();
    doc.insert("apiVersion".into(), "v1".into());
    doc.insert("kind".into(), "Config".into());
    for key in ["clusters", "users", "contexts", "current-context"] {
        if let Some(v) = value.get(key).filter(|v| !v.is_null()) {
            doc.insert(key.into(), v.clone());
        }
    }
    Value::Mapping(doc)
}

fn to_yaml(doc: &Value) -> CoreResult<String> {
    serde_yaml::to_string(doc).map_err(|_| unreadable())
}

fn unreadable() -> CoreError {
    CoreError::new(
        ErrorCode::Kubeconfig,
        "the cluster's kubeconfig cannot be written out",
    )
}

#[cfg(test)]
#[path = "view/tests.rs"]
mod tests;
