//! Journals of calls: of AI agents ("Agent activity", `mcp-audit.jsonl`) and of extensions ("Extension activity",
//! `extensions-audit.jsonl`), each the last [`CAPACITY`] calls in memory and in its file in the application data
//! directory, so they survive a restart. An entry is a summary only — who, tool or method, target, decision, result
//! code and duration; never secret values, YAML, command output or the token.

use std::collections::VecDeque;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sextant_core::ClusterId;
use ts_rs::TS;

use super::confirm::ConfirmSource;

/// Entries kept in memory and between runs.
pub const CAPACITY: usize = 2_000;

/// Longest client name or target kept (in the journal and the confirmation dialog); a longer one is cut.
pub const MAX_TEXT_CHARS: usize = 256;

/// `text`, cut to [`MAX_TEXT_CHARS`] characters with a `…[cut]` note when longer.
pub fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
    cut.push_str("…[cut]");
    cut
}

/// Name of the agents' journal file in the data directory.
pub const AUDIT_FILE: &str = "mcp-audit.jsonl";

/// Name of the extensions' journal file in the data directory.
pub const EXTENSIONS_AUDIT_FILE: &str = "extensions-audit.jsonl";

/// How the permission check of a call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AuditDecision {
    /// The rules allow it without asking.
    Allowed,
    /// No rule covers it (or access to the cluster is off).
    Denied,
    /// The user allowed it in the confirmation dialog.
    Approved,
    /// The user denied it in the confirmation dialog.
    Declined,
    /// Nobody answered the confirmation dialog in time.
    TimedOut,
}

/// One call of an agent or an extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuditEntry {
    /// When the call came, in milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub at: u64,
    /// Whose call it was (entries written before extensions existed read as `agent`).
    #[serde(default)]
    pub source: ConfirmSource,
    /// Who called, as shown: the agent's client name, or `Extension <name>`.
    #[serde(default)]
    pub principal: String,
    /// The agent's client name from `initialize` (e.g. `claude-code`) or `unknown`; the extension's id.
    pub client: String,
    /// `None` for calls about no cluster (`list_clusters`).
    pub cluster_id: Option<ClusterId>,
    pub cluster_name: Option<String>,
    pub tool: String,
    /// What the call was about, e.g. `Pod team-a/web-1`; empty when nothing in particular.
    pub target: String,
    pub decision: AuditDecision,
    /// `ok`, or the error code (`ErrorCode` in camelCase: `denied`, `notFound`, …).
    pub result: String,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

/// The journal. Writes are small appends; the file is rewritten with the last [`CAPACITY`] entries when it has
/// grown to twice as many lines.
pub struct AuditLog {
    path: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    entries: VecDeque<AuditEntry>,
    /// Lines in the file now (entries written since the last rewrite included).
    lines_in_file: usize,
}

impl AuditLog {
    /// Reads the last [`CAPACITY`] entries of `path`; a missing file is an empty journal, unreadable lines are
    /// skipped.
    pub fn open(path: PathBuf) -> Self {
        let (entries, lines_in_file) = read_entries(&path);
        let log = Self {
            path,
            inner: Mutex::new(Inner {
                entries,
                lines_in_file,
            }),
        };
        if lines_in_file > CAPACITY {
            let mut inner = log.lock();
            log.rewrite(&mut inner);
        }
        log
    }

    /// The agents' journal file in a data directory.
    pub fn path_in(data_dir: &Path) -> PathBuf {
        data_dir.join(AUDIT_FILE)
    }

    /// The extensions' journal file in a data directory.
    pub fn extensions_path_in(data_dir: &Path) -> PathBuf {
        data_dir.join(EXTENSIONS_AUDIT_FILE)
    }

    /// Adds an entry (the oldest goes when there are [`CAPACITY`]). A file that cannot be written loses the entry
    /// only on disk.
    pub fn record(&self, entry: AuditEntry) {
        let mut inner = self.lock();
        inner.entries.push_back(entry.clone());
        while inner.entries.len() > CAPACITY {
            inner.entries.pop_front();
        }
        if inner.lines_in_file + 1 >= 2 * CAPACITY {
            self.rewrite(&mut inner);
        } else if append_line(&self.path, &entry).is_ok() {
            inner.lines_in_file += 1;
        }
    }

    /// Entries, newest first; only those of `cluster` when given.
    pub fn list(&self, cluster: Option<&ClusterId>) -> Vec<AuditEntry> {
        self.lock()
            .entries
            .iter()
            .rev()
            .filter(|e| cluster.is_none_or(|c| e.cluster_id.as_ref() == Some(c)))
            .cloned()
            .collect()
    }

    /// Entries `keep` accepts, newest first.
    pub fn list_matching(&self, keep: impl Fn(&AuditEntry) -> bool) -> Vec<AuditEntry> {
        self.lock()
            .entries
            .iter()
            .rev()
            .filter(|e| keep(e))
            .cloned()
            .collect()
    }

