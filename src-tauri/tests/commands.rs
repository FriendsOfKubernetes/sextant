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
    ("cluster_connect", Some("clusterId")),
    ("cluster_disconnect", Some("clusterId")),
    ("cluster_state", Some("clusterId")),
    ("cluster_kinds", Some("clusterId")),
    ("watch_start", Some("clusterId")),
    ("watch_stop", Some("subscriptionId")),
    ("resource_get", Some("clusterId")),
    ("resource_replace", Some("clusterId")),
    ("resource_apply", Some("clusterId")),
    ("resource_delete", Some("clusterId")),
    ("workload_scale", Some("clusterId")),
    ("workload_restart", Some("clusterId")),
    ("node_cordon", Some("clusterId")),
    ("node_drain", Some("clusterId")),
    ("cronjob_trigger", Some("clusterId")),
    ("cronjob_suspend", Some("clusterId")),
    ("logs_start", Some("clusterId")),
    ("logs_stop", Some("streamId")),
    ("exec_start", Some("clusterId")),
    ("terminal_start", Some("clusterId")),
    ("term_input", Some("sessionId")),
    ("term_resize", Some("sessionId")),
    ("term_stop", Some("sessionId")),
    ("portforward_start", Some("clusterId")),
    ("portforward_list", None),
    ("portforward_stop", Some("id")),
    ("metrics_pods", Some("clusterId")),
    ("metrics_nodes", Some("clusterId")),
    ("metrics_status", Some("clusterId")),
    ("metrics_charts", Some("clusterId")),
    ("helm_status", None),
    ("helm_releases", Some("clusterId")),
    ("helm_release_detail", Some("clusterId")),
    ("helm_release_history", Some("clusterId")),
    ("helm_upgrade", Some("clusterId")),
    ("helm_rollback", Some("clusterId")),
    ("helm_uninstall", Some("clusterId")),
    ("helm_install", Some("clusterId")),
    ("helm_repos", None),
    ("helm_repo_add", Some("name")),
    ("helm_repo_remove", Some("name")),
    ("helm_repo_update", None),
    ("helm_search", Some("query")),
    ("helm_show_values", Some("chart")),
    ("settings_get", None),
    ("settings_update", Some("settings")),
    ("file_save", Some("path")),
];

struct Harness {
    _app: tauri::App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    _dirs: tempfile::TempDir,
}

fn harness() -> Harness {
    let dirs = tempfile::tempdir().unwrap();
    let app = sextant_lib::with_commands(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(sextant_lib::AppState::new(
        &dirs.path().join("config"),
        &dirs.path().join("data"),
    ));
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
        url: "tauri://localhost".parse().unwrap(),
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
fn stub_commands_answer_with_code_other() {
    let h = harness();
    let err = invoke(&h, "cluster_connect", json!({ "clusterId": "abc" })).unwrap_err();
    assert_eq!(err["code"], "other");
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
        ("workload_scale", json!({ "clusterId": "c" }), "ref"),
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
            "helm_upgrade",
            json!({ "clusterId": "c", "namespace": "n", "release": "r" }),
            "chartRef",
        ),
        ("file_save", json!({ "path": "/tmp/x" }), "contents"),
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
