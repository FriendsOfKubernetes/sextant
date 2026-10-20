//! Kubeconfig management (#150): changes to kubeconfig files (preview, then apply), credential expiry, and the checks
//! of a kubeconfig being added. Window-only: agents (MCP) and extensions get none of this.

use sextant_core::ClusterId;
use sextant_core::CoreError;
use std::sync::{Arc, RwLock, RwLockReadGuard};

use sextant_core::kubeconfig::KubeconfigRegistry;
use sextant_core::kubeconfig::edit::{
    EditOutcome, EditPreview, EditTarget, KubeconfigEdit, forget_cluster_settings,
    move_cluster_settings,
};
use sextant_core::kubeconfig::expiry::CredentialExpiry;
use sextant_core::kubeconfig::validate::{KubeconfigInput, KubeconfigValidation};
use tauri::State;

use super::clusters::disconnect_cluster;
use crate::state::AppState;

/// The sources the user allowed Sextant to edit (`kubeconfig.writableSources`), as the settings hold them now.
fn writable_sources(state: &AppState) -> Vec<String> {
    state.settings.get().kubeconfig.writable_sources
}

/// Runs `work` on a blocking thread: reading (and writing) kubeconfig files must not hold up the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| CoreError::other("the kubeconfig work stopped"))?
}

fn read(registry: &RwLock<KubeconfigRegistry>) -> RwLockReadGuard<'_, KubeconfigRegistry> {
    registry.read().unwrap_or_else(|e| e.into_inner())
}

/// What `edit` would change; nothing is written.
#[tauri::command]
pub async fn kubeconfig_edit_preview(
    state: State<'_, AppState>,
    edit: KubeconfigEdit,
) -> Result<EditPreview, CoreError> {
    preview_edit(&state, edit).await
}

pub async fn preview_edit(
    state: &AppState,
    edit: KubeconfigEdit,
) -> Result<EditPreview, CoreError> {
    let writable = writable_sources(state);
    let registry = Arc::clone(&state.registry);
    blocking(move || read(&registry).preview_edit(&edit, &writable)).await
}

/// Writes `edit` when the file is still the one previewed (`base`), then moves the settings of renamed clusters to
/// their new ids, forgets the settings of clusters whose context was deleted, saves a newly registered merged file as
/// a source, and disconnects the clusters whose context was renamed or deleted.
#[tauri::command]
pub async fn kubeconfig_edit_apply(
    state: State<'_, AppState>,
    edit: KubeconfigEdit,
    base: String,
) -> Result<EditOutcome, CoreError> {
    apply_edit(&state, edit, base).await
}

pub async fn apply_edit(
    state: &AppState,
    edit: KubeconfigEdit,
    base: String,
) -> Result<EditOutcome, CoreError> {
    let writable = writable_sources(state);
    let registry = Arc::clone(&state.registry);
    let (outcome, sources) = blocking(move || {
        let mut registry = registry.write().unwrap_or_else(|e| e.into_inner());
        let outcome = registry.apply_edit(&edit, &base, &writable)?;
        Ok((outcome, registry.added_sources()))
    })
    .await?;
    let (renamed, removed) = (outcome.renamed.clone(), outcome.removed.clone());
    state.settings.update(move |s| {
        s.kubeconfig_sources = sources;
        for r in &renamed {
            move_cluster_settings(s, &r.from, &r.to);
        }
        for id in &removed {
            forget_cluster_settings(s, id);
        }
    })?;
    let gone: Vec<ClusterId> = outcome
        .renamed
        .iter()
        .map(|r| r.from.clone())
        .chain(outcome.removed.iter().cloned())
        .collect();
    for id in gone {
        disconnect_cluster(state, &id).await;
    }
    Ok(outcome)
}

/// Where a change to the source would really be written (symlinks followed) and where its backups go, for the
/// "Allow Sextant to edit" question. Nothing is written.
#[tauri::command]
pub async fn kubeconfig_edit_target(
    state: State<'_, AppState>,
    source_id: String,
) -> Result<EditTarget, CoreError> {
    let registry = Arc::clone(&state.registry);
    blocking(move || read(&registry).edit_target(&source_id)).await
}

