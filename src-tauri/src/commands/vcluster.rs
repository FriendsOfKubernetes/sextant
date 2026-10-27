//! vcluster (#269, ADR-0122): "Connect" on a virtual cluster of a connected host cluster, as `vcluster connect` does —
//! the core reads the vcluster's kubeconfig Secret (`sextant_core::vcluster`), a port forward through the host cluster
//! (`AppState.forwarder`, so it shows in the port-forward list) reaches its API server, and the kubeconfig with the
//! forward's address goes into this process's own `kubeconfigs/vcluster-<pid>.yaml`, a kubeconfig source like any
//! other that is never stored in the settings.
//!
//! An entry lives exactly as long as its forward ([`VclusterLinks`]): when the forward ends — the user stops it, the
//! host cluster is disconnected (the forwarder closes its forwards), the app exits — the virtual cluster is
//! disconnected and its entry removed, and `vcluster-links` tells the window. Closing the window or the app removes
//! the file at once ([`close_all`]); at start the files of processes that no longer run (a crash) are removed, never
//! another running Sextant's ([`forget_earlier_run`]); connecting again is a click on the host's "Virtual clusters".
//! Nothing of the Secret reaches the window, a log or an error. Window only: no MCP tool, no extension method.

use std::collections::HashSet;
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};

use sextant_core::portforward::{ForwardInfo, PodFilter, PortForwarder};
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
    /// The virtual clusters a Connect runs for now: a second Connect of one is refused until the first ends.
    connecting: std::sync::Mutex<HashSet<ClusterId>>,
    /// Whether the task that ends links whose forward is gone runs.
    watching: AtomicBool,
}

/// A Connect of one virtual cluster in progress ([`VclusterLinks::begin`]); dropping it ends it.
pub struct Connecting<'a> {
    links: &'a VclusterLinks,
    cluster_id: ClusterId,
}

impl Drop for Connecting<'_> {
    fn drop(&mut self) {
        lock(&self.links.connecting).remove(&self.cluster_id);
    }
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl VclusterLinks {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<VclusterLink>> {
        lock(&self.links)
    }

    pub fn list(&self) -> Vec<VclusterLink> {
        self.lock().clone()
    }

    /// Starts a Connect of `cluster_id`; `conflict` while another one of it runs (two quick clicks would start two
    /// forwards for one entry).
    fn begin(&self, cluster_id: &ClusterId) -> Result<Connecting<'_>, CoreError> {
        if !lock(&self.connecting).insert(cluster_id.clone()) {
            return Err(CoreError::new(
                ErrorCode::Conflict,
                "this virtual cluster is being connected already",
            ));
        }
        Ok(Connecting {
            links: self,
            cluster_id: cluster_id.clone(),
        })
    }

    /// Adds `link`; returns the link of the same virtual cluster it replaces, whose forward the caller stops.
    fn insert(&self, link: VclusterLink) -> Option<VclusterLink> {
        let mut links = self.lock();
        let replaced = links
            .iter()
            .position(|l| l.cluster_id == link.cluster_id)
            .map(|at| links.remove(at));
        links.push(link);
        replaced
    }

    fn take(&self, cluster_id: &ClusterId) -> Option<VclusterLink> {
        let mut links = self.lock();
        let at = links.iter().position(|l| &l.cluster_id == cluster_id)?;
        Some(links.remove(at))
    }

    /// Removes and returns the links whose forward is not in `forwards`.
    #[cfg(test)]
    fn take_gone(&self, forwards: &[ForwardInfo]) -> Vec<VclusterLink> {
        take_gone_from(&mut self.lock(), forwards)
    }

    /// [`Self::take_gone`] against the forwarder's list as it is now, read under the links' lock: a link is added only
    /// after its forward started (and under that lock), so a forward the list lacks is really gone — never one that
    /// started after an older list was published.
    fn take_gone_now(&self, forwarder: &PortForwarder) -> Vec<VclusterLink> {
        let mut links = self.lock();
        take_gone_from(&mut links, &forwarder.list())
    }

    /// Forgets every link (the window closing, the app exiting; the forwarder stops their forwards).
    fn clear(&self) {
        self.lock().clear();
    }
}

