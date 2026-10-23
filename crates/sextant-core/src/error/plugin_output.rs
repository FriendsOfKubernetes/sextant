//! What a failed exec auth plugin printed on stderr, for the window only (#256, ADR-0084 amendment).
//!
//! kubectl shows a failed plugin's stderr as is; Sextant shows its last lines, cleaned and with anything that looks
//! like a credential replaced by `<hidden>`. The whole read tail (≤ 64 KiB) is masked before the last lines are cut,
//! so a PEM block or a `--password` flag whose start falls before the shown lines still hides what follows it.
//! Masked: PEM blocks, YAML block scalars of secret fields, JWTs, provider tokens with a known prefix (Vault, GitLab,
//! GitHub, Slack, AWS access keys), `Bearer`/`Basic` values, `Cookie`/`Set-Cookie` header values, the values of
//! token/password/secret/API-key/credential fields in the usual `k=v`, `k: v`, `"k":"v"`, `\"k\":\"v\"`, `--k=v` and
//! `--k v` forms, OAuth `code=` and SAS `sig=` query values, long base64/hex/Azure-secret-like runs, and last the exact
//! literal values of the plugin's env and arguments and of Sextant's own secret-named environment variables. stdout is
//! never read: it carries the ExecCredential with the token.

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
/// Literal values shorter than this are not masked by themselves: a `-v`, `dev` or `json` would cut every text that
/// mentions it into pieces the pattern rules no longer recognise.
const MIN_LITERAL: usize = 6;
/// A positional argument of the plugin (not a flag, a path or a subcommand word) at least this long is masked.
const MIN_POSITIONAL: usize = 8;
/// Stands for a masked value while the text is still being masked, so a later rule never matches inside `<hidden>`.
/// Control characters are removed before masking, so it cannot come from the plugin.
const MARK: char = '\u{1}';

/// The literal values that may be secrets: every value of the exec plugin's env, every argument that follows a flag
/// (`--profile prod`), the value of every `key=value` argument, every positional argument of at least
/// [`MIN_POSITIONAL`] characters that is not a flag, a path or a subcommand word (`get-token`), and the values of
/// Sextant's own environment variables whose names look secret (`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`): the plugin
/// inherits them. Values shorter than [`MIN_LITERAL`] or plain lower-case words are left to the pattern rules.
/// Their exact occurrences are masked. `Debug` never prints them.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ExecSecrets(Vec<String>);

impl fmt::Debug for ExecSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ExecSecrets(<{} hidden>)", self.0.len())
    }
}

impl ExecSecrets {
    /// The values of `exec` (its `env` and `args`) and of this process's secret-named environment variables to mask.
    pub fn of(exec: &kube::config::ExecConfig) -> Self {
        let process = std::env::vars_os().filter_map(|(name, value)| {
            Some((name.into_string().ok()?, value.into_string().ok()?))
        });
        Self::collect(exec, process)
    }

    /// [`ExecSecrets::of`] with the process environment given.
    fn collect(
        exec: &kube::config::ExecConfig,
        process_env: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        let env = exec
            .env
            .iter()
            .flatten()
            .filter_map(|pair| pair.get("value").cloned());
        let process = process_env
            .into_iter()
            .filter(|(name, _)| secret_env_name(name))
            .map(|(_, value)| value);
        Self::from_parts(env.chain(process), exec.args.as_deref().unwrap_or_default())
    }

    fn from_parts(env: impl IntoIterator<Item = String>, args: &[String]) -> Self {
        let mut values: Vec<String> = env.into_iter().collect();
        for (i, arg) in args.iter().enumerate() {
            if let Some((_, value)) = arg.split_once('=') {
                values.push(value.to_owned());
            }
            let after_flag = i > 0 && args[i - 1].starts_with('-') && !args[i - 1].contains('=');
            // A flag's value, or a positional argument that may be a secret.
            let flag_value = after_flag && !arg.starts_with('-');
            if flag_value || (!after_flag && secret_positional(arg)) {
                values.push(arg.clone());
            }
        }
        values.retain(|v| worth_masking(v));
        // Longest first, so a value that contains another is masked whole.
        values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        values.dedup();
        Self(values)
    }
}

/// A literal long enough, and not a plain lower-case word, to be masked wherever it appears.
fn worth_masking(value: &str) -> bool {
    let value = value.trim();
    value.chars().count() >= MIN_LITERAL && !value.chars().all(|c| c.is_ascii_lowercase())
}

