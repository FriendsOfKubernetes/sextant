//! Saving files chosen in a `tauri-plugin-dialog` save dialog (e.g. logs).

use std::path::PathBuf;

use sextant_core::CoreError;

#[tauri::command]
pub async fn file_save(_path: PathBuf, _contents: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
