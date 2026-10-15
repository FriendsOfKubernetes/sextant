//! Local shell in a pseudo-terminal (`portable-pty`): the user's `$SHELL` on Unix, PowerShell on Windows,
//! with `KUBECONFIG` pointing at a temporary single-context kubeconfig — kept after the user's startup files where the
//! shell allows it ([`ShellKind`]) — and without the app's own `KUBECONFIG`, Helm overrides and AppImage variables
//! ([`shell_environment`]).
//!
//! [`spawn_local_shell`] gives the same handles as a container shell ([`ExecSession`]), so both kinds of terminal
//! share the `term:<id>` events and `term_*` commands. Dropping the session's `input` hangs up the shell.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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

/// Starts `command` in a new `cols`×`rows` pseudo-terminal with `env` added to this process's environment (less what
/// a shell must not inherit, [`shell_environment`]) and `TERM=xterm-256color`. Output arrives on `output` and ends
/// with `Exit` once the shell exits. A local terminal is started with [`spawn_local_shell`].
pub fn spawn_shell(
    command: &ShellCommand,
    env: &[(&str, &OsStr)],
    cols: u16,
    rows: u16,
) -> Result<ExecSession, CoreError> {
    let platform = Platform::current();
    let mut vars = shell_environment(platform, std::env::vars_os());
    for (key, value) in env {
        set_var(platform, &mut vars, key, value);
    }
    spawn(command, vars, cols, rows, None)
}

/// How a local shell is made to keep the session's `KUBECONFIG` after the user's startup files, which may export
/// their own (`export KUBECONFIG=…` in `~/.zshrc`): bash reads an rc file ([`StartupFiles`]) that sources the user's
/// files and then sets it again; zsh's wrapper `.zshenv` hands the rest of startup back to the user's `ZDOTDIR` and sets
/// it in a one-time `precmd` hook — unless `/etc/zshenv` sets a `ZDOTDIR` of its own, which bypasses the wrapper, and
/// such a zsh is treated as an other shell; fish sets it in `--init-command`, which runs after its config. Other
/// shells (sh, PowerShell, …) only get it in the environment, and their terminal starts with the
/// [`KUBECONFIG_NOTICE`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    Other,
}

impl ShellKind {
    /// By the program's file name (case and `.exe` ignored).
    pub fn of(program: &OsStr) -> Self {
        let name = Path::new(program)
            .file_name()
            .unwrap_or(program)
            .to_string_lossy()
            .to_ascii_lowercase();
        match name.strip_suffix(".exe").unwrap_or(&name) {
            "bash" => Self::Bash,
            "zsh" => Self::Zsh,
            "fish" => Self::Fish,
            _ => Self::Other,
        }
    }
}

/// A local shell: the session's handles and the startup files that must live exactly as long as it (the caller keeps
/// them with the session and drops them when it is stopped).
pub struct LocalShell {
    pub session: ExecSession,
    pub startup_files: Option<StartupFiles>,
}

impl From<ExecSession> for LocalShell {
    fn from(session: ExecSession) -> Self {
        Self {
            session,
            startup_files: None,
        }
    }
}

/// Name prefix of the [`StartupFiles`] directories.
pub const STARTUP_FILES_PREFIX: &str = "sextant-shell-";

/// A temporary directory (0700) with a shell's startup files (each 0600); dropping it removes it. The files hold the
/// path of the session's kubeconfig, never its contents.
#[derive(Debug)]
pub struct StartupFiles {
    dir: PathBuf,
}

impl StartupFiles {
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// A new empty directory in `parent`. `create_dir` fails on an existing name (or a planted link), so a taken
    /// name is retried and nothing someone else prepared is ever used.
    fn create(parent: &Path) -> std::io::Result<Self> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        for _ in 0..16 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let dir = parent.join(format!(
                "{STARTUP_FILES_PREFIX}{}-{}-{nanos:08x}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match create_private_dir(&dir) {
                Ok(()) => return Ok(Self { dir }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free name for a temporary directory",
        ))
    }

    /// Writes a new file `name` (0600) and returns its path.
    fn write(&self, name: &str, contents: &[u8]) -> std::io::Result<PathBuf> {
        let path = self.dir.join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?.write_all(contents)?;
        Ok(path)
    }
}

impl Drop for StartupFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    // The user's temp directory is private to the user on Windows.
    std::fs::create_dir(dir)
}

/// A local terminal whose shell's profile may still override `KUBECONFIG` ([`ShellKind::Other`]) starts with the
/// private OSC sequence `ESC ] 7719 ; kubeconfig-not-pinned BEL`. The window shows a notice for it
/// (`src/features/terminal`); terminals ignore OSC sequences they do not know.
pub const KUBECONFIG_NOTICE_OSC: u16 = 7719;
/// The data of the [`KUBECONFIG_NOTICE_OSC`] sequence.
pub const KUBECONFIG_NOTICE: &str = "kubeconfig-not-pinned";

fn kubeconfig_notice() -> Vec<u8> {
    format!("\x1b]{KUBECONFIG_NOTICE_OSC};{KUBECONFIG_NOTICE}\x07").into_bytes()
}

/// The environment a local shell gets from `base` (this process's environment): without `KUBECONFIG` (the session
/// sets its own), the Helm overrides `HELM_KUBE*`, `HELM_NAMESPACE` and `HELM_DRIVER` (they would point `helm` at
/// another cluster or namespace) and — when the app runs from an AppImage (`APPIMAGE` and `APPDIR` set) — the
/// AppImage's own variables and every path into the mounted image (`PATH`, `LD_LIBRARY_PATH`, …; a variable left
/// with no other path goes too). Names compare case-insensitively on Windows.
pub fn shell_environment(
    platform: Platform,
    base: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let base: Vec<(OsString, OsString)> = base
        .into_iter()
        .filter(|(name, _)| !is_cluster_override(platform, name))
        .collect();
    let value = |wanted: &str| {
        base.iter()
            .find(|(name, _)| same_name(platform, name, wanted))
            .map(|(_, value)| value)
            .filter(|value| !value.is_empty())
    };
    let appdir = value("APPIMAGE")
        .and(value("APPDIR"))
        .and_then(|dir| dir.to_str())
        .map(|dir| dir.trim_end_matches(['/', '\\']).to_owned())
        .filter(|dir| !dir.is_empty());
    let Some(appdir) = appdir else {
        return base;
    };
    base.into_iter()
        .filter(|(name, _)| !is_appimage_variable(platform, name))
        .filter_map(|(name, value)| {
            without_paths_under(platform, &appdir, value).map(|value| (name, value))
        })
        .collect()
}

fn is_cluster_override(platform: Platform, name: &OsStr) -> bool {
    ["KUBECONFIG", "HELM_NAMESPACE", "HELM_DRIVER"]
        .iter()
        .any(|wanted| same_name(platform, name, wanted))
        || name_starts_with(platform, name, "HELM_KUBE")
}

