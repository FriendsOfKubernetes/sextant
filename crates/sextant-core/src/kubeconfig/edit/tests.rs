use super::*;
use crate::kubeconfig::{KubeconfigEnv, KubeconfigRegistry};

const SECRET_TOKEN: &str = "s3cr3t-t0ken-value";
const SECRET_KEY: &str = "a2V5LXNlY3JldA==";

/// `alpha` (token, namespace team-a) and `beta` (client certificate) share nothing; `gamma` shares alpha's cluster.
fn kubeconfig() -> String {
    format!(
        r#"# my clusters
apiVersion: v1
kind: Config
preferences: {{}}
clusters:
  - name: alpha-cluster
    cluster:
      server: https://alpha.example:6443
      x-unknown-field: kept
  - name: beta-cluster
    cluster:
      server: https://beta.example:6443
users:
  - name: alpha-user
    user:
      token: {SECRET_TOKEN}
  - name: beta-user
    user:
      client-certificate-data: Y2VydA==
      client-key-data: {SECRET_KEY}
  - name: gamma-user
    user:
      token: other
contexts:
  - name: alpha
    context:
      cluster: alpha-cluster
      user: alpha-user
      namespace: team-a
  - name: beta
    context:
      cluster: beta-cluster
      user: beta-user
  - name: gamma
    context:
      cluster: alpha-cluster
      user: gamma-user
current-context: alpha
"#
    )
}

struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        name.split('/')
            .fold(self.dir.path().to_path_buf(), |p, part| p.join(part))
    }

    fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.path(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    /// No `KUBECONFIG`; home in the temp dir (never the real one).
    fn registry(&self) -> KubeconfigRegistry {
        self.registry_with(None)
    }

    fn registry_with(&self, kubeconfig: Option<std::ffi::OsString>) -> KubeconfigRegistry {
        KubeconfigRegistry::new(Vec::new(), self.path("data/kubeconfigs")).with_env(KubeconfigEnv {
            kubeconfig,
            home: Some(self.path("home")),
        })
    }

    fn home_config(&self) -> PathBuf {
        self.write("home/.kube/config", &kubeconfig())
    }
}

fn id_of(registry: &KubeconfigRegistry, context: &str) -> ClusterId {
    registry
        .clusters()
        .unwrap()
        .into_iter()
        .find(|c| c.context == context)
        .unwrap()
        .id
}

fn contexts(registry: &KubeconfigRegistry) -> Vec<String> {
    registry
        .clusters()
        .unwrap()
        .into_iter()
        .map(|c| c.context)
        .collect()
}

fn backups(path: &Path) -> Vec<PathBuf> {
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    // The real directory, as the edit reports it (macOS: /var is /private/var; Windows: no \\?\ prefix).
    let dir = dunce::canonicalize(path.parent().unwrap()).unwrap();
    let mut found: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("{name}.bak-"))
        })
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

/// The writable flag of the home source.
fn allow(registry: &KubeconfigRegistry) -> Vec<String> {
    vec![registry.sources()[0].id.clone()]
}

#[test]
fn a_users_own_kubeconfig_is_never_written_without_the_users_permission() {
    let fx = Fixture::new();
    let path = fx.home_config();
    let mut registry = fx.registry();
    let edit = KubeconfigEdit::RenameContext {
        cluster_id: id_of(&registry, "alpha"),
        new_name: "prod".into(),
    };
    let err = registry.preview_edit(&edit, &[]).unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{err}");
    let err = registry.apply_edit(&edit, "anything", &[]).unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{err}");
    let other = vec!["some-other-source".to_owned()];
    assert_eq!(
        registry.apply_edit(&edit, "x", &other).unwrap_err().code,
        ErrorCode::Denied
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), kubeconfig());
    assert!(backups(&path).is_empty());
}

