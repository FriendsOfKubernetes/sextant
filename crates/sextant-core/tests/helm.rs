//! Helm against the kind test cluster: releases read natively from their Secrets, and changes made through the
//! `helm` binary (`helm::cli`).
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test helm -- --test-threads=1
//! ```
//!
//! Charts come from `tests/fixtures/helm/sextant-demo` (one ConfigMap, no pods, a values schema) — straight from
//! the directory, or from a chart repository served over HTTP on 127.0.0.1 by the test itself; no network.
//! Every test works in its own namespace `sextant-helm-<test>`, removed at the end (also when the test fails).
//! Helm's own config, cache and data go to a temporary directory, never to the user's `~/.config/helm`.
//! Tests that need `helm` return early (and pass) when it is not installed.

mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::DeleteParams;
use kube::{Api, Client};
use sextant_core::helm::cli::{self, ChartHit, HelmCli, HelmRepo};
use sextant_core::helm::{self, HelmRelease};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn chart_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/helm/sextant-demo")
}

/// A `helm` that keeps its config, cache and data in `home`; `None` (with a note) when Helm is not installed.
fn helm_in(home: &Path) -> Option<HelmCli> {
    if !HelmCli::detect().available {
        eprintln!("skipped: helm is not installed");
        return None;
    }
    Some(
        HelmCli::default()
            .with_env("HELM_CONFIG_HOME", home.join("config"))
            .with_env("HELM_CACHE_HOME", home.join("cache"))
            .with_env("HELM_DATA_HOME", home.join("data")),
    )
}

struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    ns: String,
    helm: HelmCli,
    home: PathBuf,
}

impl Scratch {
    async fn install(&self, release: &str, chart: &str, version: Option<&str>, values: &str) {
        let t = cli::kube_target(&self.mgr, &self.id).unwrap();
        self.helm
            .install(
                &t.kubeconfig,
                &t.context,
                &self.ns,
                release,
                chart,
                version,
                values,
            )
            .await
            .unwrap_or_else(|e| panic!("helm install {release}: {e}"));
    }

    async fn releases(&self) -> Vec<HelmRelease> {
        helm::list_releases(&self.mgr, &self.id, Some(vec![self.ns.clone()]))
            .await
            .unwrap()
    }

    async fn greeting(&self, release: &str) -> String {
        let cm = Api::<ConfigMap>::namespaced(self.client.clone(), &self.ns)
            .get(&format!("{release}-config"))
            .await
            .unwrap();
        cm.data.unwrap()["greeting"].clone()
    }
}