/// What the AppImage runtime sets for the app itself.
fn is_appimage_variable(platform: Platform, name: &OsStr) -> bool {
    ["APPIMAGE", "APPDIR", "OWD", "ARGV0"]
        .iter()
        .any(|wanted| same_name(platform, name, wanted))
        || name_starts_with(platform, name, "APPIMAGE_")
}

/// `value` without the entries of its path list that lie in `dir`; `None` when nothing but empty entries is left.
/// A value without such entries (or not UTF-8) is returned as is.
fn without_paths_under(platform: Platform, dir: &str, value: OsString) -> Option<OsString> {
    let Some(text) = value.to_str() else {
        return Some(value);
    };
    let separator = match platform {
        Platform::Unix => ':',
        Platform::Windows => ';',
    };
    let inside = |entry: &str| {
        entry == dir
            || entry
                .strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with(['/', '\\']))
    };
    if !text.split(separator).any(inside) {
        return Some(value);
    }
    let kept: Vec<&str> = text.split(separator).filter(|e| !inside(e)).collect();
    if kept.iter().all(|e| e.is_empty()) {
        None
    } else {
        Some(kept.join(&separator.to_string()).into())
    }
}

fn same_name(platform: Platform, name: &OsStr, wanted: &str) -> bool {
    match platform {
        Platform::Unix => name == wanted,
        Platform::Windows => name
            .to_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(wanted)),
    }
}

fn name_starts_with(platform: Platform, name: &OsStr, prefix: &str) -> bool {
    match platform {
        Platform::Unix => name.as_encoded_bytes().starts_with(prefix.as_bytes()),
        Platform::Windows => name
            .to_str()
            .and_then(|n| n.get(..prefix.len()))
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix)),
    }
}

/// Sets `name` in `env`, replacing any variable of that name.
fn set_var(platform: Platform, env: &mut Vec<(OsString, OsString)>, name: &str, value: &OsStr) {
    env.retain(|(n, _)| !same_name(platform, n, name));
    env.push((name.into(), value.to_owned()));
}

/// Starts the user's shell (`shell`, see [`user_shell`]) for a local terminal with `KUBECONFIG` set to `kubeconfig`
/// and kept after the user's startup files ([`ShellKind`]), from this process's environment ([`shell_environment`]).
pub fn spawn_local_shell(
    shell: &ShellCommand,
    kubeconfig: &OsStr,
    cols: u16,
    rows: u16,
) -> Result<LocalShell, CoreError> {
    let base: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    spawn_local_shell_with(shell, kubeconfig, &base, &std::env::temp_dir(), cols, rows)
}

/// [`spawn_local_shell`] from `base_env` instead of this process's environment, with the startup files in `temp_dir`.
pub fn spawn_local_shell_with(
    shell: &ShellCommand,
    kubeconfig: &OsStr,
    base_env: &[(OsString, OsString)],
    temp_dir: &Path,
    cols: u16,
    rows: u16,
) -> Result<LocalShell, CoreError> {
    let platform = Platform::current();
    let mut env = shell_environment(platform, base_env.iter().cloned());
    let mut command = shell.clone();
    let mut startup_files = None;
    let mut preamble = None;
    match ShellKind::of(&shell.program) {
        ShellKind::Bash => {
            let user_histfile = env
                .iter()
                .any(|(name, _)| same_name(platform, name, "HISTFILE"));
            let files = StartupFiles::create(temp_dir).map_err(startup_files_error)?;
            let rc = files
                .write("bashrc", &bash_rc(kubeconfig, user_histfile))
                .map_err(startup_files_error)?;
            // `ENV` is expanded before it is read: a path that would change is not used (the files are dropped).
            if rc.to_str().is_some_and(|p| !p.contains(['$', '`', '\\'])) {
                // An interactive bash in POSIX mode reads only `$ENV` (`--rcfile` alone would also run the system
                // bashrc, which `/etc/profile` runs again); the rc file leaves POSIX mode first. Apple's bash 3.2
                // (macOS `/bin/bash`) runs an interactive shell's startup files as if not in POSIX mode
                // (`run_startup_files` shadows `posixly_correct` with 0): it never reads `$ENV`, but `--rcfile`
                // instead of `~/.bashrc` — and has no system bashrc of its own. Any other bash ignores `--rcfile` here.
                command.args = vec![
                    "--posix".into(),
                    "--rcfile".into(),
                    rc.clone().into_os_string(),
                    "-i".into(),
                ];
                set_var(platform, &mut env, "ENV", rc.as_os_str());
                startup_files = Some(files);
            } else {
                preamble = Some(kubeconfig_notice());
            }
        }
        ShellKind::Zsh => {
            let files = StartupFiles::create(temp_dir).map_err(startup_files_error)?;
            let user_zdotdir = env
                .iter()
                .find(|(name, _)| same_name(platform, name, "ZDOTDIR"))
                .map(|(_, value)| value.clone())
                .filter(|value| !value.is_empty());
            let mut wrapped = env.clone();
            set_var(platform, &mut wrapped, "ZDOTDIR", files.path().as_os_str());
            set_var(platform, &mut wrapped, "KUBECONFIG", kubeconfig);
            // `/etc/zshenv` runs first and may set its own `ZDOTDIR`: zsh would then never read the wrapper (#72).
            if probe_zdotdir(&command.program, &wrapped).as_deref()
                == Some(files.path().as_os_str())
            {
                files
                    .write(".zshenv", &zsh_env(user_zdotdir.as_deref(), kubeconfig))
                    .map_err(startup_files_error)?;
                env = wrapped;
                startup_files = Some(files);
            } else {
                // The unused directory is removed here.
                preamble = Some(kubeconfig_notice());
            }
        }
        ShellKind::Fish => {
            command
                .args
                .extend(["--init-command".into(), FISH_INIT_COMMAND.into()]);
            set_var(platform, &mut env, FISH_KUBECONFIG_VAR, kubeconfig);
        }
        ShellKind::Other => preamble = Some(kubeconfig_notice()),
    }
    set_var(platform, &mut env, "KUBECONFIG", kubeconfig);
    // On failure the startup files are dropped (removed) here.
    let session = spawn(&command, env, cols, rows, preamble)?;
    Ok(LocalShell {
        session,
        startup_files,
    })
}

