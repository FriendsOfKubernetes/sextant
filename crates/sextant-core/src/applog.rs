//! Sextant's own log (#343, ADR-0151): a small text file in the app data directory, so that an app that closed by
//! itself can be told apart from one that was quit, and a panic leaves its reason. On Windows a release build has no
//! console, so whatever went to stderr was lost before.
//!
//! What is written: the start (version, OS, process id), how the app ended (Quit in the tray, the window closed, the
//! exit), the window hidden to the tray, every panic (thread, place, message) and the few messages Sextant printed to
//! stderr. Every line goes to stderr too. Nothing from a cluster, a kubeconfig, a credential, a Secret or an
//! exec plugin's output is ever passed here: callers write their own sentences and error kinds only.
//!
//! The file is `sextant.log`; past `MAX_LOG_BYTES` it is renamed to `sextant.1.log` (replacing the older one) and a
//! new one is started, so the log never takes more than twice that. On Unix the files are 0600.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

/// The log being written.
pub const LOG_FILE: &str = "sextant.log";
/// The log before it, kept once `LOG_FILE` grew past `MAX_LOG_BYTES`.
pub const OLD_LOG_FILE: &str = "sextant.1.log";
/// Size at which the log is started anew.
pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// A longer message is cut (a panic message can be anything).
pub const MAX_MESSAGE_CHARS: usize = 4000;

/// Writes `format!(…)` as one line of the log (and to stderr).
#[macro_export]
macro_rules! applog {
    ($($arg:tt)*) => {
        $crate::applog::line(&format!($($arg)*))
    };
}

/// A log in a directory: the open file and how much it holds.
#[derive(Debug)]
pub struct Log {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
}

impl Log {
    /// Opens (or creates) the log in `dir`, creating the directory.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = open_append(&dir.join(LOG_FILE))?;
        let size = file.metadata().map_or(0, |m| m.len());
        Ok(Self {
            dir: dir.to_path_buf(),
            file: Some(file),
            size,
        })
    }

    /// The directory the log is in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Appends one line stamped with the UTC time and the process id; a write that fails is dropped (a log must never
    /// stop the app).
    pub fn write(&mut self, time: SystemTime, message: &str) {
        let text = format!(
            "{} [{}] {}\n",
            utc_time(time),
            std::process::id(),
            clean(message)
        );
        if self.size + text.len() as u64 > MAX_LOG_BYTES && self.size > 0 {
            self.rotate();
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        if file
            .write_all(text.as_bytes())
            .and_then(|()| file.flush())
            .is_ok()
        {
            self.size += text.len() as u64;
        }
    }

    /// `sextant.log` becomes `sextant.1.log` and a new one is started.
    fn rotate(&mut self) {
        self.file = None;
        let current = self.dir.join(LOG_FILE);
        let _ = std::fs::rename(&current, self.dir.join(OLD_LOG_FILE));
        self.file = open_append(&current).ok();
        self.size = self
            .file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
    }
}

fn open_append(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// The process's log, once `init` opened it.
static LOG: Mutex<Option<Log>> = Mutex::new(None);

fn lock() -> MutexGuard<'static, Option<Log>> {
    LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Opens the process's log in `dir`. Until then (and when it cannot be opened) lines go to stderr only.
pub fn init(dir: &Path) -> std::io::Result<()> {
    let log = Log::open(dir)?;
    *lock() = Some(log);
    Ok(())
}

/// The directory of the process's log, once `init` opened it.
pub fn dir() -> Option<PathBuf> {
    lock().as_ref().map(|log| log.dir().to_path_buf())
}

/// Writes one line to stderr and to the log.
pub fn line(message: &str) {
    eprintln!("Sextant: {message}");
    if let Some(log) = lock().as_mut() {
        log.write(SystemTime::now(), message);
    }
}

/// Writes every panic to the log before the default report (to stderr) runs. A panic of a background task does not
/// always end the app; it is written all the same.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let place = info
            .location()
            .map_or_else(|| "an unknown place".to_string(), ToString::to_string);
        // `try_lock`: a panic while the log itself was being written must not wait for its own lock.
        let mut guard = match LOG.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        if let Some(log) = guard.as_mut().and_then(|g| g.as_mut()) {
            log.write(
                SystemTime::now(),
                &format!("panic in thread '{name}' at {place}: {message}"),
            );
        }
        drop(guard);
        previous(info);
    }));
}