/// Runs `body` with a namespace `sextant-helm-<test>` (created by the first `helm install`); afterwards removes
/// every release in it and the namespace, whether `body` passes or panics.
async fn in_scratch<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let Some(helm) = helm_in(tmp.path()) else {
        return;
    };
    let client = cluster.client().await;
    let ns = format!("sextant-helm-{test}");
    remove_namespace(&client, &ns).await;

    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().join("pasted")).with_env(KubeconfigEnv {
            kubeconfig: Some(cluster.kubeconfig.as_os_str().to_owned()),
            home: None,
        });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();

    let scratch = Scratch {
        mgr: mgr.clone(),
        id: id.clone(),
        client: client.clone(),
        ns: ns.clone(),
        helm: helm.clone(),
        home: tmp.path().to_path_buf(),
    };
    let outcome = AssertUnwindSafe(body(scratch)).catch_unwind().await;

    if let Ok(releases) = helm::list_releases(&mgr, &id, Some(vec![ns.clone()])).await {
        let t = cli::kube_target(&mgr, &id).unwrap();
        for r in releases {
            let _ = helm
                .uninstall(&t.kubeconfig, &t.context, &ns, &r.name)
                .await;
        }
    }
    remove_namespace(&client, &ns).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn remove_namespace(client: &Client, ns: &str) {
    let api: Api<Namespace> = Api::all(client.clone());
    let _ = api.delete(ns, &DeleteParams::default()).await;
    let deadline = Instant::now() + Duration::from_secs(180);
    while api.get_opt(ns).await.unwrap().is_some() {
        assert!(Instant::now() < deadline, "namespace {ns} is not deleted");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test]
async fn an_installed_release_is_read_with_values_manifest_notes_and_history() {
    in_scratch("read", |s| async move {
        s.install(
            "demo",
            chart_dir().to_str().unwrap(),
            None,
            "greeting: hi\n",
        )
        .await;

        let list = s.releases().await;
        assert_eq!(list.len(), 1, "{list:?}");
        let r = &list[0];
        assert_eq!(
            (
                r.name.as_str(),
                r.namespace.as_str(),
                r.revision,
                r.chart.as_str(),
                r.chart_version.as_str(),
                r.app_version.as_str(),
                r.status.as_str()
            ),
            (
                "demo",
                s.ns.as_str(),
                1,
                "sextant-demo",
                "0.1.0",
                "1.0.0",
                "deployed"
            )
        );
        assert!(
            r.updated.starts_with("20"),
            "an RFC 3339 time: {}",
            r.updated
        );

        let all = helm::list_releases(&s.mgr, &s.id, None).await.unwrap();
        assert!(all.iter().any(|x| x.name == "demo" && x.namespace == s.ns));

        let detail = helm::release_detail(&s.mgr, &s.id, &s.ns, "demo", None)
            .await
            .unwrap();
        assert_eq!(detail.release, *r);
        assert_eq!(detail.values_yaml, "greeting: hi\n");
        assert!(
            detail.manifest.contains("kind: ConfigMap"),
            "{}",
            detail.manifest
        );
        assert!(detail.manifest.contains("name: demo-config"));
        assert_eq!(detail.notes.trim(), "Release demo says hi.");

        let history = helm::release_history(&s.mgr, &s.id, &s.ns, "demo")
            .await
            .unwrap();
        assert_eq!(history, vec![r.clone()]);

        let err = helm::release_detail(&s.mgr, &s.id, &s.ns, "nope", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = helm::release_detail(&s.mgr, &s.id, &s.ns, "demo", Some(7))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    })
    .await;
}

#[tokio::test]
async fn new_values_make_a_revision_and_rollback_brings_the_old_ones_back() {
    in_scratch("upgrade", |s| async move {
        s.install(
            "demo",
            chart_dir().to_str().unwrap(),
            None,
            "greeting: hi\n",
        )
        .await;

        // Same chart, taken from the release itself (it was installed from a directory, no repository knows it).
        cli::upgrade_release(
            &s.helm,
            &s.mgr,
            &s.id,
            &s.ns,
            "demo",
            "",
            "greeting: changed\n",
        )
        .await
        .unwrap();
        let detail = helm::release_detail(&s.mgr, &s.id, &s.ns, "demo", None)
            .await
            .unwrap();
        assert_eq!(detail.release.revision, 2);
        assert_eq!(detail.release.chart_version, "0.1.0");
        assert_eq!(detail.values_yaml, "greeting: changed\n");
        assert_eq!(s.greeting("demo").await, "changed");

        let t = cli::kube_target(&s.mgr, &s.id).unwrap();
        s.helm
            .rollback(&t.kubeconfig, &t.context, &s.ns, "demo", 1)
            .await
            .unwrap();
        let history = helm::release_history(&s.mgr, &s.id, &s.ns, "demo")
            .await
            .unwrap();
        let revisions: Vec<_> = history
            .iter()
            .map(|h| (h.revision, h.status.as_str()))
            .collect();
        assert_eq!(
            revisions,
            [(1, "superseded"), (2, "superseded"), (3, "deployed")]
        );
        let latest = helm::release_detail(&s.mgr, &s.id, &s.ns, "demo", None)
            .await
            .unwrap();
        assert_eq!(latest.values_yaml, "greeting: hi\n");
        assert_eq!(s.greeting("demo").await, "hi");
        let old = helm::release_detail(&s.mgr, &s.id, &s.ns, "demo", Some(2))
            .await
            .unwrap();
        assert_eq!(old.values_yaml, "greeting: changed\n");
    })
    .await;
}

#[tokio::test]
async fn helm_errors_come_back_with_helms_own_text() {
    in_scratch("error", |s| async move {
        s.install("demo", chart_dir().to_str().unwrap(), None, "")
            .await;
        // The chart's schema wants an integer.
        let err =
            cli::upgrade_release(&s.helm, &s.mgr, &s.id, &s.ns, "demo", "", "replicas: abc\n")
                .await
                .unwrap_err();
        assert_eq!(err.code, ErrorCode::Other);
        assert!(err.message.contains("replicas"), "{}", err.message);
        assert!(err.message.contains("want integer"), "{}", err.message);
        assert_eq!(s.releases().await[0].revision, 1, "nothing was applied");

        let t = cli::kube_target(&s.mgr, &s.id).unwrap();
        let err = s
            .helm
            .rollback(&t.kubeconfig, &t.context, &s.ns, "demo", 9)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Other);
        assert!(!err.message.is_empty());
    })
    .await;
}

#[tokio::test]
async fn uninstall_removes_the_release() {
    in_scratch("uninstall", |s| async move {
        s.install("gone", chart_dir().to_str().unwrap(), None, "")
            .await;
        s.install("kept", chart_dir().to_str().unwrap(), None, "")
            .await;
        let t = cli::kube_target(&s.mgr, &s.id).unwrap();
        s.helm
            .uninstall(&t.kubeconfig, &t.context, &s.ns, "gone")
            .await
            .unwrap();
        let names: Vec<_> = s.releases().await.into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["kept"]);
        let err = helm::release_history(&s.mgr, &s.id, &s.ns, "gone")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    })
    .await;
}

