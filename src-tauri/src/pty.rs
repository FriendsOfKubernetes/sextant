//! Local shell in a pseudo-terminal (`portable-pty`): the user's `$SHELL` on Unix, PowerShell on Windows,
//! with `KUBECONFIG` pointing at a temporary single-context kubeconfig.
//!
//! [`spawn_shell`] returns the same handles as a container shell ([`ExecSession`]), so both kinds of terminal share
//! the `term:<id>` events and `term_*` commands. Dropping the session's `input` hangs up the shell.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use sextant_core::CoreError;
use sextant_core::exec::{ExecSession, TermEvent};
use tokio::sync::mpsc;

/// The operating-system family that decides which shell to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// A program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
}

/// Fallback on Unix when `$SHELL` is unset or unusable.
pub const UNIX_FALLBACK_SHELL: &str = "/bin/sh";
/// The shell on Windows (Windows PowerShell ships with every supported Windows).
pub const WINDOWS_SHELL: &str = "powershell.exe";

/// The shell to start on `platform`.
///
/// Unix: `$SHELL` (`env_shell`) when it is an absolute path to an executable, otherwise `/bin/sh`; started as a login
/// shell (`-l`) so the user's profile sets `PATH` (on macOS an app launched from the Dock has a minimal one).
/// Windows: PowerShell without its banner.
pub fn shell_for(
    platform: Platform,
    env_shell: Option<&OsStr>,
    is_executable: impl Fn(&Path) -> bool,
) -> ShellCommand {
    match platform {
        Platform::Windows => ShellCommand {
            program: WINDOWS_SHELL.into(),
            args: vec!["-NoLogo".into()],
        },
        Platform::Unix => {
            let program = env_shell
                .filter(|s| !s.is_empty())
                .filter(|s| is_unix_absolute(s) && is_executable(Path::new(s)))
                .map(|s| s.to_owned())
                .unwrap_or_else(|| UNIX_FALLBACK_SHELL.into());
            ShellCommand {
                program,
                args: vec!["-l".into()],
            }
        }
    }
}

/// Whether `path` is absolute by Unix rules (starts with `/`), whatever OS this is built for: `Path::is_absolute`
/// follows the host, so on Windows it rejects `/usr/bin/zsh`.
fn is_unix_absolute(path: &OsStr) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_bytes().first() == Some(&b'/')
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().starts_with('/')
    }
}

/// The user's shell on this machine.
pub fn user_shell() -> ShellCommand {
    shell_for(
        Platform::current(),
        std::env::var_os("SHELL").as_deref(),
        is_executable,
    )
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

const CHANNEL_SIZE: usize = 256;
const READ_BUF: usize = 16 * 1024;

/// Starts `command` in a new `cols`×`rows` pseudo-terminal with `env` added to this process's environment
/// (plus `TERM=xterm-256color`). Output arrives on `output` and ends with `Exit` once the shell exits.
pub fn spawn_shell(
    command: &ShellCommand,
    env: &[(&str, &OsStr)],
    cols: u16,
    rows: u16,
) -> Result<ExecSession, CoreError> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| CoreError::other(format!("cannot open a terminal: {e}")))?;
    let mut cmd = CommandBuilder::new(&command.program);
    cmd.args(&command.args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (key, value) in env {
        cmd.env(key, value);
    }
    // The error names the program only, never the environment (which carries the kubeconfig path).
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        CoreError::other(format!(
            "cannot start {}: {e}",
            Path::new(&command.program).display()
        ))
    })?;
    // The shell holds the slave side now; ours would keep the terminal open after it exits.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let mut writer = pair.master.take_writer().map_err(pty_error)?;
    let mut killer = child.clone_killer();
    let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(Mutex::new(Some(pair.master)));

    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_SIZE);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);
    let (output_tx, output_rx) = mpsc::channel::<TermEvent>(CHANNEL_SIZE);
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();

    // Keystrokes. When the session is dropped the shell is hung up.
    std::thread::Builder::new()
        .name("pty-input".into())
        .spawn(move || {
            while let Some(keys) = input_rx.blocking_recv() {
                if writer
                    .write_all(&keys)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
            let _ = killer.kill();
        })
        .map_err(pty_error)?;

    // Resizes; owns the master side until the session is dropped.
    let resize_master = Arc::clone(&master);
    std::thread::Builder::new()
        .name("pty-resize".into())
        .spawn(move || {
            while let Some((cols, rows)) = resize_rx.blocking_recv() {
                if let Some(master) = lock(&resize_master).as_ref() {
                    let _ = master.resize(size(cols, rows));
                }
            }
            lock(&resize_master).take();
        })
        .map_err(pty_error)?;

    // Exit status.
    let wait_master = Arc::clone(&master);
    std::thread::Builder::new()
        .name("pty-wait".into())
        .spawn(move || {
            let code = child
                .wait()
                .ok()
                .map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            let _ = exit_tx.send(code);
            // ConPTY keeps the output pipe open after the shell exits until the pseudo-console is closed.
            if cfg!(windows) {
                lock(&wait_master).take();
            }
        })
        .map_err(pty_error)?;

    // Output, then the exit code once the shell side is closed.
    std::thread::Builder::new()
        .name("pty-output".into())
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if output_tx
                            .blocking_send(TermEvent::Data(buf[..n].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            let code = exit_rx.recv().ok().flatten();
            let _ = output_tx.blocking_send(TermEvent::Exit { code });
        })
        .map_err(pty_error)?;

    Ok(ExecSession {
        input: input_tx,
        resize: resize_tx,
        output: output_rx,
    })
}

