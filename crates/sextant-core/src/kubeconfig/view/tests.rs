use super::*;
use crate::kubeconfig::KubeconfigEnv;
use std::path::{Path, PathBuf};

/// Every credential of the fixture: none may appear in what the window gets.
const SECRETS: [&str; 14] = [
    "tok-bearer-0001",
    "basic-pass-0002",
    "Y2xpZW50LWNlcnQtMDAwMw==",
    "Y2xpZW50LWtleS0wMDA0",
    "oidc-id-token-0005",
    "oidc-refresh-0006",
    "oidc-client-secret-0007",
    "gcp-access-token-0008",
    "aws-secret-0009",
    "proxy-pass-0010",
    "server-pass-0011",
    "ext-secret-0012",
    "unknown-field-0013",
    "aws-session-0014",
];
/// Contents of the referenced files: never read and inlined.
const KEY_FILE: &str = "file-key-content-0101";
const TOKEN_FILE: &str = "file-token-content-0102";

fn kubeconfig() -> String {
    r#"apiVersion: v1
kind: Config
preferences:
  colors: true
extensions:
  - name: top
    extension: { secret: ext-secret-0012 }
clusters:
  - name: main
    cluster:
      server: https://admin:server-pass-0011@main.example:6443
      proxy-url: http://me:proxy-pass-0010@proxy.example:3128
      certificate-authority-data: Q0EtREFUQQ==
      tls-server-name: api.main.example
  - name: other
    cluster: { server: https://other.example:6443 }
users:
  - name: bearer
    user: { token: tok-bearer-0001, x-unknown: unknown-field-0013 }
  - name: basic
    user: { username: alice, password: basic-pass-0002 }
  - name: cert
    user:
      client-certificate-data: Y2xpZW50LWNlcnQtMDAwMw==
      client-key-data: Y2xpZW50LWtleS0wMDA0
  - name: files
    user: { client-certificate: certs/c.crt, client-key: certs/c.key, tokenFile: tok.txt }
  - name: oidc
    user:
      auth-provider:
        name: oidc
        config:
          client-id: kube
          idp-issuer-url: https://issuer.example
          id-token: oidc-id-token-0005
          refresh-token: oidc-refresh-0006
          client-secret: oidc-client-secret-0007
  - name: gcp
    user:
      auth-provider:
        name: gcp
        config: { access-token: gcp-access-token-0008, cmd-path: /usr/bin/gcloud }
  - name: aws
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: [eks, get-token, --cluster-name, prod]
        env:
          - { name: AWS_PROFILE, value: prod }
          - { name: AWS_SECRET_ACCESS_KEY, value: aws-secret-0009 }
          - { name: AWS_SESSION_TOKEN, value: aws-session-0014 }
contexts:
  - { name: bearer, context: { cluster: main, user: bearer, namespace: team-a } }
  - { name: basic, context: { cluster: main, user: basic } }
  - { name: cert, context: { cluster: main, user: cert } }
  - { name: files, context: { cluster: other, user: files } }
  - { name: oidc, context: { cluster: main, user: oidc } }
  - { name: gcp, context: { cluster: main, user: gcp } }
  - { name: aws, context: { cluster: main, user: aws } }
current-context: aws
"#
    .to_owned()
}

struct Fixture {
    dir: tempfile::TempDir,
    registry: KubeconfigRegistry,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let kube = dir.path().join("home").join(".kube");
        std::fs::create_dir_all(kube.join("certs")).unwrap();
        std::fs::write(kube.join("config"), kubeconfig()).unwrap();
        std::fs::write(kube.join("certs").join("c.key"), KEY_FILE).unwrap();
        std::fs::write(kube.join("tok.txt"), TOKEN_FILE).unwrap();
        let registry =
            KubeconfigRegistry::new(Vec::new(), dir.path().join("data")).with_env(KubeconfigEnv {
                kubeconfig: None,
                home: Some(dir.path().join("home")),
            });
        Self { dir, registry }
    }

    fn kube_dir(&self) -> PathBuf {
        self.dir.path().join("home").join(".kube")
    }

    fn id(&self, context: &str) -> ClusterId {
        ClusterId::for_context(&self.kube_dir().join("config"), context)
    }
}

const CONTEXTS: [&str; 7] = ["bearer", "basic", "cert", "files", "oidc", "gcp", "aws"];

fn parse(yaml: &str) -> Value {
    serde_yaml::from_str(yaml).unwrap()
}

fn assert_no_secret(text: &str, what: &str) {
    for secret in SECRETS.iter().chain([&KEY_FILE, &TOKEN_FILE]) {
        assert!(!text.contains(secret), "{what} shows {secret}:\n{text}");
    }
}

#[test]
fn the_view_never_contains_a_credential() {
    let fx = Fixture::new();
    for context in CONTEXTS {
        let shown = fx.registry.view_kubeconfig(&fx.id(context)).unwrap();
        assert_no_secret(&shown, context);
    }
}