/// Serves the files of `dir` over HTTP on 127.0.0.1 until the returned task is aborted. Returns the base URL.
async fn serve_dir(dir: PathBuf) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let dir = dir.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&request);
                let path = line.split_whitespace().nth(1).unwrap_or("/");
                let name = path.trim_start_matches('/');
                let body = (!name.contains("..") && !name.is_empty())
                    .then(|| std::fs::read(dir.join(name)).ok())
                    .flatten();
                let response = match body {
                    Some(body) => {
                        let mut r = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        r.extend(body);
                        r
                    }
                    None => {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                };
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (url, task)
}

/// Packages the fixture chart into a repository directory with an `index.yaml` pointing at `url`.
fn build_repo(helm_home: &Path, repo: &Path, url: &str) {
    let run = |args: &[&std::ffi::OsStr]| {
        let out = std::process::Command::new("helm")
            .args(args)
            .env("HELM_CONFIG_HOME", helm_home.join("config"))
            .env("HELM_CACHE_HOME", helm_home.join("cache"))
            .env("HELM_DATA_HOME", helm_home.join("data"))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    run(&[
        "package".as_ref(),
        chart_dir().as_os_str(),
        "--destination".as_ref(),
        repo.as_os_str(),
    ]);
    run(&[
        "repo".as_ref(),
        "index".as_ref(),
        repo.as_os_str(),
        "--url".as_ref(),
        url.as_ref(),
    ]);
}

#[tokio::test]
async fn repositories_are_added_searched_updated_and_removed() {
    let tmp = tempfile::tempdir().unwrap();
    let Some(helm) = helm_in(tmp.path()) else {
        return;
    };
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let (url, server) = serve_dir(repo.clone()).await;
    build_repo(tmp.path(), &repo, &url);

    assert_eq!(helm.repos().await.unwrap(), Vec::<HelmRepo>::new());
    assert_eq!(
        helm.search("sextant").await.unwrap(),
        Vec::<ChartHit>::new()
    );
    helm.repo_update().await.unwrap();

    helm.repo_add("sextant-local", &url).await.unwrap();
    assert_eq!(
        helm.repos().await.unwrap(),
        vec![HelmRepo {
            name: "sextant-local".into(),
            url: url.clone()
        }]
    );
    helm.repo_update().await.unwrap();
    let hits = helm.search("sextant").await.unwrap();
    assert_eq!(
        hits,
        vec![ChartHit {
            name: "sextant-local/sextant-demo".into(),
            version: "0.1.0".into(),
            app_version: "1.0.0".into(),
            description: "A tiny chart for Sextant's Helm tests (one ConfigMap, no pods).".into(),
        }]
    );
    assert_eq!(helm.search("").await.unwrap(), hits);
    assert_eq!(helm.search("no-such-chart").await.unwrap(), vec![]);
    let values = helm
        .show_values("sextant-local/sextant-demo", Some("0.1.0"))
        .await
        .unwrap();
    assert!(values.contains("greeting: hello"), "{values}");

    let err = helm
        .repo_add("broken", "http://127.0.0.1:1")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Other);
    assert!(!err.message.is_empty());

    helm.repo_remove("sextant-local").await.unwrap();
    assert_eq!(helm.repos().await.unwrap(), vec![]);
    // Helm's own words ("no repositories configured" / "no repo named … found").
    let err = helm.repo_remove("sextant-local").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Other);
    assert!(err.message.contains("repo"), "{}", err.message);
    server.abort();
}

