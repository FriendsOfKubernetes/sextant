//! Saved views and workspaces (#149): reading an export file. Writing one goes through `file_save` (the save dialog's
//! path). The window parses and previews the file; nothing is applied here.
//!
//! The backend shows the open dialog itself and reads only the file the user picked there: the window never names a
//! path to read, so a compromised page cannot read an arbitrary file through this command.

use std::path::Path;

use sextant_core::{CoreError, ErrorCode};
use tauri::Runtime;
use tauri_plugin_dialog::DialogExt;

/// The largest export file read: far above any real one (views, pins and workspaces are capped in the settings).
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024;

/// Shows the open dialog (`title`, a filter `filter` for `.json` files) and reads the file the user picked as UTF-8
/// text ([`read_import`]); `None` when the dialog was cancelled.
#[tauri::command]
pub async fn views_import_open<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    title: String,
    filter: String,
) -> Result<Option<String>, CoreError> {
    let picked = tokio::task::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .add_filter(filter, &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|err| CoreError::other(format!("the open dialog failed: {err}")))?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || read_import(&path).map(Some))
        .await
        .map_err(|err| CoreError::other(format!("reading the file failed: {err}")))?
}

/// Reads the export file at `path` (picked in the open dialog) as UTF-8 text: an absolute path to a regular file of
/// at most [`MAX_IMPORT_BYTES`]. A folder, a device or a larger file is refused before anything is read past the cap.
pub fn read_import(path: &Path) -> Result<String, CoreError> {
    use std::io::Read;
    if !path.is_absolute() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "the file path must be absolute",
        ));
    }
    let io_error = |err: std::io::Error| {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::Forbidden,
            _ => ErrorCode::Other,
        };
        CoreError::new(code, format!("cannot read {}: {err}", path.display()))
    };
    // A folder is refused before it is opened (Windows cannot open one as a file).
    if !std::fs::metadata(path).map_err(io_error)?.is_file() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{} is not a file", path.display()),
        ));
    }
    let file = std::fs::File::open(path).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{} is not a file", path.display()),
        ));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(too_big(path));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(too_big(path));
    }
    String::from_utf8(bytes).map_err(|_| {
        CoreError::new(
            ErrorCode::Invalid,
            format!("{} is not UTF-8 text", path.display()),
        )
    })
}

fn too_big(path: &Path) -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        format!(
            "{} is larger than {} KiB",
            path.display(),
            MAX_IMPORT_BYTES / 1024
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_small_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("views.json");
        std::fs::write(&path, "{\"format\":\"sextant-workspace\"}").unwrap();
        assert_eq!(
            read_import(&path).unwrap(),
            "{\"format\":\"sextant-workspace\"}"
        );
    }

    #[test]
    fn refuses_a_large_file_a_folder_a_relative_path_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.json");
        std::fs::write(&big, vec![b' '; MAX_IMPORT_BYTES as usize + 1]).unwrap();
        assert_eq!(read_import(&big).unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(
            read_import(dir.path()).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(
            read_import(Path::new("views.json")).unwrap_err().code,
            ErrorCode::Invalid
        );
        let binary = dir.path().join("bin.json");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_import(&binary).unwrap_err().code, ErrorCode::Invalid);
        assert_eq!(
            read_import(&dir.path().join("missing.json"))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
}
