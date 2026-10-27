//! vcluster (#269, ADR-0122): "Connect" on a virtual cluster of a connected host cluster, as `vcluster connect` does —
//! the core reads the vcluster's kubeconfig Secret (`sextant_core::vcluster`), a port forward through the host cluster
//! (`AppState.forwarder`, so it shows in the port-forward list) reaches its API server, and the kubeconfig with the
//! forward's address goes into Sextant's own `kubeconfigs/vcluster.yaml`, a kubeconfig source like any other.
//!
//! An entry lives exactly as long as its forward ([`VclusterLinks`]): when the forward ends — the user stops it, the
//! host cluster is disconnected (the forwarder closes its forwards), the app exits — the virtual cluster is
//! disconnected and its entry removed, and `vcluster-links` tells the window. At start no forward runs, so the file of
//! an earlier run is forgotten ([`forget_earlier_run`]); connecting again is a click on the host's "Virtual clusters".
//! Nothing of the Secret reaches the window, a log or an error. Window only: no MCP tool, no extension method.

use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};

use sextant_core::portforward::{ForwardInfo, PodFilter};
use sextant_core::vcluster::{self, VclusterLink};
use sextant_core::{
    ClusterId, ConnectionState, CoreError, ErrorCode, KubeconfigRegistry, SettingsStore,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::clusters::disconnect_cluster;
use crate::events;
use crate::state::AppState;

/// The virtual clusters Sextant forwards for, in `AppState.vcluster`.
#[derive(Default)]
pub struct VclusterLinks {
    links: std::sync::Mutex<Vec<VclusterLink>>,
    /// Whether the task that ends links whose forward is gone runs.
    watching: AtomicBool,
}

impl VclusterLinks {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<VclusterLink>> {
        self.links.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list(&self) -> Vec<VclusterLink> {
        self.lock().clone()
    }

    fn insert(&self, link: VclusterLink) {
        let mut links = self.lock();
        links.retain(|l| l.cluster_id != link.cluster_id);
        links.push(link);
    }

    fn take(&self, cluster_id: &ClusterId) -> Option<VclusterLink> {
        let mut links = self.lock();
        let at = links.iter().position(|l| &l.cluster_id == cluster_id)?;
        Some(links.remove(at))
    }

    /// Removes and returns the links whose forward is not in `forwards`.
    fn take_gone(&self, forwards: &[ForwardInfo]) -> Vec<VclusterLink> {
        let mut links = self.lock();
        let (gone, kept): (Vec<_>, Vec<_>) = links
            .drain(..)
            .partition(|l| !forwards.iter().any(|f| f.id == l.forward_id));
        *links = kept;
        gone
    }
}

/// At start no forward runs, so the virtual clusters of an earlier run cannot be reached: their file and source are
/// removed (and the sources saved). Called by `AppState::new`; failures leave things as they were.
pub fn forget_earlier_run(registry: &RwLock<KubeconfigRegistry>, settings: &SettingsStore) {
    let sources = {
        let mut registry = registry.write().unwrap_or_else(|e| e.into_inner());
        match vcluster::forget_all(&mut registry) {
            Ok(true) => registry.added_sources(),
            _ => return,
        }
    };
    let _ = settings.update(move |s| s.kubeconfig_sources = sources);
}

/// The virtual clusters Sextant forwards for now.
#[tauri::command]
pub async fn vcluster_links(state: State<'_, AppState>) -> Result<Vec<VclusterLink>, CoreError> {
    Ok(state.vcluster.list())
}

/// Connects the vcluster `namespace`/`name` of the connected host cluster: reads its Secret `vc-<name>` (the user
/// needs `get` on it), forwards a local port to its Service or pod, and writes its entry
/// `vcluster_<name>_<namespace>_<host context>` with that address into Sextant's own `vcluster.yaml`. Connecting it
/// again replaces the forward and the entry (and disconnects the virtual cluster, whose old address is gone). The
/// virtual cluster is then in the cluster list; the window connects it like any other.
#[tauri::command]
pub async fn vcluster_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    host_cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<VclusterLink, CoreError> {
    vcluster::validate_target(&namespace, &name)?;
    let client = state.clusters.client(&host_cluster_id)?;
    let (host_context, file) = {
        let registry = state.registry.read().unwrap_or_else(|e| e.into_inner());
        let host = registry
            .clusters()?
            .into_iter()
            .find(|c| c.id == host_cluster_id)
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    "the host cluster is no longer in the kubeconfig",
                )
            })?;
        (host.context, registry.own_dir().join(vcluster::FILE_NAME))
    };
    let virtual_config =
        vcluster::read_kubeconfig(&client, &namespace, &name, &host_context).await?;
    let cluster_id = ClusterId::for_context(&file, virtual_config.context());

    // A link of the same virtual cluster ends first: its forward, its connection, its entry.
    if let Some(old) = state.vcluster.take(&cluster_id) {
        end_links(&app, &state, vec![old]).await;
    } else if state.clusters.state(&cluster_id) != ConnectionState::Disconnected {
        disconnect_cluster(&state, &cluster_id).await;
    }
    watch_forwards(&app, &state);

    let (target, remote_port) =
        vcluster::forward_target(&client, &namespace, &name, virtual_config.remote_port()).await?;
    let forward = state
        .forwarder
        .start(
            &state.clusters,
            &host_cluster_id,
            target,
            remote_port,
            None,
            PodFilter::Any,
        )
        .await?;
    let saved = {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        vcluster::save(
            &mut registry,
            &virtual_config.kubeconfig(forward.local_port),
        )
        .map(|_| registry.added_sources())
    };
    let sources = match saved {
        Ok(sources) => sources,
        Err(err) => {
            let _ = state.forwarder.stop(&forward.id).await;
            return Err(err);
        }
    };
    state
        .settings
        .update(move |s| s.kubeconfig_sources = sources)?;
    let link = VclusterLink {
        cluster_id,
        context: virtual_config.context().to_owned(),
        host_cluster_id,
        namespace,
        name,
        local_port: forward.local_port,
        forward_id: forward.id.clone(),
    };
    state.vcluster.insert(link.clone());
    // A forward that ended before the link was registered is not seen by the watcher any more.
    if !state.forwarder.list().iter().any(|f| f.id == forward.id) {
        if let Some(gone) = state.vcluster.take(&link.cluster_id) {
            end_links(&app, &state, vec![gone]).await;
        }
        return Err(CoreError::new(
            ErrorCode::Unreachable,
            "the port forward to the vcluster ended right away",
        ));
    }
    emit_links(&app, &state);
    Ok(link)
}