    /// Forgets every entry, in memory and on disk.
    pub fn clear(&self) -> io::Result<()> {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.lines_in_file = 0;
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn rewrite(&self, inner: &mut Inner) {
        if write_all(&self.path, &inner.entries).is_ok() {
            inner.lines_in_file = inner.entries.len();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn read_entries(path: &Path) -> (VecDeque<AuditEntry>, usize) {
    let mut entries = VecDeque::new();
    let mut lines = 0;
    let Ok(file) = std::fs::File::open(path) else {
        return (entries, 0);
    };
    for line in io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        lines += 1;
        if let Ok(entry) = serde_json::from_str::<AuditEntry>(&line) {
            entries.push_back(entry);
            if entries.len() > CAPACITY {
                entries.pop_front();
            }
        }
    }
    (entries, lines)
}

fn append_line(path: &Path, entry: &AuditEntry) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    open_private(path, true)?.write_all(&line)
}

fn write_all(path: &Path, entries: &VecDeque<AuditEntry>) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("the journal has no directory"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    let written = (|| {
        let mut out = io::BufWriter::new(open_private(&tmp, false)?);
        for entry in entries {
            serde_json::to_writer(&mut out, entry)?;
            out.write_all(b"\n")?;
        }
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Opens for appending (or truncating), readable only by the user on Unix.
fn open_private(path: &Path, append: bool) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true);
    if append {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u64, cluster: &str) -> AuditEntry {
        AuditEntry {
            at: 1_700_000_000_000 + n,
            source: ConfirmSource::Agent,
            principal: "claude-code".into(),
            client: "claude-code".into(),
            cluster_id: Some(ClusterId::from(cluster)),
            cluster_name: Some(format!("{cluster}-name")),
            tool: "get_resource".into(),
            target: format!("Pod team-a/web-{n}"),
            decision: AuditDecision::Allowed,
            result: "ok".into(),
            duration_ms: 12,
        }
    }

    #[test]
    fn wire_format() {
        let json = serde_json::to_value(entry(1, "c1")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "at": 1_700_000_000_001_u64, "source": "agent", "principal": "claude-code", "client": "claude-code",
                "clusterId": "c1", "clusterName": "c1-name",
                "tool": "get_resource", "target": "Pod team-a/web-1", "decision": "allowed", "result": "ok",
                "durationMs": 12,
            })
        );
        let timed_out = serde_json::to_value(AuditDecision::TimedOut).unwrap();
        assert_eq!(timed_out, "timedOut");
    }

    #[test]
    fn an_entry_written_before_extensions_reads_as_an_agents() {
        let old = r#"{"at":1,"client":"claude-code","clusterId":null,"clusterName":null,"tool":"list_clusters",
            "target":"","decision":"allowed","result":"ok","durationMs":3}"#;
        let entry: AuditEntry = serde_json::from_str(old).unwrap();
        assert_eq!(entry.source, ConfirmSource::Agent);
        assert_eq!(entry.client, "claude-code");
    }

    #[test]
    fn entries_survive_a_restart_newest_first_and_filtered_by_cluster() {
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::path_in(dir.path());
        let log = AuditLog::open(path.clone());
        log.record(entry(1, "c1"));
        log.record(entry(2, "c2"));
        log.record(entry(3, "c1"));

        let again = AuditLog::open(path);
        let all: Vec<u64> = again.list(None).iter().map(|e| e.at % 10).collect();
        assert_eq!(all, vec![3, 2, 1]);
        let c1: Vec<u64> = again
            .list(Some(&ClusterId::from("c1")))
            .iter()
            .map(|e| e.at % 10)
            .collect();
        assert_eq!(c1, vec![3, 1]);
    }

    #[test]
    fn only_the_last_2000_entries_are_kept_in_memory_and_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::path_in(dir.path());
        let log = AuditLog::open(path.clone());
        for n in 0..(2 * CAPACITY as u64 + 10) {
            log.record(entry(n, "c1"));
        }
        let kept = log.list(None);
        assert_eq!(kept.len(), CAPACITY);
        assert_eq!(kept[0].at, entry(2 * CAPACITY as u64 + 9, "c1").at);
        let lines = std::fs::read_to_string(&path).unwrap().lines().count();
        assert!(lines < 2 * CAPACITY, "the file is rewritten: {lines} lines");

        let again = AuditLog::open(path.clone());
        assert_eq!(again.list(None), kept);
        let lines = std::fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(lines, CAPACITY, "a long file is cut on open");
    }

    #[test]
    fn clear_empties_memory_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::path_in(dir.path());
        let log = AuditLog::open(path.clone());
        log.record(entry(1, "c1"));
        log.clear().unwrap();
        assert!(log.list(None).is_empty());
        assert!(AuditLog::open(path).list(None).is_empty());
        log.clear().unwrap();
    }

    #[test]
    fn unreadable_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::path_in(dir.path());
        let good = serde_json::to_string(&entry(1, "c1")).unwrap();
        std::fs::write(&path, format!("not json\n{good}\n{{\"at\":1}}\n")).unwrap();
        assert_eq!(AuditLog::open(path).list(None), vec![entry(1, "c1")]);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_only_by_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::path_in(dir.path());
        AuditLog::open(path.clone()).record(entry(1, "c1"));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
