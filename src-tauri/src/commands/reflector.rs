//! Reflector's namespace patterns (#241, ADR-0110): each pattern against each name, in linear time in the core
//! (`sextant_core::reflector`), off the async runtime. Pure (no cluster) and window only: neither the MCP server nor
//! the extension API offers it.

use sextant_core::reflector::{self, PatternMatches};
use sextant_core::{CoreError, CoreResult};

/// At most `MAX_PATTERNS` patterns and `MAX_NAMES` names; a pattern the core will not run is "cannot tell".
#[tauri::command]
pub async fn reflector_match_patterns(
    patterns: Vec<String>,
    names: Vec<String>,
) -> CoreResult<Vec<PatternMatches>> {
    tokio::task::spawn_blocking(move || reflector::match_patterns(&patterns, &names))
        .await
        .map_err(|err| CoreError::other(format!("matching the patterns failed: {err}")))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_pattern_matching() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("reflector") || t.contains("pattern")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("reflector") || m.contains("pattern")
            }),
            "{methods:?}"
        );
    }
}
