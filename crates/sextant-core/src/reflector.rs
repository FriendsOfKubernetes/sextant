//! emberstack Reflector's namespace patterns (#241, ADR-0110), matched in linear time.
//!
//! A source's `reflection-allowed-namespaces` / `reflection-auto-namespaces` annotation is a comma-separated list of
//! .NET regular expressions; Reflector's `PatternListMatch` runs `Regex.Match(name, pattern)` and takes the pattern as
//! matching when that first match is the whole name. These patterns come from cluster objects, so they are not run by
//! a backtracking engine (the window's JavaScript `RegExp` can be frozen for seconds by `(a|a)*b`): the `regex` crate
//! guarantees time linear in the pattern and the name, and its compiled size is capped.
//!
//! Its semantics are leftmost-first like .NET's, so its first match (`find`) is the one `Regex.Match` returns.
//! Where the two syntaxes differ the pattern is not run but "cannot tell", never a match or a mismatch:
//!   - .NET syntax the crate refuses (backreferences, lookaround, atomic groups, `\Z`, `\G`, `(?n)`, comments, …);
//!   - syntax both accept with different meanings, refused before compiling ([`dotnet_divergence`]): a `[` inside a
//!     character class (Rust's nested and POSIX classes, .NET's subtraction), `&&` / `--` / `~~` in a class, `\x{…}`,
//!     `\u{…}`, `\U…`, `\<`, `\>`, `\b{…}`, `\p` without braces or with a name that is no general category (.NET block
//!     names `IsGreek` vs Rust scripts), a digit escape, a `{` that is not a .NET quantifier (`{,3}`, `{ 2 }`),
//!     a quantifier on a quantifier (.NET's "nested quantifier" error), the flags `x`, `U`, `u`, `R`, and `(?P<…>`.
//!
//! Pure: no cluster, no I/O. The window calls it through `reflector_match_patterns`; agents and extensions do not.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};

/// A pattern longer than this (in characters) is not run.
pub const MAX_PATTERN_LENGTH: usize = 256;
/// Patterns per call.
pub const MAX_PATTERNS: usize = 64;
/// Names per call.
pub const MAX_NAMES: usize = 2000;
/// A name longer than this (a namespace name is at most 63) is refused.
pub const MAX_NAME_LENGTH: usize = 253;
/// The compiled program and the lazy DFA's cache of one pattern, at most.
pub const SIZE_LIMIT: usize = 1 << 20;

/// Whether a pattern matches a name as Reflector takes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PatternMatch {
    Yes,
    No,
    /// The pattern is not run: see its [`PatternIssue`].
    CannotTell,
}

/// Why a pattern is not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PatternIssue {
    /// Not a regular expression Sextant can run the way .NET does (invalid, or .NET syntax handled differently).
    Invalid,
    /// Longer than [`MAX_PATTERN_LENGTH`], or compiled larger than [`SIZE_LIMIT`].
    NotEvaluated,
}

/// One pattern against every name of the call, in the order of the names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PatternMatches {
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<PatternIssue>,
    pub matches: Vec<PatternMatch>,
}

/// Each of `patterns` against each of `names`: `result[i].matches[j]` is pattern `i` on name `j`.
pub fn match_patterns(patterns: &[String], names: &[String]) -> CoreResult<Vec<PatternMatches>> {
    if patterns.len() > MAX_PATTERNS {
        return Err(invalid(format!("at most {MAX_PATTERNS} patterns per call")));
    }
    if names.len() > MAX_NAMES {
        return Err(invalid(format!("at most {MAX_NAMES} names per call")));
    }
    if names.iter().any(|n| n.len() > MAX_NAME_LENGTH) {
        return Err(invalid(format!(
            "a name is longer than {MAX_NAME_LENGTH} bytes"
        )));
    }
    Ok(patterns
        .iter()
        .map(|pattern| match compile(pattern) {
            Ok(re) => PatternMatches {
                issue: None,
                matches: names
                    .iter()
                    .map(|name| {
                        if whole_match(&re, name) {
                            PatternMatch::Yes
                        } else {
                            PatternMatch::No
                        }
                    })
                    .collect(),
            },
            Err(issue) => PatternMatches {
                issue: Some(issue),
                matches: vec![PatternMatch::CannotTell; names.len()],
            },
        })
        .collect())
}

fn invalid(message: String) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// `Regex.Match(name).Value == name`: the first (leftmost-first) match is the whole name.
fn whole_match(re: &Regex, name: &str) -> bool {
    re.find(name)
        .is_some_and(|m| m.start() == 0 && m.end() == name.len())
}