fn pty_error(e: impl std::fmt::Display) -> CoreError {
    CoreError::other(format!("terminal: {e}"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    use super::*;

    fn shell(program: &str, args: &[&str]) -> ShellCommand {
        ShellCommand {
            program: program.into(),
            args: args.iter().map(OsString::from).collect(),
        }
    }

    #[test]
    fn unix_uses_shell_from_the_environment_as_a_login_shell() {
        let picked = shell_for(Platform::Unix, Some(OsStr::new("/usr/bin/zsh")), |_| true);
        assert_eq!(picked, shell("/usr/bin/zsh", &["-l"]));
    }

    #[test]
    fn unix_falls_back_to_sh_without_a_usable_shell_variable() {
        let fallback = shell("/bin/sh", &["-l"]);
        assert_eq!(shell_for(Platform::Unix, None, |_| true), fallback);
        assert_eq!(
            shell_for(Platform::Unix, Some(OsStr::new("")), |_| true),
            fallback
        );
        // Not executable / missing.
        assert_eq!(
            shell_for(Platform::Unix, Some(OsStr::new("/opt/gone/fish")), |_| {
                false
            }),
            fallback
        );
        // A relative name is not resolved against the app's working directory.
        assert_eq!(
            shell_for(Platform::Unix, Some(OsStr::new("bash")), |_| true),
            fallback
        );
    }

    #[test]
    fn windows_uses_powershell_whatever_shell_says() {
        let expected = shell("powershell.exe", &["-NoLogo"]);
        assert_eq!(shell_for(Platform::Windows, None, |_| true), expected);
        assert_eq!(
            shell_for(Platform::Windows, Some(OsStr::new("/bin/bash")), |_| true),
            expected
        );
    }

    #[test]
    fn current_platform_matches_the_build() {
        assert_eq!(Platform::current() == Platform::Windows, cfg!(windows));
    }

    /// Collects output until `done` holds or the shell exits.
    #[cfg(unix)]
    fn read_until(
        session: &mut ExecSession,
        done: impl Fn(&str) -> bool,
    ) -> (String, Option<Option<i32>>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut text = String::new();
        while Instant::now() < deadline {
            match session.output.try_recv() {
                Ok(TermEvent::Data(bytes)) => {
                    text.push_str(&String::from_utf8_lossy(&bytes));
                    if done(&text) {
                        return (text, None);
                    }
                }
                Ok(TermEvent::Exit { code }) => return (text, Some(code)),
                Ok(TermEvent::Error(e)) => panic!("terminal error: {e}"),
                Err(mpsc::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(mpsc::error::TryRecvError::Disconnected) => panic!("output closed: {text:?}"),
            }
        }
        panic!("timed out: {text:?}");
    }

    #[cfg(unix)]
    #[test]
    fn shell_gets_the_environment_follows_resize_and_reports_its_exit_code() {
        let mut session = spawn_shell(
            &shell("/bin/sh", &[]),
            &[("SEXTANT_PTY_TEST", OsStr::new("hello-pty"))],
            80,
            24,
        )
        .unwrap();
        session
            .input
            .blocking_send(b"echo \"v=$SEXTANT_PTY_TEST t=$TERM\"; stty size\n".to_vec())
            .unwrap();
        let (text, exit) = read_until(&mut session, |t| {
            t.contains("v=hello-pty t=xterm-256color") && t.contains("24 80")
        });
        assert_eq!(exit, None, "{text}");

        session.resize.blocking_send((100, 30)).unwrap();
        session
            .input
            .blocking_send(b"stty size\n".to_vec())
            .unwrap();
        let (text, exit) = read_until(&mut session, |t| t.contains("30 100"));
        assert_eq!(exit, None, "{text}");

        session.input.blocking_send(b"exit 7\n".to_vec()).unwrap();
        let (_, exit) = read_until(&mut session, |_| false);
        assert_eq!(exit, Some(Some(7)));
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_session_hangs_up_the_shell() {
        let mut session = spawn_shell(&shell("/bin/sh", &[]), &[], 80, 24).unwrap();
        session
            .input
            .blocking_send(b"echo \"pid=$$ ok\"\n".to_vec())
            .unwrap();
        // The echoed command line shows `$$`; the output shows the number.
        let pid_in = |t: &str| {
            t.match_indices("pid=")
                .map(|(i, _)| &t[i + 4..])
                .filter_map(|rest| rest.split_once(" ok"))
                .map(|(digits, _)| digits.to_owned())
                .find(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
        };
        let (text, _) = read_until(&mut session, |t| pid_in(t).is_some());
        let pid = pid_in(&text).unwrap();
        drop(session);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !is_gone_or_zombie(&pid) {
            assert!(Instant::now() < deadline, "shell {pid} is still running");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// No such process, or only an unreaped zombie. `ps` instead of `/proc`, which macOS does not have.
    #[cfg(unix)]
    fn is_gone_or_zombie(pid: &str) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .expect("run ps");
        let stat = String::from_utf8_lossy(&out.stdout);
        let stat = stat.trim();
        stat.is_empty() || stat.starts_with('Z')
    }

    #[test]
    fn a_missing_program_is_an_error_without_the_environment() {
        let err = spawn_shell(
            &shell("/nonexistent/sextant-shell", &[]),
            &[("KUBECONFIG", OsStr::new("/tmp/secret-path.yaml"))],
            80,
            24,
        )
        .err()
        .expect("no such program");
        assert!(err.message.contains("sextant-shell"), "{err}");
        assert!(!err.message.contains("secret-path"), "{err}");
    }
}
