//! AI agent access rules (`sextant_core::access`). The rules of the presets come only from here, so the frontend
//! never keeps its own copy.

use sextant_core::CoreError;
use sextant_core::access::{self, AccessPreset, AccessRule};

/// The rules a preset stands for (empty for `off` and `custom`); "Custom" starts from them for editing.
#[tauri::command]
pub fn access_preset_rules(preset: AccessPreset) -> Result<Vec<AccessRule>, CoreError> {
    Ok(access::preset_rules(preset))
}