/// Ends the link of a virtual cluster: stops its forward, disconnects it and removes its entry. Nothing to do when it
/// has no link.
#[tauri::command]
pub async fn vcluster_disconnect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<(), CoreError> {
    if let Some(link) = state.vcluster.take(&cluster_id) {
        end_links(&app, &state, vec![link]).await;
    }
    Ok(())
}

/// Stops the links' forwards (if they still run), disconnects their virtual clusters, removes their entries and
/// tells the window. The links are already out of [`VclusterLinks`].
async fn end_links<R: Runtime>(app: &AppHandle<R>, state: &AppState, gone: Vec<VclusterLink>) {
    if gone.is_empty() {
        return;
    }
    for link in &gone {
        let _ = state.forwarder.stop(&link.forward_id).await;
        disconnect_cluster(state, &link.cluster_id).await;
    }
    let contexts: Vec<String> = gone.iter().map(|l| l.context.clone()).collect();
    let sources = {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        match vcluster::remove(&mut registry, &contexts) {
            Ok(true) => Some(registry.added_sources()),
            _ => None,
        }
    };
    if let Some(sources) = sources {
        let _ = state
            .settings
            .update(move |s| s.kubeconfig_sources = sources);
    }
    emit_links(app, state);
}

fn emit_links<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit(events::VCLUSTER_LINKS, state.vcluster.list());
}