/// When the credentials of every context stop working, where the kubeconfig tells. Nothing is run or sent.
#[tauri::command]
pub async fn kubeconfig_credentials(
    state: State<'_, AppState>,
) -> Result<Vec<CredentialExpiry>, CoreError> {
    let registry = Arc::clone(&state.registry);
    blocking(move || Ok(read(&registry).credential_expiry())).await
}

/// Checks a kubeconfig being added (a file or pasted text), offline: exec plugins are looked up in `PATH`, never run.
#[tauri::command]
pub async fn kubeconfig_validate(
    input: KubeconfigInput,
) -> Result<KubeconfigValidation, CoreError> {
    let path = std::env::var_os("PATH");
    tokio::task::spawn_blocking(move || {
        sextant_core::kubeconfig::validate::validate(&input, path.as_deref())
    })
    .await
    .map_err(|_| CoreError::other("the kubeconfig check stopped"))
}

/// Connects once to `context` of a kubeconfig being added — only when the user asks ("Check connection").
#[tauri::command]
pub async fn kubeconfig_check_connection(
    input: KubeconfigInput,
    context: String,
) -> Result<(), CoreError> {
    let kubeconfig = sextant_core::kubeconfig::validate::connection_kubeconfig(&input, &context)?;
    sextant_core::cluster::check_connection(kubeconfig).await
}

/// The kubeconfig of one cluster (#228) as YAML, every credential `<hidden>` — what the viewer shows.
#[tauri::command]
pub async fn kubeconfig_view(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<String, CoreError> {
    view(&state, cluster_id).await
}

pub async fn view(state: &AppState, cluster_id: ClusterId) -> Result<String, CoreError> {
    let registry = Arc::clone(&state.registry);
    blocking(move || read(&registry).view_kubeconfig(&cluster_id)).await
}

/// Puts the kubeconfig of one cluster on the clipboard (#228): with `with_credentials` the full working one (the
/// window asked the user first), otherwise what the viewer shows. Written from Rust, so the credentials never cross
/// into the window; as a secret, so clipboard managers that honour the hint keep it out of their history. Returns
/// nothing; an error never carries the text.
#[tauri::command]
pub async fn kubeconfig_copy<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    with_credentials: bool,
) -> Result<(), CoreError> {
    let text = copy_text(&state, cluster_id, with_credentials).await?;
    use tauri::Manager;
    let clipboard = app
        .try_state::<tauri_plugin_clipboard_manager::Clipboard<R>>()
        .ok_or_else(clipboard_failed)?;
    let written = if with_credentials {
        clipboard.write_secret(text)
    } else {
        clipboard.write_text(text)
    };
    written.map_err(|_| clipboard_failed())
}

/// The text `kubeconfig_copy` writes: full or masked.
async fn copy_text(
    state: &AppState,
    cluster_id: ClusterId,
    with_credentials: bool,
) -> Result<String, CoreError> {
    let registry = Arc::clone(&state.registry);
    blocking(move || {
        let registry = read(&registry);
        if with_credentials {
            registry.full_kubeconfig(&cluster_id)
        } else {
            registry.view_kubeconfig(&cluster_id)
        }
    })
    .await
}