fn take_gone_from(links: &mut Vec<VclusterLink>, forwards: &[ForwardInfo]) -> Vec<VclusterLink> {
    let (gone, kept): (Vec<_>, Vec<_>) = links
        .drain(..)
        .partition(|l| !forwards.iter().any(|f| f.id == l.forward_id));
    *links = kept;
    gone
}

/// At start no forward of this process runs: the files of processes that no longer run (a crash) are removed with
/// their entries, and a virtual clusters' source an earlier build stored in the settings is dropped from them (the
/// sources are saved only then). Another running Sextant's file is left alone. Called by `AppState::new`.
pub fn forget_earlier_run(registry: &RwLock<KubeconfigRegistry>, settings: &SettingsStore) {
    let sources = {
        let mut registry = registry.write().unwrap_or_else(|e| e.into_inner());
        if !vcluster::forget_earlier_runs(&mut registry) {
            return;
        }
        registry.added_sources()
    };
    let _ = settings.update(move |s| s.kubeconfig_sources = sources);
}

/// The window closes or the app exits (`AppState::close_all`, after the forwarder stopped every forward): every link
/// ends and this process's file, with the credentials in it, is removed before this returns.
pub fn close_all(state: &AppState) {
    state.vcluster.clear();
    let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
    vcluster::forget_own(&mut registry);
}

/// The virtual clusters Sextant forwards for now.
#[tauri::command]
pub async fn vcluster_links(state: State<'_, AppState>) -> Result<Vec<VclusterLink>, CoreError> {
    Ok(state.vcluster.list())
}

/// Connects the vcluster `namespace`/`name` of the connected host cluster: reads its Secret `vc-<name>` (the user
/// needs `get` on it), forwards a local port to its Service or pod, and writes its entry
/// `vcluster_<name>_<namespace>_<host context>` with that address into this process's own `vcluster-<pid>.yaml`.
/// Connecting it again replaces the forward and the entry (and disconnects the virtual cluster, whose old address is
/// gone); a second Connect while one runs is a `conflict`. Whatever fails after the forward started stops it and
/// removes the entry. The virtual cluster is then in the cluster list; the window connects it like any other.
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
    let (host_context, cluster_id) = {
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
        let context = vcluster::context_name(&name, &namespace, &host.context);
        let id = vcluster::cluster_id(&registry, &context);
        (host.context, id)
    };
    let _connecting = state.vcluster.begin(&cluster_id)?;
    let virtual_config =
        vcluster::read_kubeconfig(&client, &namespace, &name, &host_context).await?;

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
    let context = virtual_config.context().to_owned();
    // From here on, a failure stops the forward and removes the entry: nothing runs or stays on disk without a link.
    let undo = |state: &AppState| {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        let _ = vcluster::remove(&mut registry, std::slice::from_ref(&context));
    };
    let saved = {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        vcluster::save(
            &mut registry,
            &virtual_config.kubeconfig(forward.local_port),
        )
    };
    if let Err(err) = saved {
        let _ = state.forwarder.stop(&forward.id).await;
        undo(&state);
        return Err(err);
    }
    let link = VclusterLink {
        cluster_id,
        context: context.clone(),
        host_cluster_id,
        namespace,
        name,
        local_port: forward.local_port,
        forward_id: forward.id.clone(),
    };
    // Not with one Connect at a time; should a link be there all the same, its forward is not left running.
    if let Some(replaced) = state.vcluster.insert(link.clone()) {
        let _ = state.forwarder.stop(&replaced.forward_id).await;
    }
    // A forward that ended before the link was registered is not seen by the watcher any more.
    if !state.forwarder.list().iter().any(|f| f.id == forward.id) {
        if let Some(gone) = state.vcluster.take(&link.cluster_id) {
            end_links(&app, &state, vec![gone]).await;
        }
        undo(&state);
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
    {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        let _ = vcluster::remove(&mut registry, &contexts);
    }
    emit_links(app, state);
}

fn emit_links<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit(events::VCLUSTER_LINKS, state.vcluster.list());
}