#[test]
fn the_view_is_one_standalone_context_without_preferences() {
    let fx = Fixture::new();
    let doc = parse(&fx.registry.view_kubeconfig(&fx.id("bearer")).unwrap());
    let keys: Vec<&str> = doc
        .as_mapping()
        .unwrap()
        .keys()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "apiVersion",
            "kind",
            "clusters",
            "users",
            "contexts",
            "current-context"
        ]
    );
    assert_eq!(doc["current-context"], "bearer");
    assert_eq!(doc["contexts"].as_sequence().unwrap().len(), 1);
    assert_eq!(doc["contexts"][0]["context"]["namespace"], "team-a");
    assert_eq!(doc["clusters"].as_sequence().unwrap().len(), 1);
    assert_eq!(doc["users"].as_sequence().unwrap().len(), 1);
    let cluster = &doc["clusters"][0]["cluster"];
    assert_eq!(cluster["server"], "https://main.example:6443");
    assert_eq!(cluster["proxy-url"], "http://proxy.example:3128");
    assert_eq!(cluster["tls-server-name"], "api.main.example");
    // A CA certificate is public: shown, so a copy without credentials still trusts the cluster.
    assert_eq!(cluster["certificate-authority-data"], "Q0EtREFUQQ==");
    assert_eq!(doc["users"][0]["user"]["token"], mask::HIDDEN);
}

#[test]
fn exec_and_auth_provider_blocks_are_shown_without_their_secrets() {
    let fx = Fixture::new();
    let aws = parse(&fx.registry.view_kubeconfig(&fx.id("aws")).unwrap());
    let exec = &aws["users"][0]["user"]["exec"];
    assert_eq!(exec["command"], "aws");
    assert_eq!(exec["args"][1], "get-token");
    assert_eq!(exec["env"][0]["value"], "prod");
    assert_eq!(exec["env"][1]["name"], "AWS_SECRET_ACCESS_KEY");
    assert_eq!(exec["env"][1]["value"], mask::HIDDEN);

    let oidc = parse(&fx.registry.view_kubeconfig(&fx.id("oidc")).unwrap());
    let provider = &oidc["users"][0]["user"]["auth-provider"];
    assert_eq!(provider["name"], "oidc");
    assert_eq!(provider["config"]["client-id"], "kube");
    assert_eq!(
        provider["config"]["idp-issuer-url"],
        "https://issuer.example"
    );
    for key in ["id-token", "refresh-token", "client-secret"] {
        assert_eq!(provider["config"][key], mask::HIDDEN, "{key}");
    }
    let basic = parse(&fx.registry.view_kubeconfig(&fx.id("basic")).unwrap());
    assert_eq!(basic["users"][0]["user"]["username"], "alice");
    assert_eq!(basic["users"][0]["user"]["password"], mask::HIDDEN);
}

#[test]
fn file_references_stay_references_in_both_outputs() {
    let fx = Fixture::new();
    let id = fx.id("files");
    let key = fx.kube_dir().join("certs").join("c.key");
    let token = fx.kube_dir().join("tok.txt");
    for yaml in [
        fx.registry.view_kubeconfig(&id).unwrap(),
        fx.registry.full_kubeconfig(&id).unwrap(),
    ] {
        assert!(
            !yaml.contains(KEY_FILE) && !yaml.contains(TOKEN_FILE),
            "{yaml}"
        );
        let user = &parse(&yaml)["users"][0]["user"];
        assert_eq!(Path::new(user["client-key"].as_str().unwrap()), key);
        assert_eq!(Path::new(user["tokenFile"].as_str().unwrap()), token);
    }
}

#[test]
fn the_full_copy_keeps_every_credential_as_written() {
    let fx = Fixture::new();
    let full = |c: &str| fx.registry.full_kubeconfig(&fx.id(c)).unwrap();
    assert!(full("bearer").contains("tok-bearer-0001"));
    assert!(full("basic").contains("basic-pass-0002"));
    let cert = parse(&full("cert"));
    assert_eq!(
        cert["users"][0]["user"]["client-key-data"],
        "Y2xpZW50LWtleS0wMDA0"
    );
    assert!(full("oidc").contains("oidc-refresh-0006"));
    assert!(full("aws").contains("aws-secret-0009"));
    assert!(full("bearer").contains("https://admin:server-pass-0011@main.example:6443"));
    // Still one context, and nothing of the file's preferences or extensions.
    let doc = parse(&full("gcp"));
    assert_eq!(doc["current-context"], "gcp");
    assert!(doc.get("preferences").is_none() && doc.get("extensions").is_none());
    assert!(!full("gcp").contains("ext-secret-0012"));
}