/// One line: control characters other than line breaks become `?`, every line after the first is indented, and the
/// whole is cut at `MAX_MESSAGE_CHARS`.
fn clean(message: &str) -> String {
    let mut out = String::new();
    for (i, c) in message.trim_end().chars().enumerate() {
        if i == MAX_MESSAGE_CHARS {
            out.push('…');
            break;
        }
        match c {
            '\n' => out.push_str("\n    "),
            '\r' => {}
            c if c.is_control() && c != '\t' => out.push('?'),
            c => out.push(c),
        }
    }
    out
}

/// `2026-11-06T10:15:02Z`.
fn utc_time(time: SystemTime) -> String {
    let secs = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (year, month, day) = crate::settings::civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn a_line_has_the_utc_time_the_process_and_the_message() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::open(&dir.path().join("logs")).unwrap();
        log.write(at(1_793_960_102), "Sextant 1.0.0 started");
        let text = std::fs::read_to_string(dir.path().join("logs").join(LOG_FILE)).unwrap();
        assert_eq!(
            text,
            format!(
                "2026-11-06T10:15:02Z [{}] Sextant 1.0.0 started\n",
                std::process::id()
            )
        );
    }

    #[test]
    fn a_message_stays_one_entry_clean_and_bounded() {
        assert_eq!(
            clean("first\r\nsecond\u{1b}[31m\n"),
            "first\n    second?[31m"
        );
        let long = "x".repeat(MAX_MESSAGE_CHARS + 10);
        let cut = clean(&long);
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn the_log_is_appended_to_across_runs() {
        let dir = tempfile::tempdir().unwrap();
        Log::open(dir.path()).unwrap().write(at(0), "first run");
        Log::open(dir.path()).unwrap().write(at(1), "second run");
        let text = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.contains("first run") && text.contains("second run"));
    }

    #[test]
    fn a_full_log_is_kept_once_and_started_anew() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::open(dir.path()).unwrap();
        let message = "y".repeat(1000);
        // Three logs' worth: the oldest is gone, the one before is kept, the current one is under the limit.
        let lines = 3 * MAX_LOG_BYTES as usize / 1000;
        for i in 0..lines {
            log.write(at(i as u64), &message);
        }
        let current = std::fs::metadata(dir.path().join(LOG_FILE)).unwrap().len();
        let old = std::fs::metadata(dir.path().join(OLD_LOG_FILE))
            .unwrap()
            .len();
        assert!(
            current <= MAX_LOG_BYTES && old <= MAX_LOG_BYTES,
            "{current} {old}"
        );
        assert!(old > MAX_LOG_BYTES - 1100, "{old}");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[cfg(unix)]
    #[test]
    fn only_the_user_may_read_the_log() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        Log::open(dir.path()).unwrap().write(at(0), "x");
        let mode = std::fs::metadata(dir.path().join(LOG_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_panic_is_written_with_its_thread_place_and_message() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path()).unwrap();
        install_panic_hook();
        let result = std::thread::Builder::new()
            .name("watch".into())
            .spawn(|| panic!("the list ended"))
            .unwrap()
            .join();
        assert!(result.is_err());
        let _ = std::panic::take_hook();
        *lock() = None;
        let text = std::fs::read_to_string(dir.path().join(LOG_FILE)).unwrap();
        // Another test of this process may panic meanwhile and be written too: this one's line is looked for.
        let panic = text
            .lines()
            .find(|l| l.contains("panic in thread 'watch' at "))
            .unwrap_or_else(|| panic!("{text}"));
        assert!(
            panic.contains("applog.rs") && panic.ends_with(": the list ended"),
            "{panic}"
        );
    }
}