/// Once per app: a task that ends every link whose forward left the forwarder's list.
fn watch_forwards<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    if state.vcluster.watching.swap(true, Ordering::AcqRel) {
        return;
    }
    let mut forwards = state.forwarder.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            let list = match forwards.recv().await {
                Ok(list) => list,
                Err(RecvError::Lagged(_)) => handle.state::<AppState>().forwarder.list(),
                Err(RecvError::Closed) => break,
            };
            let state = handle.state::<AppState>();
            let gone = state.vcluster.take_gone(&list);
            end_links(&handle, &state, gone).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use sextant_core::portforward::{ForwardStatus, ForwardTarget};

    use super::*;

    #[test]
    fn neither_agents_nor_extensions_get_vcluster() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(!tools.iter().any(|t| t.contains("vcluster")), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| m.contains("vcluster")),
            "{methods:?}"
        );
    }

    fn link(id: &str, forward: &str) -> VclusterLink {
        VclusterLink {
            cluster_id: ClusterId::from(id),
            context: format!("vcluster_{id}_ns_host"),
            host_cluster_id: ClusterId::from("host"),
            namespace: "ns".into(),
            name: id.into(),
            local_port: 40000,
            forward_id: forward.into(),
        }
    }

    fn forward(id: &str) -> ForwardInfo {
        ForwardInfo {
            id: id.into(),
            cluster: ClusterId::from("host"),
            target: ForwardTarget::Service {
                namespace: "ns".into(),
                name: "dev".into(),
            },
            remote_port: 443,
            local_port: 40000,
            status: ForwardStatus::Active,
        }
    }

    #[test]
    fn a_link_ends_when_its_forward_leaves_the_list() {
        let links = VclusterLinks::default();
        links.insert(link("a", "pf-1"));
        links.insert(link("b", "pf-2"));
        // Connecting again replaces the link of the same virtual cluster.
        links.insert(link("b", "pf-3"));

        let gone = links.take_gone(&[forward("pf-1"), forward("pf-2")]);

        assert_eq!(
            gone.iter()
                .map(|l| l.forward_id.as_str())
                .collect::<Vec<_>>(),
            ["pf-3"]
        );
        assert_eq!(links.list(), [link("a", "pf-1")]);
        assert!(links.take(&ClusterId::from("a")).is_some());
        assert!(links.list().is_empty());
    }

    #[tokio::test]
    async fn connecting_needs_a_connected_host_and_valid_names() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        let handle = app.handle().clone();

        let err = vcluster_connect(
            handle.clone(),
            app.state::<AppState>(),
            ClusterId::from("nope"),
            "team-a".into(),
            "dev".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        let err = vcluster_connect(
            handle.clone(),
            app.state::<AppState>(),
            ClusterId::from("nope"),
            "team-a".into(),
            "../dev".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);

        let links = vcluster_links(app.state::<AppState>()).await.unwrap();
        assert!(links.is_empty());
        vcluster_disconnect(handle, app.state::<AppState>(), ClusterId::from("nope"))
            .await
            .unwrap();
    }

    #[test]
    fn the_virtual_clusters_of_an_earlier_run_are_forgotten_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let (config_dir, data_dir) = (dir.path().join("config"), dir.path().join("data"));
        let file = data_dir.join("kubeconfigs").join(vcluster::FILE_NAME);
        {
            let state = AppState::new(&config_dir, &data_dir);
            let entry = vcluster::parse_kubeconfig(
                b"apiVersion: v1\nkind: Config\nclusters:\n- name: v\n  cluster:\n    server: https://localhost:8443\n\
                  contexts:\n- name: v\n  context:\n    cluster: v\n    user: v\nusers:\n- name: v\n  user:\n    token: t\n\
                  current-context: v\n",
                "vcluster_v_ns_host",
            )
            .unwrap()
            .kubeconfig(40000);
            let sources = {
                let mut registry = state.registry.write().unwrap();
                vcluster::save(&mut registry, &entry).unwrap();
                registry.added_sources()
            };
            state
                .settings
                .update(move |s| s.kubeconfig_sources = sources)
                .unwrap();
            assert!(file.exists());
        }

        let state = AppState::new(&config_dir, &data_dir);

        assert!(!file.exists());
        assert!(state.settings.get().kubeconfig_sources.is_empty());
        assert!(state.registry.read().unwrap().added_sources().is_empty());
    }
}
