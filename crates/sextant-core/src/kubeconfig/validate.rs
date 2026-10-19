//! Checks of a kubeconfig the user is adding (#150), per context, in codes the window words in plain language: the
//! YAML parses, `current-context` exists, every context names a cluster and a user that exist, the server URL is a
//! URL, the CA data is a certificate, the files it names exist, the exec plugin is in `PATH`, the client certificate
//! has not expired.
//!
//! Rules: offline and read-only — nothing is run (an exec plugin is only looked up, never started), nothing is sent.
//! Whether the server answers is checked only when the user asks ([`connection_kubeconfig`] +
//! [`crate::cluster::check_connection`], the usual connect timeouts). No value of the file is returned: names, file
//! paths and the exec command's file name only.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use k8s_openapi::jiff::Timestamp;
use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::edit::absolutize_paths;
use super::expiry::{
    CredentialKind, CredentialProblem, MAX_CREDENTIAL_FILE, expiry_of, read_capped,
};
use super::{ClusterId, single_context};
use crate::error::{CoreError, CoreResult, ErrorCode};

/// Pasted text larger than this is not checked.
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

/// A kubeconfig being added: a file the user chose, or text the user pasted. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KubeconfigInput {
    File { path: PathBuf },
    Text { text: String },
}

/// What is wrong (or doubtful) with a kubeconfig or one of its contexts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ValidationCode {
    /// The file cannot be read.
    Unreadable,
    /// Not YAML (`line`, `column`).
    NotYaml,
    /// YAML, but not a kubeconfig.
    NotKubeconfig,
    NoContexts,
    /// `current-context` (`subject`) names no context.
    CurrentContextMissing,
    /// The context's cluster (`subject`) is not defined.
    ClusterMissing,
    /// The context's user (`subject`) is not defined.
    UserMissing,
    /// The cluster has no `server`.
    NoServer,
    /// `server` (`subject`) is not an `https://` or `http://` URL.
    BadServerUrl,
    /// `certificate-authority-data` (or the file) is not a certificate.
    CaUnreadable,
    /// A file the kubeconfig names (`subject`) does not exist.
    FileMissing,
    /// The client certificate is not a certificate.
    ClientCertificateUnreadable,
    /// The client certificate expired (`subject`: when).
    ClientCertificateExpired,
    /// The token (a JWT) expired (`subject`: when).
    TokenExpired,
    /// The exec plugin (`subject`: its file name) is not found.
    ExecNotFound,
    /// TLS is not verified (`insecure-skip-tls-verify`).
    InsecureTls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ValidationProblem {
    pub code: ValidationCode,
    /// What it is about: a name, a file path, a command's file name, a time (RFC 3339).
    pub subject: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// Worth knowing, but the context may still work.
    pub warning: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextValidation {
    pub context: String,
    pub server: Option<String>,
    pub problems: Vec<ValidationProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KubeconfigValidation {
    /// Problems of the whole file.
    pub problems: Vec<ValidationProblem>,
    pub contexts: Vec<ContextValidation>,
}

fn problem(code: ValidationCode, subject: Option<String>) -> ValidationProblem {
    ValidationProblem {
        code,
        subject,
        line: None,
        column: None,
        warning: matches!(code, ValidationCode::InsecureTls),
    }
}

/// Reads the input as kube does (relative file paths of a file resolved against its directory). The error names no
/// value.
fn read(input: &KubeconfigInput) -> Result<Kubeconfig, ValidationProblem> {
    let text = match input {
        // A regular file of at most the cap: a FIFO, a device or a huge file is never read.
        KubeconfigInput::File { path } => read_capped(path, MAX_TEXT_BYTES as u64)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| problem(ValidationCode::Unreadable, Some(path.display().to_string())))?,
        KubeconfigInput::Text { text } => {
            if text.len() > MAX_TEXT_BYTES {
                return Err(problem(ValidationCode::Unreadable, None));
            }
            text.clone()
        }
    };
    let mut doc = match serde_yaml::from_str::<serde_yaml::Value>(&text) {
        Ok(doc) => doc,
        Err(err) => {
            let mut p = problem(ValidationCode::NotYaml, None);
            if let Some(loc) = err.location() {
                p.line = u32::try_from(loc.line()).ok();
                p.column = u32::try_from(loc.column()).ok();
            }
            return Err(p);
        }
    };
    // The text read once is what is checked (the file is not read again): its relative paths resolved against the
    // file's directory, as kube and kubectl do.
    if let KubeconfigInput::File { path } = input
        && let Some(dir) = path.parent()
        && doc.is_mapping()
    {
        absolutize_paths(&mut doc, dir);
        let resolved = serde_yaml::to_string(&doc)
            .map_err(|_| problem(ValidationCode::NotKubeconfig, None))?;
        return Kubeconfig::from_yaml(&resolved)
            .map_err(|_| problem(ValidationCode::NotKubeconfig, None));
    }
    Kubeconfig::from_yaml(&text).map_err(|_| problem(ValidationCode::NotKubeconfig, None))
}

/// Checks a kubeconfig being added. `path_var` is the `PATH` exec plugins are looked up in.
pub fn validate(input: &KubeconfigInput, path_var: Option<&OsStr>) -> KubeconfigValidation {
    let mut out = KubeconfigValidation {
        problems: Vec::new(),
        contexts: Vec::new(),
    };
    let config = match read(input) {
        Ok(config) => config,
        Err(p) => {
            out.problems.push(p);
            return out;
        }
    };
    if config.contexts.is_empty() {
        out.problems.push(problem(ValidationCode::NoContexts, None));
    }
    if let Some(current) = config.current_context.as_deref().filter(|c| !c.is_empty())
        && !config.contexts.iter().any(|c| c.name == current)
    {
        out.problems.push(problem(
            ValidationCode::CurrentContextMissing,
            Some(current.to_owned()),
        ));
    }
    let base_dir = match input {
        KubeconfigInput::File { path } => path.parent().map(Path::to_path_buf),
        KubeconfigInput::Text { .. } => None,
    };
    let now = Timestamp::now().to_string();
    for named in &config.contexts {
        out.contexts.push(check_context(
            &config,
            &named.name,
            base_dir.as_deref(),
            path_var,
            &now,
        ));
    }
    out
}

fn check_context(
    config: &Kubeconfig,
    name: &str,
    base_dir: Option<&Path>,
    path_var: Option<&OsStr>,
    now: &str,
) -> ContextValidation {
    let mut problems = Vec::new();
    let ctx = config
        .contexts
        .iter()
        .find(|c| c.name == name)
        .and_then(|c| c.context.clone())
        .unwrap_or_default();
    let cluster = config
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .and_then(|c| c.cluster.clone());
    let mut server = None;
    match &cluster {
        None => problems.push(problem(
            ValidationCode::ClusterMissing,
            Some(ctx.cluster.clone()),
        )),
        Some(cluster) => {
            server = cluster.server.clone();
            match cluster.server.as_deref().map(str::trim) {
                None | Some("") => problems.push(problem(ValidationCode::NoServer, None)),
                Some(url) if !server_url_ok(url) => {
                    problems.push(problem(ValidationCode::BadServerUrl, Some(url.to_owned())))
                }
                Some(_) => {}
            }
            if cluster.insecure_skip_tls_verify == Some(true) {
                problems.push(problem(ValidationCode::InsecureTls, None));
            }
            match (
                &cluster.certificate_authority_data,
                &cluster.certificate_authority,
            ) {
                (Some(data), _) => {
                    let ok = base64::engine::general_purpose::STANDARD
                        .decode(data.trim())
                        .ok()
                        .is_some_and(|bytes| {
                            crate::tls::parse_certificates(&bytes, "the CA").is_ok()
                        });
                    if !ok {
                        problems.push(problem(ValidationCode::CaUnreadable, None));
                    }
                }
                (None, Some(file)) => match read_capped(Path::new(file), MAX_CREDENTIAL_FILE) {
                    None => problems.push(problem(ValidationCode::FileMissing, Some(file.clone()))),
                    Some(bytes) => {
                        if crate::tls::parse_certificates(&bytes, "the CA").is_err() {
                            problems.push(problem(ValidationCode::CaUnreadable, None));
                        }
                    }
                },
                (None, None) => {}
            }
        }
    }

    let user_name = ctx.user.clone().unwrap_or_default();
    let user = config
        .auth_infos
        .iter()
        .find(|u| u.name == user_name)
        .and_then(|u| u.auth_info.clone());
    match &user {
        None if ctx.user.is_some() => {
            problems.push(problem(ValidationCode::UserMissing, Some(user_name)));
        }
        None => {}
        Some(user) => {
            for file in [&user.client_key, &user.token_file].into_iter().flatten() {
                if !Path::new(file).is_file() {
                    problems.push(problem(ValidationCode::FileMissing, Some(file.clone())));
                }
            }
            if let Some(exec) = &user.exec
                && let Some(command) = exec.command.as_deref()
                && find_command(command, base_dir, path_var).is_none()
            {
                let shown = Path::new(command)
                    .file_name()
                    .map_or_else(|| command.to_owned(), |n| n.to_string_lossy().into_owned());
                problems.push(problem(ValidationCode::ExecNotFound, Some(shown)));
            }
            let expiry = expiry_of(ClusterId::from(""), &single_context(config, name));
            match (expiry.kind, expiry.problem, expiry.expires_at) {
                (CredentialKind::ClientCertificate, Some(CredentialProblem::FileUnreadable), _) => {
                    problems.push(problem(
                        ValidationCode::FileMissing,
                        user.client_certificate.clone(),
                    ));
                }
                (
                    CredentialKind::ClientCertificate,
                    Some(CredentialProblem::NotACertificate),
                    _,
                ) => {
                    problems.push(problem(ValidationCode::ClientCertificateUnreadable, None));
                }
                (CredentialKind::ClientCertificate, None, Some(at)) if at.as_str() < now => {
                    problems.push(problem(ValidationCode::ClientCertificateExpired, Some(at)));
                }
                (CredentialKind::Token | CredentialKind::OidcToken, None, Some(at))
                    if at.as_str() < now && !expiry.refreshable =>
                {
                    problems.push(problem(ValidationCode::TokenExpired, Some(at)));
                }
                _ => {}
            }
        }
    }
    ContextValidation {
        context: name.to_owned(),
        server,
        problems,
    }
}

/// `https://host[:port][/path]` or `http://…`.
fn server_url_ok(url: &str) -> bool {
    url.parse::<http::Uri>().is_ok_and(|uri| {
        matches!(uri.scheme_str(), Some("https" | "http"))
            && uri.host().is_some_and(|h| !h.is_empty())
    })
}

/// Where the exec plugin `command` would be found: a path (relative ones against the kubeconfig's directory, as
/// kubectl does), else in `path_var`. Nothing is run.
pub fn find_command(
    command: &str,
    base_dir: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Option<PathBuf> {
    let as_path = Path::new(command);
    if as_path.components().count() > 1 || as_path.is_absolute() {
        let full = match (as_path.is_relative(), base_dir) {
            (true, Some(dir)) => dir.join(as_path),
            _ => as_path.to_path_buf(),
        };
        return is_executable(&full).then_some(full);
    }
    let names: Vec<String> = if cfg!(windows) {
        ["", ".exe", ".cmd", ".bat"]
            .iter()
            .map(|ext| format!("{command}{ext}"))
            .collect()
    } else {
        vec![command.to_owned()]
    };
    std::env::split_paths(path_var?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The one-context kubeconfig of `context` of the input, for a connection test ([`crate::cluster::check_connection`]).
pub fn connection_kubeconfig(input: &KubeconfigInput, context: &str) -> CoreResult<Kubeconfig> {
    let config = read(input)
        .map_err(|_| CoreError::new(ErrorCode::Kubeconfig, "the kubeconfig cannot be read"))?;
    if !config.contexts.iter().any(|c| c.name == context) {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("the kubeconfig has no context {context:?}"),
        ));
    }
    Ok(single_context(&config, context))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(yaml: &str) -> KubeconfigInput {
        KubeconfigInput::Text {
            text: yaml.to_owned(),
        }
    }

    fn codes(v: &ContextValidation) -> Vec<ValidationCode> {
        v.problems.iter().map(|p| p.code).collect()
    }

    #[test]
    fn a_huge_file_a_folder_or_a_huge_ca_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let huge = dir.path().join("huge.yaml");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(MAX_TEXT_BYTES as u64 + 1).unwrap();
        for path in [huge, dir.path().to_path_buf()] {
            let v = validate(&KubeconfigInput::File { path }, None);
            assert_eq!(v.problems[0].code, ValidationCode::Unreadable, "{v:?}");
        }
        // A CA file over the cap (relative: resolved against the kubeconfig's directory) is not read either.
        let ca = dir.path().join("ca.crt");
        std::fs::File::create(&ca)
            .unwrap()
            .set_len(MAX_CREDENTIAL_FILE + 1)
            .unwrap();
        let config = dir.path().join("config");
        std::fs::write(
            &config,
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c:6443, certificate-authority: ca.crt }\nusers:\n  - name: u\n    user: { token: abc }\ncontexts:\n  - name: x\n    context: { cluster: c, user: u }\n",
        )
        .unwrap();
        let v = validate(&KubeconfigInput::File { path: config }, None);
        let problem = &v.contexts[0].problems[0];
        assert_eq!(problem.code, ValidationCode::FileMissing, "{v:?}");
        assert_eq!(problem.subject.as_deref(), ca.to_str());
    }

    #[test]
    fn a_good_kubeconfig_has_no_problems() {
        let v = validate(
            &text(
                "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c.example:6443 }\nusers:\n  - name: u\n    user: { token: abc }\ncontexts:\n  - name: x\n    context: { cluster: c, user: u }\ncurrent-context: x\n",
            ),
            None,
        );
        assert!(v.problems.is_empty(), "{v:?}");
        assert_eq!(v.contexts.len(), 1);
        assert!(v.contexts[0].problems.is_empty(), "{v:?}");
        assert_eq!(
            v.contexts[0].server.as_deref(),
            Some("https://c.example:6443")
        );
    }

    #[test]
    fn broken_yaml_gives_its_position_and_never_the_text() {
        let v = validate(
            &text("users:\n  - name: u\n    user:\n      token: s3cret\n  bad: [\n"),
            None,
        );
        assert_eq!(v.problems[0].code, ValidationCode::NotYaml);
        assert!(v.problems[0].line.is_some());
        assert!(!serde_json::to_string(&v).unwrap().contains("s3cret"));
    }

    #[test]
    fn every_problem_of_a_context_is_listed_in_plain_codes() {
        let dir = tempfile::tempdir().unwrap();
        let yaml = format!(
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: not a url\n      certificate-authority-data: Y2E=\n      insecure-skip-tls-verify: true\n  - name: d\n    cluster: {{ certificate-authority: {missing} }}\nusers:\n  - name: u\n    user:\n      exec:\n        apiVersion: client.authentication.k8s.io/v1beta1\n        command: sextant-no-such-plugin\n        args: [--token, s3cret]\n      client-key: {missing}\ncontexts:\n  - name: x\n    context: {{ cluster: c, user: u }}\n  - name: y\n    context: {{ cluster: gone, user: nobody }}\n  - name: z\n    context: {{ cluster: d, user: u }}\ncurrent-context: w\n",
            missing = dir
                .path()
                .join("missing.pem")
                .display()
                .to_string()
                .replace('\\', "/"),
        );
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        let v = validate(&text(&yaml), Some(&path_var));
        assert_eq!(v.problems[0].code, ValidationCode::CurrentContextMissing);
        assert_eq!(v.problems[0].subject.as_deref(), Some("w"));
        let x = &v.contexts[0];
        for code in [
            ValidationCode::BadServerUrl,
            ValidationCode::CaUnreadable,
            ValidationCode::InsecureTls,
            ValidationCode::FileMissing,
            ValidationCode::ExecNotFound,
        ] {
            assert!(codes(x).contains(&code), "{code:?} in {x:?}");
        }
        assert_eq!(
            codes(&v.contexts[1]),
            [ValidationCode::ClusterMissing, ValidationCode::UserMissing]
        );
        assert!(codes(&v.contexts[2]).contains(&ValidationCode::NoServer));
        assert!(codes(&v.contexts[2]).contains(&ValidationCode::FileMissing));
        assert!(!serde_json::to_string(&v).unwrap().contains("s3cret"));
    }

    #[cfg(unix)]
    #[test]
    fn an_exec_plugin_in_path_is_found_without_running_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let plugin = dir.path().join("my-plugin");
        std::fs::write(&plugin, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            find_command("my-plugin", None, Some(&path_var)),
            Some(plugin.clone())
        );
        assert_eq!(find_command("other", None, Some(&path_var)), None);
        assert_eq!(
            find_command("./my-plugin", Some(dir.path()), None),
            Some(dir.path().join("./my-plugin"))
        );
        assert!(!marker.exists(), "the plugin was never started");
    }

    #[test]
    fn a_connection_kubeconfig_holds_only_the_asked_context() {
        let input = text(
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: https://c:6443 }\ncontexts:\n  - name: x\n    context: { cluster: c }\n  - name: y\n    context: { cluster: c }\n",
        );
        let kc = connection_kubeconfig(&input, "y").unwrap();
        assert_eq!(kc.current_context.as_deref(), Some("y"));
        assert_eq!(kc.contexts.len(), 1);
        assert_eq!(
            connection_kubeconfig(&input, "nope").unwrap_err().code,
            ErrorCode::NotFound
        );
    }
}