/// What [`probe_zdotdir`] prints before the value; anything `/etc/zshenv` itself prints comes before it.
const ZDOTDIR_PROBE_MARKER: &str = "sextant-zdotdir:";
/// zsh's command for [`probe_zdotdir`].
const ZDOTDIR_PROBE: &str = "print -rn -- \"sextant-zdotdir:$ZDOTDIR\"";
/// How long [`probe_zdotdir`] waits for zsh.
const ZDOTDIR_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The `ZDOTDIR` a zsh (`program`) started with exactly `env` has once `/etc/zshenv` — which zsh always reads first,
/// even with `-f` — has run: `zsh -f -c 'print …'` reads no other startup file. `None` when zsh fails, prints no
/// value or takes longer than [`ZDOTDIR_PROBE_TIMEOUT`] (it is killed then).
fn probe_zdotdir(program: &OsStr, env: &[(OsString, OsString)]) -> Option<OsString> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
        .args(["-f", "-c", ZDOTDIR_PROBE])
        .env_clear()
        .envs(env.iter().map(|(name, value)| (name, value)))
        .envs(TERMINAL_VARS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + ZDOTDIR_PROBE_TIMEOUT;
    // Read on a thread: a process `/etc/zshenv` left behind may hold the pipe open after zsh exits.
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = std::thread::Builder::new()
            .name("zsh-probe".into())
            .spawn(move || {
                let mut out = Vec::new();
                let _ = stdout.read_to_end(&mut out);
                let _ = tx.send(out);
            });
    }
    let out = rx.recv_timeout(ZDOTDIR_PROBE_TIMEOUT).ok();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if out.is_some() && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    if !status?.success() {
        return None;
    }
    let out = out?;
    let marker = ZDOTDIR_PROBE_MARKER.as_bytes();
    let at = out.windows(marker.len()).rposition(|w| w == marker)?;
    let value = out[at + marker.len()..].to_vec();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(OsString::from_vec(value))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(value).ok().map(OsString::from)
    }
}

fn startup_files_error(e: std::io::Error) -> CoreError {
    CoreError::other(format!("cannot write the shell's startup files: {e}"))
}

/// `value` in single quotes for sh-like shells (bash, zsh).
fn sh_quote(value: &OsStr) -> Vec<u8> {
    let mut out = vec![b'\''];
    for &byte in value.as_encoded_bytes() {
        if byte == b'\'' {
            out.extend_from_slice(b"'\\''");
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
    out
}

fn export_kubeconfig(kubeconfig: &OsStr) -> Vec<u8> {
    let mut line = b"export KUBECONFIG=".to_vec();
    line.extend(sh_quote(kubeconfig));
    line.push(b'\n');
    line
}

const STARTUP_FILE_HEADER: &str = "# Written by Sextant for one terminal session and removed with it: runs the user's \
startup files, then sets\n# KUBECONFIG again, so a profile that exports its own does not point kubectl at another \
cluster.\n";

/// The `ENV` file (and `--rcfile`, which Apple's bash 3.2 reads instead) of an interactive bash started in POSIX mode:
/// leaves POSIX mode and undoes what it set before this file was read and `set +o posix` keeps
/// (`HISTFILE=~/.sh_history` — unless the environment chose one, which `user_histfile` tells — and `inherit_errexit`),
/// defines `logout` as `exit` (this bash is not a login shell, so its own `logout` refuses; `~/.bash_logout` is not
/// run), reads what a login bash reads (`/etc/profile` runs the system bashrc where the distribution has one), then sets the
/// session's `KUBECONFIG`. bash loads the history after this file.
fn bash_rc(kubeconfig: &OsStr, user_histfile: bool) -> Vec<u8> {
    let mut rc = STARTUP_FILE_HEADER.as_bytes().to_vec();
    rc.extend_from_slice(
        b"set +o posix\n\
          unset ENV\n\
          shopt -u inherit_errexit 2>/dev/null\n\
          logout() { builtin exit \"$@\"; }\n",
    );
    if !user_histfile {
        rc.extend_from_slice(b"HISTFILE=~/.bash_history\n");
    }
    rc.extend_from_slice(
        b"\
          if [ -r /etc/profile ]; then . /etc/profile; fi\n\
          if [ -r ~/.bash_profile ]; then . ~/.bash_profile\n\
          elif [ -r ~/.bash_login ]; then . ~/.bash_login\n\
          elif [ -r ~/.profile ]; then . ~/.profile\n\
          fi\n",
    );
    rc.extend(export_kubeconfig(kubeconfig));
    rc
}

/// The `.zshenv` of a zsh started with `ZDOTDIR` at the startup files: it points `ZDOTDIR` back at the user's
/// (`user_zdotdir`, else unset — `$HOME`) and sources their `.zshenv`, so zsh reads every later file — the user's and
/// the system's `/etc/zshrc`, which may derive `HISTFILE` or the completion dump from `ZDOTDIR` — as without Sextant.
/// A one-time `precmd` hook sets the session's `KUBECONFIG` once all of them ran, just before the first prompt.
fn zsh_env(user_zdotdir: Option<&OsStr>, kubeconfig: &OsStr) -> Vec<u8> {
    let mut text = STARTUP_FILE_HEADER.as_bytes().to_vec();
    match user_zdotdir {
        Some(user) => {
            text.extend_from_slice(b"ZDOTDIR=");
            text.extend(sh_quote(user));
            text.push(b'\n');
        }
        None => text.extend_from_slice(b"unset ZDOTDIR\n"),
    }
    text.extend_from_slice(
        b"if [[ -r \"${ZDOTDIR:-$HOME}/.zshenv\" ]]; then builtin source \"${ZDOTDIR:-$HOME}/.zshenv\"; fi\n\
          _sextant_kubeconfig() {\n  ",
    );
    text.extend(export_kubeconfig(kubeconfig));
    text.extend_from_slice(
        b"  local -a kept\n\
          \x20 local hook\n\
          \x20 for hook in \"${precmd_functions[@]}\"; do\n\
          \x20   if [[ $hook != _sextant_kubeconfig ]]; then kept+=(\"$hook\"); fi\n\
          \x20 done\n\
          \x20 precmd_functions=(\"${kept[@]}\")\n\
          }\n\
          precmd_functions+=(_sextant_kubeconfig)\n",
    );
    text
}

/// The environment variable that hands fish the session's kubeconfig path (not the command line, which other users
/// can read); [`FISH_INIT_COMMAND`] moves it to `KUBECONFIG`.
const FISH_KUBECONFIG_VAR: &str = "SEXTANT_KUBECONFIG";
/// fish runs `--init-command` after its config files.
const FISH_INIT_COMMAND: &str = "set -gx KUBECONFIG $SEXTANT_KUBECONFIG; set -e SEXTANT_KUBECONFIG";

/// What every shell started here is told about its terminal.
const TERMINAL_VARS: [(&str, &str); 2] = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

/// Starts `command` with exactly `env` (plus [`TERMINAL_VARS`]); `preamble` is the session's first output.
fn spawn(
    command: &ShellCommand,
    env: Vec<(OsString, OsString)>,
    cols: u16,
    rows: u16,
    preamble: Option<Vec<u8>>,
) -> Result<ExecSession, CoreError> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| CoreError::other(format!("cannot open a terminal: {e}")))?;
    let mut cmd = CommandBuilder::new(&command.program);
    cmd.args(&command.args);
    cmd.env_clear();
    for (key, value) in &env {
        cmd.env(key, value);
    }
    for (name, value) in TERMINAL_VARS {
        cmd.env(name, value);
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
    let (mut reader, stop) = output_reader(pair.master.as_ref())?;
    let input_stop = stop.try_clone().map_err(pty_error)?;
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
            // Even if the shell outlives the hang-up, the output thread lets go of the terminal.
            input_stop.signal();
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
            // A job the shell left behind (`cmd & disown`) may keep the terminal open: output is read only a little
            // longer.
            stop.signal();
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
            if let Some(preamble) = preamble
                && output_tx.blocking_send(TermEvent::Data(preamble)).is_err()
            {
                return;
            }
            let mut buf = vec![0u8; READ_BUF];
            while let Some(n) = reader.read(&mut buf) {
                if output_tx
                    .blocking_send(TermEvent::Data(buf[..n].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            // Our side of the terminal closes now, not when the job that holds it ends.
            drop(reader);
            let code = loop {
                match exit_rx.recv_timeout(EXIT_POLL) {
                    Ok(code) => break code,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !output_tx.is_closed() => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break None,
                }
            };
            let _ = output_tx.blocking_send(TermEvent::Exit { code });
        })
        .map_err(pty_error)?;

    Ok(ExecSession {
        input: input_tx,
        resize: resize_tx,
        output: output_rx,
    })
}

/// How often the output thread, done reading, checks whether the session is gone while it waits for the exit code.
const EXIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// The reader of the shell's output and the [`Stop`] that ends it.
#[cfg(unix)]
fn output_reader(master: &dyn MasterPty) -> Result<(OutputReader, Stop), CoreError> {
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| pty_error("no terminal descriptor"))?;
    // SAFETY: `master` is alive for this call, so `fd` is open; the clone is our own descriptor.
    let master = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }
        .try_clone_to_owned()
        .map_err(pty_error)?;
    let (stop_rx, stop_tx) = std::io::pipe().map_err(pty_error)?;
    Ok((
        OutputReader {
            master: std::fs::File::from(master),
            stop: stop_rx,
            draining_until: None,
            poll_unsupported: false,
        },
        Stop(stop_tx),
    ))
}

