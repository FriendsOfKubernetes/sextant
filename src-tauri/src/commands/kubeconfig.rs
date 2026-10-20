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

/// Puts the kubeconfig of one cluster on the clipboard (#228): with `with_credentials` the full working one, otherwise
/// what the viewer shows. Written from Rust, so the credentials never cross into the window; as a secret, so
/// clipboard managers that honour the hint keep it out of their history. Returns whether it was copied.
///
/// Credentials are copied only after the user confirmed in a native dialog shown from here (not in the webview), so
/// a compromised window cannot copy them silently; the dialog's texts are Sextant's own translations
/// ([`copy_confirmation`], `language` only picks one) and the context name is read from the registry. With no dialog
/// the copy is refused. The clipboard is cleared [`CLEAR_AFTER`] later if it still holds that text. An error never
/// carries the text.
#[tauri::command]
pub async fn kubeconfig_copy<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    with_credentials: bool,
    language: String,
) -> Result<bool, CoreError> {
    use tauri::Manager;
    if with_credentials {
        let context = context_of(&state, cluster_id.clone()).await?;
        let texts = copy_confirmation(&language, &context);
        let dialog = app
            .try_state::<tauri_plugin_dialog::Dialog<R>>()
            .map(|d| d.inner().clone())
            .ok_or_else(|| CoreError::other("the confirmation cannot be shown"))?;
        if !ask(dialog, window, texts).await? {
            return Ok(false);
        }
    }
    let text = copy_text(&state, cluster_id, with_credentials).await?;
    let clipboard = app
        .try_state::<tauri_plugin_clipboard_manager::Clipboard<R>>()
        .ok_or_else(clipboard_failed)?;
    if with_credentials {
        clipboard
            .write_secret(text.as_str())
            .map_err(|_| clipboard_failed())?;
        clear_later(app.clone(), &text);
    } else {
        clipboard.write_text(text).map_err(|_| clipboard_failed())?;
    }
    Ok(true)
}

/// Shows the native confirmation over `window` and waits for the answer (off the async runtime).
async fn ask<R: tauri::Runtime>(
    dialog: tauri_plugin_dialog::Dialog<R>,
    window: tauri::WebviewWindow<R>,
    texts: CopyConfirmation,
) -> Result<bool, CoreError> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    tokio::task::spawn_blocking(move || {
        dialog
            .message(texts.message)
            .title(texts.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                texts.copy,
                texts.cancel,
            ))
            .parent(&window)
            .blocking_show()
    })
    .await
    .map_err(|_| CoreError::other("the confirmation failed"))
}

/// How long credentials stay on the clipboard: then it is cleared, unless it holds something else by then.
pub const CLEAR_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// Counts copies with credentials: a timer clears the clipboard only when no later copy happened.
static COPIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Clears the clipboard [`CLEAR_AFTER`] from now if it still holds `text` (compared by hash; the text itself is not
/// kept) and no later copy with credentials was made. Failures are ignored.
fn clear_later<R: tauri::Runtime>(app: tauri::AppHandle<R>, text: &str) {
    use std::sync::atomic::Ordering;
    let copy = COPIES.fetch_add(1, Ordering::SeqCst) + 1;
    let hash = text_hash(text);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLEAR_AFTER).await;
        if COPIES.load(Ordering::SeqCst) != copy {
            return;
        }
        use tauri::Manager;
        let Some(clipboard) = app.try_state::<tauri_plugin_clipboard_manager::Clipboard<R>>()
        else {
            return;
        };
        if should_clear(clipboard.read_text().ok().as_deref(), &hash) {
            let _ = clipboard.clear();
        }
    });
}

fn text_hash(text: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes()).into()
}

/// Whether the clipboard, holding `current`, still holds the text hashed to `hash`.
fn should_clear(current: Option<&str>, hash: &[u8; 32]) -> bool {
    current.is_some_and(|text| text_hash(text) == *hash)
}

/// The texts of the confirmation before credentials are copied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyConfirmation {
    pub title: String,
    pub message: String,
    pub copy: String,
    pub cancel: String,
}

