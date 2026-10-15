//! Journals of calls: of AI agents ("Agent activity", `mcp-audit.jsonl`) and of extensions ("Extension activity",
//! `extensions-audit.jsonl`), each the last [`CAPACITY`] calls in memory and in its file in the application data
//! directory, so they survive a restart. An entry is a summary only — who, tool or method, target, decision, result
//! code and duration; never secret values, YAML, command output or the token.
//!
//! The agents' journal drops its oldest entry when full. The extensions' journal is shared by every extension, so it
//! evicts fairly (`Eviction::PerExtension`): one extension flooding it with cheap calls pushes out only its own
//! cheap entries, never another extension's entries nor its own writes and secret reads.

use std::collections::{HashMap, VecDeque};
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

/// Which entry goes when a journal holds more than [`CAPACITY`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Eviction {
    /// The oldest entry (the agents' journal).
    OldestFirst,
    /// An entry of the extension (`client`) with the most entries — on a tie, the one whose entries began earliest:
    /// its oldest cheap entry ([`is_cheap`]), or its oldest entry when it has no cheap ones left (the extensions'
    /// journal).
    PerExtension,
}

impl Eviction {
    /// The extensions' journal is told apart by its file name ([`EXTENSIONS_AUDIT_FILE`]).
    fn for_path(path: &Path) -> Self {
        if path.file_name().is_some_and(|n| n == EXTENSIONS_AUDIT_FILE) {
            Self::PerExtension
        } else {
            Self::OldestFirst
        }
    }

    /// Drops entries until at most [`CAPACITY`] are left.
    fn trim(self, entries: &mut VecDeque<AuditEntry>) {
        while entries.len() > CAPACITY {
            let index = match self {
                Self::OldestFirst => 0,
                Self::PerExtension => victim_per_extension(entries),
            };
            entries.remove(index);
        }
    }
}

/// Extension methods whose record is kept as long as the extension has cheap entries to lose instead.
const KEPT_METHODS: &[&str] = &[
    "resources.apply",
    "resources.patch",
    "resources.delete",
    "secret.value",
];

/// A cheap entry of an extension, one it can repeat as often as it likes: a read (`clusters.list`, `kinds`,
/// `resources.list/get/watch`, `logs.tail`), a call the rules denied, or an unknown method. A write, a delete, a
/// secret value read ([`KEPT_METHODS`]) and any call the user answered (approved, declined, timed out) are not cheap.
fn is_cheap(entry: &AuditEntry) -> bool {
    match entry.decision {
        AuditDecision::Denied => true,
        AuditDecision::Approved | AuditDecision::Declined | AuditDecision::TimedOut => false,
        AuditDecision::Allowed => !KEPT_METHODS.contains(&entry.tool.as_str()),
    }
}

/// The index of the entry [`Eviction::PerExtension`] drops; `entries` is not empty.
fn victim_per_extension(entries: &VecDeque<AuditEntry>) -> usize {
    // Per extension: (entries, index of its first entry, index of its first cheap entry).
    let mut per: HashMap<&str, (usize, usize, Option<usize>)> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let slot = per.entry(entry.client.as_str()).or_insert((0, index, None));
        slot.0 += 1;
        if slot.2.is_none() && is_cheap(entry) {
            slot.2 = Some(index);
        }
    }
    per.values()
        .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
        .map(|&(_, first, cheap)| cheap.unwrap_or(first))
        .unwrap_or(0)
}

/// The journal. Writes are small appends; the file is rewritten with the kept entries when it has grown to twice
/// [`CAPACITY`] lines. Reading the file replays the same eviction, so a restart keeps the same entries.
pub struct AuditLog {
    path: PathBuf,
    eviction: Eviction,
    inner: Mutex<Inner>,
}

struct Inner {
    entries: VecDeque<AuditEntry>,
    /// Lines in the file now (entries written since the last rewrite included).
    lines_in_file: usize,
}

