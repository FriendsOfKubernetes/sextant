//! Saving files chosen in a `tauri-plugin-dialog` save dialog (e.g. logs).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use sextant_core::{CoreError, ErrorCode};

/// Writes `contents` to `path` (created or replaced). The path comes from the system save dialog.
#[tauri::command]
pub async fn file_save(path: PathBuf, contents: String) -> Result<(), CoreError> {
    write_file(&path, &contents).await
}

async fn write_file(path: &Path, contents: &str) -> Result<(), CoreError> {
    tokio::fs::write(path, contents).await.map_err(|err| {
        let code = match err.kind() {
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::Forbidden,
            _ => ErrorCode::Other,
        };
        CoreError::new(code, format!("cannot write {}: {err}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saves_the_contents_and_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pod.log");
        file_save(path.clone(), "one\ntwo\n".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        file_save(path.clone(), "three\n".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three\n");
    }

    #[tokio::test]
    async fn a_missing_directory_is_a_not_found_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = file_save(dir.path().join("no/such/dir/x.log"), "x".into())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