/// The pattern compiled with the size caps, or why it is not run.
pub fn compile(pattern: &str) -> Result<Regex, PatternIssue> {
    if pattern.chars().count() > MAX_PATTERN_LENGTH {
        return Err(PatternIssue::NotEvaluated);
    }
    if dotnet_divergence(pattern) {
        return Err(PatternIssue::Invalid);
    }
    RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(SIZE_LIMIT)
        .build()
        .map_err(|err| match err {
            regex::Error::CompiledTooBig(_) => PatternIssue::NotEvaluated,
            _ => PatternIssue::Invalid,
        })
}

/// The Unicode general categories .NET accepts in `\p{…}`; the crate reads them alike.
const GENERAL_CATEGORIES: &[&str] = &[
    "L", "Lu", "Ll", "Lt", "Lm", "Lo", "M", "Mn", "Mc", "Me", "N", "Nd", "Nl", "No", "P", "Pc",
    "Pd", "Ps", "Pe", "Pi", "Pf", "Po", "S", "Sm", "Sc", "Sk", "So", "Z", "Zs", "Zl", "Zp", "C",
    "Cc", "Cf", "Cs", "Co", "Cn",
];

/// Whether `pattern` uses syntax that the crate and .NET would read differently (see the module header). Errs on the
/// side of "yes": such a pattern is "cannot tell".
pub fn dotnet_divergence(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    let mut in_class = false;
    // The position right after `[` (or `[^`): a `]` there is a literal.
    let mut class_start = 0;
    // The previous token was a quantifier (`*`, `+`, `?`, `{n,m}`), and whether a lazy `?` already followed it.
    let mut after_quantifier = false;
    let mut lazy = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let Some(&next) = chars.get(i + 1) else {
                return true;
            };
            if escape_diverges(&chars, i + 1, in_class) {
                return true;
            }
            // `\p{…}` / `\x41` / `A` are skipped as a whole below by their own lengths; others are one char.
            i += 2;
            if matches!(next, 'p' | 'P') {
                while i < chars.len() && chars[i] != '}' {
                    i += 1;
                }
                i += 1;
            }
            after_quantifier = false;
            lazy = false;
            continue;
        }
        if in_class {
            match c {
                ']' if i != class_start => in_class = false,
                '[' => return true,
                '&' | '-' | '~' if chars.get(i + 1) == Some(&c) => return true,
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            '[' => {
                in_class = true;
                i += 1;
                if chars.get(i) == Some(&'^') {
                    i += 1;
                }
                class_start = i;
                after_quantifier = false;
                continue;
            }
            '*' | '+' => {
                if after_quantifier {
                    return true;
                }
                after_quantifier = true;
                lazy = false;
            }
            '?' => {
                if after_quantifier && !lazy {
                    lazy = true;
                } else if after_quantifier {
                    return true;
                } else {
                    after_quantifier = true;
                    lazy = false;
                }
            }
            '{' => {
                let Some(len) = dotnet_quantifier(&chars[i..]) else {
                    return true;
                };
                if after_quantifier {
                    return true;
                }
                after_quantifier = true;
                lazy = false;
                i += len;
                continue;
            }
            '(' => {
                after_quantifier = false;
                lazy = false;
                if chars.get(i + 1) == Some(&'?') {
                    if group_diverges(&chars[i + 2..]) {
                        return true;
                    }
                    // The `?` opens the group; it is no quantifier.
                    i += 2;
                    continue;
                }
            }
            _ => after_quantifier = false,
        }
        if c != '*' && c != '+' && c != '?' {
            lazy = false;
        }
        i += 1;
    }
    in_class
}

/// The escape whose letter is at `at` (right after the backslash).
fn escape_diverges(chars: &[char], at: usize, in_class: bool) -> bool {
    let c = chars[at];
    let rest = &chars[at + 1..];
    match c {
        // .NET octal or a backreference; the crate refuses both or reads them otherwise.
        '0'..='9' => true,
        'p' | 'P' => {
            if rest.first() != Some(&'{') {
                return true;
            }
            let Some(end) = rest.iter().position(|&c| c == '}') else {
                return true;
            };
            let name: String = rest[1..end].iter().collect();
            !GENERAL_CATEGORIES.contains(&name.as_str())
        }
        'x' => !(rest.len() >= 2 && rest[..2].iter().all(char::is_ascii_hexdigit)),
        'u' => !(rest.len() >= 4 && rest[..4].iter().all(char::is_ascii_hexdigit)),
        'U' | '<' | '>' => true,
        // A backspace in a .NET class; `\b{start}` and the like in the crate.
        'b' => in_class || rest.first() == Some(&'{'),
        _ => false,
    }
}