/// A positional argument (no flag before it) that may be a secret: long, and not a flag, a `key=value` (its value is
/// taken separately), a path or a subcommand word made of lower-case letters and separators.
fn secret_positional(arg: &str) -> bool {
    static WORD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z]+(?:[-_.][a-z]+)*$").unwrap());
    let path =
        arg.contains('/') || arg.contains('\\') || arg.starts_with('~') || arg.starts_with('.');
    arg.chars().count() >= MIN_POSITIONAL
        && !arg.starts_with('-')
        && !arg.contains('=')
        && !path
        && !WORD.is_match(arg)
}

/// An environment variable name that says its value is a secret (`VAULT_TOKEN`, `DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`,
/// `OPENAI_API_KEY`); `PWD`/`OLDPWD` (the working directory) and `*_KEYBOARD`-like names are not.
fn secret_env_name(name: &str) -> bool {
    static NAME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|COOKIE|(?:^|_)(?:API_?|PRIVATE_?|ACCESS_?|AUTH_?)?KEY(?:$|_)|APIKEY",
        )
        .unwrap()
    });
    NAME.is_match(name)
}

/// The plugin's stderr as the window shows it: the last [`MAX_LINES`] lines within [`MAX_BYTES`], without terminal
/// escapes or control characters, masked over the whole read tail first. `None` when it printed nothing readable.
pub fn masked_stderr(stderr: &[u8], secrets: &ExecSecrets) -> Option<String> {
    let cut = stderr.len() > MAX_READ_BYTES;
    let tail = &stderr[stderr.len().saturating_sub(MAX_READ_BYTES)..];
    let mut text = sanitize(&String::from_utf8_lossy(tail));
    if cut {
        // The first line was cut in the middle (a single line is kept: it keeps its end).
        if let Some(end) = text.find('\n') {
            text.drain(..=end);
        }
    }
    // Masked whole before cutting, so a secret whose start (`-----BEGIN`, `--password`, `token: |`) lies before
    // the kept lines is still recognised.
    let masked = mask(&text, secrets);
    let mut lines: Vec<&str> = masked.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let mut dropped = lines.len() > MAX_LINES || cut;
    let kept = &lines[lines.len().saturating_sub(MAX_LINES)..];
    let start = kept.iter().position(|l| !l.trim().is_empty())?;
    let joined = kept[start..].join("\n");
    let clipped = clip_lines(&joined, MAX_BYTES);
    if clipped.len() < joined.len() {
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
const KEYS: &str = r"(?:[a-z0-9]+[_-])*(?:token|passw(?:or)?d|passphrase|pass|pwd|secret|client[_-]?secret|api[_-]?key|private[_-]?key|secret[_-]?access[_-]?key|authorization)";
/// Names that are secrets only where the form leaves no doubt (`k=v`, a quoted JSON key, a flag, a YAML block): in
/// prose `credentials: not found` or `exit code: 1` are words. `code` and `sig` (OAuth code, SAS signature) without a
/// prefix, so `error_code=5` stays.
const WEAK_KEYS: &str = r"(?:(?:[a-z0-9]+[_-])*(?:credentials?|cookie)|code|sig)";

/// `text` with every secret-looking value replaced by [`HIDDEN`]: the pattern rules first, then the literal values,
/// so a short literal never cuts a token into pieces the patterns would no longer recognise.
fn mask(text: &str, secrets: &ExecSecrets) -> String {
    static PEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]{1,40}-----.*?(?:-----END [A-Z0-9 ]{1,40}-----|\z)")
            .unwrap()
    });
    static JWT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}").unwrap());
    // Tokens whose prefix names them: AWS access keys, Vault (`s.` + 24, `hvs.`/`hvb.`/`hvr.`), GitLab personal
    // access tokens, GitHub tokens, Slack tokens.
    static PREFIXED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}\b|s\.[A-Za-z0-9]{24}\b|hv[sbr]\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})",
        )
        .unwrap()
    });
    static BEARER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b(bearer\s+)[^\s"',;\\]+|\b(basic\s+)[A-Za-z0-9+/=]{8,}"#).unwrap()
    });
    static COOKIE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?im)\b((?:set-)?cookie\s*:[ \t]*)[^\n]*[^\s]").unwrap());
    // `k=v`, `k: v`, `"k":"v"`, `\"k\":\"v\"`, `--k=v`; the value is quoted (also with escaped quotes) or runs to a
    // space or separator.
    static FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r#"(?i)\b({KEYS}(?:\\?")?\s*[:=]\s*)({VALUE})"#)).unwrap()
    });
    static WEAK_FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r#"(?i)(?:\b({WEAK_KEYS}\s*=\s*)|(\\?"{WEAK_KEYS}\\?"\s*:\s*))({VALUE})"#
        ))
        .unwrap()
    });
    // `--k v`, also across a line end; the value stops at a closing bracket, a quote or a separator.
    static FLAG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r#"(?i)(--(?:{KEYS}|{WEAK_KEYS})\s+)([^\s\-{MARK})\]}}"',;][^\s)\]}}"',;]*)"#
        ))
        .unwrap()
    });
    static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/_=-]{32,}").unwrap());
    // Azure client secrets and the like: `~` and `.` inside the run.
    static TILDE_RUN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[A-Za-z0-9_~.-]{32,}").unwrap());

    let mark = MARK.to_string();
    let text = mask_yaml_blocks(text);
    let text = PEM.replace_all(&text, mark.as_str());
    let text = JWT.replace_all(&text, mark.as_str());
    let text = PREFIXED.replace_all(&text, mark.as_str());
    let text = BEARER.replace_all(&text, |c: &Captures| {
        let prefix = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        format!("{prefix}{MARK}")
    });
    let text = COOKIE.replace_all(&text, |c: &Captures| format!("{}{MARK}", &c[1]));
    let text = FIELD.replace_all(&text, |c: &Captures| masked_value(&c[1], &c[2]));
    let text = WEAK_FIELD.replace_all(&text, |c: &Captures| {
        let prefix = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        masked_value(prefix, &c[3])
    });
    let text = FLAG.replace_all(&text, |c: &Captures| format!("{}{MARK}", &c[1]));
    // Runs with `~` or `.` first, whole: RUN would otherwise mask only the part after the `~` of an Azure secret.
    let text = TILDE_RUN.replace_all(&text, |c: &Captures| {
        let run = &c[0];
        let dotted = run.contains('.') && !hostname_like(run);
        if looks_random(run) && (run.contains('~') || dotted) {
            mark.clone()
        } else {
            run.to_owned()
        }
    });
    let text = RUN.replace_all(&text, |c: &Captures| {
        let run = &c[0];
        if looks_random(run) {
            mark.clone()
        } else {
            run.to_owned()
        }
    });
    let mut text = text.into_owned();
    for value in &secrets.0 {
        text = text.replace(value.as_str(), &mark);
    }
    text.replace(MARK, HIDDEN)
}

