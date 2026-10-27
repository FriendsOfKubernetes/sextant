//! Every command from the IPC contract (interfaces.md, "Команды") is registered, with the argument names the
//! frontend sends. Uses Tauri's mock runtime, so no window opens.
//!
//! Commands with arguments are invoked with an empty argument object: Tauri rejects them while deserializing
//! ("missing required key <name>"), which proves the command exists and checks its first argument name without
//! running it. Commands without arguments run for real and must answer with a value or a `CoreError`.

use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

/// (command, first argument as the frontend names it; `None` = no arguments)
const COMMANDS: &[(&str, Option<&str>)] = &[
    ("clusters_list", None),
    ("kubeconfig_sources", None),
    ("kubeconfig_add_file", Some("path")),
    ("kubeconfig_add_pasted", Some("text")),
    ("kubeconfig_remove", Some("sourceId")),
    ("kubeconfig_edit_preview", Some("edit")),
    ("kubeconfig_edit_apply", Some("edit")),
    ("kubeconfig_credentials", None),
    ("kubeconfig_edit_target", Some("sourceId")),
    ("kubeconfig_validate", Some("input")),
    ("kubeconfig_check_connection", Some("input")),
    ("kubeconfig_view", Some("clusterId")),
    ("kubeconfig_copy", Some("clusterId")),
    ("cluster_connect", Some("clusterId")),
    ("cluster_disconnect", Some("clusterId")),
    ("cluster_state", Some("clusterId")),
    ("cluster_kinds", Some("clusterId")),
    ("cluster_kinds_refresh", Some("clusterId")),
    ("cloud_status", None),
    ("cloud_accounts", Some("provider")),
    ("cloud_find", Some("query")),
    ("cloud_import", Some("clusters")),
    ("cloud_login_hint", Some("clusterId")),
    ("watch_start", Some("clusterId")),
    ("watch_stop", Some("subscriptionId")),
    ("streams_reset", None),
    ("resource_get", Some("clusterId")),
    ("resource_count", Some("clusterId")),
    ("resource_replace", Some("clusterId")),
    ("resource_apply", Some("clusterId")),
    ("resource_dry_run", Some("clusterId")),
    ("resource_delete", Some("clusterId")),
    ("secret_value", Some("clusterId")),
    ("resource_get_full", Some("clusterId")),
    ("workload_scale", Some("clusterId")),
    ("workload_restart", Some("clusterId")),
    ("node_cordon", Some("clusterId")),
    ("node_drain_preview", Some("clusterId")),
    ("node_drain", Some("clusterId")),
    ("cronjob_trigger", Some("clusterId")),
    ("cronjob_suspend", Some("clusterId")),
    ("resource_patch", Some("clusterId")),
    ("resource_patch_status", Some("clusterId")),
    ("logs_start", Some("clusterId")),
    ("logs_stop", Some("streamId")),
    ("exec_start", Some("clusterId")),
    // `clusterId` is optional (a terminal without a cluster), so the first required argument is `cols`.
    ("terminal_start", Some("cols")),
    ("node_shell_start", Some("clusterId")),
    ("debug_start", Some("clusterId")),
    ("term_input", Some("sessionId")),
    ("term_resize", Some("sessionId")),
    ("term_stop", Some("sessionId")),
    ("term_ack", Some("sessionId")),
    ("portforward_start", Some("clusterId")),
    ("portforward_list", None),
    ("portforward_stop", Some("id")),
    ("metrics_pods", Some("clusterId")),
    ("metrics_nodes", Some("clusterId")),
    ("metrics_status", Some("clusterId")),
    ("metrics_charts", Some("clusterId")),
    ("metrics_usage_history", Some("clusterId")),
    ("metrics_request_health", Some("clusterId")),
    ("metrics_traffic_graph", Some("clusterId")),
    ("storage_volume_usage", Some("clusterId")),
    ("resource_create", Some("clusterId")),
    ("helm_status", None),
    ("helm_releases", Some("clusterId")),
    ("helm_release_detail", Some("clusterId")),
    ("helm_release_history", Some("clusterId")),
    ("helm_upgrade", Some("clusterId")),
    ("helm_rollback", Some("clusterId")),
    ("helm_uninstall", Some("clusterId")),
    ("helm_install", Some("clusterId")),
    ("helm_upgrade_preview", Some("clusterId")),
    ("helm_install_preview", Some("clusterId")),
    ("helm_preview_stop", Some("previewId")),
    ("helm_repos", None),
    ("helm_repo_add", Some("name")),
    ("helm_repo_remove", Some("name")),
    ("helm_repo_update", None),
    ("helm_search", Some("query")),
    ("helm_show_values", Some("chart")),
    ("helm_revision_diff", Some("clusterId")),
    ("helm_chart_updates", Some("charts")),
    ("settings_get", None),
    ("settings_update", Some("settings")),
    ("settings_status", None),
    ("tray_status", None),
    ("tray_set_texts", Some("texts")),
    ("about_info", None),
    ("system_fonts", None),
    ("gitops_install_versions", Some("tool")),
    ("gitops_install_prepare", Some("clusterId")),
    ("gitops_install_start", Some("clusterId")),
    ("gitops_install_stop", Some("streamId")),
    ("gitops_install_status", Some("clusterId")),
    ("file_save", Some("path")),
    ("views_import_open", Some("title")),
    ("files_stat", Some("clusterId")),
    ("files_download_start", Some("clusterId")),
    ("files_upload_start", Some("clusterId")),
    ("files_transfer_stop", Some("streamId")),
    ("image_files_open_start", Some("source")),
    ("image_files_read_start", Some("sessionId")),
    ("image_files_download_start", Some("sessionId")),
    ("image_files_list", Some("sessionId")),
    ("image_files_search", Some("sessionId")),
    ("image_files_resolve", Some("sessionId")),
    ("image_files_stop", Some("streamId")),
    ("argocd_status", Some("clusterId")),
    ("argocd_login", Some("clusterId")),
    ("argocd_logout", Some("clusterId")),
    ("argocd_diff", Some("clusterId")),
    ("access_preset_rules", Some("preset")),
    ("rbac_can_i", Some("clusterId")),
    ("rbac_rules_review", Some("clusterId")),
    ("rbac_whoami", Some("clusterId")),
    ("reflector_match_patterns", Some("patterns")),
    ("openshift_rollout_latest", Some("clusterId")),
    ("openshift_start_build", Some("clusterId")),
    ("upgrade_scan", Some("clusterId")),
    ("vcluster_links", None),
    ("vcluster_connect", Some("hostClusterId")),
    ("vcluster_disconnect", Some("clusterId")),
    ("cleanup_sample", Some("clusterId")),
    ("cleanup_cluster_check", Some("clusterId")),
    ("compare_list", Some("clusterId")),
    ("compare_secrets", Some("left")),
    ("compare_secret_namespaces", Some("left")),
    ("compare_helm_drift", Some("clusterId")),
    ("workload_set_image", Some("clusterId")),
    ("workload_set_image_dry_run", Some("clusterId")),
    ("openapi_kind_schema", Some("clusterId")),
    ("timeline_managers", Some("clusterId")),
    ("timeline_history", Some("clusterId")),
    ("timeline_object_history", Some("clusterId")),
    ("timeline_save", Some("clusterId")),
    ("timeline_load", Some("clusterId")),
    ("timeline_remove_all", None),
    ("tls_certificate_info", Some("clusterId")),
    ("tls_expiry_scan", Some("clusterId")),
    ("cost_allocation", Some("clusterId")),
    ("alerts_list", Some("clusterId")),
    ("loki_status", Some("clusterId")),
    ("loki_names", Some("clusterId")),
    ("loki_logs_start", Some("clusterId")),
    ("loki_logs_stop", Some("streamId")),
    ("mcp_status", None),
    ("mcp_token", None),
    ("mcp_regenerate_token", None),
    ("mcp_audit_list", None),
    ("mcp_audit_clear", None),
    ("mcp_confirm_answer", Some("id")),
    ("mcp_diagnostic_answer", Some("id")),
    ("mcp_binary_path", None),
    ("extensions_list", None),
    ("extension_inspect_file", Some("path")),
    ("extension_inspect_url", Some("url")),
    ("extension_inspect_folder", Some("path")),
    ("extension_install", Some("token")),
    ("extension_install_cancel", Some("token")),
    ("extension_set_enabled", Some("id")),
    ("extension_remove", Some("id")),
    ("extension_reload", Some("id")),
    ("extension_call", Some("extensionId")),
    ("extension_watch_stop", Some("extensionId")),
    ("extension_audit_list", None),
    ("extension_audit_clear", None),
];