#[tokio::test]
async fn a_chart_from_an_added_repository_installs_and_shows_up_in_releases() {
    in_scratch("repo", |s| async move {
        let repo = s.home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let (url, server) = serve_dir(repo.clone()).await;
        build_repo(&s.home, &repo, &url);
        s.helm.repo_add("sextant-local", &url).await.unwrap();
        let hit = s.helm.search("sextant-demo").await.unwrap().remove(0);

        s.install(
            "from-repo",
            &hit.name,
            Some(&hit.version),
            "greeting: from repo\n",
        )
        .await;
        let list = s.releases().await;
        assert_eq!(list.len(), 1);
        assert_eq!(
            (
                list[0].name.as_str(),
                list[0].chart.as_str(),
                list[0].chart_version.as_str()
            ),
            ("from-repo", "sextant-demo", "0.1.0")
        );
        assert_eq!(s.greeting("from-repo").await, "from repo");

        // Upgrade through the repository reference, pinned to the release's chart version.
        cli::upgrade_release(
            &s.helm,
            &s.mgr,
            &s.id,
            &s.ns,
            "from-repo",
            "sextant-local/sextant-demo",
            "greeting: again\n",
        )
        .await
        .unwrap();
        assert_eq!(s.releases().await[0].revision, 2);
        assert_eq!(s.greeting("from-repo").await, "again");
        server.abort();
    })
    .await;
}

/// The temporary kubeconfig a `helm` call gets is private (0600), holds the credentials only inside the file —
/// never on the command line — and is gone after the call. A fake `helm` records what it was given.
#[cfg(unix)]
#[tokio::test]
async fn helm_gets_a_private_temporary_kubeconfig_and_no_credentials_in_arguments() {
    use std::os::unix::fs::PermissionsExt;

    const TOKEN: &str = "sextant-helm-secret-token";
    let tmp = tempfile::tempdir().unwrap();
    let kubeconfig = tmp.path().join("config");
    std::fs::write(
        &kubeconfig,
        format!(
            "apiVersion: v1
kind: Config
clusters:
  - name: c
    cluster:
      server: https://127.0.0.1:1
users:
  - name: u
    user:
      token: {TOKEN}
contexts:
  - name: team
    context:
      cluster: c
      user: u
current-context: team
"
        ),
    )
    .unwrap();
    let record = tmp.path().join("record");
    let fake = tmp.path().join("helm");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh
out={record}
printf '%s\\n' \"$@\" > \"$out.args\"
prev=''
for a in \"$@\"; do
  if [ \"$prev\" = --kubeconfig ]; then
    stat -c %a \"$a\" > \"$out.mode\" 2>/dev/null || stat -f %Lp \"$a\" > \"$out.mode\"
    cat \"$a\" > \"$out.kubeconfig\"
    printf '%s' \"$a\" > \"$out.path\"
  fi
  prev=\"$a\"
done
",
            record = record.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().join("pasted")).with_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.as_os_str().to_owned()),
            home: None,
        });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));

    let helm = HelmCli::default().with_binary(&fake);
    {
        let t = cli::kube_target(&mgr, &id).unwrap();
        assert_eq!(t.context, "team");
        helm.uninstall(&t.kubeconfig, &t.context, "ns", "demo")
            .await
            .unwrap();
    }

    let read =
        |ext: &str| std::fs::read_to_string(tmp.path().join(format!("record.{ext}"))).unwrap();
    let args = read("args");
    assert!(
        !args.contains(TOKEN),
        "credentials on the command line: {args}"
    );
    assert!(args.contains("--kube-context\nteam\n"), "{args}");
    assert!(args.ends_with("--\ndemo\n"), "{args}");
    assert_eq!(read("mode").trim(), "600");
    assert!(
        read("kubeconfig").contains(TOKEN),
        "the file has the credentials"
    );
    assert!(
        !Path::new(&read("path")).exists(),
        "the temporary kubeconfig is deleted after the call"
    );
}