/// The reader of the shell's output and the [`Stop`] that ends it.
#[cfg(not(unix))]
fn output_reader(master: &dyn MasterPty) -> Result<(OutputReader, Stop), CoreError> {
    let reader = master.try_clone_reader().map_err(pty_error)?;
    Ok((OutputReader(reader), Stop))
}

/// Tells the output thread the shell is gone (it exited, or the session was dropped). On Unix a job the shell left
/// behind (`cmd & disown`) may hold the terminal's slave side open, so reads would block until that job ends; after
/// [`Stop::signal`] the reader returns what is already there and then ends, and its descriptor is closed.
#[cfg(unix)]
struct Stop(std::io::PipeWriter);

#[cfg(unix)]
impl Stop {
    fn try_clone(&self) -> std::io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    fn signal(&self) {
        let _ = (&self.0).write(&[1]);
    }
}

/// On Windows closing the pseudo-console (after the shell exits) ends reads, so there is nothing to signal.
#[cfg(not(unix))]
struct Stop;

#[cfg(not(unix))]
impl Stop {
    fn try_clone(&self) -> std::io::Result<Self> {
        Ok(Self)
    }

    fn signal(&self) {}
}

#[cfg(not(unix))]
struct OutputReader(Box<dyn Read + Send>);

#[cfg(not(unix))]
impl OutputReader {
    /// The next chunk of output into `buf`, or `None` once the terminal is closed.
    fn read(&mut self, buf: &mut [u8]) -> Option<usize> {
        match self.0.read(buf) {
            Ok(0) | Err(_) => None,
            Ok(n) => Some(n),
        }
    }
}

/// After [`Stop::signal`]: output is read while it keeps coming at least every [`DRAIN_IDLE`], for at most
/// [`DRAIN_LIMIT`].
#[cfg(unix)]
const DRAIN_IDLE: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(unix)]
const DRAIN_LIMIT: std::time::Duration = std::time::Duration::from_millis(500);

/// Reads the master side with `poll()` on it and on the [`Stop`] pipe.
#[cfg(unix)]
struct OutputReader {
    master: std::fs::File,
    stop: std::io::PipeReader,
    /// Set once stopped: the end of the last reads.
    draining_until: Option<std::time::Instant>,
    /// `poll()` refused the terminal (`POLLNVAL`): plain blocking reads, as before.
    poll_unsupported: bool,
}

#[cfg(unix)]
impl OutputReader {
    /// The next chunk of output into `buf`, or `None` once the terminal is closed or the reader was stopped and has
    /// read what was left.
    fn read(&mut self, buf: &mut [u8]) -> Option<usize> {
        use std::os::fd::AsRawFd;
        loop {
            if !self.poll_unsupported {
                let timeout = match self.draining_until {
                    None => -1,
                    Some(until) => {
                        let left = until.saturating_duration_since(std::time::Instant::now());
                        if left.is_zero() {
                            return None;
                        }
                        // At most 50 ms, so it fits.
                        left.min(DRAIN_IDLE).as_millis() as std::ffi::c_int
                    }
                };
                let mut fds = [
                    poll::PollFd::new(self.master.as_raw_fd()),
                    poll::PollFd::new(self.stop.as_raw_fd()),
                ];
                // Once stopped the pipe stays readable: only the terminal is watched.
                let watched = if self.draining_until.is_some() { 1 } else { 2 };
                match poll::poll(&mut fds[..watched], timeout) {
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return None,
                    // Nothing more came while draining.
                    Ok(0) => return None,
                    Ok(_) => {}
                }
                if fds[0].revents & poll::POLLNVAL != 0 {
                    self.poll_unsupported = true;
                } else if fds[0].revents == 0 {
                    // Only the stop pipe.
                    self.draining_until = Some(std::time::Instant::now() + DRAIN_LIMIT);
                    continue;
                }
            }
            return match self.master.read(buf) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => None,
                Ok(n) => Some(n),
            };
        }
    }
}

/// `poll(2)` from the C library std already links; the values are the same on Linux and macOS.
#[cfg(unix)]
mod poll {
    use std::ffi::{c_int, c_short};

    pub const POLLIN: c_short = 0x1;
    pub const POLLNVAL: c_short = 0x20;

    #[cfg(target_os = "linux")]
    type NFds = std::ffi::c_ulong;
    #[cfg(not(target_os = "linux"))]
    type NFds = std::ffi::c_uint;

    #[repr(C)]
    pub struct PollFd {
        fd: c_int,
        events: c_short,
        pub revents: c_short,
    }

    impl PollFd {
        pub fn new(fd: c_int) -> Self {
            Self {
                fd,
                events: POLLIN,
                revents: 0,
            }
        }
    }

    unsafe extern "C" {
        #[link_name = "poll"]
        fn c_poll(fds: *mut PollFd, nfds: NFds, timeout: c_int) -> c_int;
    }

    /// How many of `fds` are ready; `timeout` in milliseconds, negative for none.
    pub fn poll(fds: &mut [PollFd], timeout: c_int) -> std::io::Result<usize> {
        // SAFETY: `fds` is a valid array of `pollfd` (same layout) of the given length for the whole call.
        let ready = unsafe { c_poll(fds.as_mut_ptr(), fds.len() as NFds, timeout) };
        usize::try_from(ready).map_err(|_| std::io::Error::last_os_error())
    }
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