struct Harness {
    _app: tauri::App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    _dirs: tempfile::TempDir,
}

/// Application state in `dirs` that never reads the developer's own kubeconfig: no `KUBECONFIG`, home inside
/// `dirs` (so `~/.kube/config` is `<dirs>/home/.kube/config`).
fn isolated_state(dirs: &std::path::Path) -> sextant_lib::AppState {
    let state = sextant_lib::AppState::new(&dirs.join("config"), &dirs.join("data"));
    state
        .registry
        .write()
        .unwrap()
        .set_env(sextant_core::kubeconfig::KubeconfigEnv {
            kubeconfig: None,
            home: Some(dirs.join("home")),
        });
    state
}

fn harness() -> Harness {
    harness_in(tempfile::tempdir().unwrap())
}

fn harness_in(dirs: tempfile::TempDir) -> Harness {
    let app = sextant_lib::with_commands(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let state = isolated_state(dirs.path());
    app.manage(sextant_lib::extensions::ExtensionHost::new(
        &dirs.path().join("data"),
        std::sync::Arc::clone(&state.settings),
    ));
    app.manage(state);
    app.manage(sextant_lib::commands::timeline::TimelineDir(
        dirs.path().join("data").join("timeline"),
    ));
    // Helm commands use this `helm`: a path that does not exist, so no test runs the developer's helm (network,
    // ~/.config/helm, ~/.cache/helm) — they answer `helmMissing` instead.
    app.manage(
        sextant_core::helm::cli::HelmCli::default().with_binary(dirs.path().join("no-helm")),
    );
    // Cloud commands look for `aws`/`gcloud`/`az` in an empty directory: no test runs the developer's cloud CLIs.
    app.manage(
        sextant_core::cloud::CloudCli::default().with_env([("PATH", dirs.path().join("no-cli"))]),
    );
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Harness {
        _app: app,
        window,
        _dirs: dirs,
    }
}

fn invoke(h: &Harness, cmd: &str, args: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        // Local origin of the app's own pages differs per OS: tauri-2.12.3
        // src/protocol/mod.rs `origin()` (used by `Webview::is_local_url`).
        // Any other URL is treated as a remote origin, which `default`
        // capability does not grant.
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&h.window, request).map(|body| body.deserialize::<Value>().unwrap())
}

const ERROR_CODES: &[&str] = &[
    "unreachable",
    "unauthorized",
    "forbidden",
    "notFound",
    "conflict",
    "invalid",
    "authPlugin",
    "helmMissing",
    "portInUse",
    "kubeconfig",
    "timeout",
    "denied",
    "other",
];

#[test]
fn unknown_command_is_rejected() {
    let h = harness();
    let err = invoke(&h, "no_such_command", json!({})).unwrap_err();
    assert!(
        err.as_str().unwrap_or_default().contains("not found"),
        "{err}"
    );
}

#[test]
fn helm_commands_never_run_the_real_helm() {
    let h = harness();
    let status = invoke(&h, "helm_status", json!({})).unwrap();
    assert_eq!(status["available"], false, "{status}");
    for cmd in ["helm_repos", "helm_repo_update"] {
        let err = invoke(&h, cmd, json!({})).unwrap_err();
        assert_eq!(err["code"], "helmMissing", "{cmd}: {err}");
    }
}

#[test]
fn without_a_tray_icon_the_window_is_told_the_tray_is_unavailable() {
    let h = harness();
    // The mock runtime never creates a tray icon, like a Linux desktop without AppIndicator.
    let status = invoke(&h, "tray_status", json!({})).unwrap();
    assert_eq!(status, json!({ "available": false }));
}

#[test]
fn system_fonts_lists_family_names_only() {
    let h = harness();
    let fonts = invoke(&h, "system_fonts", json!({})).unwrap();
    // A build machine may have no fonts; every entry is a name and a flag, never a path.
    for font in fonts.as_array().unwrap() {
        let mut keys: Vec<_> = font.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["family", "monospace"], "{font}");
        assert!(font["monospace"].is_boolean(), "{font}");
        let family = font["family"].as_str().unwrap();
        assert!(!family.is_empty() && !family.contains('/'), "{font}");
    }
    // The second call is answered from the cache, the same list.
    assert_eq!(invoke(&h, "system_fonts", json!({})).unwrap(), fonts);
}

#[test]
fn about_info_names_the_machine_without_paths_or_user_names() {
    let h = harness();
    let info = invoke(&h, "about_info", json!({})).unwrap();
    assert_eq!(info["tauriVersion"], tauri::VERSION, "{info}");
    assert_eq!(info["arch"], std::env::consts::ARCH, "{info}");
    let os = info["os"].as_str().unwrap();
    assert!(["Linux", "macOS", "Windows"].contains(&os), "{info}");
    // Only the five fields of the contract, and nothing that names the user or a folder.
    let mut keys: Vec<_> = info.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["arch", "os", "osVersion", "tauriVersion", "webviewVersion"],
        "{info}"
    );
    let text = info.to_string();
    // HOME/USER are usually unset on Windows, where the names are in USERPROFILE/USERNAME.
    for var in ["HOME", "USER", "USERNAME", "USERPROFILE"] {
        let private = std::env::var(var).unwrap_or_default();
        assert!(
            private.len() < 2 || !text.contains(&private),
            "{info} names {var}={private}"
        );
    }
}