fn clipboard_failed() -> CoreError {
    CoreError::other("the clipboard cannot be written")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE_TOKEN: &str = "fake-t0ken-do-not-print";

    fn kubeconfig() -> String {
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: {{ server: https://c.example:6443 }}\nusers:\n  - name: u\n    user: {{ token: {FAKE_TOKEN} }}\ncontexts:\n  - name: prod\n    context: {{ cluster: c, user: u }}\ncurrent-context: prod\n"
        )
    }

    #[tokio::test]
    async fn a_rename_moves_the_clusters_settings_to_its_new_id() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
        // Never the real home or KUBECONFIG.
        state
            .registry
            .write()
            .unwrap()
            .set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: None,
                home: Some(dir.path().join("home")),
            });
        let source = state
            .registry
            .write()
            .unwrap()
            .add_pasted(&kubeconfig())
            .unwrap();
        let old = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state
            .settings
            .update(|s| {
                s.clusters.insert(
                    old.as_str().to_owned(),
                    sextant_core::settings::ClusterSettings {
                        display_name: Some("Production".into()),
                        ..Default::default()
                    },
                );
            })
            .unwrap();
        let edit = KubeconfigEdit::RenameContext {
            cluster_id: old.clone(),
            new_name: "production".into(),
        };
        // A pasted source is Sextant's own file: no permission needed.
        let preview = preview_edit(&state, edit.clone()).await.unwrap();
        assert_eq!(preview.source_id.as_deref(), Some(source.id.as_str()));
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains(FAKE_TOKEN)
        );
        let outcome = apply_edit(&state, edit.clone(), preview.base.clone())
            .await
            .unwrap();
        let new = outcome.renamed[0].to.clone();
        let settings = state.settings.get();
        assert!(!settings.clusters.contains_key(old.as_str()));
        assert_eq!(
            settings.clusters[new.as_str()].display_name.as_deref(),
            Some("Production")
        );
        assert_eq!(
            state.registry.read().unwrap().clusters().unwrap()[0].id,
            new
        );
        // The same preview again is stale.
        let err = apply_edit(&state, edit, preview.base).await.unwrap_err();
        assert!(!err.message.contains(FAKE_TOKEN));
    }

    #[tokio::test]
    async fn deleting_a_context_forgets_its_settings() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
        state
            .registry
            .write()
            .unwrap()
            .set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: None,
                home: Some(dir.path().join("home")),
            });
        state
            .registry
            .write()
            .unwrap()
            .add_pasted(&kubeconfig())
            .unwrap();
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state
            .settings
            .update(|s| {
                s.clusters
                    .insert(id.as_str().to_owned(), Default::default());
            })
            .unwrap();
        let edit = KubeconfigEdit::DeleteContext {
            cluster_id: id.clone(),
        };
        let preview = preview_edit(&state, edit.clone()).await.unwrap();
        apply_edit(&state, edit, preview.base).await.unwrap();
        assert!(!state.settings.get().clusters.contains_key(id.as_str()));
    }

    #[test]
    fn neither_agents_nor_extensions_can_manage_kubeconfigs() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools.iter().any(|t| t.contains("kubeconfig")
                || t.contains("context")
                || t.contains("credential")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| m.contains("kubeconfig")
                || m.contains("context")
                || m.contains("credential")),
            "{methods:?}"
        );
        // Nor the clipboard the kubeconfig copy writes (#228).
        assert!(!tools.iter().any(|t| t.contains("clipboard")), "{tools:?}");
        assert!(
            !methods.iter().any(|m| m.contains("clipboard")),
            "{methods:?}"
        );
    }

    #[tokio::test]
    async fn the_view_hides_the_token_and_only_the_copy_with_credentials_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
        state
            .registry
            .write()
            .unwrap()
            .set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: None,
                home: Some(dir.path().join("home")),
            });
        state
            .registry
            .write()
            .unwrap()
            .add_pasted(&kubeconfig())
            .unwrap();
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        let shown = view(&state, id.clone()).await.unwrap();
        assert!(shown.contains("<hidden>") && shown.contains("current-context: prod"));
        assert!(!shown.contains(FAKE_TOKEN), "{shown}");
        assert_eq!(copy_text(&state, id.clone(), false).await.unwrap(), shown);
        assert!(
            copy_text(&state, id, true)
                .await
                .unwrap()
                .contains(FAKE_TOKEN)
        );
        let missing = ClusterId("gone".to_owned());
        let err = view(&state, missing.clone()).await.unwrap_err();
        assert_eq!(err.code, sextant_core::ErrorCode::NotFound);
        let err = copy_text(&state, missing, true).await.unwrap_err();
        assert!(!format!("{err:?}").contains(FAKE_TOKEN));
    }
}
