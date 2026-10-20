//! Saving one file of an image where the user picked (the backend's save dialog): written to a
//! `.sextant-download-*.part` file created exclusively next to the destination, the whole layer read and its digest
//! checked, and only then renamed over the destination (a link there is replaced, never followed). A failed or
//! stopped download leaves nothing.

use std::io::{BufWriter, Write};
use std::path::Path;

use super::layer::{Extracted, StreamOptions, extract_file};
use super::{invalid, limits};
use crate::{CoreError, CoreResult, ErrorCode};

fn local_error(path: &Path, err: &std::io::Error) -> CoreError {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::Forbidden,
        _ => ErrorCode::Other,
    };
    CoreError::new(code, format!("cannot write {}: {err}", path.display()))
}

/// Saves the regular file `entry` (a normalised path) of the layer stream `inner` to `destination` (absolute).
pub fn save_file<R: std::io::Read>(
    inner: R,
    options: &StreamOptions,
    entry: &str,
    destination: &Path,
    progress: &mut dyn FnMut(u64),
) -> CoreResult<u64> {
    if !destination.is_absolute() {
        return Err(invalid("the destination must be an absolute path"));
    }
    let dir = destination
        .parent()
        .ok_or_else(|| invalid("the destination has no folder"))?;
    let temp = tempfile::Builder::new()
        .prefix(".sextant-download-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| local_error(destination, &e))?;
    let mut out = BufWriter::new(temp);
    let Extracted { size, written } = extract_file(
        inner,
        options,
        entry,
        limits::MAX_DOWNLOAD_BYTES,
        true,
        &mut out,
        progress,
    )?;
    if written < size {
        return Err(invalid("the file is larger than 4 GiB"));
    }
    out.flush().map_err(|e| local_error(destination, &e))?;
    let temp = out
        .into_inner()
        .map_err(|e| local_error(destination, e.error()))?;
    temp.persist(destination)
        .map_err(|e| local_error(destination, &e.error))?;
    Ok(written)
}
