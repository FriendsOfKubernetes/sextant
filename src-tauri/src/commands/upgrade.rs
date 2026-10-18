//! Upgrade readiness (#142): one read-only scan through the core (`sextant_core::upgrade`): the server version, the
//! requested deprecated API versions the cluster serves and where they are still used (live objects' last applied
//! configuration and field managers, Helm release manifests decoded in the core, Argo CD and Flux inventories), and
//! kubelet and control-plane versions. Only lists and reads; nothing in the cluster changes, and neither a manifest
//! nor a Secret value leaves the core. A window command only: neither the MCP server nor the extension API offers it.

use sextant_core::upgrade::{self, ScanApi, UpgradeScan};
use sextant_core::{ClusterId, CoreResult};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn upgrade_scan(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    apis: Vec<ScanApi>,
) -> CoreResult<UpgradeScan> {
    upgrade::scan(&state.clusters, &cluster_id, apis).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_can_scan_for_upgrades() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        // `helm_upgrade` is a Helm action, not this scan.
        assert!(
            !tools.iter().any(|t| t.contains("upgrade_scan")
                || t.contains("readiness")
                || t.contains("deprecat")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("upgradescan")
                    || m.contains("upgrade_scan")
                    || m.contains("readiness")
                    || m.contains("deprecat")
            }),
            "{methods:?}"
        );
    }
}