/// A field's value: quoted (`"…"`, `'…'`, or `\"…\"` inside escaped JSON) or unquoted up to a space or separator.
const VALUE: &str = r#"\\"(?:[^\\\n]|\\[^"\n])*\\"|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;&'"\x01]+"#;

/// `prefix` and the masked `value`, its quotes kept.
fn masked_value(prefix: &str, value: &str) -> String {
    for quote in [r#"\""#, "\"", "'"] {
        if value.len() >= 2 * quote.len() && value.starts_with(quote) && value.ends_with(quote) {
            return format!("{prefix}{quote}{MARK}{quote}");
        }
    }
    format!("{prefix}{MARK}")
}

/// YAML block scalars of secret fields (`token: |`, `private_key: >-`): the header's value and every following line
/// indented deeper (or blank) become one masked value.
fn mask_yaml_blocks(text: &str) -> String {
    static HEADER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r#"(?i)^([ ]*(?:-[ ]+)?["']?(?:{KEYS}|{WEAK_KEYS})["']?[ ]*:[ ]*)[|>][-+0-9]*[ ]*$"#
        ))
        .unwrap()
    });
    let indent = |line: &str| line.len() - line.trim_start_matches(' ').len();
    let mut out: Vec<String> = Vec::new();
    let mut block: Option<usize> = None;
    for line in text.split('\n') {
        if let Some(header_indent) = block {
            if line.trim().is_empty() || indent(line) > header_indent {
                continue;
            }
            block = None;
        }
        match HEADER.captures(line) {
            Some(c) => {
                block = Some(indent(line));
                out.push(format!("{}{MARK}", &c[1]));
            }
            None => out.push(line.to_owned()),
        }
    }
    out.join("\n")
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

/// A dotted name (`web-7f9c.Prod-EU1.svc.cluster.local`): at least two non-empty labels of letters, digits and
/// hyphens, the last one letters only.
fn hostname_like(run: &str) -> bool {
    let labels: Vec<&str> = run.split('.').collect();
    labels.len() >= 2
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && labels
            .last()
            .is_some_and(|l| l.len() >= 2 && l.chars().all(|c| c.is_ascii_alphabetic()))
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
