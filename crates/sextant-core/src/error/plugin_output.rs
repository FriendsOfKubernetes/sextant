//! What a failed exec auth plugin printed on stderr, for the window only (#256, ADR-0084 amendment).
//!
//! kubectl shows a failed plugin's stderr as is; Sextant shows its last lines, cleaned and with anything that looks
//! like a credential replaced by `<hidden>`: the literal values of the plugin's own env and flag arguments, JWTs,
//! `Bearer` values, the values of token/password/secret/API-key fields in the usual `k=v`, `k: v`, `"k":"v"`,
//! `--k=v` and `--k v` forms, AWS access keys, PEM blocks and long base64 or hex runs. stdout is never read: it
//! carries the ExecCredential with the token.

use std::fmt;
use std::sync::LazyLock;

use regex::{Captures, Regex};

/// At most this many of the last lines are shown.
pub const MAX_LINES: usize = 20;
/// At most this many bytes (whole lines, the last ones) are shown.
pub const MAX_BYTES: usize = 2048;
/// What replaces a masked value.
pub const HIDDEN: &str = "<hidden>";
/// Only this much of the end of stderr is read at all.
const MAX_READ_BYTES: usize = 64 * 1024;
/// Literal values shorter than this are not masked by themselves (a `-v` or `1` would hide every such text).
const MIN_LITERAL: usize = 3;
/// Stands for a masked value while the text is still being masked, so a later rule never matches inside `<hidden>`.
/// Control characters are removed before masking, so it cannot come from the plugin.
const MARK: char = '\u{1}';

/// The literal values of an exec plugin's configuration that may be secrets: every env value, every argument that
/// follows a flag (`--profile prod`) and the value of every `key=value` argument. Their exact occurrences are masked.
/// `Debug` never prints them.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ExecSecrets(Vec<String>);

impl fmt::Debug for ExecSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ExecSecrets(<{} hidden>)", self.0.len())
    }
}

impl ExecSecrets {
    /// The values of `exec` (its `env` and `args`) to mask.
    pub fn of(exec: &kube::config::ExecConfig) -> Self {
        let env = exec
            .env
            .iter()
            .flatten()
            .filter_map(|pair| pair.get("value").cloned());
        Self::from_parts(env, exec.args.as_deref().unwrap_or_default())
    }

    fn from_parts(env: impl IntoIterator<Item = String>, args: &[String]) -> Self {
        let mut values: Vec<String> = env.into_iter().collect();
        for (i, arg) in args.iter().enumerate() {
            if let Some((_, value)) = arg.split_once('=') {
                values.push(value.to_owned());
            }
            let after_flag = i > 0 && args[i - 1].starts_with('-') && !args[i - 1].contains('=');
            if after_flag && !arg.starts_with('-') {
                values.push(arg.clone());
            }
        }
        values.retain(|v| v.trim().chars().count() >= MIN_LITERAL);
        // Longest first, so a value that contains another is masked whole.
        values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        values.dedup();
        Self(values)
    }
}

/// The plugin's stderr as the window shows it: the last [`MAX_LINES`] lines within [`MAX_BYTES`], without terminal
/// escapes or control characters, masked. `None` when it printed nothing readable.
pub fn masked_stderr(stderr: &[u8], secrets: &ExecSecrets) -> Option<String> {
    let cut = stderr.len() > MAX_READ_BYTES;
    let tail = &stderr[stderr.len().saturating_sub(MAX_READ_BYTES)..];
    let text = sanitize(&String::from_utf8_lossy(tail));
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    if cut && lines.len() > 1 {
        // The first line was cut in the middle.
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let mut dropped = lines.len() > MAX_LINES || cut;
    let kept = &lines[lines.len().saturating_sub(MAX_LINES)..];
    let start = kept.iter().position(|l| !l.trim().is_empty())?;
    let masked = mask(&kept[start..].join("\n"), secrets);
    let clipped = clip_lines(&masked, MAX_BYTES);
    if clipped.len() < masked.len() {
        dropped = true;
    }
    Some(if dropped {
        format!("…\n{clipped}")
    } else {
        clipped
    })
}

/// The text without terminal escape sequences, control characters (except line ends; a tab becomes a space) and
/// invisible or text-direction characters.
fn sanitize(text: &str) -> String {
    static ESCAPES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])").unwrap()
    });
    let text = ESCAPES.replace_all(text, "");
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            c if c.is_control() || is_invisible(c) => None,
            c => Some(c),
        })
        .collect()
}

fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
}

/// The names of fields whose values are secrets, with any `prefix_` / `prefix-` (`VAULT_TOKEN`, `client-secret`).
const KEYS: &str = r"(?:[a-z0-9]+[_-])*(?:token|passw(?:or)?d|secret|client[_-]?secret|api[_-]?key|secret[_-]?access[_-]?key|authorization)";

/// `text` with every secret-looking value replaced by [`HIDDEN`].
fn mask(text: &str, secrets: &ExecSecrets) -> String {
    static PEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]{1,40}-----.*?(?:-----END [A-Z0-9 ]{1,40}-----|\z)")
            .unwrap()
    });
    static JWT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}").unwrap());
    static BEARER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b(bearer\s+)[^\s"',;]+|\b(basic\s+)[A-Za-z0-9+/=]{8,}"#).unwrap()
    });
    // `k=v`, `k: v`, `"k":"v"`, `--k=v`; the value is quoted or runs to a space or separator.
    static FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r#"(?i)\b({KEYS}"?\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;&'"{MARK}]+)"#
        ))
        .unwrap()
    });
    // `--k v`.
    static FLAG: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"(?i)(--{KEYS}\s+)([^\s\-{MARK}]\S*)")).unwrap());
    static AWS_KEY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap());
    static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/_=-]{32,}").unwrap());

    let mark = MARK.to_string();
    let mut text = text.to_owned();
    for value in &secrets.0 {
        text = text.replace(value.as_str(), &mark);
    }
    let text = PEM.replace_all(&text, mark.as_str());
    let text = JWT.replace_all(&text, mark.as_str());
    let text = BEARER.replace_all(&text, |c: &Captures| {
        let prefix = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        format!("{prefix}{MARK}")
    });
    let text = FIELD.replace_all(&text, |c: &Captures| {
        let value = &c[2];
        let quote = value.chars().next().filter(|q| *q == '"' || *q == '\'');
        match quote {
            Some(q) => format!("{}{q}{MARK}{q}", &c[1]),
            None => format!("{}{MARK}", &c[1]),
        }
    });
    let text = FLAG.replace_all(&text, |c: &Captures| format!("{}{MARK}", &c[1]));
    let text = AWS_KEY.replace_all(&text, mark.as_str());
    let text = RUN.replace_all(&text, |c: &Captures| {
        let run = &c[0];
        if looks_random(run) {
            mark.clone()
        } else {
            run.to_owned()
        }
    });
    text.replace(MARK, HIDDEN)
}

/// A run of base64 / base64url / hex characters (already ≥ 32 long) that looks like a key or token rather than a
/// word, a name or a path: all hex, or digits with both upper- and lower-case letters.
fn looks_random(run: &str) -> bool {
    let body = run.trim_end_matches('=');
    let hex = body.len() >= 32 && body.chars().all(|c| c.is_ascii_hexdigit());
    let digit = body.chars().any(|c| c.is_ascii_digit());
    let upper = body.chars().any(|c| c.is_ascii_uppercase());
    let lower = body.chars().any(|c| c.is_ascii_lowercase());
    hex || (digit && upper && lower)
}

/// The last whole lines of `text` within `max` bytes; a last line longer than that keeps its end.
fn clip_lines(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in text.rsplit('\n') {
        let added = line.len() + usize::from(!kept.is_empty());
        if size + added > max {
            break;
        }
        size += added;
        kept.push(line);
    }
    if kept.is_empty() {
        let last = text.rsplit('\n').next().unwrap_or_default();
        let mut start = last.len().saturating_sub(max.saturating_sub("…".len()));
        while !last.is_char_boundary(start) {
            start += 1;
        }
        return format!("…{}", &last[start..]);
    }
    kept.reverse();
    kept.join("\n")
}

#[cfg(test)]
mod tests;