/// `{n}`, `{n,}` or `{n,m}` with digits only, as .NET reads a quantifier: its length; anything else is `None` (a
/// literal `{` in .NET, an error or another quantifier in the crate).
fn dotnet_quantifier(chars: &[char]) -> Option<usize> {
    let close = chars.iter().position(|&c| c == '}')?;
    let inner: String = chars[1..close].iter().collect();
    let (min, max) = match inner.split_once(',') {
        Some((min, max)) => (min, Some(max)),
        None => (inner.as_str(), None),
    };
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let ok = digits(min) && max.is_none_or(|m| m.is_empty() || digits(m));
    ok.then_some(close + 1)
}

/// The text after `(?`: a group the crate reads otherwise than .NET.
fn group_diverges(rest: &[char]) -> bool {
    match rest.first() {
        // `(?P<name>…)`: the crate's syntax, an error in .NET.
        Some('P') => true,
        // `(?<name>…)`: .NET names are word characters (the crate also takes `.`, `[`, `]`); lookbehind is refused by
        // the crate anyway.
        Some('<') => {
            let name: String = rest[1..].iter().take_while(|&&c| c != '>').collect();
            !matches!(rest.get(1), Some('=' | '!'))
                && !name.chars().all(|c| c.is_alphanumeric() || c == '_')
        }
        // Inline flags: `i`, `m`, `s` mean the same in both; the crate's `x` also ignores whitespace in classes,
        // `U`, `u` and `R` are its own.
        _ => rest
            .iter()
            .take_while(|&&c| c != ':' && c != ')')
            .any(|c| matches!(c, 'x' | 'U' | 'u' | 'R')),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn one(pattern: &str, name: &str) -> PatternMatch {
        let out = match_patterns(&[pattern.to_string()], &[name.to_string()]).unwrap();
        out[0].matches[0]
    }

    use PatternMatch::{CannotTell, No, Yes};

    #[test]
    fn reflectors_own_examples() {
        // README: "namespace-1,namespace-2,namespace-[0-9]*".
        for (name, want) in [
            ("namespace-1", Yes),
            ("namespace-30", Yes),
            ("namespace-", Yes),
            ("xnamespace-1", No),
            ("namespace-1x", No),
        ] {
            assert_eq!(one("namespace-[0-9]*", name), want, "{name}");
        }
        assert_eq!(one("namespace-1", "namespace-1"), Yes);
        assert_eq!(one("namespace-1", "namespace-10"), No);
    }

    #[test]
    fn the_first_match_must_be_the_whole_name_as_regex_match_finds_it() {
        // Leftmost-first, as .NET: `a|ab` matches "a" in "ab", so the name is not matched.
        assert_eq!(one("a|ab", "ab"), No);
        assert_eq!(one("ab|a", "ab"), Yes);
        assert_eq!(one("team", "my-team"), No);
        assert_eq!(one(".*team", "my-team"), Yes);
        assert_eq!(one("(?i)TEAM", "team"), Yes);
        assert_eq!(one("^team$", "team"), Yes);
    }

    #[test]
    fn pathological_patterns_run_in_linear_time() {
        let started = Instant::now();
        let long = "a".repeat(26);
        let longer = "a".repeat(253);
        let patterns: Vec<String> = ["(a|a)*b", "((a)+)+b", ".*.*.*.*.*.*.*.*.*x", "(\\w*)*b"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let names: Vec<String> = (0..MAX_NAMES)
            .map(|i| {
                if i % 2 == 0 {
                    long.clone()
                } else {
                    longer.clone()
                }
            })
            .collect();
        let out = match_patterns(&patterns, &names).unwrap();
        for (p, r) in patterns.iter().zip(&out) {
            assert_eq!(r.issue, None, "{p}");
            assert!(r.matches.iter().all(|m| *m == No), "{p}");
        }
        assert_eq!(one("(a+)+$", &long), Yes);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn dotnet_only_syntax_is_cannot_tell_never_a_literal() {
        for p in [
            "(a)\\1",
            "(?=team)team",
            "(?<=a)b",
            "(?>team)",
            "team\\Z",
            "\\Gteam",
            "(?n)team",
            "(?#comment)team",
            "\\p{IsGreek}+",
            "\\pL+",
            "\\k<x>",
            "(?'x'team)",
            "(?<a-b>x)",
        ] {
            let r = &match_patterns(&[p.to_string()], &["team".to_string()]).unwrap()[0];
            assert_eq!(r.matches, vec![CannotTell], "{p}");
            assert_eq!(r.issue, Some(PatternIssue::Invalid), "{p}");
        }
    }

    #[test]
    fn syntax_read_otherwise_by_the_crate_is_refused_before_compiling() {
        for p in [
            "[[:alpha:]]+",
            "[[a]]",
            "[a-z&&[^b]]",
            "[a--b]",
            "[a~~b]",
            "\\x{61}",
            "\\u{61}",
            "\\U00000061",
            "\\<team\\>",
            "\\b{start}team",
            "[\\b]",
            "a{,3}",
            "a{ 2 }",
            "a**",
            "a*+",
            "a{2}*",
            "a??+",
            "(?x)t e a m",
            "(?U)a+",
            "(?-u)a",
            "(?P<n>a)",
            "(?<n.x>a)",
            "\\0",
            "[abc",
            "\\",
        ] {
            assert!(dotnet_divergence(p), "{p}");
            assert_eq!(one(p, "a"), CannotTell, "{p}");
        }
    }

    #[test]
    fn syntax_both_read_alike_runs_with_net_semantics() {
        assert_eq!(one("\\Ateam\\z", "team"), Yes);
        assert_eq!(one("\\p{Ll}+", "team"), Yes);
        assert_eq!(one("\\p{Ll}+", "Team"), No);
        assert_eq!(one("\\P{Lu}+", "team-1"), Yes);
        assert_eq!(one("\\x74eam", "team"), Yes);
        assert_eq!(one("\\u0074eam", "team"), Yes);
        assert_eq!(one("[]a]+", "a]"), Yes);
        assert_eq!(one("[^]a]+", "bc"), Yes);
        assert_eq!(one("ns-[a-z]{1,3}", "ns-abc"), Yes);
        assert_eq!(one("ns-[a-z]{2}", "ns-abc"), No);
        assert_eq!(one("ns-[a-z]{2,}", "ns-abc"), Yes);
        assert_eq!(one("a+?", "aa"), No);
        assert_eq!(one("a*?b", "aab"), Yes);
        assert_eq!(one("(?<team>t)eam", "team"), Yes);
        assert_eq!(one("(?i:T)eam", "team"), Yes);
        assert_eq!(one("\\d+", "123"), Yes);
        assert_eq!(one("[\\w-]+", "team-a"), Yes);
        assert_eq!(one("\\bteam\\b", "team"), Yes);
        assert_eq!(one("prod-\\.?x", "prod-x"), Yes);
    }

    #[test]
    fn too_long_or_too_large_is_not_evaluated() {
        let long = "a".repeat(MAX_PATTERN_LENGTH + 1);
        let r = &match_patterns(&[long], &["a".to_string()]).unwrap()[0];
        assert_eq!(r.issue, Some(PatternIssue::NotEvaluated));
        assert_eq!(r.matches, vec![CannotTell]);
        let big = "(\\w{100}){100}".to_string();
        let r = &match_patterns(&[big], &["a".to_string()]).unwrap()[0];
        assert_eq!(r.issue, Some(PatternIssue::NotEvaluated));
    }

    #[test]
    fn the_call_is_bounded() {
        let p = vec!["a".to_string(); MAX_PATTERNS + 1];
        assert_eq!(
            match_patterns(&p, &[]).unwrap_err().code,
            ErrorCode::Invalid
        );
        let n = vec!["a".to_string(); MAX_NAMES + 1];
        assert_eq!(
            match_patterns(&["a".to_string()], &n).unwrap_err().code,
            ErrorCode::Invalid
        );
        let long = vec!["a".repeat(MAX_NAME_LENGTH + 1)];
        assert_eq!(
            match_patterns(&["a".to_string()], &long).unwrap_err().code,
            ErrorCode::Invalid
        );
        // No names: the issues alone.
        let out = match_patterns(&["(?=x)".to_string(), "x".to_string()], &[]).unwrap();
        assert_eq!(out[0].issue, Some(PatternIssue::Invalid));
        assert_eq!(out[1].issue, None);
        assert!(out[1].matches.is_empty());
    }
}