        // Resizes and keystrokes go through separate threads, so the first `stty size` may run before the resize:
        // ask again until it reports the new size. Each answer ends with a marker the echoed command line lacks.
        session.resize.blocking_send((100, 30)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        for attempt in 0.. {
            assert!(
                Instant::now() < deadline,
                "the resize never reached the shell"
            );
            session
                .input
                .blocking_send(format!("stty size; echo \"m{attempt}=$((40+2))\"\n").into_bytes())
                .unwrap();
            let marker = format!("m{attempt}=42");
            let (text, exit) = read_until(&mut session, |t| t.contains(&marker));
            assert_eq!(exit, None, "{text}");
            if text.contains("30 100") {
                break;
            }
        }

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

    /// A disowned job keeps the terminal's slave side open after the shell exits: the session still ends at once
    /// (the job keeps running, it was disowned).
    #[cfg(unix)]
    #[test]
    fn the_session_ends_with_the_shell_while_a_disowned_job_holds_the_terminal() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: no bash");
            return;
        };
        let bash = bash.to_string_lossy().into_owned();
        let mut session =
            spawn_shell(&shell(&bash, &["--norc", "--noprofile"]), &[], 80, 24).unwrap();
        session
            .input
            .blocking_send(b"sleep 30 & disown; echo \"job=$! ok\"\n".to_vec())
            .unwrap();
        let job_in = |t: &str| {
            t.match_indices("job=")
                .map(|(i, _)| &t[i + 4..])
                .filter_map(|rest| rest.split_once(" ok"))
                .map(|(digits, _)| digits.to_owned())
                .find(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()))
        };
        let (text, _) = read_until(&mut session, |t| job_in(t).is_some());
        // Ends the job however the test ends.
        struct Job(String);
        impl Drop for Job {
            fn drop(&mut self) {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &self.0])
                    .status();
            }
        }
        let job = Job(job_in(&text).unwrap());

        session.input.blocking_send(b"exit 3\n".to_vec()).unwrap();
        let sent = Instant::now();
        let (text, exit) = read_until(&mut session, |_| false);
        assert_eq!(exit, Some(Some(3)), "{text}");
        assert!(
            sent.elapsed() < Duration::from_secs(2),
            "the session ended {:?} after the shell",
            sent.elapsed()
        );
        assert!(!is_gone_or_zombie(&job.0), "the disowned job was killed");
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

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(env: &[(OsString, OsString)]) -> Vec<String> {
        env.iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn helm_overrides_and_the_apps_kubeconfig_are_dropped_by_name_ignoring_case_on_windows() {
        let base = os(&[
            ("Path", r"C:\Windows\System32"),
            ("USERPROFILE", r"C:\Users\me"),
            ("Helm_KubeToken", "t"),
            ("helm_kubeapiserver", "https://elsewhere"),
            ("Helm_Namespace", "ns"),
            ("HELM_DRIVER", "sql"),
            ("KubeConfig", r"C:\app\kubeconfig"),
            ("HELM_CACHE_HOME", r"C:\cache"),
        ]);
        assert_eq!(
            names(&shell_environment(Platform::Windows, base)),
            ["Path", "USERPROFILE", "HELM_CACHE_HOME"]
        );
        // On Unix names are case-sensitive: only the exact ones go.
        let base = os(&[
            ("PATH", "/usr/bin"),
            ("HELM_KUBECONTEXT", "x"),
            ("helm_namespace", "lower-case is another variable"),
            ("KUBECONFIG", "/app/kubeconfig"),
        ]);
        assert_eq!(
            names(&shell_environment(Platform::Unix, base)),
            ["PATH", "helm_namespace"]
        );
    }

    #[test]
    fn appimage_variables_and_paths_into_the_mounted_image_are_dropped() {
        let base = os(&[
            ("APPIMAGE", "/home/me/Sextant.AppImage"),
            ("APPDIR", "/tmp/.mount_SextanAbC"),
            ("OWD", "/home/me"),
            ("ARGV0", "Sextant.AppImage"),
            (
                "PATH",
                "/tmp/.mount_SextanAbC/usr/bin:/usr/local/bin:/usr/bin",
            ),
            ("LD_LIBRARY_PATH", "/tmp/.mount_SextanAbC/usr/lib:"),
            (
                "GDK_PIXBUF_MODULE_FILE",
                "/tmp/.mount_SextanAbC/usr/lib/loaders.cache",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_SextanAbC/usr/share:/usr/share",
            ),
            ("HOME", "/home/me"),
            ("NOTES", "/tmp/.mount_SextanAbCdef/elsewhere"),
        ]);
        assert_eq!(
            shell_environment(Platform::Unix, base),
            os(&[
                ("PATH", "/usr/local/bin:/usr/bin"),
                ("XDG_DATA_DIRS", "/usr/share"),
                ("HOME", "/home/me"),
                ("NOTES", "/tmp/.mount_SextanAbCdef/elsewhere"),
            ])
        );
        // Not started from an AppImage: such variables are the user's own.
        let base = os(&[("APPDIR", "/opt/app"), ("PATH", "/opt/app/bin:/usr/bin")]);
        assert_eq!(shell_environment(Platform::Unix, base.clone()), base);
    }

    #[test]
    fn shell_kind_follows_the_program_name() {
        assert_eq!(ShellKind::of(OsStr::new("/bin/bash")), ShellKind::Bash);
        assert_eq!(
            ShellKind::of(OsStr::new("/usr/local/bin/zsh")),
            ShellKind::Zsh
        );
        assert_eq!(
            ShellKind::of(OsStr::new("/opt/homebrew/bin/fish")),
            ShellKind::Fish
        );
        assert_eq!(ShellKind::of(OsStr::new("/bin/sh")), ShellKind::Other);
        assert_eq!(
            ShellKind::of(OsStr::new("powershell.exe")),
            ShellKind::Other
        );
        assert_eq!(ShellKind::of(OsStr::new("/usr/bin/nu")), ShellKind::Other);
    }

    /// `name` found in this process's `PATH`.
    #[cfg(unix)]
    fn installed(name: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(name))
            .find(|p| is_executable(p))
    }

    /// A clean environment for a shell under test: this process's `PATH` and a temporary `HOME`, so the user's
    /// own rc files are never read.
    #[cfg(unix)]
    fn test_env(home: &Path) -> Vec<(OsString, OsString)> {
        vec![
            ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
            ("HOME".into(), home.into()),
        ]
    }

    #[cfg(unix)]
    fn write_script(path: &Path, text: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The line of a stand-in `zsh` (a sh script) that answers the `ZDOTDIR` probe like a zsh whose `/etc/zshenv`
    /// leaves `ZDOTDIR` alone.
    #[cfg(unix)]
    fn answers_the_probe() -> String {
        format!(
            "if [ \"$1\" = -f ]; then printf '{ZDOTDIR_PROBE_MARKER}%s' \"$ZDOTDIR\"; exit 0; fi\n"
        )
    }

    #[cfg(unix)]
    fn notice() -> String {
        format!("\x1b]{KUBECONFIG_NOTICE_OSC};{KUBECONFIG_NOTICE}\x07")
    }

    #[cfg(unix)]
    #[test]
    fn bash_keeps_the_session_kubeconfig_over_the_users_rc_files() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".bash_profile"), ". ~/.bashrc\n").unwrap();
        std::fs::write(
            home.path().join(".bashrc"),
            "export KUBECONFIG=/other\nexport SEXTANT_USER_RC=ran\n",
        )
        .unwrap();
        let kubeconfig = home.path().join("it's the session.yaml");
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: bash.into(),
                args: vec!["-l".into()],
            },
            kubeconfig.as_os_str(),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(b"echo \"KC=$KUBECONFIG RC=$SEXTANT_USER_RC\"\n".to_vec())
            .unwrap();
        let expected = format!("KC={} RC=ran", kubeconfig.display());
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(&expected));
        assert_eq!(exit, None, "{text}");
        assert!(!text.contains(&notice()), "bash needs no notice: {text:?}");
    }

    /// bash started through the rc file is not a login shell, so its `logout` refused ("not login shell", #71);
    /// in a terminal tab it ends the shell like `exit`.
    #[cfg(unix)]
    #[test]
    fn bash_logout_ends_the_shell_like_exit() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: bash.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(b"logout 5\necho \"STILL-$((1+1))\"\n".to_vec())
            .unwrap();
        let (text, exit) = read_until(&mut shell.session, |t| t.contains("STILL-2"));
        assert_eq!(exit, Some(Some(5)), "logout did not end the shell: {text}");
    }

    /// `bash --rcfile` would read the system bashrc itself (Debian, Arch: `SYS_BASHRC`) and again through
    /// `/etc/profile`. Traced with `xtrace` (imported from `SHELLOPTS`): each run of `/etc/bash.bashrc` shows its
    /// first command once.
    #[cfg(unix)]
    #[test]
    fn bash_runs_the_system_bashrc_and_the_users_rc_once() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".profile"), ". ~/.bashrc\n").unwrap();
        std::fs::write(
            home.path().join(".bashrc"),
            "SEXTANT_USER_RC_RUNS=$((${SEXTANT_USER_RC_RUNS:-0}+1))\n",
        )
        .unwrap();
        let mut env = test_env(home.path());
        env.extend(os(&[
            ("SHELLOPTS", "xtrace"),
            ("PS4", "+${BASH_SOURCE}:${LINENO}: "),
        ]));
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: bash.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &env,
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(
                b"set +x; echo \"RUNS=[$SEXTANT_USER_RC_RUNS] KC=$KUBECONFIG.\"\n".to_vec(),
            )
            .unwrap();
        let (text, exit) = read_until(&mut shell.session, |t| {
            t.contains("RUNS=[1] KC=/session/kubeconfig.yaml.")
        });
        assert_eq!(exit, None, "{text}");
        let system_lines: Vec<u32> = text
            .split(['\r', '\n'])
            .filter_map(|line| {
                line.trim_start_matches('+')
                    .strip_prefix("/etc/bash.bashrc:")
            })
            .filter_map(|rest| rest.split_once(':')?.0.parse().ok())
            .collect();
        if let Some(first) = system_lines.iter().min() {
            let runs = system_lines.iter().filter(|line| *line == first).count();
            assert_eq!(runs, 1, "/etc/bash.bashrc ran {runs} times: {text}");
        }
    }

    /// bash in POSIX mode (how Sextant starts it) defaults to `~/.sh_history` and `inherit_errexit`; the user's bash
    /// keeps `~/.bash_history` and has `inherit_errexit` off.
    #[cfg(unix)]
    #[test]
    fn bash_keeps_its_own_history_and_options() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(".bash_history"),
            "echo from-the-bash-history\n",
        )
        .unwrap();
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: bash.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(
                // `IE=[]`: a bash before 4.4 (macOS has 3.2) has no `inherit_errexit`.
                b"history | sed 's/^ *[0-9]* */H:/'; echo \"IE=[$(shopt inherit_errexit 2>/dev/null)]\"; \
                  echo \"HF=[$HISTFILE]\"\n"
                    .to_vec(),
            )
            .unwrap();
        let expected = format!("HF=[{}/.bash_history]", home.path().display());
        // The echoed command line has `HF=[$`; only the output has `HF=[/`.
        let (text, exit) = read_until(&mut shell.session, |t| t.contains("HF=[/"));
        assert_eq!(exit, None, "{text}");
        assert!(text.contains(&expected), "{text}");
        assert!(
            text.contains("H:echo from-the-bash-history"),
            "the user's history is not loaded: {text}"
        );
        // The echoed command line has `IE=[$`; only the output has `IE=[]` or `IE=[inherit_errexit…]`.
        let inherit_errexit = text
            .split(['\r', '\n'])
            .find_map(|l| l.strip_prefix("IE=[").filter(|rest| !rest.starts_with('$')))
            .unwrap_or_else(|| panic!("no shopt output: {text}"));
        if inherit_errexit == "]" {
            eprintln!("inherit_errexit not checked: this bash does not know it");
        } else {
            assert!(
                inherit_errexit.starts_with("inherit_errexit") && inherit_errexit.ends_with("off]"),
                "{text}"
            );
        }
    }

    /// Apple's bash 3.2 (`/bin/bash` on macOS) runs an interactive shell's startup files as if not in POSIX mode
    /// (its `run_startup_files` shadows `posixly_correct` with 0): `--posix -i` reads `--rcfile`, else `~/.bashrc`,
    /// and never `$ENV`, while `HISTFILE` already defaults to `~/.sh_history`. A stand-in `bash` starts the real one
    /// that way, so the macOS order is checked on every system (on macOS the tests above check the real one).
    #[cfg(unix)]
    #[test]
    fn bash_that_reads_the_rcfile_instead_of_env_keeps_the_session_kubeconfig_and_history() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".bash_profile"), ". ~/.bashrc\n").unwrap();
        std::fs::write(
            home.path().join(".bashrc"),
            "export KUBECONFIG=/other\nSEXTANT_USER_RC_RUNS=$((${SEXTANT_USER_RC_RUNS:-0}+1))\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".bash_history"),
            "echo from-the-bash-history\n",
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let stand_in = dir.path().join("bash");
        write_script(
            &stand_in,
            &format!(
                "#!{bash}\n\
                 rc=~/.bashrc\n\
                 while [ $# -gt 0 ]; do\n\
                 \x20 case $1 in --rcfile) rc=$2; shift ;; esac\n\
                 \x20 shift\n\
                 done\n\
                 export HISTFILE=~/.sh_history\n\
                 exec {bash} --rcfile \"$rc\" -i\n",
                bash = bash.display()
            ),
        );
        let kubeconfig = home.path().join("it's the session.yaml");
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: stand_in.into(),
                args: vec!["-l".into()],
            },
            kubeconfig.as_os_str(),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(
                b"history | sed 's/^ *[0-9]* */H:/'; \
                  echo \"KC=$KUBECONFIG RUNS=[$SEXTANT_USER_RC_RUNS] HF=[$HISTFILE]\"\n"
                    .to_vec(),
            )
            .unwrap();
        // The echoed command line has `HF=[$`; only the output has `HF=[/`.
        let (text, exit) = read_until(&mut shell.session, |t| t.contains("HF=[/"));
        assert_eq!(exit, None, "{text}");
        let expected = format!(
            "KC={} RUNS=[1] HF=[{}/.bash_history]",
            kubeconfig.display(),
            home.path().display()
        );
        assert!(text.contains(&expected), "{text}");
        assert!(
            text.contains("H:echo from-the-bash-history"),
            "the user's history is not loaded: {text}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn zsh_keeps_the_session_kubeconfig_over_the_users_rc_files() {
        let Some(zsh) = installed("zsh") else {
            eprintln!("skipped: zsh is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        // A common layout: `~/.zshenv` moves the rest of the files to `~/.config/zsh`.
        let zdotdir = home.path().join(".config/zsh");
        std::fs::create_dir_all(&zdotdir).unwrap();
        std::fs::write(
            home.path().join(".zshenv"),
            "export ZDOTDIR=\"$HOME/.config/zsh\"\n",
        )
        .unwrap();
        std::fs::write(
            zdotdir.join(".zshrc"),
            "export KUBECONFIG=/other\nexport SEXTANT_USER_RC=ran\n",
        )
        .unwrap();
        let kubeconfig = home.path().join("it's the session.yaml");
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: zsh.into(),
                args: vec!["-l".into()],
            },
            kubeconfig.as_os_str(),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(
                b"echo \"KC=$KUBECONFIG RC=$SEXTANT_USER_RC ZD=$ZDOTDIR. HF=[$HISTFILE]\"\n"
                    .to_vec(),
            )
            .unwrap();
        let expected = format!(
            "KC={} RC=ran ZD={}. HF=[",
            kubeconfig.display(),
            zdotdir.display()
        );
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(&expected));
        assert_eq!(exit, None, "{text}");
        assert!(!text.contains(&notice()), "zsh needs no notice: {text:?}");
        let startup = shell.startup_files.as_ref().unwrap().path();
        assert!(
            !text.contains(&format!("HF=[{}", startup.display())),
            "the history file is in the startup files: {text:?}"
        );
    }

    /// zsh reads `/etc/zshrc` (and `/etc/zprofile`, `/etc/zlogin`) between the user's files; macOS's sets
    /// `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`, grml's also runs `compinit -d ${ZDOTDIR:-$HOME}/.zcompdump`. A
    /// stand-in `zsh` (bash, which reads the wrapper the same way) goes through zsh's startup order with such a
    /// system file: neither may land in the session's startup files.
    #[cfg(unix)]
    #[test]
    fn zsh_history_and_completion_dump_stay_with_the_users_files() {
        let Some(bash) = installed("bash") else {
            eprintln!("skipped: bash is not installed");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let zdotdir = home.path().join(".config/zsh");
        std::fs::create_dir_all(&zdotdir).unwrap();
        std::fs::write(
            home.path().join(".zshenv"),
            "export ZDOTDIR=\"$HOME/.config/zsh\"\n",
        )
        .unwrap();
        std::fs::write(
            zdotdir.join(".zshrc"),
            "export KUBECONFIG=/other\nexport SEXTANT_USER_RC=ran\n",
        )
        .unwrap();
        let system_rc = "HISTFILE=\"${ZDOTDIR:-$HOME}/.zsh_history\"; \
                         ZCOMPDUMP=\"${ZDOTDIR:-$HOME}/.zcompdump\"; : > \"$ZCOMPDUMP\"";
        let zsh = home.path().join("zsh");
        write_script(
            &zsh,
            &format!(
                "#!{bash}\n{probe}\
                 . \"$ZDOTDIR/.zshenv\"\n\
                 for f in .zprofile SYSTEM .zshrc .zlogin; do\n\
                 \x20 if [ $f = SYSTEM ]; then {system_rc}\n\
                 \x20 elif [ -r \"${{ZDOTDIR:-$HOME}}/$f\" ]; then . \"${{ZDOTDIR:-$HOME}}/$f\"; fi\n\
                 done\n\
                 for hook in \"${{precmd_functions[@]}}\"; do \"$hook\"; done\n\
                 echo \"KC=$KUBECONFIG RC=$SEXTANT_USER_RC HF=$HISTFILE CD=$ZCOMPDUMP hooks=[${{precmd_functions[*]}}]\"\n\
                 exec sleep 30\n",
                bash = bash.display(),
                probe = answers_the_probe()
            ),
        );
        let kubeconfig = home.path().join("it's the session.yaml");
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: zsh.into(),
                args: vec!["-l".into()],
            },
            kubeconfig.as_os_str(),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        let expected = format!(
            "KC={} RC=ran HF={zd}/.zsh_history CD={zd}/.zcompdump hooks=[]",
            kubeconfig.display(),
            zd = zdotdir.display()
        );
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(&expected));
        assert_eq!(exit, None, "{text}");
        let startup = shell.startup_files.as_ref().unwrap().path();
        let mut inside: Vec<_> = std::fs::read_dir(startup)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        inside.sort();
        assert_eq!(inside, [".zshenv"], "only the wrapper is there");
    }

    /// A stand-in `zsh` whose `/etc/zshenv` sets `ZDOTDIR`; it answers the probe (`-f -c …`) the way zsh would.
    #[cfg(unix)]
    fn zsh_with_a_system_zdotdir(dir: &Path, probe_answer: &str) -> PathBuf {
        let zsh = dir.join("zsh");
        write_script(
            &zsh,
            &format!(
                "#!/bin/sh\nZDOTDIR=/etc/zsh-system\n\
                 if [ \"$1\" = -f ]; then {probe_answer}; fi\n\
                 printf 'ZD=%s KC=%s.\\n' \"$ZDOTDIR\" \"$KUBECONFIG\"\nexec sleep 30\n"
            ),
        );
        zsh
    }

    /// `/etc/zshenv` runs before anything else and here sets `ZDOTDIR`, so zsh never reads the wrapper (#72): the
    /// tab says the kubeconfig is not pinned, and no startup files are left behind.
    #[cfg(unix)]
    #[test]
    fn zsh_whose_system_zshenv_sets_zdotdir_starts_with_the_notice() {
        let dir = tempfile::tempdir().unwrap();
        let zsh = zsh_with_a_system_zdotdir(
            dir.path(),
            &format!("printf 'from /etc/zshenv\\n{ZDOTDIR_PROBE_MARKER}%s' \"$ZDOTDIR\"; exit 0"),
        );
        let temp = tempfile::tempdir().unwrap();
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: zsh.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(dir.path()),
            temp.path(),
            80,
            24,
        )
        .unwrap();
        assert!(shell.startup_files.is_none());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        let expected = "ZD=/etc/zsh-system KC=/session/kubeconfig.yaml.";
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(expected));
        assert_eq!(exit, None, "{text}");
        assert!(
            text.starts_with(&notice()),
            "the notice comes first: {text:?}"
        );
    }

    /// A zsh that does not answer the probe in time is not trusted with the wrapper either.
    #[cfg(unix)]
    #[test]
    fn zsh_that_does_not_answer_the_probe_starts_with_the_notice() {
        let dir = tempfile::tempdir().unwrap();
        let zsh = zsh_with_a_system_zdotdir(dir.path(), "exec sleep 30");
        let temp = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: zsh.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(dir.path()),
            temp.path(),
            80,
            24,
        )
        .unwrap();
        assert!(started.elapsed() < ZDOTDIR_PROBE_TIMEOUT + Duration::from_secs(2));
        assert!(shell.startup_files.is_none());
        let (text, exit) = read_until(&mut shell.session, |t| {
            t.contains("KC=/session/kubeconfig.yaml.")
        });
        assert_eq!(exit, None, "{text}");
        assert!(
            text.starts_with(&notice()),
            "the notice comes first: {text:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fish_sets_the_session_kubeconfig_after_its_config() {
        // A stand-in `fish` that prints its arguments: fish runs `--init-command` after its config files.
        let dir = tempfile::tempdir().unwrap();
        let fish = dir.path().join("fish");
        write_script(
            &fish,
            "#!/bin/sh\nfor a in \"$@\"; do printf 'ARG[%s]\\n' \"$a\"; done\n\
             printf 'ENV[%s]\\n' \"$SEXTANT_KUBECONFIG\"\nexec sleep 30\n",
        );
        let kubeconfig = dir.path().join("it's\\here.yaml");
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: fish.into(),
                args: vec!["-l".into()],
            },
            kubeconfig.as_os_str(),
            &test_env(dir.path()),
            dir.path(),
            80,
            24,
        )
        .unwrap();
        let expected = format!(
            "ARG[-l]\r\nARG[--init-command]\r\n\
             ARG[set -gx KUBECONFIG $SEXTANT_KUBECONFIG; set -e SEXTANT_KUBECONFIG]\r\nENV[{}]",
            kubeconfig.display()
        );
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(&expected));
        assert_eq!(exit, None, "{text}");
        assert!(!text.contains(&notice()), "{text:?}");
        assert!(
            !text
                .split(['\r', '\n'])
                .any(|line| line.starts_with("ARG[") && line.contains("here.yaml")),
            "the path is in the arguments: {text:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_files_are_private_and_removed_with_the_shell() {
        use std::os::unix::fs::PermissionsExt;
        // A stand-in `zsh` that reports where its startup files are.
        let dir = tempfile::tempdir().unwrap();
        let zsh = dir.path().join("zsh");
        write_script(
            &zsh,
            &format!(
                "#!/bin/sh\n{}printf 'ZD=%s.\\n' \"$ZDOTDIR\"\nexec sleep 30\n",
                answers_the_probe()
            ),
        );
        let temp = tempfile::tempdir().unwrap();
        let mut shell = spawn_local_shell_with(
            &ShellCommand {
                program: zsh.into(),
                args: vec!["-l".into()],
            },
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(dir.path()),
            temp.path(),
            80,
            24,
        )
        .unwrap();
        let files = shell
            .startup_files
            .as_ref()
            .expect("zsh gets startup files")
            .path()
            .to_path_buf();
        assert!(files.starts_with(temp.path()), "{}", files.display());
        let expected = format!("ZD={}.", files.display());
        let (text, exit) = read_until(&mut shell.session, |t| t.contains(&expected));
        assert_eq!(exit, None, "{text}");

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&files), 0o700);
        let mut written: Vec<String> = std::fs::read_dir(&files)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                assert_eq!(mode(&e.path()), 0o600, "{}", e.path().display());
                e.file_name().to_string_lossy().into_owned()
            })
            .collect();
        written.sort();
        assert_eq!(written, [".zshenv"]);

        drop(shell);
        assert!(!files.exists(), "the startup files outlived the session");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn other_shells_start_with_the_kubeconfig_notice_and_the_session_kubeconfig() {
        let home = tempfile::tempdir().unwrap();
        let mut shell = spawn_local_shell_with(
            &shell("/bin/sh", &[]),
            OsStr::new("/session/kubeconfig.yaml"),
            &test_env(home.path()),
            home.path(),
            80,
            24,
        )
        .unwrap();
        assert!(shell.startup_files.is_none());
        let (text, _) = read_until(&mut shell.session, |t| t.contains(&notice()));
        assert!(
            text.starts_with(&notice()),
            "the notice comes first: {text:?}"
        );
        shell
            .session
            .input
            .blocking_send(b"echo \"KC=$KUBECONFIG.\"\n".to_vec())
            .unwrap();
        read_until(&mut shell.session, |t| {
            t.contains("KC=/session/kubeconfig.yaml.")
        });
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_gets_neither_helm_overrides_nor_the_apps_kubeconfig_nor_appimage_variables() {
        let home = tempfile::tempdir().unwrap();
        let path = std::env::var_os("PATH").unwrap();
        let appdir = "/tmp/.mount_SextanTest";
        let mut env = test_env(home.path());
        env[0].1 = format!("{appdir}/usr/bin:{}", path.to_string_lossy()).into();
        env.extend(os(&[
            ("HELM_KUBEAPISERVER", "https://elsewhere:6443"),
            ("HELM_KUBETOKEN", "not-for-the-shell"),
            ("HELM_NAMESPACE", "elsewhere"),
            ("HELM_DRIVER", "sql"),
            ("KUBECONFIG", "/app/kubeconfig"),
            ("APPIMAGE", "/home/me/Sextant.AppImage"),
            ("APPDIR", appdir),
            ("LD_LIBRARY_PATH", "/tmp/.mount_SextanTest/usr/lib"),
            ("SEXTANT_KEEP", "kept"),
        ]));
        let mut shell = spawn_local_shell_with(
            &shell("/bin/sh", &[]),
            OsStr::new("/session/kubeconfig.yaml"),
            &env,
            home.path(),
            80,
            24,
        )
        .unwrap();
        shell
            .session
            .input
            .blocking_send(b"env | sed 's/^/ENV /'; echo \"END-$((1+1))\"\n".to_vec())
            .unwrap();
        let (text, exit) = read_until(&mut shell.session, |t| t.contains("END-2"));
        assert_eq!(exit, None, "{text}");
        // Each variable on its own line after `ENV ` (the first one may follow the prompt).
        let vars: Vec<&str> = text
            .split(['\r', '\n'])
            .filter_map(|line| line.split_once("ENV ").map(|(_, var)| var))
            .collect();
        for gone in [
            "HELM_",
            "KUBECONFIG=/app",
            "APPIMAGE=",
            "APPDIR=",
            "LD_LIBRARY_PATH=",
        ] {
            assert!(
                !vars.iter().any(|l| l.starts_with(gone)),
                "{gone} reached the shell: {text}"
            );
        }
        for kept in [
            format!("PATH={}", path.to_string_lossy()),
            format!("HOME={}", home.path().display()),
            "KUBECONFIG=/session/kubeconfig.yaml".to_owned(),
            "SEXTANT_KEEP=kept".to_owned(),
        ] {
            assert!(vars.contains(&kept.as_str()), "{kept} is missing: {text}");
        }
    }
}