impl AuditLog {
    /// Reads the kept [`CAPACITY`] entries of `path`; a missing file is an empty journal, unreadable lines are
    /// skipped. A file named [`EXTENSIONS_AUDIT_FILE`] is the extensions' journal and evicts per extension.
    pub fn open(path: PathBuf) -> Self {
        let eviction = Eviction::for_path(&path);
        let (entries, lines_in_file) = read_entries(&path, eviction);
        let log = Self {
            path,
            eviction,
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

    /// Adds an entry (when there are [`CAPACITY`], one goes by the journal's [`Eviction`]). A file that cannot be
    /// written loses the entry only on disk.
    pub fn record(&self, entry: AuditEntry) {
        let mut inner = self.lock();
        inner.entries.push_back(entry.clone());
        self.eviction.trim(&mut inner.entries);
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

fn read_entries(path: &Path, eviction: Eviction) -> (VecDeque<AuditEntry>, usize) {
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
            eviction.trim(&mut entries);
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

    fn ext_entry(n: u64, extension: &str, method: &str, decision: AuditDecision) -> AuditEntry {
        AuditEntry {
            at: 1_700_000_000_000 + n,
            source: ConfirmSource::Extension,
            principal: format!("Extension {extension}"),
            client: extension.into(),
            cluster_id: Some(ClusterId::from("c1")),
            cluster_name: Some("c1-name".into()),
            tool: method.into(),
            target: format!("Secret team-a/db-{n}"),
            decision,
            result: "ok".into(),
            duration_ms: 3,
        }
    }

    fn count(entries: &[AuditEntry], keep: impl Fn(&AuditEntry) -> bool) -> usize {
        entries.iter().filter(|e| keep(e)).count()
    }

    #[test]
    fn a_flooding_extension_pushes_out_only_its_own_cheap_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = AuditLog::extensions_path_in(dir.path());
        let log = AuditLog::open(path.clone());
        let allowed = AuditDecision::Allowed;
        // B's history: reads and writes; A's own secret read, write, delete, approved patch and declined apply.
        let mut n = 0;
        for method in [
            "resources.get",
            "resources.apply",
            "resources.delete",
            "logs.tail",
        ] {
            log.record(ext_entry(n, "b", method, allowed));
            n += 1;
        }
        for (method, decision) in [
            ("secret.value", allowed),
            ("resources.apply", allowed),
            ("resources.delete", allowed),
            ("resources.patch", AuditDecision::Approved),
            ("resources.apply", AuditDecision::Declined),
        ] {
            log.record(ext_entry(n, "a", method, decision));
            n += 1;
        }
        // A floods: cheap reads, denied calls and unknown methods, far over the capacity.
        for i in 0..(3 * CAPACITY as u64) {
            let (method, decision) = match i % 3 {
                0 => ("clusters.list", allowed),
                1 => ("secret.value", AuditDecision::Denied),
                _ => ("no.such.method", allowed),
            };
            log.record(ext_entry(n, "a", method, decision));
            n += 1;
        }

        let check = |kept: &[AuditEntry]| {
            assert_eq!(kept.len(), CAPACITY);
            assert_eq!(count(kept, |e| e.client == "b"), 4, "B keeps every entry");
            let a_important = |method: &str, decision: AuditDecision| {
                count(kept, |e| {
                    e.client == "a" && e.tool == method && e.decision == decision
                })
            };
            assert_eq!(
                a_important("secret.value", allowed),
                1,
                "A's secret read stays"
            );
            assert_eq!(a_important("resources.apply", allowed), 1);
            assert_eq!(a_important("resources.delete", allowed), 1);
            assert_eq!(a_important("resources.patch", AuditDecision::Approved), 1);
            assert_eq!(a_important("resources.apply", AuditDecision::Declined), 1);
            assert_eq!(
                kept[0].at,
                1_700_000_000_000 + n - 1,
                "the newest call is kept"
            );
        };
        check(&log.list(None));
        // The same entries come back after a restart, from a file not yet rewritten and from a rewritten one.
        check(&AuditLog::open(path.clone()).list(None));
        check(&AuditLog::open(path).list(None));
    }

    #[test]
    fn the_extension_with_the_most_entries_loses_its_oldest_read_first() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(AuditLog::extensions_path_in(dir.path()));
        let allowed = AuditDecision::Allowed;
        log.record(ext_entry(0, "a", "resources.delete", allowed));
        log.record(ext_entry(1, "a", "resources.list", allowed));
        for n in 2..(CAPACITY as u64) {
            let who = if n % 2 == 0 { "a" } else { "b" };
            log.record(ext_entry(n, who, "resources.get", allowed));
        }
        // Full: A has 1001 entries, B 999. The next call goes over the capacity: A's oldest read (n = 1) goes.
        log.record(ext_entry(CAPACITY as u64, "b", "resources.get", allowed));
        let kept = log.list(None);
        assert_eq!(kept.len(), CAPACITY);
        assert!(kept.iter().any(|e| e.at % 10_000 == 0), "A's delete stays");
        assert!(
            !kept.iter().any(|e| e.at % 10_000 == 1),
            "A's oldest read goes"
        );
        assert_eq!(count(&kept, |e| e.client == "b"), 1_000);

        // A, now at 1000 entries like B, ties with it when a third extension calls; the tie goes to the one whose
        // entries began earlier (A).
        log.record(ext_entry(
            CAPACITY as u64 + 1,
            "c",
            "resources.get",
            allowed,
        ));
        let kept = log.list(None);
        assert_eq!(count(&kept, |e| e.client == "a"), 999);
        assert_eq!(count(&kept, |e| e.client == "b"), 1_000);
        assert!(
            !kept.iter().any(|e| e.at % 10_000 == 2),
            "A's next oldest read goes"
        );
    }

    #[test]
    fn the_agents_journal_still_drops_the_oldest_entry() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(AuditLog::path_in(dir.path()));
        let mut first = entry(0, "c1");
        first.tool = "delete_resource".into();
        log.record(first);
        for n in 1..=(CAPACITY as u64) {
            log.record(entry(n, "c1"));
        }
        let kept = log.list(None);
        assert_eq!(kept.len(), CAPACITY);
        assert_eq!(
            kept.last().unwrap().at,
            entry(1, "c1").at,
            "the oldest entry went"
        );
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