/// Once per app: a task that ends every link whose forward left the forwarder's list. A message only says that the
/// list changed: the list is read again when it arrives ([`VclusterLinks::take_gone_now`]), since one published before
/// a new forward started would not have it.
fn watch_forwards<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    if state.vcluster.watching.swap(true, Ordering::AcqRel) {
        return;
    }
    let mut forwards = state.forwarder.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match forwards.recv().await {
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
            let state = handle.state::<AppState>();
            let gone = state.vcluster.take_gone_now(&state.forwarder);
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
        assert!(links.insert(link("a", "pf-1")).is_none());
        assert!(links.insert(link("b", "pf-2")).is_none());
        // Connecting again replaces the link of the same virtual cluster, and says which forward to stop.
        let replaced = links.insert(link("b", "pf-3")).unwrap();
        assert_eq!(replaced.forward_id, "pf-2");

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

    #[test]
    fn links_are_judged_against_the_forwarders_list_as_it_is_now() {
        // A message published before a forward started does not carry it: the list is read again, so a link of a
        // running forward never ends. With no forward running at all, every link has ended.
        let links = VclusterLinks::default();
        links.insert(link("a", "pf-1"));
        let forwarder = PortForwarder::new();
        let gone = links.take_gone_now(&forwarder);
        assert_eq!(gone, [link("a", "pf-1")]);
        assert!(links.list().is_empty());
        links.insert(link("b", "pf-2"));
        links.clear();
        assert!(links.list().is_empty());
    }

    #[test]
    fn a_second_connect_of_one_virtual_cluster_waits_for_the_first() {
        let links = VclusterLinks::default();
        let first = links.begin(&ClusterId::from("v")).unwrap();
        assert_eq!(
            links.begin(&ClusterId::from("v")).err().unwrap().code,
            ErrorCode::Conflict
        );
        // Another virtual cluster is not held up.
        let other = links.begin(&ClusterId::from("w")).unwrap();
        drop(first);
        assert!(links.begin(&ClusterId::from("v")).is_ok());
        drop(other);
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
    fn the_virtual_clusters_of_an_earlier_run_are_forgotten_at_start_and_never_stored() {
        let dir = tempfile::tempdir().unwrap();
        let (config_dir, data_dir) = (dir.path().join("config"), dir.path().join("data"));
        let own = data_dir.join("kubeconfigs");
        // An earlier build's single file, stored in the settings.
        let legacy = own.join(vcluster::ID_FILE_NAME);
        {
            let state = AppState::new(&config_dir, &data_dir);
            std::fs::create_dir_all(&own).unwrap();
            std::fs::write(&legacy, "apiVersion: v1\nkind: Config\n").unwrap();
            state
                .settings
                .update(|s| {
                    s.kubeconfig_sources = vec![sextant_core::KubeconfigSource {
                        id: "legacy".into(),
                        path: legacy.clone(),
                        kind: sextant_core::SourceKind::Vcluster,
                        error: None,
                    }]
                })
                .unwrap();
        }
        // This process's file of an earlier process with the same PID (a crash).
        let reused = own.join(vcluster::file_name());
        std::fs::write(&reused, "apiVersion: v1\nkind: Config\n").unwrap();

        let state = AppState::new(&config_dir, &data_dir);

        assert!(!legacy.exists() && !reused.exists());
        assert!(state.settings.get().kubeconfig_sources.is_empty());

        // A new entry is listed, never stored, and goes when the app closes.
        {
            let mut registry = state.registry.write().unwrap();
            // Not this machine's own kubeconfig files.
            registry.set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: None,
                home: None,
            });
            let entry = vcluster::parse_kubeconfig(
                b"apiVersion: v1\nkind: Config\nclusters:\n- name: v\n  cluster:\n    server: https://localhost:8443\n\
                  contexts:\n- name: v\n  context:\n    cluster: v\n    user: v\nusers:\n- name: v\n  user:\n    token: t\n\
                  current-context: v\n",
                "vcluster_v_ns_host",
            )
            .unwrap()
            .kubeconfig(40000);
            vcluster::save(&mut registry, &entry).unwrap();
            assert!(registry.added_sources().is_empty());
            assert_eq!(registry.clusters().unwrap().len(), 1);
        }
        assert!(reused.exists());
        close_all(&state);
        assert!(!reused.exists());
        assert!(
            state
                .registry
                .read()
                .unwrap()
                .clusters()
                .unwrap()
                .is_empty()
        );
    }
}
