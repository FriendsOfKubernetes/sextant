//! The user's Docker credentials, read only when the settings allow it (`imageFiles.dockerCredentials`, off by
//! default; ADR-0103): `$DOCKER_CONFIG/config.json` or `~/.docker/config.json` — `credHelpers`, then `auths`, then
//! `credsStore`. A credential helper is the program `docker-credential-<name>` found in `PATH`, run without a shell,
//! with the cloud CLIs' cleaned environment, the server on stdin, a time limit and a bounded output.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::auth::{Credential, DockerConfig, parse_helper_output};
use super::limits;
use super::reference::DOCKER_HUB;
use crate::cloud::CloudCli;
use crate::{CoreError, CoreResult, ErrorCode};

/// Where the user's Docker config is: `$DOCKER_CONFIG/config.json`, else `~/.docker/config.json`.
pub fn default_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DOCKER_CONFIG").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("config.json"));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".docker").join("config.json"))
}

/// The credentials the Docker config at `path` gives `registry` (a registry key), running a helper through `cli`'s
/// `PATH` and environment when one is named. A missing file is `None`; a helper that has nothing is `None`.
pub async fn docker_credential(
    path: &Path,
    cli: &CloudCli,
    registry: &str,
) -> CoreResult<Option<Credential>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(CoreError::other(format!(
                "cannot read the Docker config: {}",
                err.kind()
            )));
        }
    };
    let config = DockerConfig::parse(&bytes)?;
    if let Some(helper) = config.helper_for(registry) {
        return run_helper(cli, helper, registry).await;
    }
    if let Some(credential) = config.auth_for(registry) {
        return Ok(Some(credential));
    }
    match config.store() {
        Some(store) => run_helper(cli, store, registry).await,
        None => Ok(None),
    }
}

/// The server name a helper is asked about: Docker Hub's legacy URL, else the registry itself.
fn helper_server(registry: &str) -> String {
    if registry == DOCKER_HUB {
        "https://index.docker.io/v1/".to_owned()
    } else {
        registry.to_owned()
    }
}

async fn run_helper(cli: &CloudCli, name: &str, registry: &str) -> CoreResult<Option<Credential>> {
    let program = format!("docker-credential-{name}");
    let Some(binary) = cli.which(&program) else {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("the Docker credential helper {program} is not installed"),
        ));
    };
    let env = cli.child_env();
    let server = helper_server(registry);
    let output = tokio::task::spawn_blocking(move || {
        run_bounded(&binary, &env, &server, limits::HELPER_TIMEOUT)
    })
    .await
    .map_err(|e| CoreError::other(format!("{program} failed: {e}")))?;
    match output {
        Ok(Some(stdout)) => Ok(parse_helper_output(&stdout)),
        // A non-zero exit is the helper's "no credentials for this server".
        Ok(None) => Ok(None),
        Err(HelperError::Timeout) => Err(CoreError::new(
            ErrorCode::Timeout,
            format!(
                "{program} did not answer in {} s",
                limits::HELPER_TIMEOUT.as_secs()
            ),
        )),
        Err(HelperError::Io(kind)) => {
            Err(CoreError::other(format!("cannot run {program}: {kind}")))
        }
    }
}

enum HelperError {
    Timeout,
    Io(std::io::ErrorKind),
}

/// Runs `binary get` with `server` on stdin; its stdout (≤ [`limits::MAX_HELPER_OUTPUT`]) on success, `None` on a
/// non-zero exit. Its stderr is dropped (it may echo the secret).
fn run_bounded(
    binary: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    server: &str,
    timeout: Duration,
) -> Result<Option<Vec<u8>>, HelperError> {
    let mut child = Command::new(binary)
        .arg("get")
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| HelperError::Io(e.kind()))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(server.as_bytes());
    }
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(stdout) = stdout.as_mut() {
            let _ = stdout
                .take(limits::MAX_HELPER_OUTPUT as u64 + 1)
                .read_to_end(&mut out);
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HelperError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(HelperError::Io(e.kind())),
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() || out.len() > limits::MAX_HELPER_OUTPUT {
        return Ok(None);
    }
    Ok(Some(out))
}