#[test]
fn rename_previews_then_writes_with_a_private_backup_and_keeps_unknown_fields() {
    let fx = Fixture::new();
    let path = fx.home_config();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    }
    let mut registry = fx.registry();
    let writable = allow(&registry);
    let old_id = id_of(&registry, "alpha");
    let edit = KubeconfigEdit::RenameContext {
        cluster_id: old_id.clone(),
        new_name: "prod".into(),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    assert!(!preview.unchanged);
    assert!(preview.comments_lost, "the file has a comment");
    assert!(!preview.own_file);
    assert_eq!(preview.path, path);
    let new_id = ClusterId::for_context(&path, "prod");
    assert_eq!(
        preview.renamed,
        [RenamedCluster {
            from: old_id.clone(),
            to: new_id.clone()
        }]
    );
    let kinds: Vec<(EntryKind, ChangeKind)> = preview
        .changes
        .iter()
        .map(|c| (c.entry, c.change))
        .collect();
    assert_eq!(
        kinds,
        [
            (EntryKind::Context, ChangeKind::Renamed),
            (EntryKind::CurrentContext, ChangeKind::Changed)
        ]
    );
    // The preview wrote nothing.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), kubeconfig());

    let outcome = registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap();
    assert_eq!(outcome.renamed, preview.renamed);
    assert_eq!(contexts(&registry), ["prod", "beta", "gamma"]);
    assert_eq!(id_of(&registry, "prod"), new_id);

    let backup = outcome.backup_path.unwrap();
    assert_eq!(backups(&path), std::slice::from_ref(&backup));
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), kubeconfig());
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(written.contains("x-unknown-field: kept"), "{written}");
    assert!(written.contains("current-context: prod"), "{written}");
    assert!(
        written.contains(SECRET_TOKEN),
        "credentials stay in the file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&backup), 0o600, "the copy is private");
        assert_eq!(mode(&path), 0o640, "the file keeps its permissions");
    }

    // The same preview again: the file is no longer the one previewed.
    let err = registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");
}