#[test]
fn gitops_install_commands_on_a_cluster_that_is_not_connected_fail_before_downloading() {
    let h = harness();
    let not_connected = json!({ "clusterId": "nope", "tool": "argoCd", "version": "v3.5.5" });
    let err = invoke(&h, "gitops_install_prepare", not_connected).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "gitops_install_start",
        json!({ "clusterId": "nope", "token": "t", "streamId": "s-1", "onEvent": "__CHANNEL__:1" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "gitops_install_start",
        json!({ "clusterId": "nope", "token": "t", "streamId": "bad id", "onEvent": "__CHANNEL__:2" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let err = invoke(&h, "gitops_install_status", json!({ "clusterId": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // Stopping an install that does not run is not an error.
    assert_eq!(
        invoke(&h, "gitops_install_stop", json!({ "streamId": "s-1" })).unwrap(),
        Value::Null
    );
    let err = invoke(&h, "gitops_install_versions", json!({ "tool": "helm" })).unwrap_err();
    assert!(
        err.as_str().unwrap_or_default().contains("unknown variant"),
        "{err}"
    );
}

#[test]
fn rbac_reviews_need_a_connected_cluster_and_check_their_input_first() {
    let h = harness();
    let err = invoke(
        &h,
        "rbac_can_i",
        json!({ "clusterId": "nope", "queries": [{ "verb": "get", "resource": "pods" }] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // A malformed question is refused before the cluster is looked up.
    let err = invoke(
        &h,
        "rbac_can_i",
        json!({ "clusterId": "nope", "queries": [{ "verb": "get" }] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let err = invoke(
        &h,
        "rbac_rules_review",
        json!({ "clusterId": "nope", "namespace": "default" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(&h, "rbac_whoami", json!({ "clusterId": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

#[test]
fn reflector_patterns_are_matched_in_the_core_and_bounded() {
    let h = harness();
    let out = invoke(
        &h,
        "reflector_match_patterns",
        json!({ "patterns": ["namespace-[0-9]*", "(a|a)*b", "(?=x)x"], "names": ["namespace-30", "aaaaaaaaaaaaaaaaaaaaaaaaaa"] }),
    )
    .unwrap();
    assert_eq!(
        out,
        json!([
            { "matches": ["yes", "no"] },
            { "matches": ["no", "no"] },
            { "issue": "invalid", "matches": ["cannotTell", "cannotTell"] }
        ])
    );
    let too_many: Vec<String> = (0..65).map(|i| format!("p{i}")).collect();
    let err = invoke(
        &h,
        "reflector_match_patterns",
        json!({ "patterns": too_many, "names": [] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn the_cleanup_sample_checks_its_input_first_and_needs_a_connected_cluster() {
    let h = harness();
    let config_maps = json!([{ "group": "", "version": "v1", "kind": "ConfigMap" }]);
    let err = invoke(
        &h,
        "cleanup_sample",
        json!({ "clusterId": "nope", "namespace": "Not A Namespace", "kinds": config_maps, "limit": 1 }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let err = invoke(
        &h,
        "cleanup_sample",
        json!({ "clusterId": "nope", "namespace": "team", "kinds": config_maps, "limit": 1 }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "cleanup_cluster_check",
        json!({ "clusterId": "nope", "kinds": [], "targets": [{ "kind": "Pod", "namespace": "a", "name": "b" }] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn set_image_checks_its_input_before_it_reaches_a_cluster() {
    let h = harness();
    let deployment = json!({ "kind": { "group": "apps", "version": "v1", "kind": "Deployment" }, "namespace": "n", "name": "web" });
    let config_map = json!({ "kind": { "group": "", "version": "v1", "kind": "ConfigMap" }, "namespace": "n", "name": "web" });
    let change =
        json!([{ "container": "web", "init": false, "from": "nginx:1", "image": "nginx:2" }]);
    for command in ["workload_set_image", "workload_set_image_dry_run"] {
        let err = invoke(
            &h,
            command,
            json!({ "clusterId": "nope", "ref": deployment, "changes": [] }),
        )
        .unwrap_err();
        assert_eq!(err["code"], "invalid", "{command}: {err}");
        let err = invoke(
            &h,
            command,
            json!({ "clusterId": "nope", "ref": config_map, "changes": change }),
        )
        .unwrap_err();
        assert_eq!(err["code"], "invalid", "{command}: {err}");
        let err = invoke(
            &h,
            command,
            json!({ "clusterId": "nope", "ref": deployment, "changes": change }),
        )
        .unwrap_err();
        assert_eq!(err["code"], "notFound", "{command}: {err}");
    }
}

#[test]
fn the_comparison_checks_its_input_first_and_never_connects_a_cluster() {
    let h = harness();
    let config_maps = json!([{ "group": "", "version": "v1", "kind": "ConfigMap" }]);
    let err = invoke(
        &h,
        "compare_list",
        json!({ "clusterId": "nope", "namespace": "Not A Namespace", "kinds": config_maps, "limit": 10 }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let err = invoke(
        &h,
        "compare_list",
        json!({ "clusterId": "nope", "namespace": "team", "kinds": config_maps, "limit": 10 }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let side = |ns: &str| json!({ "clusterId": "nope", "namespace": ns, "name": "app" });
    let err = invoke(
        &h,
        "compare_secrets",
        json!({ "left": side("team"), "right": side("prod") }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "compare_secrets",
        json!({ "left": side("Bad"), "right": side("prod") }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let ns = |ns: &str| json!({ "clusterId": "nope", "namespace": ns });
    let err = invoke(
        &h,
        "compare_secret_namespaces",
        json!({ "left": ns("team"), "right": ns("prod") }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "compare_helm_drift",
        json!({ "clusterId": "nope", "namespace": "team", "name": "web" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

#[test]
fn the_upgrade_scan_needs_a_connected_cluster_and_checks_its_input_first() {
    let h = harness();
    let apis = json!([{ "api": { "group": "batch", "version": "v1beta1", "kind": "CronJob" },
                         "replacement": { "group": "batch", "version": "v1", "kind": "CronJob" } }]);
    let err = invoke(
        &h,
        "upgrade_scan",
        json!({ "clusterId": "nope", "apis": apis }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // A malformed API version is refused before the cluster is looked up.
    let bad = json!([{ "api": { "group": "batch", "version": "", "kind": "CronJob" } }]);
    let err = invoke(
        &h,
        "upgrade_scan",
        json!({ "clusterId": "nope", "apis": bad }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn the_editor_schema_checks_its_names_and_needs_a_connected_cluster() {
    let h = harness();
    let ask = |group: &str, version: &str, kind: &str| {
        invoke(
            &h,
            "openapi_kind_schema",
            json!({ "clusterId": "nope", "group": group, "version": version, "kind": kind }),
        )
        .unwrap_err()
    };
    assert_eq!(ask("apps", "v1", "Deployment")["code"], "notFound");
    // A malformed name is refused before the cluster is looked up.
    assert_eq!(ask("apps/../x", "v1", "Deployment")["code"], "invalid");
    assert_eq!(ask("", "v1", "")["code"], "invalid");
}

#[test]
fn timeline_reads_need_a_connected_cluster_and_check_their_input_first() {
    let h = harness();
    let web = json!({ "kind": { "group": "apps", "version": "v1", "kind": "Deployment" },
                      "namespace": "shop", "name": "web" });
    let err = invoke(
        &h,
        "timeline_managers",
        json!({ "clusterId": "nope", "refs": [web.clone()] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "timeline_object_history",
        json!({ "clusterId": "nope", "object": web }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let deployments = json!([{ "group": "apps", "version": "v1", "kind": "Deployment" }]);
    let err = invoke(
        &h,
        "timeline_history",
        json!({ "clusterId": "nope", "namespaces": ["shop"], "kinds": deployments, "helm": true }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // A malformed namespace is refused before the cluster is looked up.
    let err = invoke(
        &h,
        "timeline_history",
        json!({ "clusterId": "nope", "namespaces": ["Not A Namespace"], "kinds": deployments, "helm": false }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn a_saved_timeline_is_read_back_and_removed() {
    let h = harness();
    let none = invoke(&h, "timeline_load", json!({ "clusterId": "c1" })).unwrap();
    assert_eq!(none, Value::Null);
    let text = json!({ "version": 1, "cluster": "c1", "entries": [] }).to_string();
    invoke(
        &h,
        "timeline_save",
        json!({ "clusterId": "c1", "text": text }),
    )
    .unwrap();
    let read = invoke(&h, "timeline_load", json!({ "clusterId": "c1" })).unwrap();
    let read: Value = serde_json::from_str(read.as_str().unwrap()).unwrap();
    assert_eq!(read["cluster"], "c1");
    let err = invoke(
        &h,
        "timeline_save",
        json!({ "clusterId": "c1", "text": "{\"version\":1,\"cluster\":\"other\",\"entries\":[]}" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    invoke(
        &h,
        "timeline_save",
        json!({ "clusterId": "c1", "text": null }),
    )
    .unwrap();
    let none = invoke(&h, "timeline_load", json!({ "clusterId": "c1" })).unwrap();
    assert_eq!(none, Value::Null);
    // Turning persistence off removes every cluster's file.
    for id in ["c1", "c2"] {
        let text = json!({ "version": 1, "cluster": id, "entries": [] }).to_string();
        invoke(
            &h,
            "timeline_save",
            json!({ "clusterId": id, "text": text }),
        )
        .unwrap();
    }
    invoke(&h, "timeline_remove_all", json!({})).unwrap();
    for id in ["c1", "c2"] {
        let none = invoke(&h, "timeline_load", json!({ "clusterId": id })).unwrap();
        assert_eq!(none, Value::Null);
    }
}

#[test]
fn certificate_commands_need_a_connected_cluster() {
    let h = harness();
    let err = invoke(
        &h,
        "tls_certificate_info",
        json!({ "clusterId": "nope", "namespace": "shop", "name": "shop-tls" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // `namespaces` may be left out: all namespaces.
    let err = invoke(&h, "tls_expiry_scan", json!({ "clusterId": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

#[test]
fn every_contract_command_is_registered_with_its_argument_names() {
    let h = harness();
    for (cmd, first_arg) in COMMANDS {
        let response = invoke(&h, cmd, json!({}));
        match first_arg {
            Some(arg) => {
                let err = response.expect_err(cmd);
                let text = err.as_str().unwrap_or_default();
                assert!(
                    text.contains(&format!("missing required key {arg}")),
                    "{cmd}: expected a missing `{arg}` argument, got {err}"
                );
            }
            None => {
                if let Err(err) = response {
                    let code = err.get("code").and_then(Value::as_str).unwrap_or_default();
                    assert!(ERROR_CODES.contains(&code), "{cmd}: not a CoreError: {err}");
                }
            }
        }
    }
}

#[test]
fn streams_reset_is_registered_without_arguments_and_answers() {
    let h = harness();
    assert_eq!(invoke(&h, "streams_reset", json!({})).unwrap(), Value::Null);
    let state = h.window.state::<sextant_lib::AppState>();
    assert!(state.subscriptions.is_empty() && state.sessions.is_empty());
}

#[test]
fn optional_arguments_of_changed_commands_may_be_left_out() {
    let h = harness();
    // The login of helm_repo_add is optional: without it the command runs. (`options` of node_drain is required.)
    let err = invoke(
        &h,
        "node_drain",
        json!({ "clusterId": "c", "name": "n", "options": { "force": true, "deleteEmptyDirData": false } }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "helm_repo_add",
        json!({ "name": "r", "url": "https://x" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "helmMissing", "{err}");
}

#[test]
fn argocd_commands_on_a_cluster_that_is_not_connected_fail_without_echoing_the_password() {
    let h = harness();
    let login = json!({ "username": "admin", "password": "pw-echo-42", "remember": true });
    let app = json!({ "kind": { "group": "argoproj.io", "version": "v1alpha1", "kind": "Application" }, "namespace": "argocd", "name": "a" });

    let status = invoke(&h, "argocd_status", json!({ "clusterId": "nope" })).unwrap_err();
    let signed = invoke(
        &h,
        "argocd_login",
        json!({ "clusterId": "nope", "login": login }),
    )
    .unwrap_err();
    let out = invoke(
        &h,
        "argocd_logout",
        json!({ "clusterId": "nope", "options": { "forget": true } }),
    )
    .unwrap_err();
    let diff = invoke(
        &h,
        "argocd_diff",
        json!({ "clusterId": "nope", "app": app }),
    )
    .unwrap_err();
    let empty = invoke(
        &h,
        "argocd_login",
        json!({ "clusterId": "nope", "login": { "remember": false } }),
    )
    .unwrap_err();

    for err in [&status, &signed, &out, &diff] {
        assert_eq!(err["code"], "notFound", "{err}");
    }
    assert_eq!(empty["code"], "invalid", "{empty}");
    assert!(!signed.to_string().contains("pw-echo-42"));
}

#[test]
fn unknown_cluster_cannot_connect_and_is_disconnected() {
    let h = harness();
    let err = invoke(&h, "cluster_connect", json!({ "clusterId": "abc" })).unwrap_err();
    assert_eq!(err["code"], "notFound");
    let state = invoke(&h, "cluster_state", json!({ "clusterId": "abc" })).unwrap();
    assert_eq!(
        state,
        json!({ "state": "error", "code": "notFound", "message": err["message"] })
    );
    invoke(&h, "cluster_disconnect", json!({ "clusterId": "abc" })).unwrap();
    let state = invoke(&h, "cluster_state", json!({ "clusterId": "abc" })).unwrap();
    assert_eq!(state, json!({ "state": "disconnected" }));
    let err = invoke(&h, "cluster_kinds", json!({ "clusterId": "abc" })).unwrap_err();
    assert_eq!(err["code"], "notFound");
    // Refreshing the kinds of a cluster that is not connected is harmless.
    assert_eq!(
        invoke(&h, "cluster_kinds_refresh", json!({ "clusterId": "abc" })).unwrap(),
        Value::Null
    );
    let err = invoke(
        &h,
        "resource_patch",
        json!({
            "clusterId": "abc",
            "ref": { "kind": { "group": "", "version": "v1", "kind": "ConfigMap" }, "namespace": "n", "name": "x" },
            "patch": { "metadata": { "labels": { "a": "b" } } },
            "patchType": "merge",
        }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

const PASTED: &str = "apiVersion: v1
kind: Config
clusters:
  - name: c
    cluster:
      server: https://127.0.0.1:1
users:
  - name: u
    user:
      token: pasted-secret-token
contexts:
  - name: pasted-one
    context:
      cluster: c
      user: u
  - name: pasted-two
    context:
      cluster: c
      user: u
      namespace: team
current-context: pasted-one
";

#[test]
fn without_kubeconfig_there_are_no_clusters_and_the_checked_path_is_listed() {
    let dirs = tempfile::tempdir().unwrap();
    let home_config = dirs.path().join("home").join(".kube").join("config");
    let h = harness_in(dirs);
    assert_eq!(invoke(&h, "clusters_list", json!({})).unwrap(), json!([]));
    let sources = invoke(&h, "kubeconfig_sources", json!({})).unwrap();
    assert_eq!(sources.as_array().unwrap().len(), 1);
    assert_eq!(sources[0]["kind"], "default");
    assert_eq!(sources[0]["path"], home_config.to_str().unwrap());
}

#[test]
fn pasted_and_added_kubeconfigs_survive_a_restart_and_are_removed() {
    let dirs = tempfile::tempdir().unwrap();
    let root = dirs.path().to_path_buf();
    let h = harness_in(dirs);

    let pasted = invoke(&h, "kubeconfig_add_pasted", json!({ "text": PASTED })).unwrap();
    assert_eq!(pasted["kind"], "pasted");
    assert!(std::path::Path::new(pasted["path"].as_str().unwrap()).starts_with(root.join("data")));

    let file = root.join("team.yaml");
    std::fs::write(&file, PASTED.replace("pasted-", "file-")).unwrap();
    let added = invoke(&h, "kubeconfig_add_file", json!({ "path": file })).unwrap();
    assert_eq!(added["kind"], "addedFile");

    let clusters = invoke(&h, "clusters_list", json!({})).unwrap();
    let contexts: Vec<_> = clusters
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["context"].clone())
        .collect();
    assert_eq!(
        contexts,
        [
            json!("pasted-one"),
            json!("pasted-two"),
            json!("file-one"),
            json!("file-two")
        ]
    );
    assert!(
        !clusters.to_string().contains("pasted-secret-token"),
        "no credentials in the list"
    );

    let invalid = invoke(
        &h,
        "kubeconfig_add_pasted",
        json!({ "text": "not: [valid" }),
    )
    .unwrap_err();
    assert_eq!(invalid["code"], "kubeconfig");

    // Restart: a new application state over the same directories.
    let restarted = isolated_state(&root);
    let again = sextant_lib::commands::clusters::list_clusters(&restarted).unwrap();
    assert_eq!(again.len(), 4);
    assert_eq!(again[0].id.as_str(), clusters[0]["id"].as_str().unwrap());

    invoke(&h, "kubeconfig_remove", json!({ "sourceId": pasted["id"] })).unwrap();
    let clusters = invoke(&h, "clusters_list", json!({})).unwrap();
    assert_eq!(clusters.as_array().unwrap().len(), 2);
    assert!(!std::path::Path::new(pasted["path"].as_str().unwrap()).exists());
    let saved = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(saved["kubeconfigSources"].as_array().unwrap().len(), 1);
    assert_eq!(saved["kubeconfigSources"][0]["id"], added["id"]);

    let default_source = invoke(&h, "kubeconfig_sources", json!({})).unwrap()[0]["id"].clone();
    let err = invoke(
        &h,
        "kubeconfig_remove",
        json!({ "sourceId": default_source }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid");
}

#[test]
fn cloud_clusters_are_imported_into_sextants_own_file_and_saved_as_a_source() {
    let dirs = tempfile::tempdir().unwrap();
    let root = dirs.path().to_path_buf();
    let h = harness_in(dirs);

    // No CLI is installed (the harness's PATH is empty): every provider says so, nothing fails.
    let status = invoke(&h, "cloud_status", json!({})).unwrap();
    let providers: Vec<_> = status
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["provider"].clone())
        .collect();
    assert_eq!(providers, [json!("aws"), json!("gcp"), json!("azure")]);
    assert!(
        status
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["available"] == false)
    );
    let accounts = invoke(&h, "cloud_accounts", json!({ "provider": "aws" })).unwrap();
    assert_eq!(accounts["problem"]["kind"], "cliMissing");

    // An EKS cluster as `cloud_find` returns it: endpoint and CA are known, no CLI call is needed.
    let cluster = json!({
        "provider": "aws", "name": "prod", "account": "dev", "location": "eu-west-1", "resourceGroup": null,
        "cloudId": "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
        "endpoint": "https://abc.eks.amazonaws.com", "certificateAuthority": "Y2E=",
        "version": "1.29", "status": "ACTIVE", "context": "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
    });
    let import = invoke(&h, "cloud_import", json!({ "clusters": [cluster.clone()] })).unwrap();
    assert_eq!(import["problems"], json!([]));
    assert_eq!(
        import["contexts"],
        json!(["arn:aws:eks:eu-west-1:111122223333:cluster/prod"])
    );
    let source = &import["sources"][0];
    assert_eq!(source["kind"], "cloud");
    assert_eq!(
        source["path"].as_str().unwrap(),
        root.join("data")
            .join("kubeconfigs")
            .join("cloud-aws.yaml")
            .to_str()
            .unwrap()
    );
    invoke(&h, "cloud_import", json!({ "clusters": [cluster] })).unwrap();

    let clusters = invoke(&h, "clusters_list", json!({})).unwrap();
    assert_eq!(
        clusters.as_array().unwrap().len(),
        1,
        "a second import does not duplicate"
    );
    assert_eq!(clusters[0]["server"], "https://abc.eks.amazonaws.com");
    let saved = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(saved["kubeconfigSources"], json!([source.clone()]));
    let restarted = isolated_state(&root);
    assert_eq!(
        sextant_lib::commands::clusters::list_clusters(&restarted)
            .unwrap()
            .len(),
        1
    );

    // Its sign-in goes through `aws`, which is not installed here.
    let hint = invoke(
        &h,
        "cloud_login_hint",
        json!({ "clusterId": clusters[0]["id"] }),
    )
    .unwrap();
    assert_eq!(hint["kind"], "cliMissing");
    assert_eq!(hint["provider"], "aws");

    invoke(&h, "kubeconfig_remove", json!({ "sourceId": source["id"] })).unwrap();
    assert_eq!(invoke(&h, "clusters_list", json!({})).unwrap(), json!([]));
    assert!(
        !root
            .join("data")
            .join("kubeconfigs")
            .join("cloud-aws.yaml")
            .exists()
    );
}

#[test]
fn settings_roundtrip_through_commands() {
    let h = harness();
    let mut settings = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(settings["theme"], "system");
    settings["theme"] = json!("dark");
    settings["window"]["dockOpen"] = json!(true);
    settings["window"]["dockHeight"] = json!(333);
    let saved = invoke(&h, "settings_update", json!({ "settings": settings })).unwrap();
    assert_eq!(saved["theme"], "dark");
    let again = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(again["theme"], "dark");
    assert_eq!(again["window"]["dockHeight"], 333);
    assert_eq!(again["window"]["dockOpen"], true);
}

#[test]
fn the_mcp_server_starts_and_stops_with_settings_update() {
    let h = harness();
    let status = invoke(&h, "mcp_status", json!({})).unwrap();
    assert_eq!(
        status,
        json!({ "state": "off", "url": null, "error": null })
    );

    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut settings = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(settings["mcp"], json!({ "enabled": false, "port": 47391 }));
    settings["mcp"] = json!({ "enabled": true, "port": port });
    invoke(
        &h,
        "settings_update",
        json!({ "settings": settings.clone() }),
    )
    .unwrap();
    let status = invoke(&h, "mcp_status", json!({})).unwrap();
    assert_eq!(status["state"], "running", "{status}");
    assert_eq!(status["url"], format!("http://127.0.0.1:{port}/mcp"));
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

    settings["mcp"]["enabled"] = json!(false);
    invoke(&h, "settings_update", json!({ "settings": settings })).unwrap();
    let status = invoke(&h, "mcp_status", json!({})).unwrap();
    assert_eq!(status["state"], "off");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn mcp_token_journal_and_confirmation_commands() {
    let h = harness();
    let token = invoke(&h, "mcp_token", json!({})).unwrap();
    let token = token.as_str().unwrap().to_owned();
    assert_eq!(token.len(), 43);
    assert_eq!(invoke(&h, "mcp_token", json!({})).unwrap(), token.as_str());
    let new = invoke(&h, "mcp_regenerate_token", json!({})).unwrap();
    assert_ne!(new, token.as_str());
    assert_eq!(invoke(&h, "mcp_token", json!({})).unwrap(), new);

    assert_eq!(invoke(&h, "mcp_audit_list", json!({})).unwrap(), json!([]));
    assert_eq!(
        invoke(&h, "mcp_audit_list", json!({ "clusterId": "abc" })).unwrap(),
        json!([])
    );
    assert_eq!(
        invoke(&h, "mcp_audit_clear", json!({})).unwrap(),
        Value::Null
    );

    let err = invoke(
        &h,
        "mcp_confirm_answer",
        json!({ "id": "confirm-1", "approved": true }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");

    let err = invoke(
        &h,
        "mcp_diagnostic_answer",
        json!({ "id": "diagnostic-1", "answer": { "type": "ok", "result": {} } }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");

    let path = invoke(&h, "mcp_binary_path", json!({})).unwrap();
    assert!(std::path::Path::new(path.as_str().unwrap()).is_absolute());
}

#[test]
fn settings_update_keeps_window_geometry_recorded_by_the_backend() {
    let h = harness();
    let state = h.window.state::<sextant_lib::AppState>();
    state
        .settings
        .update(|s| {
            s.window.width = Some(1500);
            s.window.height = Some(900);
        })
        .unwrap();
    let mut stale = invoke(&h, "settings_get", json!({})).unwrap();
    stale["window"]["width"] = Value::Null;
    stale["window"]["height"] = Value::Null;
    stale["theme"] = json!("light");
    let saved = invoke(&h, "settings_update", json!({ "settings": stale })).unwrap();
    assert_eq!(saved["theme"], "light");
    assert_eq!(saved["window"]["width"], 1500);
    assert_eq!(saved["window"]["height"], 900);
}

#[test]
fn later_argument_names_match_the_frontend() {
    let h = harness();
    // (command, arguments given, next argument expected)
    let cases = [
        ("resource_get", json!({ "clusterId": "c" }), "ref"),
        ("loki_names", json!({ "clusterId": "c" }), "query"),
        (
            "loki_names",
            json!({ "clusterId": "c", "query": { "type": "podContainers", "namespace": "n", "pod": "p" } }),
            "range",
        ),
        ("loki_logs_start", json!({ "clusterId": "c" }), "query"),
        (
            "loki_logs_start",
            json!({ "clusterId": "c", "query": { "namespace": "n", "pod": "p", "container": null, "range": { "startMs": 1, "endMs": 2 }, "direction": "backward", "limit": 10 } }),
            "streamId",
        ),
        (
            "loki_logs_start",
            json!({ "clusterId": "c", "query": { "namespace": "n", "pod": "p", "container": null, "range": { "startMs": 1, "endMs": 2 }, "direction": "backward", "limit": 10 }, "streamId": "s" }),
            "onEvent",
        ),
        ("resource_count", json!({ "clusterId": "c" }), "kind"),
        (
            "vcluster_connect",
            json!({ "hostClusterId": "c" }),
            "namespace",
        ),
        (
            "vcluster_connect",
            json!({ "hostClusterId": "c", "namespace": "n" }),
            "name",
        ),
        ("workload_scale", json!({ "clusterId": "c" }), "ref"),
        (
            "kubeconfig_copy",
            json!({ "clusterId": "c" }),
            "withCredentials",
        ),
        (
            "kubeconfig_copy",
            json!({ "clusterId": "c", "withCredentials": true }),
            "language",
        ),
        ("workload_set_image", json!({ "clusterId": "c" }), "ref"),
        (
            "workload_set_image_dry_run",
            json!({ "clusterId": "c" }),
            "ref",
        ),
        ("logs_start", json!({ "clusterId": "c" }), "pod"),
        (
            "exec_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" } }),
            "container",
        ),
        (
            "portforward_start",
            json!({ "clusterId": "c", "target": { "type": "pod", "namespace": "n", "name": "p" } }),
            "remotePort",
        ),
        (
            "metrics_charts",
            json!({ "clusterId": "c", "chart": { "type": "cluster" } }),
            "rangeSecs",
        ),
        (
            "metrics_usage_history",
            json!({ "clusterId": "c" }),
            "scope",
        ),
        (
            "metrics_request_health",
            json!({ "clusterId": "c" }),
            "target",
        ),
        (
            "metrics_traffic_graph",
            json!({ "clusterId": "c" }),
            "namespaces",
        ),
        (
            "metrics_traffic_graph",
            json!({ "clusterId": "c", "namespaces": ["n"] }),
            "window",
        ),
        (
            "metrics_usage_history",
            json!({ "clusterId": "c", "scope": { "type": "pod", "namespace": "n", "name": "p" } }),
            "window",
        ),
        (
            "helm_upgrade",
            json!({ "clusterId": "c", "namespace": "n", "release": "r" }),
            "chartRef",
        ),
        (
            "resource_dry_run",
            json!({ "clusterId": "c", "yaml": "kind: ConfigMap" }),
            "mode",
        ),
        (
            "helm_upgrade_preview",
            json!({ "clusterId": "c", "namespace": "n", "release": "r" }),
            "chartRef",
        ),
        (
            "helm_upgrade_preview",
            json!({ "clusterId": "c", "namespace": "n", "release": "r", "chartRef": "", "valuesYaml": "" }),
            "previewId",
        ),
        ("file_save", json!({ "path": "/tmp/x" }), "contents"),
        (
            "watch_start",
            json!({ "clusterId": "c", "spec": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespaces": null, "labelSelector": null, "fieldSelector": null } }),
            "streamId",
        ),
        (
            "logs_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "opts": { "container": "app", "follow": true, "tailLines": null, "timestamps": false, "previous": false } }),
            "streamId",
        ),
        (
            "exec_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": "app", "cols": 80, "rows": 24 }),
            "streamId",
        ),
        (
            "terminal_start",
            json!({ "clusterId": "c", "cols": 80, "rows": 24 }),
            "streamId",
        ),
        (
            "terminal_start",
            json!({ "clusterId": null, "cols": 80, "rows": 24 }),
            "streamId",
        ),
        ("node_shell_start", json!({ "clusterId": "c" }), "node"),
        (
            "node_shell_start",
            json!({ "clusterId": "c", "node": "n", "cols": 80, "rows": 24 }),
            "streamId",
        ),
        ("debug_start", json!({ "clusterId": "c" }), "pod"),
        (
            "debug_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" } }),
            "spec",
        ),
        (
            "debug_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "spec": { "image": "busybox:stable", "target": "app", "copy": { "command": ["sleep", "1d"] } }, "cols": 80, "rows": 24 }),
            "streamId",
        ),
        (
            "files_stat",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" } }),
            "path",
        ),
        (
            "files_download_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": "app", "path": "/etc/hostname" }),
            "kind",
        ),
        (
            "files_download_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": "app", "path": "/etc/hostname", "kind": "file" }),
            "destination",
        ),
        (
            "files_download_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "path": "/etc/hostname", "kind": "file", "destination": "/tmp/hostname" }),
            "streamId",
        ),
        (
            "files_upload_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": null }),
            "source",
        ),
        (
            "files_upload_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "source": "/tmp/x" }),
            "path",
        ),
        (
            "files_upload_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "source": "/tmp/x", "path": "/tmp/x" }),
            "streamId",
        ),
        ("term_ack", json!({ "sessionId": "t" }), "bytes"),
        ("secret_value", json!({ "clusterId": "c" }), "namespace"),
        (
            "secret_value",
            json!({ "clusterId": "c", "namespace": "n", "name": "s" }),
            "key",
        ),
        ("resource_get_full", json!({ "clusterId": "c" }), "ref"),
        (
            "tls_certificate_info",
            json!({ "clusterId": "c" }),
            "namespace",
        ),
        (
            "tls_certificate_info",
            json!({ "clusterId": "c", "namespace": "n" }),
            "name",
        ),
        ("node_drain_preview", json!({ "clusterId": "c" }), "name"),
        ("resource_patch", json!({ "clusterId": "c" }), "ref"),
        ("resource_patch_status", json!({ "clusterId": "c" }), "ref"),
        (
            "openshift_rollout_latest",
            json!({ "clusterId": "c" }),
            "ref",
        ),
        ("openshift_start_build", json!({ "clusterId": "c" }), "ref"),
        (
            "resource_patch",
            json!({ "clusterId": "c", "ref": { "kind": { "group": "", "version": "v1", "kind": "ConfigMap" }, "namespace": "n", "name": "x" } }),
            "patch",
        ),
        (
            "resource_patch",
            json!({ "clusterId": "c", "ref": { "kind": { "group": "", "version": "v1", "kind": "ConfigMap" }, "namespace": "n", "name": "x" }, "patch": {} }),
            "patchType",
        ),
        (
            "node_drain",
            json!({ "clusterId": "c", "name": "n" }),
            "options",
        ),
        ("argocd_login", json!({ "clusterId": "c" }), "login"),
        ("argocd_logout", json!({ "clusterId": "c" }), "options"),
        ("argocd_diff", json!({ "clusterId": "c" }), "app"),
        ("mcp_confirm_answer", json!({ "id": "x" }), "approved"),
        ("mcp_diagnostic_answer", json!({ "id": "x" }), "answer"),
        (
            "gitops_install_prepare",
            json!({ "clusterId": "c" }),
            "tool",
        ),
        (
            "gitops_install_prepare",
            json!({ "clusterId": "c", "tool": "flux" }),
            "version",
        ),
        ("gitops_install_start", json!({ "clusterId": "c" }), "token"),
        (
            "gitops_install_start",
            json!({ "clusterId": "c", "token": "t" }),
            "streamId",
        ), // Streams send their payloads through the channel the window created (ADR-0078).
        (
            "watch_start",
            json!({ "clusterId": "c", "spec": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespaces": null, "labelSelector": null, "fieldSelector": null }, "streamId": "s" }),
            "onEvent",
        ),
        (
            "logs_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "opts": { "container": "app", "follow": true, "tailLines": null, "timestamps": false, "previous": false }, "streamId": "s" }),
            "onEvent",
        ),
        (
            "exec_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": "app", "cols": 80, "rows": 24, "streamId": "s" }),
            "onEvent",
        ),
        (
            "terminal_start",
            json!({ "clusterId": null, "cols": 80, "rows": 24, "streamId": "s" }),
            "onEvent",
        ),
        (
            "node_shell_start",
            json!({ "clusterId": "c", "node": "n", "cols": 80, "rows": 24, "streamId": "s" }),
            "onEvent",
        ),
        (
            "debug_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "spec": { "image": "busybox:stable", "target": "app", "copy": null }, "cols": 80, "rows": 24, "streamId": "s" }),
            "onEvent",
        ),
        (
            "files_download_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": null, "path": "/etc/hostname", "kind": "file", "destination": "/tmp/hostname", "streamId": "s" }),
            "onEvent",
        ),
        (
            "files_upload_start",
            json!({ "clusterId": "c", "pod": { "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "n", "name": "p" }, "container": null, "source": "/tmp/x", "path": "/tmp/x", "streamId": "s" }),
            "onEvent",
        ),
        (
            "gitops_install_start",
            json!({ "clusterId": "c", "token": "t", "streamId": "s" }),
            "onEvent",
        ),
        (
            "image_files_open_start",
            json!({ "source": { "type": "reference", "reference": "nginx" } }),
            "streamId",
        ),
        (
            "image_files_open_start",
            json!({ "source": { "type": "reference", "reference": "nginx" }, "platform": null, "streamId": "s" }),
            "onEvent",
        ),
        (
            "image_files_read_start",
            json!({ "sessionId": "x", "path": "/etc/os-release", "streamId": "s" }),
            "onEvent",
        ),
        (
            "image_files_download_start",
            json!({ "sessionId": "x", "path": "/etc/os-release" }),
            "title",
        ),
        (
            "image_files_download_start",
            json!({ "sessionId": "x", "path": "/etc/os-release", "title": "t", "streamId": "s" }),
            "onEvent",
        ),
    ];
    for (cmd, args, next) in cases {
        let err = invoke(&h, cmd, args).expect_err(cmd);
        let text = err.as_str().unwrap_or_default();
        assert!(
            text.contains(&format!("missing required key {next}")),
            "{cmd}: expected `{next}`, got {err}"
        );
    }
}

/// Debug containers and copying files are the user's own tools (like a node shell): no MCP tool and no extension
/// method reaches them.
#[test]
fn debug_containers_and_file_copies_are_offered_to_neither_agents_nor_extensions() {
    let tools = sextant_lib::mcp::server::all_tools().names();
    let methods = sextant_lib::extensions::api::METHODS.map(str::to_owned);
    assert!(!tools.is_empty() && !methods.is_empty());
    let banned = [
        "debug",
        "ephemeral",
        "attach",
        "file",
        "files",
        "copy",
        "cp",
        "upload",
        "download",
        "tar",
    ];
    for name in tools.iter().chain(methods.iter()) {
        let lower = name.to_lowercase();
        for word in lower.split(['_', '.']) {
            assert!(!banned.contains(&word), "{name} offers {word}");
        }
    }
}

#[test]
fn settings_update_from_a_stale_copy_keeps_kubeconfig_sources_written_by_the_backend() {
    let h = harness();
    // The frontend caches settings before the backend records a kubeconfig source.
    let mut stale = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(stale["kubeconfigSources"], json!([]));

    // The backend records a source (as `kubeconfig_add_file` does).
    let state = h.window.state::<sextant_lib::AppState>();
    let source = sextant_core::KubeconfigSource {
        id: "src-1".to_owned(),
        path: std::path::PathBuf::from("/home/user/extra.yaml"),
        kind: sextant_core::SourceKind::AddedFile,
        error: None,
    };
    state
        .settings
        .update(|s| s.kubeconfig_sources.push(source.clone()))
        .unwrap();

    // The frontend saves its stale copy (e.g. a layout change).
    stale["window"]["dockOpen"] = json!(true);
    let saved = invoke(&h, "settings_update", json!({ "settings": stale })).unwrap();

    assert_eq!(saved["window"]["dockOpen"], true);
    assert_eq!(saved["kubeconfigSources"][0]["id"], "src-1");
    assert_eq!(state.settings.get().kubeconfig_sources, vec![source]);
}

/// The `helm` chosen in Settings (`helmPath`) wins over the one found in `PATH`; clearing it goes back to auto.
#[cfg(unix)]
#[test]
fn helm_path_from_settings_is_used_by_helm_commands() {
    use std::os::unix::fs::PermissionsExt;

    let h = harness();
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("my-helm");
    std::fs::write(&fake, "#!/bin/sh\nprintf v9.9.9\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut settings = invoke(&h, "settings_get", json!({})).unwrap();
    assert_eq!(settings["helmPath"], Value::Null, "{settings}");
    settings["helmPath"] = json!(fake.display().to_string());
    let saved = invoke(
        &h,
        "settings_update",
        json!({ "settings": settings.clone() }),
    )
    .unwrap();
    assert_eq!(saved["helmPath"], json!(fake.display().to_string()));

    let status = invoke(&h, "helm_status", json!({})).unwrap();
    assert_eq!(status["available"], true, "{status}");
    assert_eq!(status["version"], "v9.9.9", "{status}");
    assert_eq!(
        status["path"],
        json!(fake.display().to_string()),
        "{status}"
    );

    settings["helmPath"] = Value::Null;
    invoke(&h, "settings_update", json!({ "settings": settings })).unwrap();
    let status = invoke(&h, "helm_status", json!({})).unwrap();
    assert_eq!(status["available"], false, "{status}");
}

#[test]
fn access_preset_rules_answer_the_rules_of_each_preset() {
    let h = harness();
    let all = json!({ "type": "all" });
    // spec «Наборы».
    let rules = |preset: &str| invoke(&h, "access_preset_rules", json!({ "preset": preset }));
    assert_eq!(
        rules("readOnly").unwrap(),
        json!([{ "namespaces": all, "kinds": all, "actions": ["read", "logs"], "confirm": false }])
    );
    assert_eq!(
        rules("readWrite").unwrap(),
        json!([{ "namespaces": all, "kinds": all, "actions": ["read", "logs", "modify", "exec", "portForward"], "confirm": true }])
    );
    assert_eq!(
        rules("full").unwrap(),
        json!([{ "namespaces": all, "kinds": all, "actions": ["read", "logs", "modify", "delete", "exec", "portForward"], "confirm": true }])
    );
    assert_eq!(rules("off").unwrap(), json!([]));
    assert_eq!(rules("custom").unwrap(), json!([]));
    assert!(rules("everything").is_err());
}

#[test]
fn extension_commands_answer_with_the_installed_list_and_core_errors() {
    let h = harness();
    assert_eq!(invoke(&h, "extensions_list", json!({})).unwrap(), json!([]));
    let err = invoke(&h, "extension_install", json!({ "token": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    assert_eq!(
        invoke(&h, "extension_install_cancel", json!({ "token": "nope" })).unwrap(),
        json!(null),
        "cancelling an unknown install is not an error"
    );
    let err = invoke(
        &h,
        "extension_set_enabled",
        json!({ "id": "w", "enabled": true }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    let err = invoke(
        &h,
        "extension_inspect_url",
        json!({ "url": "https://example.com/w.zip" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn extension_api_commands_refuse_an_extension_that_is_not_installed_and_journal_it() {
    let h = harness();
    let err = invoke(
        &h,
        "extension_call",
        json!({ "extensionId": "ghost", "method": "clusters.list" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "denied", "{err}");
    let journal = invoke(
        &h,
        "extension_audit_list",
        json!({ "extensionId": "ghost" }),
    )
    .unwrap();
    assert_eq!(journal[0]["client"], "ghost");
    assert_eq!(journal[0]["source"], "extension");
    assert_eq!(journal[0]["decision"], "denied");
    assert_eq!(
        invoke(
            &h,
            "extension_audit_list",
            json!({ "extensionId": "other" })
        )
        .unwrap(),
        json!([])
    );
    invoke(&h, "extension_audit_clear", json!({})).unwrap();
    assert_eq!(
        invoke(&h, "extension_audit_list", json!({})).unwrap(),
        json!([])
    );
    invoke(
        &h,
        "extension_watch_stop",
        json!({ "extensionId": "ghost", "streamId": "nothing" }),
    )
    .unwrap();
    // `resources.watch` takes the channel of its updates as `onEvent` (other methods leave it out).
    let err = invoke(
        &h,
        "extension_call",
        json!({ "extensionId": "ghost", "method": "resources.watch", "params": {}, "streamId": "s-1", "onEvent": "nope" }),
    )
    .unwrap_err();
    let text = err.as_str().unwrap_or_default();
    assert!(
        text.contains("onEvent") && text.contains("invalid channel value"),
        "{err}"
    );
    let err = invoke(
        &h,
        "extension_call",
        json!({ "extensionId": "ghost", "method": "resources.watch", "params": { "clusterId": "c", "kind": { "kind": "Pod" } }, "streamId": "s-1", "onEvent": "__CHANNEL__:3" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "denied", "{err}");
    // Without the channel there is nowhere to send updates: the watch is not started.
    let err = invoke(
        &h,
        "extension_call",
        json!({ "extensionId": "ghost", "method": "resources.watch", "params": { "clusterId": "c", "kind": { "kind": "Pod" } }, "streamId": "s-1" }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

#[test]
fn removing_a_kubeconfig_source_forgets_that_sextant_may_edit_it() {
    let dirs = tempfile::tempdir().unwrap();
    let file = dirs.path().join("team.yaml");
    std::fs::write(
        &file,
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c:6443 }\nusers:\n  - name: u\n    user: {}\ncontexts:\n  - name: x\n    context: { cluster: c, user: u }\n",
    )
    .unwrap();
    let h = harness_in(dirs);
    let added = invoke(&h, "kubeconfig_add_file", json!({ "path": file })).unwrap();
    let id = added["id"].as_str().unwrap().to_owned();
    let state = h.window.state::<sextant_lib::AppState>();
    state
        .settings
        .update(|s| s.kubeconfig.writable_sources.push(id.clone()))
        .unwrap();
    invoke(&h, "kubeconfig_remove", json!({ "sourceId": id })).unwrap();
    assert!(state.settings.get().kubeconfig.writable_sources.is_empty());
    // Added again: the same id, not writable until the user allows it again.
    let again = invoke(&h, "kubeconfig_add_file", json!({ "path": file })).unwrap();
    assert_eq!(again["id"], added["id"]);
    assert!(state.settings.get().kubeconfig.writable_sources.is_empty());
}

#[test]
fn the_window_cannot_name_a_file_for_the_views_import_to_read() {
    let h = harness();
    // Only the command that shows the open dialog itself exists; there is no command taking a path to read.
    let err = invoke(&h, "views_import_read", json!({ "path": "/etc/passwd" })).unwrap_err();
    assert!(!err.to_string().contains("root:"), "{err}");
    assert!(err.to_string().contains("not found"), "{err}");
}

#[test]
fn the_cost_allocation_checks_its_query_first_and_needs_a_connected_cluster() {
    let h = harness();
    let query =
        json!({ "window": "week", "aggregate": { "type": "namespace" }, "namespaces": null });
    let err = invoke(
        &h,
        "cost_allocation",
        json!({ "clusterId": "nope", "query": query }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // A label key that could smuggle parameters is refused before the cluster is looked up.
    let bad = json!({ "window": "day", "aggregate": { "type": "label", "key": "a&b" }, "namespaces": null });
    let err = invoke(
        &h,
        "cost_allocation",
        json!({ "clusterId": "nope", "query": bad }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
}

/// Alerts (#264): a read of a cluster that is not connected is `notFound`; nothing else is taken from the window.
#[test]
fn alerts_need_a_connected_cluster() {
    let h = harness();
    let err = invoke(&h, "alerts_list", json!({ "clusterId": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

/// Loki (#265): names and reads are checked before the cluster is looked up; a read needs a connected cluster.
#[test]
fn loki_calls_check_their_input_first_and_need_a_connected_cluster() {
    let h = harness();
    let range = json!({ "startMs": 1_700_000_000_000_i64, "endMs": 1_700_000_360_000_i64 });
    let pods =
        json!({ "type": "workloadPods", "namespace": "shop", "kind": "Deployment", "name": "web" });
    let err = invoke(
        &h,
        "loki_names",
        json!({ "clusterId": "nope", "query": pods, "range": range }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    // A name that could carry LogQL is refused before anything else.
    let bad = json!({ "type": "workloadPods", "namespace": "shop", "kind": "Deployment", "name": "web\"} or {x=~\".+" });
    let err = invoke(
        &h,
        "loki_names",
        json!({ "clusterId": "nope", "query": bad, "range": range }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "invalid", "{err}");
    let err = invoke(&h, "loki_status", json!({ "clusterId": "nope" })).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
}

/// Comparing two revisions reads the release Secrets of a connected cluster; the input is checked first (#209).
#[test]
fn helm_revision_diff_checks_its_input_and_needs_a_connected_cluster() {
    let h = harness();
    let args = |name: &str, left: i32, right: i32| json!({ "clusterId": "nope", "namespace": "apps", "name": name, "left": left, "right": right });
    let err = invoke(&h, "helm_revision_diff", args("web", 1, 2)).unwrap_err();
    assert_eq!(err["code"], "notFound", "{err}");
    for bad in [args("Not A Release", 1, 2), args("web", 0, 2)] {
        let err = invoke(&h, "helm_revision_diff", bad).unwrap_err();
        assert_eq!(err["code"], "invalid", "{err}");
    }
}

/// Newer chart versions come from the `helm` of Settings (a fake one here, answering JSON fixtures): one search per
/// chart name in Helm's local indexes, never a `repo update`; without helm the command answers `helmMissing`.
#[cfg(unix)]
#[test]
fn helm_chart_updates_search_the_added_repositories_with_the_chosen_helm() {
    use std::os::unix::fs::PermissionsExt;

    let h = harness();
    let charts = json!({ "charts": [{ "chart": "nginx", "version": "15.1.0" }] });
    let err = invoke(&h, "helm_chart_updates", charts.clone()).unwrap_err();
    assert_eq!(err["code"], "helmMissing", "{err}");

    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("args");
    let fake = dir.path().join("fake-helm");
    std::fs::write(
        &fake,
        format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
case "$1 $2" in
  "repo list") printf '%s' '[{{"name":"bitnami","url":"https://charts.example/bitnami"}}]' ;;
  "search repo") printf '%s' '[{{"name":"bitnami/nginx","version":"16.0.1","app_version":"1.27.0","description":"d"}},{{"name":"bitnami/nginx","version":"15.1.0","app_version":"1.25.3","description":"d"}}]' ;;
esac
"#,
            record.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut settings = invoke(&h, "settings_get", json!({})).unwrap();
    settings["helmPath"] = json!(fake.display().to_string());
    invoke(&h, "settings_update", json!({ "settings": settings })).unwrap();

    let report = invoke(&h, "helm_chart_updates", charts).unwrap();
    assert_eq!(report["repos"], 1, "{report}");
    let chart = &report["charts"][0];
    assert_eq!(chart["chartRef"], "bitnami/nginx", "{report}");
    assert_eq!(chart["latest"], "16.0.1", "{report}");
    assert_eq!(chart["latestAppVersion"], "1.27.0", "{report}");
    assert_eq!(chart["step"], "major", "{report}");
    assert_eq!(chart["upToDate"], false, "{report}");
    let calls = std::fs::read_to_string(&record).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|l| l.starts_with("search repo"))
            .count(),
        1,
        "{calls}"
    );
    assert!(!calls.contains("update"), "{calls}");
}
