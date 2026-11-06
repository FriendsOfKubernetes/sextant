//! Port forwards extensions start (`portForward.start`, ADR-0156): forwards of the app's one forwarder, listed on the
//! port-forward page with the source "Extension" and stoppable there like the user's own. Here: which extension
//! started which forward, with the grant it had then, so that an extension sees and stops only its own, holds at most
//! [`MAX_FORWARDS_PER_EXTENSION`], and loses them all when it is disabled, removed or granted anything else.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use sextant_core::extensions::{ExtensionPermissions, InstalledExtension};
use sextant_core::portforward::{ForwardInfo, PortForwarder};
use sextant_core::{CoreError, CoreResult};

use super::ExtensionHost;

/// Forwards one extension may hold at once.
pub const MAX_FORWARDS_PER_EXTENSION: usize = 8;

struct Owned {
    extension: String,
    granted: ExtensionPermissions,
    /// Sextant's own forward for the extension's service requests (ADR-0158): the key it serves; never listed to
    /// the extension or counted against its limit.
    internal: Option<String>,
}

/// The extensions' forwards, by forward id.
#[derive(Default)]
pub struct ExtensionForwards {
    forwarder: RwLock<Option<Arc<PortForwarder>>>,
    owned: Mutex<HashMap<String, Owned>>,
}

impl ExtensionForwards {
    /// The app's forwarder (set once by `AppState`).
    pub fn set_forwarder(&self, forwarder: Arc<PortForwarder>) {
        *self.forwarder.write().unwrap_or_else(|e| e.into_inner()) = Some(forwarder);
    }

    pub fn forwarder(&self) -> CoreResult<Arc<PortForwarder>> {
        self.forwarder
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| CoreError::other("port forwards are not available here"))
    }

    /// The forwards of `extension` still running.
    pub fn of(&self, extension: &str) -> Vec<ForwardInfo> {
        let Ok(forwarder) = self.forwarder() else {
            return Vec::new();
        };
        let mut owned = lock(&self.owned);
        let live = forwarder.list();
        // Forwards stopped elsewhere (the page, a disconnect) are forgotten here.
        owned.retain(|id, _| live.iter().any(|f| &f.id == id));
        live.into_iter()
            .filter(|f| {
                owned
                    .get(&f.id)
                    .is_some_and(|o| o.extension == extension && o.internal.is_none())
            })
            .collect()
    }

    /// The running internal forward of `extension` for `key`, if any.
    pub fn internal(&self, extension: &str, key: &str) -> Option<ForwardInfo> {
        let forwarder = self.forwarder().ok()?;
        let owned = lock(&self.owned);
        forwarder.list().into_iter().find(|f| {
            owned
                .get(&f.id)
                .is_some_and(|o| o.extension == extension && o.internal.as_deref() == Some(key))
        })
    }

    /// Remembers Sextant's own forward for `extension`'s requests to `key`.
    pub fn add_internal(
        &self,
        id: String,
        extension: &str,
        granted: ExtensionPermissions,
        key: String,
    ) {
        lock(&self.owned).insert(
            id,
            Owned {
                extension: extension.to_owned(),
                granted,
                internal: Some(key),
            },
        );
    }

    /// Whether `extension` may start one more.
    pub fn room_for(&self, extension: &str) -> bool {
        self.of(extension).len() < MAX_FORWARDS_PER_EXTENSION
    }

    pub fn add(&self, id: String, extension: &str, granted: ExtensionPermissions) {
        lock(&self.owned).insert(
            id,
            Owned {
                extension: extension.to_owned(),
                granted,
                internal: None,
            },
        );
    }

    /// Whether the forward `id` is `extension`'s.
    pub fn is_of(&self, id: &str, extension: &str) -> bool {
        self.of(extension).iter().any(|f| f.id == id)
    }

    pub fn forget(&self, id: &str) {
        lock(&self.owned).remove(id);
    }

    /// Stops the forwards of extensions that are no longer enabled with the grant they had when they started them.
    pub fn stop_changed(&self, host: &ExtensionHost) {
        let installed: HashMap<String, InstalledExtension> = host
            .installed()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let gone: Vec<String> = {
            let mut owned = lock(&self.owned);
            let gone: Vec<String> = owned
                .iter()
                .filter(|(_, o)| {
                    !installed
                        .get(&o.extension)
                        .is_some_and(|e| e.enabled && e.granted == o.granted)
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in &gone {
                owned.remove(id);
            }
            gone
        };
        if gone.is_empty() {
            return;
        }
        let Ok(forwarder) = self.forwarder() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            for id in gone {
                let _ = forwarder.stop(&id).await;
            }
        });
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