#[test]
fn a_file_changed_after_the_preview_is_not_overwritten() {
    let fx = Fixture::new();
    let path = fx.home_config();
    let mut registry = fx.registry();
    let writable = allow(&registry);
    let edit = KubeconfigEdit::SetNamespace {
        cluster_id: id_of(&registry, "beta"),
        namespace: Some("web".into()),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    let edited = kubeconfig().replace("team-a", "team-b");
    std::fs::write(&path, &edited).unwrap();
    let err = registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    assert!(backups(&path).is_empty());
}

#[test]
fn set_namespace_and_duplicate_change_only_that_context() {
    let fx = Fixture::new();
    fx.home_config();
    let mut registry = fx.registry();
    let writable = allow(&registry);
    let beta = id_of(&registry, "beta");

    let set = KubeconfigEdit::SetNamespace {
        cluster_id: beta.clone(),
        namespace: Some("web".into()),
    };
    let preview = registry.preview_edit(&set, &writable).unwrap();
    assert_eq!(preview.changed, std::slice::from_ref(&beta));
    assert_eq!(
        preview.changes[0].fields,
        [FieldChange {
            field: "namespace".into(),
            before: None,
            after: Some("web".into())
        }]
    );
    registry.apply_edit(&set, &preview.base, &writable).unwrap();
    let info = |r: &KubeconfigRegistry, ctx: &str| {
        r.clusters()
            .unwrap()
            .into_iter()
            .find(|c| c.context == ctx)
            .unwrap()
    };
    assert_eq!(info(&registry, "beta").namespace.as_deref(), Some("web"));
    assert_eq!(info(&registry, "beta").id, beta, "the id stays");

    // Setting it again changes nothing.
    let again = registry.preview_edit(&set, &writable).unwrap();
    assert!(again.unchanged);
    assert_eq!(
        registry
            .apply_edit(&set, &again.base, &writable)
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );

    let dup = KubeconfigEdit::DuplicateContext {
        cluster_id: id_of(&registry, "alpha"),
        new_name: "alpha-staging".into(),
        namespace: "staging".into(),
    };
    let preview = registry.preview_edit(&dup, &writable).unwrap();
    registry.apply_edit(&dup, &preview.base, &writable).unwrap();
    assert_eq!(
        contexts(&registry),
        ["alpha", "alpha-staging", "beta", "gamma"]
    );
    let copy = info(&registry, "alpha-staging");
    assert_eq!(copy.namespace.as_deref(), Some("staging"));
    assert_eq!(copy.user, "alpha-user");
    assert_eq!(copy.server, "https://alpha.example:6443");
    assert_eq!(
        info(&registry, "alpha").namespace.as_deref(),
        Some("team-a")
    );

    // Bad input is refused before anything is written.
    for bad in [
        KubeconfigEdit::SetNamespace {
            cluster_id: beta.clone(),
            namespace: Some("Not_A_Namespace".into()),
        },
        KubeconfigEdit::RenameContext {
            cluster_id: beta.clone(),
            new_name: "alpha".into(),
        },
        KubeconfigEdit::RenameContext {
            cluster_id: beta.clone(),
            new_name: "  ".into(),
        },
        KubeconfigEdit::DuplicateContext {
            cluster_id: beta.clone(),
            new_name: "gamma".into(),
            namespace: "x".into(),
        },
    ] {
        assert_eq!(
            registry.preview_edit(&bad, &writable).unwrap_err().code,
            ErrorCode::Invalid,
            "{bad:?}"
        );
    }
}

#[test]
fn delete_removes_the_cluster_and_user_no_other_context_uses() {
    let fx = Fixture::new();
    let path = fx.home_config();
    let mut registry = fx.registry();
    let writable = allow(&registry);

    // alpha: its cluster is gamma's too, so only its user goes; it was the current context.
    let alpha = id_of(&registry, "alpha");
    let edit = KubeconfigEdit::DeleteContext {
        cluster_id: alpha.clone(),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    assert_eq!(preview.removed, [alpha]);
    let removed: Vec<(EntryKind, &str)> = preview
        .changes
        .iter()
        .filter(|c| c.change == ChangeKind::Removed)
        .map(|c| (c.entry, c.name.as_str()))
        .collect();
    assert_eq!(
        removed,
        [
            (EntryKind::Context, "alpha"),
            (EntryKind::User, "alpha-user")
        ]
    );
    // The current context is left unset, not switched to another cluster, and the preview says so.
    let current = preview
        .changes
        .iter()
        .find(|c| c.entry == EntryKind::CurrentContext)
        .unwrap();
    assert_eq!(current.fields[0].before.as_deref(), Some("alpha"));
    assert_eq!(current.fields[0].after, None);
    registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap();
    let written = Kubeconfig::read_from(&path).unwrap();
    assert_eq!(written.current_context, None);
    assert!(
        !std::fs::read_to_string(&path)
            .unwrap()
            .contains("current-context")
    );
    assert!(written.clusters.iter().any(|c| c.name == "alpha-cluster"));
    assert!(!written.auth_infos.iter().any(|u| u.name == "alpha-user"));

    let beta = KubeconfigEdit::DeleteContext {
        cluster_id: id_of(&registry, "beta"),
    };
    let preview = registry.preview_edit(&beta, &writable).unwrap();
    registry
        .apply_edit(&beta, &preview.base, &writable)
        .unwrap();
    let written = Kubeconfig::read_from(&path).unwrap();
    assert!(!written.clusters.iter().any(|c| c.name == "beta-cluster"));
    assert!(!written.auth_infos.iter().any(|u| u.name == "beta-user"));
    assert_eq!(contexts(&registry), ["gamma"]);
    assert_eq!(backups(&path).len(), 2);
}

use kube::config::Kubeconfig;

#[test]
fn deleting_in_kubeconfig_keeps_a_user_another_file_of_the_list_uses() {
    let fx = Fixture::new();
    let a = fx.write(
        "a.yaml",
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c:6443 }\nusers:\n  - name: shared\n    user: { token: abc }\ncontexts:\n  - name: one\n    context: { cluster: c, user: shared }\n",
    );
    let b = fx.write(
        "b.yaml",
        "apiVersion: v1\nkind: Config\ncontexts:\n  - name: two\n    context: { cluster: c, user: shared }\n",
    );
    let registry = fx.registry_with(Some(std::env::join_paths([&a, &b]).unwrap()));
    let mut registry = registry;
    let writable: Vec<String> = registry.sources().into_iter().map(|s| s.id).collect();
    let edit = KubeconfigEdit::DeleteContext {
        cluster_id: id_of(&registry, "one"),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap();
    let written = Kubeconfig::read_from(&a).unwrap();
    assert!(written.auth_infos.iter().any(|u| u.name == "shared"));
    assert!(written.clusters.iter().any(|c| c.name == "c"));
    // A name another file of the list holds is taken.
    let rename = KubeconfigEdit::RenameContext {
        cluster_id: id_of(&registry, "two"),
        new_name: "one".into(),
    };
    assert!(registry.preview_edit(&rename, &writable).is_ok());
}

#[test]
fn previews_never_carry_credentials() {
    let fx = Fixture::new();
    fx.home_config();
    let other = fx.write(
        "other.yaml",
        &kubeconfig().replace("https://alpha", "https://alpha2"),
    );
    let registry = fx.registry();
    let writable = allow(&registry);
    let edits = [
        KubeconfigEdit::DeleteContext {
            cluster_id: id_of(&registry, "beta"),
        },
        KubeconfigEdit::DuplicateContext {
            cluster_id: id_of(&registry, "beta"),
            new_name: "copy".into(),
            namespace: "x".into(),
        },
        KubeconfigEdit::Merge {
            paths: vec![fx.path("home/.kube/config"), other],
        },
    ];
    for edit in &edits {
        let preview = registry.preview_edit(edit, &writable).unwrap();
        let json = serde_json::to_string(&preview).unwrap();
        for secret in [SECRET_TOKEN, SECRET_KEY, "Y2VydA==", "\"other\""] {
            assert!(!json.contains(secret), "{secret} in {json}");
        }
    }
}

#[test]
fn merge_writes_sextants_own_file_and_suffixes_conflicting_names() {
    let fx = Fixture::new();
    let home = fx.home_config();
    let before_home = std::fs::read(&home).unwrap();
    let a = fx.write(
        "team/a.yaml",
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: shared\n    cluster: { server: https://a:6443 }\nusers:\n  - name: me\n    user: { token: tok-a }\ncontexts:\n  - name: dev\n    context: { cluster: shared, user: me }\ncurrent-context: dev\n",
    );
    let b = fx.write(
        "team/b.yaml",
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: shared\n    cluster: { server: https://b:6443 }\nusers:\n  - name: me\n    user: { token: tok-a }\ncontexts:\n  - name: dev\n    context: { cluster: shared, user: me, namespace: web }\n",
    );
    let mut registry = fx.registry();
    let edit = KubeconfigEdit::Merge {
        paths: vec![a.clone(), b.clone(), a.clone()],
    };
    // Sextant's own file needs no permission.
    let preview = registry.preview_edit(&edit, &[]).unwrap();
    assert!(preview.creates_file && preview.own_file);
    assert_eq!(preview.source_id, None);
    let target = fx.path("data/kubeconfigs/merged.yaml");
    assert_eq!(preview.path, target);
    let renamed: Vec<(EntryKind, &str, Option<&str>)> = preview
        .changes
        .iter()
        .filter(|c| c.entry != EntryKind::CurrentContext)
        .map(|c| (c.entry, c.name.as_str(), c.new_name.as_deref()))
        .collect();
    assert_eq!(
        renamed,
        [
            (EntryKind::Cluster, "shared", None),
            (EntryKind::User, "me", None),
            (EntryKind::Context, "dev", None),
            // b's cluster differs: renamed; its user is the same entry: reused.
            (EntryKind::Cluster, "shared", Some("shared-2")),
            (EntryKind::Context, "dev", Some("dev-2")),
        ]
    );
    let user = preview
        .changes
        .iter()
        .find(|c| c.entry == EntryKind::User)
        .unwrap();
    assert_eq!(user.fields[0].after.as_deref(), Some(HIDDEN));
    assert!(!serde_json::to_string(&preview).unwrap().contains("tok-a"));

    let outcome = registry.apply_edit(&edit, &preview.base, &[]).unwrap();
    assert_eq!(outcome.source.kind, SourceKind::Merged);
    assert_eq!(outcome.backup_path, None);
    assert_eq!(
        registry.added_sources(),
        std::slice::from_ref(&outcome.source)
    );
    let merged = Kubeconfig::read_from(&target).unwrap();
    let dev2 = merged.contexts.iter().find(|c| c.name == "dev-2").unwrap();
    assert_eq!(dev2.context.as_ref().unwrap().cluster, "shared-2");
    assert_eq!(merged.current_context.as_deref(), Some("dev"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(
        std::fs::read(&home).unwrap(),
        before_home,
        "the merged files are not changed"
    );
    assert!(contexts(&registry).contains(&"dev-2".to_owned()));

    // Merging the same files again adds nothing.
    let again = registry.preview_edit(&edit, &[]).unwrap();
    assert!(again.unchanged, "{again:?}");
    assert_eq!(again.source_id.as_deref(), Some(outcome.source.id.as_str()));
    // The merged file cannot be merged into itself.
    let own = KubeconfigEdit::Merge {
        paths: vec![target.clone()],
    };
    assert_eq!(
        registry.preview_edit(&own, &[]).unwrap_err().code,
        ErrorCode::Invalid
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_kubeconfig_stays_a_symlink() {
    let fx = Fixture::new();
    let real = fx.write("dotfiles/kube.yaml", &kubeconfig());
    let link = fx.path("home/.kube/config");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let mut registry = fx.registry();
    let writable = allow(&registry);
    let edit = KubeconfigEdit::SetNamespace {
        cluster_id: id_of(&registry, "beta"),
        namespace: Some("web".into()),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    let outcome = registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap();
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        std::fs::read_to_string(&real)
            .unwrap()
            .contains("namespace: web")
    );
    assert_eq!(
        outcome.backup_path.unwrap().parent().unwrap(),
        dunce::canonicalize(real.parent().unwrap()).unwrap()
    );
}

#[test]
fn comments_are_detected_outside_quotes() {
    assert!(has_comments(b"# top\napiVersion: v1\n"));
    assert!(has_comments(b"server: https://x # note\n"));
    assert!(!has_comments(b"server: https://x#frag\n"));
    assert!(!has_comments(b"name: \"a # b\"\n"));
}

#[test]
fn settings_of_a_renamed_cluster_move_to_its_new_id() {
    let mut settings = AppSettings::default();
    let (old, new) = (ClusterId::from("old"), ClusterId::from("new"));
    settings.clusters.insert(
        "old".into(),
        crate::settings::ClusterSettings {
            display_name: Some("Prod".into()),
            ..Default::default()
        },
    );
    settings.fleet.selected = vec!["a".into(), "old".into()];
    settings.notifications.muted_clusters = vec!["old".into()];
    settings.window.last_cluster = Some("old".into());
    settings.views = vec![crate::settings::SavedView {
        id: "v".into(),
        cluster: Some("old".into()),
        ..Default::default()
    }];
    settings.pins = vec![crate::settings::Pin {
        id: "p".into(),
        cluster: "old".into(),
        target: crate::settings::PinTarget::View { view: "v".into() },
    }];
    settings.workspaces = vec![crate::settings::Workspace {
        id: "w".into(),
        name: "Prod".into(),
        clusters: vec!["old".into(), "new".into()],
    }];
    move_cluster_settings(&mut settings, &old, &new);
    assert_eq!(settings.views[0].cluster.as_deref(), Some("new"));
    assert_eq!(settings.pins[0].cluster, "new");
    assert_eq!(settings.workspaces[0].clusters, ["new"]);
    assert!(!settings.clusters.contains_key("old"));
    assert_eq!(
        settings.clusters["new"].display_name.as_deref(),
        Some("Prod")
    );
    assert_eq!(settings.fleet.selected, ["a", "new"]);
    assert_eq!(settings.notifications.muted_clusters, ["new"]);
    assert_eq!(settings.window.last_cluster.as_deref(), Some("new"));
}

#[test]
fn a_renamed_cluster_never_inherits_the_settings_of_a_deleted_context_with_its_new_name() {
    let mut settings = AppSettings::default();
    let (dev, prod) = (ClusterId::from("dev"), ClusterId::from("prod"));
    let named = |name: &str| crate::settings::ClusterSettings {
        display_name: Some(name.into()),
        ..Default::default()
    };
    settings.clusters.insert("prod".into(), named("Old prod"));
    settings.clusters.insert("dev".into(), named("Dev"));
    settings.views = vec![crate::settings::SavedView {
        id: "pv".into(),
        name: "Prod pods".into(),
        cluster: Some("prod".into()),
        kind: "Pod".into(),
        ..Default::default()
    }];
    settings.pins = vec![
        crate::settings::Pin {
            id: "p1".into(),
            cluster: "prod".into(),
            target: crate::settings::PinTarget::View { view: "pv".into() },
        },
        crate::settings::Pin {
            id: "p2".into(),
            cluster: "dev".into(),
            target: crate::settings::PinTarget::View { view: "pv".into() },
        },
    ];
    settings.workspaces = vec![crate::settings::Workspace {
        id: "w".into(),
        name: "Prod".into(),
        clusters: vec!["prod".into(), "dev".into()],
    }];
    settings.fleet.selected = vec!["prod".into()];
    settings.window.last_cluster = Some("prod".into());

    // Deleting the context "prod" forgets everything kept for it.
    forget_cluster_settings(&mut settings, &prod);
    assert!(!settings.clusters.contains_key("prod"));
    assert!(settings.views.is_empty());
    assert!(
        settings.pins.is_empty(),
        "pins of the cluster and of its views"
    );
    assert_eq!(settings.workspaces[0].clusters, ["dev"]);
    assert!(settings.fleet.selected.is_empty());
    assert_eq!(settings.window.last_cluster, None);

    // Even when stale settings are still there, the renamed cluster's own settings win.
    settings.clusters.insert("prod".into(), named("Stale prod"));
    move_cluster_settings(&mut settings, &dev, &prod);
    assert_eq!(
        settings.clusters["prod"].display_name.as_deref(),
        Some("Dev")
    );
    assert!(!settings.clusters.contains_key("dev"));
    assert_eq!(settings.workspaces[0].clusters, ["prod"]);
}

#[test]
fn removing_a_source_forgets_that_it_was_writable() {
    let mut settings = AppSettings::default();
    settings.kubeconfig.writable_sources = vec!["a".into(), "b".into()];
    forget_source_settings(&mut settings, "a");
    assert_eq!(settings.kubeconfig.writable_sources, ["b"]);
}

#[test]
fn bad_kubeconfig_settings_read_as_defaults_instead_of_failing_the_file() {
    let read = |json: &str| -> KubeconfigSettings { serde_json::from_str(json).unwrap() };
    assert_eq!(read("{}"), KubeconfigSettings::default());
    assert_eq!(read("\"nonsense\""), KubeconfigSettings::default());
    let bad =
        read(r#"{"writableSources": ["a", 5, "a", null, "b"], "credentialExpiryDays": "soon"}"#);
    assert_eq!(bad.writable_sources, ["a", "b"]);
    assert_eq!(bad.credential_expiry_days, DEFAULT_CREDENTIAL_EXPIRY_DAYS);
    assert_eq!(
        read(r#"{"credentialExpiryDays": 0}"#).credential_expiry_days,
        1
    );
    assert_eq!(
        read(r#"{"credentialExpiryDays": -3}"#).credential_expiry_days,
        1
    );
    assert_eq!(
        read(r#"{"credentialExpiryDays": 99999}"#).credential_expiry_days,
        365
    );
    assert_eq!(
        read(r#"{"credentialExpiryDays": 30}"#).credential_expiry_days,
        30
    );
    assert_eq!(
        read(r#"{"writableSources": "x"}"#).writable_sources,
        Vec::<String>::new()
    );

    // A whole settings file with a bad value keeps everything else.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"theme": "dark", "kubeconfig": {"credentialExpiryDays": "x", "writableSources": ["s1"]}}"#,
    )
    .unwrap();
    let settings = crate::settings::SettingsStore::open(path).get();
    assert_eq!(settings.theme, crate::settings::Theme::Dark);
    assert_eq!(settings.kubeconfig.writable_sources, ["s1"]);
    assert_eq!(
        settings.kubeconfig.credential_expiry_days,
        DEFAULT_CREDENTIAL_EXPIRY_DAYS
    );
}

#[test]
fn merged_entries_keep_pointing_at_their_files_and_previews_hide_url_credentials() {
    let fx = Fixture::new();
    let team = fx.write(
        "team/a.yaml",
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: https://admin:hunter2@c:6443\n      proxy-url: http://pu:pp@proxy:3128\n      certificate-authority: certs/ca.crt\nusers:\n  - name: u\n    user:\n      client-certificate: certs/me.crt\n      client-key: /abs/me.key\n      tokenFile: tok\n      exec: { command: ./bin/login, apiVersion: client.authentication.k8s.io/v1 }\n  - name: v\n    user:\n      exec: { command: aws, apiVersion: client.authentication.k8s.io/v1 }\ncontexts:\n  - name: dev\n    context: { cluster: c, user: u }\n",
    );
    let dir = team.parent().unwrap().to_path_buf();
    let mut registry = fx.registry();
    let edit = KubeconfigEdit::Merge {
        paths: vec![team.clone()],
    };
    let preview = registry.preview_edit(&edit, &[]).unwrap();
    let json = serde_json::to_string(&preview).unwrap();
    // "admin:" rather than "admin": a Windows temp path holds the user name "runneradmin".
    for secret in ["admin:", "hunter2", "pu:", "pp@"] {
        assert!(!json.contains(secret), "{secret} in {json}");
    }
    let cluster = preview
        .changes
        .iter()
        .find(|c| c.entry == EntryKind::Cluster)
        .unwrap();
    let field = |name: &str| {
        cluster
            .fields
            .iter()
            .find(|f| f.field == name)
            .and_then(|f| f.after.clone())
    };
    assert_eq!(field("server").as_deref(), Some("https://c:6443"));
    assert_eq!(field("proxy-url").as_deref(), Some("http://proxy:3128"));
    registry.apply_edit(&edit, &preview.base, &[]).unwrap();

    let merged = Kubeconfig::read_from(fx.path("data/kubeconfigs/merged.yaml")).unwrap();
    let c = merged.clusters[0].cluster.as_ref().unwrap();
    assert_eq!(
        c.certificate_authority.as_deref().map(PathBuf::from),
        Some(dir.join("certs/ca.crt"))
    );
    let user = |name: &str| {
        merged
            .auth_infos
            .iter()
            .find(|u| u.name == name)
            .unwrap()
            .auth_info
            .clone()
            .unwrap()
    };
    let u = user("u");
    assert_eq!(
        u.client_certificate.map(PathBuf::from),
        Some(dir.join("certs/me.crt"))
    );
    #[cfg(unix)]
    assert_eq!(u.client_key.as_deref(), Some("/abs/me.key"));
    assert_eq!(u.token_file.map(PathBuf::from), Some(dir.join("tok")));
    assert_eq!(
        u.exec.unwrap().command.map(PathBuf::from),
        Some(dir.join("./bin/login"))
    );
    // A bare command is looked up in PATH: left as it is.
    assert_eq!(user("v").exec.unwrap().command.as_deref(), Some("aws"));
}

#[test]
fn a_preview_names_the_real_file_and_only_the_newest_backups_are_kept() {
    let fx = Fixture::new();
    let path = fx.home_config();
    let real = dunce::canonicalize(&path).unwrap();
    // Files that only look like backups are never touched.
    let dir = path.parent().unwrap();
    let foreign = [
        "config.bak-old",
        "config.bak-20000101-000000.txt",
        "other.bak-20000101-000000",
    ];
    for name in foreign {
        std::fs::write(dir.join(name), "keep").unwrap();
    }
    let mut registry = fx.registry();
    let writable = allow(&registry);
    let target = registry.edit_target(&registry.sources()[0].id).unwrap();
    assert_eq!(target.real_path, real);
    assert_eq!(target.backups_kept as usize, MAX_BACKUPS);
    let pattern = target.backup_pattern.clone().unwrap();
    assert_eq!(pattern.parent(), real.parent());
    for i in 0..MAX_BACKUPS + 2 {
        // Older backups (as if written earlier) so the order is known.
        std::fs::write(dir.join(format!("config.bak-20200101-00000{i}")), "old").unwrap();
    }
    let edit = KubeconfigEdit::SetNamespace {
        cluster_id: id_of(&registry, "beta"),
        namespace: Some("web".into()),
    };
    let preview = registry.preview_edit(&edit, &writable).unwrap();
    assert_eq!(preview.target, target);
    let outcome = registry
        .apply_edit(&edit, &preview.base, &writable)
        .unwrap();
    let left = backups(&path);
    let ours: Vec<_> = left
        .iter()
        .filter(|p| backup_order("config", p.file_name().unwrap().to_str().unwrap()).is_some())
        .collect();
    assert_eq!(ours.len(), MAX_BACKUPS, "{left:?}");
    assert!(ours.contains(&&outcome.backup_path.unwrap()));
    assert!(!dir.join("config.bak-20200101-000000").exists());
    for name in foreign {
        assert!(dir.join(name).exists(), "{name}");
    }
}

#[test]
fn a_rename_follows_the_current_context_of_another_kubeconfig_file_only_when_it_is_writable() {
    let fx = Fixture::new();
    let a = fx.write(
        "a.yaml",
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c:6443 }\nusers:\n  - name: u\n    user: { token: abc }\ncontexts:\n  - name: one\n    context: { cluster: c, user: u }\n",
    );
    let b_text = "apiVersion: v1\nkind: Config\ncurrent-context: one\n";
    let b = fx.write("b.yaml", b_text);
    let mut registry = fx.registry_with(Some(std::env::join_paths([&a, &b]).unwrap()));
    let source_of = |registry: &KubeconfigRegistry, path: &Path| {
        registry
            .sources()
            .into_iter()
            .find(|s| s.path == path)
            .unwrap()
            .id
    };
    let rename = |registry: &KubeconfigRegistry, to: &str| KubeconfigEdit::RenameContext {
        cluster_id: id_of(registry, "one"),
        new_name: to.into(),
    };

    // b may not be edited: the preview names it, and it stays as it is.
    let only_a = vec![source_of(&registry, &a)];
    let preview = registry
        .preview_edit(&rename(&registry, "two"), &only_a)
        .unwrap();
    assert_eq!(preview.current_context_elsewhere, std::slice::from_ref(&b));
    let edit = rename(&registry, "two");
    registry.apply_edit(&edit, &preview.base, &only_a).unwrap();
    assert_eq!(std::fs::read_to_string(&b).unwrap(), b_text);

    // Both writable: b follows the new name, and its change is shown under its path.
    std::fs::write(&b, "apiVersion: v1\nkind: Config\ncurrent-context: two\n").unwrap();
    let both = vec![source_of(&registry, &a), source_of(&registry, &b)];
    let edit = KubeconfigEdit::RenameContext {
        cluster_id: id_of(&registry, "two"),
        new_name: "three".into(),
    };
    let preview = registry.preview_edit(&edit, &both).unwrap();
    assert!(preview.current_context_elsewhere.is_empty());
    assert!(
        preview
            .changes
            .iter()
            .any(|c| c.entry == EntryKind::CurrentContext
                && c.origin.as_deref() == Some(b.as_path()))
    );
    // A change to b after the preview stops the whole change.
    std::fs::write(
        &b,
        "apiVersion: v1\nkind: Config\ncurrent-context: two\n# edited\n",
    )
    .unwrap();
    assert_eq!(
        registry
            .apply_edit(&edit, &preview.base, &both)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    std::fs::write(&b, "apiVersion: v1\nkind: Config\ncurrent-context: two\n").unwrap();
    registry.apply_edit(&edit, &preview.base, &both).unwrap();
    assert_eq!(
        Kubeconfig::read_from(&b)
            .unwrap()
            .current_context
            .as_deref(),
        Some("three")
    );
    assert_eq!(contexts(&registry), ["three"]);
}