/// Variables `helm` reads that would point it at another API server, another identity or another release store,
/// overriding the `--kubeconfig` it is given.
#[cfg(unix)]
const INHERITED_OVERRIDES: &[(&str, &str)] = &[
    ("HELM_KUBEAPISERVER", "https://other-cluster.example:6443"),
    ("HELM_KUBETOKEN", "sextant-leaked-app-token"),
    ("HELM_KUBEASUSER", "system:admin"),
    ("HELM_KUBEASGROUPS", "system:masters"),
    ("HELM_KUBECAFILE", "/tmp/other-ca.crt"),
    ("HELM_KUBEINSECURE_SKIP_TLS_VERIFY", "true"),
    ("HELM_KUBETLS_SERVER_NAME", "other-cluster.example"),
    ("HELM_KUBECONTEXT", "other-context"),
    ("HELM_NAMESPACE", "other-namespace"),
    ("HELM_DRIVER", "configmap"),
    ("KUBECONFIG", "/tmp/other-kubeconfig"),
];

/// The app's own environment must not redirect `helm`: the variables above, set in the process, do not reach the
/// binary; a variable set explicitly with `with_env` does. Runs itself again as a child process with the variables
/// set, so the environment of this test process is never changed.
#[cfg(unix)]
#[tokio::test]
async fn helm_does_not_inherit_kube_overrides_from_the_app_environment() {
    use std::os::unix::fs::PermissionsExt;

    const CHILD: &str = "SEXTANT_HELM_ENV_CHILD";
    const NAME: &str = "helm_does_not_inherit_kube_overrides_from_the_app_environment";
    if std::env::var_os(CHILD).is_none() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([NAME, "--exact", "--nocapture", "--test-threads=1"])
            .envs(INHERITED_OVERRIDES.iter().copied())
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        return;
    }

    for (key, value) in INHERITED_OVERRIDES {
        assert_eq!(
            std::env::var(key).as_deref(),
            Ok(*value),
            "the child has {key}"
        );
    }
    let tmp = tempfile::tempdir().unwrap();
    let record = tmp.path().join("env");
    let fake = tmp.path().join("helm");
    std::fs::write(&fake, format!("#!/bin/sh\nenv > '{}'\n", record.display())).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    let helm = HelmCli::default()
        .with_binary(&fake)
        .with_env("HELM_NAMESPACE", "explicit-namespace");
    helm.uninstall(Path::new("/tmp/kc"), "ctx", "ns", "demo")
        .await
        .unwrap();
    let env = std::fs::read_to_string(&record).unwrap();
    let vars: Vec<&str> = env.lines().collect();
    for (key, _) in INHERITED_OVERRIDES {
        if *key == "HELM_NAMESPACE" {
            continue;
        }
        assert!(
            !vars.iter().any(|l| l.starts_with(&format!("{key}="))),
            "{key} reached helm:\n{env}"
        );
    }
    assert!(!env.contains("sextant-leaked-app-token"), "{env}");
    assert!(
        vars.contains(&"HELM_NAMESPACE=explicit-namespace"),
        "an explicit with_env value is kept:\n{env}"
    );
}