/// `src/locales/<language>/kubeconfigview.json` of every UI language, built in: the native dialog's texts come from
/// Sextant itself, not from the window.
const CONFIRMATION_TEXTS: [(&str, &str); 14] = [
    (
        "en",
        include_str!("../../../src/locales/en/kubeconfigview.json"),
    ),
    (
        "ru",
        include_str!("../../../src/locales/ru/kubeconfigview.json"),
    ),
    (
        "uk",
        include_str!("../../../src/locales/uk/kubeconfigview.json"),
    ),
    (
        "de",
        include_str!("../../../src/locales/de/kubeconfigview.json"),
    ),
    (
        "fr",
        include_str!("../../../src/locales/fr/kubeconfigview.json"),
    ),
    (
        "es",
        include_str!("../../../src/locales/es/kubeconfigview.json"),
    ),
    (
        "pt-BR",
        include_str!("../../../src/locales/pt-BR/kubeconfigview.json"),
    ),
    (
        "it",
        include_str!("../../../src/locales/it/kubeconfigview.json"),
    ),
    (
        "pl",
        include_str!("../../../src/locales/pl/kubeconfigview.json"),
    ),
    (
        "tr",
        include_str!("../../../src/locales/tr/kubeconfigview.json"),
    ),
    (
        "zh-CN",
        include_str!("../../../src/locales/zh-CN/kubeconfigview.json"),
    ),
    (
        "zh-TW",
        include_str!("../../../src/locales/zh-TW/kubeconfigview.json"),
    ),
    (
        "ja",
        include_str!("../../../src/locales/ja/kubeconfigview.json"),
    ),
    (
        "ko",
        include_str!("../../../src/locales/ko/kubeconfigview.json"),
    ),
];

/// The confirmation in `language` (a UI language tag; English when unknown), naming `context`.
pub fn copy_confirmation(language: &str, context: &str) -> CopyConfirmation {
    let file = |tag: &str| {
        CONFIRMATION_TEXTS
            .iter()
            .find(|(lang, _)| *lang == tag)
            .and_then(|(_, text)| serde_json::from_str::<serde_json::Value>(text).ok())
    };
    let english = file("en").unwrap_or_default();
    let chosen = file(language).unwrap_or_else(|| english.clone());
    let text = |key: &str| {
        chosen[key]
            .as_str()
            .or_else(|| english[key].as_str())
            .unwrap_or(key)
            .to_owned()
    };
    let context: String = context
        .chars()
        .filter(|c| !c.is_control())
        .take(253)
        .collect();
    CopyConfirmation {
        title: text("confirmTitle"),
        message: format!(
            "{}\n\n{}",
            text("confirmText").replace("{{context}}", &context),
            text("confirmClears")
        ),
        copy: text("confirmCopy"),
        cancel: text("confirmCancel"),
    }
}

/// The context name of `cluster_id`, as the registry has it.
async fn context_of(state: &AppState, cluster_id: ClusterId) -> Result<String, CoreError> {
    let registry = Arc::clone(&state.registry);
    blocking(move || {
        read(&registry)
            .clusters()?
            .into_iter()
            .find(|c| c.id == cluster_id)
            .map(|c| c.context)
            .ok_or_else(|| CoreError::new(sextant_core::ErrorCode::NotFound, "no such cluster"))
    })
    .await
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

    #[tokio::test]
    async fn the_native_confirmation_names_the_context_from_the_registry() {
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
        assert_eq!(context_of(&state, id).await.unwrap(), "prod");
        let missing = context_of(&state, ClusterId("gone".to_owned())).await;
        assert_eq!(missing.unwrap_err().code, sextant_core::ErrorCode::NotFound);
    }

    #[test]
    fn the_confirmation_is_sextants_own_text_in_every_language() {
        let en = copy_confirmation("en", "prod");
        assert_eq!(en.title, "Copy the kubeconfig with credentials?");
        assert!(en.message.contains("can use prod as you"), "{}", en.message);
        assert!(en.message.contains("after 60 seconds"), "{}", en.message);
        assert_eq!(
            (en.copy.as_str(), en.cancel.as_str()),
            ("Copy with credentials", "Cancel")
        );
        // An unknown language falls back to English; a control character cannot reshape the text.
        assert_eq!(copy_confirmation("xx", "prod"), en);
        assert!(!copy_confirmation("en", "a\nb").message.contains("a\nb"));
        for (language, _) in CONFIRMATION_TEXTS {
            let texts = copy_confirmation(language, "ctx-name");
            assert!(texts.message.contains("ctx-name"), "{language}");
            assert!(!texts.message.contains("{{"), "{language}");
            for text in [&texts.title, &texts.copy, &texts.cancel] {
                assert!(!text.is_empty(), "{language}");
            }
            // The plugin tells the buttons apart by their labels: equal labels would make Cancel confirm.
            assert_ne!(texts.copy, texts.cancel, "{language}");
            if language != "en" {
                assert_ne!(texts.title, en.title, "{language} is translated");
            }
        }
    }

    #[test]
    fn the_clipboard_is_cleared_only_while_it_holds_the_copied_text() {
        let hash = text_hash("full kubeconfig");
        assert!(should_clear(Some("full kubeconfig"), &hash));
        assert!(!should_clear(
            Some("something the user copied since"),
            &hash
        ));
        assert!(!should_clear(None, &hash));
        assert_eq!(CLEAR_AFTER.as_secs(), 60);
    }
}
