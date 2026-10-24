//! The names a workload's controller gives its pods, as a regular expression (RE2 syntax, so PromQL's and LogQL's `=~`,
//! which anchor it, read it alike). Shared by the right-sizing history, the request metrics and Loki's pod lists.
//!
//! How the names are made (Kubernetes 1.28 on):
//! - The API server makes a `generateName` unique (`apiserver/pkg/storage/names/generate.go`): `maxNameLength` 63,
//!   `randomLength` 5, so `MaxGeneratedNameLength` 58 — a base longer than 58 characters is cut to 58, then five
//!   characters of `k8s.io/apimachinery/pkg/util/rand`'s safe alphabet are added.
//! - A ReplicaSet's, DaemonSet's and (non-indexed) Job's pods have the `generateName` `<owner>-`
//!   (`pkg/controller/controller_utils.go` `getPodsPrefix`; the job controller's `podGenerateNameWithIndex` without an
//!   index).
//! - A Deployment's ReplicaSet is `<deployment>-<pod-template-hash>`, uncut (`pkg/controller/deployment/sync.go`), the
//!   hash being `rand.SafeEncodeString` of a 32-bit FNV hash printed in decimal (`controller.ComputeHash`): 1 to 10
//!   characters of the safe alphabet. Its pods are `<cut to 58: <deployment>-<hash>->` + 5.
//! - An indexed Job's pods are `<job>-<index>-` + 5, the Job name cut first so the prefix stays within 58
//!   (`podGenerateNameWithIndex`: `jobName[:58-len(appendIndex)] + appendIndex`).
//! - A CronJob's Jobs are `<cronjob>-<scheduled time in minutes>` (`getJobName`, decimal), their pods as a Job's.
//! - A StatefulSet's pods are `<statefulset>-<ordinal>`, never cut.
//!
//! The hash and the random part use the safe alphabet (no vowels, no 0, 1, 3), so `web-api`'s pods are never taken for
//! `web`'s; a sibling workload whose whole name after `web-` is in that alphabet (`web-db`) can still look like one of
//! `web`'s generated parts, as it would to anyone reading the names.

/// The characters of generated name parts (`k8s.io/apimachinery/pkg/util/rand`).
pub const SAFE: &str = "[bcdfghjklmnpqrstvwxz2456789]";
/// `names.MaxGeneratedNameLength`: a generated name's base is cut to this many characters.
pub const MAX_GENERATED_BASE: usize = 58;
/// The longest pod-template-hash: a `uint32` in decimal.
const MAX_HASH: usize = 10;
/// The longest CronJob schedule part considered: minutes since 1970 in decimal (8 digits until the year 2160).
const MAX_MINUTES: usize = 11;
/// The longest Job completion index (`.spec.completions` ≤ 100 000 for indexed Jobs): 5 digits; one more for safety.
const MAX_INDEX_DIGITS: usize = 6;

/// The workload kinds whose pods [`pod_name_pattern`] knows.
pub const WORKLOAD_KINDS: [&str; 6] = [
    "Deployment",
    "ReplicaSet",
    "StatefulSet",
    "DaemonSet",
    "Job",
    "CronJob",
];

/// A regular expression matching `text` literally.
fn regex_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if r"\.+*?()|[]{}^$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The first `max` characters of `text` (names are ASCII; a character is never split).
fn cut(text: &str, max: usize) -> &str {
    text.char_indices()
        .nth(max)
        .map_or(text, |(i, _)| &text[..i])
}

/// The base `<name>-<part>-` of a generated name, cut to 58 characters, where `<part>` is 1 to `max_part` characters
/// of `class`: the full forms that fit, and the cut ones.
fn generated_base(name: &str, class: &str, max_part: usize) -> String {
    let len = name.chars().count();
    // Room after `<name>-` within the 58.
    let room = MAX_GENERATED_BASE.saturating_sub(len + 1);
    if room == 0 {
        return regex_literal(cut(&format!("{name}-"), MAX_GENERATED_BASE));
    }
    let mut forms = Vec::new();
    // `<part>-` whole: a part of at most `room - 1` characters.
    let whole = max_part.min(room - 1);
    if whole >= 1 {
        forms.push(format!("{class}{{1,{whole}}}-"));
    }
    // Cut inside the part (or right before its dash): exactly `room` characters of it.
    if room <= max_part {
        forms.push(format!("{class}{{{room}}}"));
    }
    let name = regex_literal(name);
    match forms.as_slice() {
        [one] => format!("{name}-{one}"),
        _ => format!("{name}-(?:{})", forms.join("|")),
    }
}

/// `<name>-` cut to 58, as the base of a ReplicaSet's, DaemonSet's or Job's pods.
fn simple_base(name: &str) -> String {
    regex_literal(cut(&format!("{name}-"), MAX_GENERATED_BASE))
}

/// The bases of an indexed Job's pods: `<job>-<index>-`, the Job name cut so the whole stays within 58.
fn indexed_bases(name: &str) -> Vec<String> {
    let len = name.chars().count();
    let mut out: Vec<(String, usize, usize)> = Vec::new();
    for digits in 1..=MAX_INDEX_DIGITS {
        let append = digits + 2;
        let kept = if len + append > MAX_GENERATED_BASE {
            cut(name, MAX_GENERATED_BASE.saturating_sub(append))
        } else {
            name
        };
        match out.last_mut() {
            Some((last, _, hi)) if last == kept => *hi = digits,
            _ => out.push((kept.to_owned(), digits, digits)),
        }
    }
    out.into_iter()
        .map(|(kept, lo, hi)| {
            let digits = if lo == hi {
                format!("{{{lo}}}")
            } else {
                format!("{{{lo},{hi}}}")
            };
            format!("{}-[0-9]{digits}-", regex_literal(&kept))
        })
        .collect()
}

/// The regular expression (not yet a PromQL or LogQL literal; `=~` is anchored) of the names `kind`'s controller gives
/// the pods of the workload `name` (see the module's notes). A kind not in [`WORKLOAD_KINDS`] is read as a ReplicaSet.
pub fn pod_name_pattern(kind: &str, name: &str) -> String {
    match kind {
        "Deployment" => format!("{}{SAFE}{{5}}", generated_base(name, SAFE, MAX_HASH)),
        "StatefulSet" => format!("{}-[0-9]+", regex_literal(name)),
        "CronJob" => format!("{}{SAFE}{{5}}", generated_base(name, "[0-9]", MAX_MINUTES)),
        "Job" => {
            let mut bases = vec![simple_base(name)];
            bases.extend(indexed_bases(name));
            format!("(?:{}){SAFE}{{5}}", bases.join("|"))
        }
        _ => format!("{}{SAFE}{{5}}", simple_base(name)),
    }
}

#[cfg(test)]
mod tests;
