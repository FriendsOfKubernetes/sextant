use super::yandex::*;
use super::*;

#[test]
fn profiles_keep_the_active_marker_out_of_names_and_reject_non_lists() {
    let profiles = parse_profiles("personal\nwork profile ACTIVE\nservice\n").unwrap();
    assert_eq!(profiles.len(), 3);
    assert_eq!(profiles[1].id, "work profile");
    assert!(profiles[1].is_default);
    assert!(!profiles[0].is_default);
    assert!(parse_profiles("").unwrap().is_empty());
    assert!(parse_profiles("{\"token\":\"must-not-be-a-profile\"}").is_err());
    assert!(parse_profiles("--profile=bad").is_err());
}

#[test]
fn clouds_and_folders_use_ids_and_default_without_needing_secrets() {
    let accounts = parse_accounts(r#"[{"id":"a","name":"Alpha"},{"id":"b"}]"#, Some("b")).unwrap();
    assert_eq!(accounts[0].name, "Alpha");
    assert_eq!(accounts[1].name, "b");
    assert!(accounts[1].is_default);
    assert!(!accounts[0].is_default);
    assert!(parse_accounts("{}", None).is_err());
    assert!(parse_accounts("[]", None).unwrap().is_empty());
}

fn cluster_json() -> Value {
    json!({"id":"cluster-demo","name":"Demo","folder_id":"folder-demo","status":"RUNNING",
        "master":{"version":"1.32","zonal_master":{"zone_id":"ru-central1-a"},
            "endpoints":{"external_v4_endpoint":"https://192.0.2.10:6443","internal_v4_endpoint":"https://192.0.2.20:6443"},
            "master_auth":{"cluster_ca_certificate":"-----BEGIN CERTIFICATE-----\nZGVtbw==\n-----END CERTIFICATE-----\n"}}})
}

#[test]
fn the_chosen_endpoint_and_profile_survive_cluster_parsing() {
    for (mode, address) in [
        (YandexEndpoint::External, "https://192.0.2.10:6443"),
        (YandexEndpoint::Internal, "https://192.0.2.20:6443"),
    ] {
        let selection = YandexSelection {
            profile: "work profile".into(),
            endpoint: mode,
        };
        let clusters = parse_clusters(
            &json!([cluster_json()]).to_string(),
            "folder-demo",
            &selection,
        )
        .unwrap();
        let cluster = &clusters[0];
        assert_eq!(cluster.endpoint.as_deref(), Some(address));
        assert_eq!(cluster.context, "yc-cluster-demo");
        assert_eq!(cluster.location, "ru-central1-a");
        assert_eq!(cluster.account, "folder-demo");
        assert_eq!(cluster.yandex.as_ref(), Some(&selection));
        let ca = base64::engine::general_purpose::STANDARD
            .decode(cluster.certificate_authority.as_ref().unwrap())
            .unwrap();
        assert!(
            String::from_utf8(ca)
                .unwrap()
                .starts_with("-----BEGIN CERTIFICATE-----")
        );
    }
}

#[test]
fn a_cluster_without_the_chosen_endpoint_is_not_silently_redirected() {
    let mut value = cluster_json();
    value["master"]["endpoints"]
        .as_object_mut()
        .unwrap()
        .remove("external_v4_endpoint");
    let clusters = parse_clusters(
        &json!([value]).to_string(),
        "folder-demo",
        &YandexSelection {
            profile: "demo".into(),
            endpoint: YandexEndpoint::External,
        },
    )
    .unwrap();
    assert!(clusters[0].endpoint.is_none());
    assert!(kubeconfig_for(&clusters[0]).is_err());
}

#[test]
fn malformed_cluster_data_is_refused_and_creating_clusters_stay_visible() {
    assert!(
        parse_clusters(
            "{}",
            "folder-demo",
            &YandexSelection {
                profile: "demo".into(),
                endpoint: YandexEndpoint::External
            }
        )
        .is_err()
    );
    let clusters = parse_clusters(
        r#"[{"id":"new","name":"Creating","status":"PROVISIONING"}]"#,
        "folder-demo",
        &YandexSelection {
            profile: "demo".into(),
            endpoint: YandexEndpoint::Internal,
        },
    )
    .unwrap();
    assert_eq!(clusters[0].name, "Creating");
    assert!(clusters[0].endpoint.is_none());
    assert!(clusters[0].certificate_authority.is_none());
}

#[test]
fn permission_errors_do_not_ask_the_user_to_log_in_again() {
    assert!(is_login_error(
        CloudProvider::Yandex,
        "rpc error: code = Unauthenticated desc = token has expired"
    ));
    assert!(!is_login_error(
        CloudProvider::Yandex,
        "rpc error: code = PermissionDenied desc = permission denied to list folders"
    ));
    assert!(!is_login_error(
        CloudProvider::Yandex,
        "rpc error: code = NotFound desc = profile not found"
    ));
}

#[test]
fn the_pinned_profile_exec_masks_an_inherited_iam_token() {
    let cluster = parse_clusters(
        &json!([cluster_json()]).to_string(),
        "folder-demo",
        &YandexSelection {
            profile: "work".into(),
            endpoint: YandexEndpoint::External,
        },
    )
    .unwrap()
    .remove(0);
    let (_, exec) = exec_for(&cluster).unwrap();
    assert_eq!(exec["env"], json!([{"name":"YC_IAM_TOKEN","value":""}]));
}

#[test]
fn only_yc_launches_remove_the_ambient_iam_token_and_keep_the_config_location() {
    for key in ["YC_IAM_TOKEN", "yc_iam_token"] {
        let cli = CloudCli::default().with_env([
            (key, "ambient-token"),
            ("YC_CONFIG_PATH", "/custom/config.yaml"),
            ("PATH", "/bin"),
        ]);
        let yandex = cli.provider_env(CloudProvider::Yandex);
        assert_eq!(
            yandex.iter().any(|(k, _)| k == key),
            key != "YC_IAM_TOKEN" && !cfg!(windows)
        );
        assert!(
            yandex
                .iter()
                .any(|(k, v)| k == "YC_CONFIG_PATH" && v == "/custom/config.yaml")
        );
        for provider in [CloudProvider::Aws, CloudProvider::Gcp, CloudProvider::Azure] {
            assert!(
                cli.provider_env(provider)
                    .iter()
                    .any(|(k, v)| k == key && v == "ambient-token")
            );
        }
    }
}