#[test]
fn errors_name_no_credential() {
    let fx = Fixture::new();
    let missing = ClusterId("not-a-cluster".to_owned());
    for err in [
        fx.registry.view_kubeconfig(&missing).unwrap_err(),
        fx.registry.full_kubeconfig(&missing).unwrap_err(),
    ] {
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_no_secret(&format!("{err:?} {err}"), "an error");
    }
}

#[test]
fn unknown_shapes_are_hidden() {
    let mut doc = parse(
        "clusters:\n  - name: c\n    cluster: { server: [x], extensions: [{ name: e, extension: s3 }] }\n    extra: s4\nusers:\n  - name: u\n    user: { exec: oops-1, auth-provider: { name: p, config: { password: s5, scopes: [a] } }, as-groups: [ops] }\n",
    );
    mask::mask_document(&mut doc);
    let text = serde_yaml::to_string(&doc).unwrap();
    for leaked in ["[x]", "s3", "s4", "oops-1", "s5"] {
        assert!(!text.contains(leaked), "{leaked}: {text}");
    }
    assert_eq!(doc["users"][0]["user"]["as-groups"][0], "ops");
    assert_eq!(
        doc["users"][0]["user"]["auth-provider"]["config"]["scopes"],
        mask::HIDDEN
    );
}

#[test]
fn exec_flag_values_that_look_secret_are_hidden_in_both_forms() {
    let mut doc = parse(
        r#"users:
  - name: u
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=https://issuer.example
          - --oidc-client-secret=arg-secret-01
          - --token=arg-secret-02
          - --password
          - arg-secret-03
          - --Client-Secret
          - arg-secret-04
          - -bearer
          - arg-secret-05
          - --Refresh-Token=arg-secret-06
          - --auth-header
          - arg-secret-07
          - api_key=arg-secret-08
          - --cluster-name
          - prod
        installHint: install kubelogin
        interactiveMode: Never
        provideClusterInfo: true
        futureField: exec-other-09
        env:
          - { name: MODE, value: plain, extra: env-extra-10 }
"#,
    );
    mask::mask_document(&mut doc);
    let text = serde_yaml::to_string(&doc).unwrap();
    for n in 1..=10 {
        assert!(
            !text.contains(&format!("-{n:02}")),
            "secret {n} shown:\n{text}"
        );
    }
    let exec = &doc["users"][0]["user"]["exec"];
    let args: Vec<&str> = exec["args"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(
        args,
        [
            "oidc-login",
            "get-token",
            "--oidc-issuer-url=https://issuer.example",
            "--oidc-client-secret=<hidden>",
            "--token=<hidden>",
            "--password",
            mask::HIDDEN,
            "--Client-Secret",
            mask::HIDDEN,
            "-bearer",
            mask::HIDDEN,
            "--Refresh-Token=<hidden>",
            "--auth-header",
            mask::HIDDEN,
            "api_key=<hidden>",
            "--cluster-name",
            "prod",
        ]
    );
    assert_eq!(exec["command"], "kubectl");
    assert_eq!(exec["installHint"], "install kubelogin");
    assert_eq!(exec["interactiveMode"], "Never");
    assert_eq!(exec["provideClusterInfo"], true);
    assert_eq!(exec["futureField"], mask::HIDDEN);
    assert_eq!(exec["env"][0]["value"], "plain");
    assert_eq!(exec["env"][0]["extra"], mask::HIDDEN);
}

#[test]
fn exec_fields_kube_keeps_beyond_the_known_ones_are_hidden_in_the_view() {
    let fx = Fixture::new();
    let path = fx.kube_dir().join("config");
    let yaml = std::fs::read_to_string(&path).unwrap().replace(
        "        command: aws\n",
        "        command: aws\n        unknownField: exec-unknown-0201\n",
    );
    std::fs::write(&path, yaml).unwrap();
    let shown = fx.registry.view_kubeconfig(&fx.id("aws")).unwrap();
    assert!(!shown.contains("exec-unknown-0201"), "{shown}");
    assert!(
        fx.registry
            .full_kubeconfig(&fx.id("aws"))
            .unwrap()
            .contains("exec-unknown-0201")
    );
}

#[test]
fn contexts_show_only_their_cluster_user_and_namespace() {
    let mut doc = parse(
        "contexts:\n  - name: c\n    context:\n      cluster: main\n      user: me\n      namespace: web\n      extensions: [{ name: e, extension: ctx-secret-01 }]\n      other: ctx-secret-02\n    extra: ctx-secret-03\n",
    );
    mask::mask_document(&mut doc);
    let text = serde_yaml::to_string(&doc).unwrap();
    for leaked in ["ctx-secret-01", "ctx-secret-02", "ctx-secret-03"] {
        assert!(!text.contains(leaked), "{leaked}: {text}");
    }
    let ctx = &doc["contexts"][0]["context"];
    assert_eq!(ctx["cluster"], "main");
    assert_eq!(ctx["user"], "me");
    assert_eq!(ctx["namespace"], "web");
    assert_eq!(doc["contexts"][0]["name"], "c");
}
