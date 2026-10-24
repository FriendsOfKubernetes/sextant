//! Reading the answers: only the fields the views need, every text clipped and every URI in it cleaned, an element
//! that does not read skipped; then Prometheus' and Alertmanager's alerts merged and sorted.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{
    Alert, AlertLink, AlertOrigin, AlertState, MAX_ANNOTATION_BYTES, MAX_LABEL_BYTES, MAX_LABELS,
    MAX_LINKS, MAX_OTHER_ANNOTATIONS, MAX_SILENCES, Silence, SilenceMatcher, SilenceState,
};
use crate::error::{CoreError, CoreResult, ErrorCode};

/// An element read on its own: one that does not have the expected shape is skipped, not the whole answer.
struct Lenient<T>(Option<T>);

impl<'de, T: DeserializeOwned> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        Ok(Lenient(serde_json::from_value(value).ok()))
    }
}

fn read_all<T>(items: Vec<Lenient<T>>) -> impl Iterator<Item = T> {
    items.into_iter().filter_map(|l| l.0)
}

// ---------------------------------------------------------------------------------------------------------------
// Texts

/// `text` cut to at most `max` bytes (at a character boundary, with `…`).
pub(crate) fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^([A-Za-z][A-Za-z0-9+.\-]*:)(/*)(.*)$").expect("scheme"));
static LEADING_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^/]*@").expect("userinfo"));
/// URI-looking parts of a free text, as `src/resources/uri.ts` finds them: `scheme:/…` (one slash or more), and
/// `user:password@host…` without a scheme; a part ends at whitespace, a quote or an angle bracket.
static URI_IN_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)[a-z][a-z0-9+.\-]*:/+[^\s"'`<>]+|[^\s"'`<>/@:]+:[^\s"'`<>/@]*@[^\s"'`<>]+"#)
        .expect("uri in text")
});

/// A URI as it may be shown, as `safeUri` in `src/resources/uri.ts` (ADR-0115): trimmed, everything from the first `?`
/// or `#` dropped, and the userinfo (up to the last `@` after `scheme:` and its slashes; without a scheme up to the
/// `@` before the first `/`) dropped. The text and whether anything was left out; `None` for nothing.
pub fn safe_uri(value: &str) -> Option<(String, bool)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cut = trimmed.find(['?', '#']);
    let main = &trimmed[..cut.unwrap_or(trimmed.len())];
    let mut hidden = cut.is_some();
    if let Some(caps) = SCHEME.captures(main) {
        let (scheme, slashes, rest) = (&caps[1], &caps[2], &caps[3]);
        if !slashes.is_empty() || !rest.contains('@') {
            let at = rest.rfind('@');
            hidden |= at.is_some();
            let host = at.map_or(rest, |i| &rest[i + 1..]);
            return Some((format!("{scheme}{slashes}{host}"), hidden));
        }
    }
    let text = LEADING_USERINFO.replace(main, "").into_owned();
    hidden |= text != main;
    Some((text, hidden))
}

/// A free text with every URI-looking part cleaned as [`safe_uri`] cleans a URI.
pub fn clean_text(text: &str) -> String {
    URI_IN_TEXT
        .replace_all(text, |caps: &regex::Captures| {
            safe_uri(&caps[0]).map(|(t, _)| t).unwrap_or_default()
        })
        .into_owned()
}

/// A cleaned, clipped text; `None` for an empty one.
fn text(value: Option<&String>, max: usize) -> Option<String> {
    let cleaned = clean_text(value?.trim());
    (!cleaned.is_empty()).then(|| clip(&cleaned, max))
}

/// An `http(s)` link to `scheme://host…`, cleaned; `None` for anything else.
fn link(key: &str, value: &str) -> Option<AlertLink> {
    let (url, cleaned) = safe_uri(value)?;
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    if rest.is_empty() || rest.starts_with('/') || url.len() > MAX_ANNOTATION_BYTES {
        return None;
    }
    Some(AlertLink {
        key: clip(key, 128),
        url,
        cleaned,
    })
}

/// Annotation names whose value is offered as a link when it is an `http(s)` URL (kube-prometheus' `runbook_url`,
/// Grafana's `dashboard`/`__dashboardUid__`-style keys, any `…url`).
fn is_link_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.ends_with("url") || key == "runbook" || key == "dashboard" || key == "playbook"
}

/// FNV-1a over the label pairs: the id of an alert read from Prometheus (its labels are its identity).
fn label_hash(labels: &BTreeMap<String, String>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (k, v) in labels {
        for byte in k.bytes().chain([0xff]).chain(v.bytes()).chain([0xfe]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("p{hash:016x}")
}

// ---------------------------------------------------------------------------------------------------------------
// Alerts

/// What both sources say about an alert, before it is clipped.
struct Parts {
    labels: BTreeMap<String, String>,
    annotations: BTreeMap<String, String>,
    state: AlertState,
    active_at: Option<String>,
    origin: AlertOrigin,
    id: String,
    fallback_name: Option<String>,
    silenced_by: Vec<String>,
    inhibited_by: Vec<String>,
}

fn alert(parts: Parts) -> Alert {
    let Parts {
        labels: raw_labels,
        annotations,
        ..
    } = &parts;
    let labels: BTreeMap<String, String> = raw_labels
        .iter()
        .take(MAX_LABELS)
        .map(|(k, v)| (clip(k, 128), clip(v, MAX_LABEL_BYTES)))
        .collect();
    let name = raw_labels
        .get("alertname")
        .or(parts.fallback_name.as_ref())
        .map(|n| clip(n, 256))
        .unwrap_or_default();
    let severity = raw_labels
        .get("severity")
        .map(|s| clip(&s.trim().to_lowercase(), 32))
        .filter(|s| !s.is_empty());
    let summary = text(
        annotations.get("summary").or(annotations.get("message")),
        MAX_ANNOTATION_BYTES,
    );
    let description = text(annotations.get("description"), MAX_ANNOTATION_BYTES);
    let mut links = Vec::new();
    let mut others = Vec::new();
    for (key, value) in annotations {
        if matches!(key.as_str(), "summary" | "description")
            || (key == "message" && !annotations.contains_key("summary"))
        {
            continue;
        }
        let as_link = (is_link_key(key)
            || value.trim_start().to_ascii_lowercase().starts_with("http"))
        .then(|| link(key, value))
        .flatten();
        match as_link {
            Some(l) if links.len() < MAX_LINKS => links.push(l),
            Some(_) => {}
            None if others.len() < MAX_OTHER_ANNOTATIONS => {
                if let Some(t) = text(Some(value), MAX_ANNOTATION_BYTES) {
                    others.push((clip(key, 128), t));
                }
            }
            None => {}
        }
    }
    let ids = |list: &[String]| list.iter().take(32).map(|s| clip(s, 64)).collect();
    Alert {
        id: clip(&parts.id, 64),
        name,
        state: parts.state,
        severity,
        labels,
        summary,
        description,
        annotations: others,
        links,
        active_at: parts.active_at.as_deref().map(|t| clip(t, 64)),
        origin: parts.origin,
        silenced_by: ids(&parts.silenced_by),
        inhibited_by: ids(&parts.inhibited_by),
    }
}

/// An alert of Prometheus' (or vmalert's) `api/v1/alerts`.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPromAlert {
    labels: BTreeMap<String, String>,
    annotations: BTreeMap<String, String>,
    state: String,
    #[serde(rename = "activeAt")]
    active_at: Option<String>,
    /// vmalert's rule name (its alerts carry `alertname` too).
    name: Option<String>,
}

#[derive(Deserialize)]
struct PromAnswer {
    status: String,
    #[serde(default)]
    data: Option<PromData>,
}

#[derive(Deserialize)]
struct PromData {
    alerts: Vec<Lenient<RawPromAlert>>,
}

/// The firing and pending alerts of a Prometheus HTTP API answer; an error answer as the metrics client tells it.
pub(super) fn prometheus_alerts(status: http::StatusCode, body: &[u8]) -> CoreResult<Vec<Alert>> {
    if status.is_success()
        && let Ok(answer) = serde_json::from_slice::<PromAnswer>(body)
        && answer.status == "success"
        && let Some(data) = answer.data
    {
        return Ok(read_all(data.alerts)
            .filter_map(|raw| {
                let state = match raw.state.as_str() {
                    "firing" => AlertState::Firing,
                    "pending" => AlertState::Pending,
                    _ => return None,
                };
                Some(alert(Parts {
                    id: label_hash(&raw.labels),
                    labels: raw.labels,
                    annotations: raw.annotations,
                    state,
                    // A zero time (vmalert's "never") says nothing.
                    active_at: raw.active_at.filter(|t| !t.starts_with("0001-")),
                    origin: AlertOrigin::Prometheus,
                    fallback_name: raw.name,
                    silenced_by: Vec::new(),
                    inhibited_by: Vec::new(),
                }))
            })
            .collect());
    }
    crate::metrics::prometheus_answer_data(status, body).and_then(|_| {
        Err(CoreError::new(
            ErrorCode::Invalid,
            "the answer is not the alert list of the Prometheus HTTP API",
        ))
    })
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawAmStatus {
    state: String,
    silenced_by: Vec<String>,
    inhibited_by: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawAmAlert {
    labels: BTreeMap<String, String>,
    annotations: BTreeMap<String, String>,
    fingerprint: String,
    starts_at: Option<String>,
    status: RawAmStatus,
}

fn not_alertmanager() -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        "the answer is not from the Alertmanager API v2",
    )
}

/// The alerts of Alertmanager's `api/v2/alerts`: active (and not yet processed) ones are firing; a suppressed one is
/// silenced when a silence holds it, inhibited when only an inhibition does, and counts as silenced when it is muted by
/// a time interval (nobody is notified either way).
pub(super) fn alertmanager_alerts(body: &[u8]) -> CoreResult<Vec<Alert>> {
    let raw: Vec<Lenient<RawAmAlert>> =
        serde_json::from_slice(body).map_err(|_| not_alertmanager())?;
    Ok(read_all(raw)
        .map(|raw| {
            let status = raw.status;
            let state = match status.state.as_str() {
                "suppressed"
                    if status.silenced_by.is_empty() && !status.inhibited_by.is_empty() =>
                {
                    AlertState::Inhibited
                }
                "suppressed" => AlertState::Silenced,
                _ => AlertState::Firing,
            };
            let id = if raw.fingerprint.is_empty() {
                label_hash(&raw.labels)
            } else {
                raw.fingerprint
            };
            alert(Parts {
                labels: raw.labels,
                annotations: raw.annotations,
                state,
                active_at: raw.starts_at,
                origin: AlertOrigin::Alertmanager,
                id,
                fallback_name: None,
                silenced_by: status.silenced_by,
                inhibited_by: status.inhibited_by,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Silences

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMatcher {
    name: String,
    value: String,
    #[serde(default)]
    is_regex: bool,
    /// Alertmanager before 0.22 had no negative matchers and sends no `isEqual`.
    #[serde(default = "yes")]
    is_equal: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawSilenceStatus {
    state: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawSilence {
    id: String,
    status: RawSilenceStatus,
    matchers: Vec<Lenient<RawMatcher>>,
    starts_at: Option<String>,
    ends_at: Option<String>,
    created_by: Option<String>,
    comment: Option<String>,
}

/// The active and pending silences of Alertmanager's `api/v2/silences` (active first, the soonest to end first; at
/// most [`MAX_SILENCES`]) and how many expired ones it keeps.
pub(super) fn silences(body: &[u8]) -> CoreResult<(Vec<Silence>, u32)> {
    let raw: Vec<Lenient<RawSilence>> =
        serde_json::from_slice(body).map_err(|_| not_alertmanager())?;
    let mut expired: u32 = 0;
    let mut out: Vec<Silence> = Vec::new();
    for raw in read_all(raw) {
        let state = match raw.status.state.as_str() {
            "active" => SilenceState::Active,
            "pending" => SilenceState::Pending,
            _ => {
                expired = expired.saturating_add(1);
                continue;
            }
        };
        out.push(Silence {
            id: clip(&raw.id, 64),
            state,
            matchers: read_all(raw.matchers)
                .take(MAX_LABELS)
                .map(|m| SilenceMatcher {
                    name: clip(&m.name, 128),
                    value: clip(&m.value, MAX_LABEL_BYTES),
                    is_regex: m.is_regex,
                    is_equal: m.is_equal,
                })
                .collect(),
            starts_at: raw.starts_at.map(|t| clip(&t, 64)),
            ends_at: raw.ends_at.map(|t| clip(&t, 64)),
            created_by: text(raw.created_by.as_ref(), 256),
            comment: text(raw.comment.as_ref(), MAX_ANNOTATION_BYTES),
        });
    }
    out.sort_by(|a, b| {
        (a.state != SilenceState::Active, &a.ends_at, &a.id).cmp(&(
            b.state != SilenceState::Active,
            &b.ends_at,
            &b.id,
        ))
    });
    out.truncate(MAX_SILENCES);
    Ok((out, expired))
}

// ---------------------------------------------------------------------------------------------------------------
// Merging and order

/// The order of severities: the usual names first, then any other, then none.
pub(crate) fn severity_rank(severity: Option<&str>) -> u8 {
    match severity {
        Some("critical") => 0,
        Some("error" | "high") => 1,
        Some("warning" | "medium") => 2,
        Some("info" | "low") => 3,
        Some("none") | None => 5,
        Some(_) => 4,
    }
}

/// Whether every label of `alert` is one of `held`'s with the same value: Alertmanager's copy of an alert has the
/// rule's labels plus Prometheus' external labels.
fn covers(held: &Alert, alert: &Alert) -> bool {
    alert
        .labels
        .iter()
        .all(|(k, v)| held.labels.get(k) == Some(v))
}

/// Alertmanager's alerts (`held`, when it answered) and Prometheus' pending ones, and Prometheus' firing ones that
/// Alertmanager does not hold (not sent yet, or sent to another Alertmanager); without an Alertmanager every alert
/// Prometheus gives. Sorted by severity, name, state, then the oldest first.
pub(super) fn merge(held: Option<Vec<Alert>>, prometheus: Vec<Alert>) -> Vec<Alert> {
    let present = held.is_some();
    let mut out = held.unwrap_or_default();
    let keep: Vec<bool> = {
        let mut by_name: HashMap<&str, Vec<&Alert>> = HashMap::new();
        for a in &out {
            by_name.entry(a.name.as_str()).or_default().push(a);
        }
        prometheus
            .iter()
            .map(|p| {
                p.state == AlertState::Pending
                    || !present
                    || !by_name
                        .get(p.name.as_str())
                        .is_some_and(|list| list.iter().any(|h| covers(h, p)))
            })
            .collect()
    };
    out.extend(
        prometheus
            .into_iter()
            .zip(keep)
            .filter_map(|(p, k)| k.then_some(p)),
    );
    out.sort_by(|a, b| {
        (
            severity_rank(a.severity.as_deref()),
            &a.name,
            a.state,
            &a.active_at,
            &a.id,
        )
            .cmp(&(
                severity_rank(b.severity.as_deref()),
                &b.name,
                b.state,
                &b.active_at,
                &b.id,
            ))
    });
    out
}
