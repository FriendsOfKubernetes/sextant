//! Newer versions of the charts releases run (#209), from the repositories the user added to Helm.
//!
//! Only Helm's local copies of the repository indexes are read, through the `helm` binary ([`HelmCli::chart_versions`],
//! one bounded call per chart name, at most [`PARALLEL_SEARCHES`] at once and [`SEARCH_TIMEOUT`] each); the indexes
//! are downloaded again only by `helm repo update`, which the user starts. Helm does not record where a release's chart
//! came from, so a chart is matched by name: when several repositories have a chart of that name, the one whose index
//! lists the installed version wins (else the one with the newest version), and the others are named. A chart from an
//! OCI registry or a local path is not in any repository index: its latest version is unknown (Helm offers no listing
//! of an OCI repository's tags without pulling).
//!
//! Versions are compared as semantic versions; a prerelease counts only when the installed version is one itself.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::cli::{ChartHit, HelmCli};
use crate::error::{CoreError, CoreResult, ErrorCode};

/// Chart names looked up in one call, at most.
pub const MAX_CHARTS: usize = 200;
/// `helm search` calls running at once.
pub const PARALLEL_SEARCHES: usize = 4;
/// How long one `helm search` may run before it is stopped (its `helm` is killed).
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A chart a release runs: its name and version as the release stores them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledChart {
    pub chart: String,
    pub version: String,
}

/// How far a newer version is from the installed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VersionStep {
    Patch,
    Minor,
    Major,
}

/// What the repositories know about one installed chart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartUpdate {
    pub chart: String,
    pub version: String,
    /// `repo/chart` of the repository matched; `None` when no added repository has the chart.
    pub chart_ref: Option<String>,
    /// The newest version there (a prerelease only when `version` is one); `None` when unknown.
    pub latest: Option<String>,
    pub latest_app_version: Option<String>,
    /// Set when `latest` is newer than `version`.
    pub step: Option<VersionStep>,
    /// `latest` is not newer than `version`.
    pub up_to_date: bool,
    /// Other repositories that also have a chart of this name.
    pub other_repos: Vec<String>,
    /// The search for this chart failed (the others still count).
    pub error: Option<CoreError>,
}

/// A repository Helm could not read (its local index is missing or broken).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoProblem {
    pub repo: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartUpdates {
    /// One entry per distinct chart and version asked about, in the order asked.
    pub charts: Vec<ChartUpdate>,
    /// How many repositories Helm has.
    pub repos: u32,
    pub repo_problems: Vec<RepoProblem>,
    /// Distinct chart names past [`MAX_CHARTS`], not looked up.
    pub skipped: u32,
}

// ---------- semantic versions ----------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Text(String),
}

/// A version as Helm reads one (Masterminds semver, loosely): an optional `v`, one to three numbers, a prerelease
/// after `-`, build metadata after `+` (ignored).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Ident>,
}

impl SemVer {
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = text.split_once('+').map_or(text, |(v, _)| v);
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let numbers: Vec<&str> = core.split('.').collect();
        if numbers.is_empty() || numbers.len() > 3 {
            return None;
        }
        let number = |s: &str| -> Option<u64> {
            (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .then(|| s.parse().ok())
                .flatten()
        };
        let mut parts = [0u64; 3];
        for (slot, s) in parts.iter_mut().zip(&numbers) {
            *slot = number(s)?;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => pre
                .split('.')
                .map(|id| {
                    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        None
                    } else {
                        Some(number(id).map_or_else(|| Ident::Text(id.to_owned()), Ident::Num))
                    }
                })
                .collect::<Option<Vec<_>>>()?,
        };
        Some(Self {
            major: parts[0],
            minor: parts[1],
            patch: parts[2],
            pre,
        })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Ident {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
            (Ident::Num(_), Ident::Text(_)) => Ordering::Less,
            (Ident::Text(_), Ident::Num(_)) => Ordering::Greater,
            (Ident::Text(a), Ident::Text(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Ident {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // A release is newer than its prereleases.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// The step from `current` to `newer`; `None` when `newer` is not newer.
pub fn version_step(current: &SemVer, newer: &SemVer) -> Option<VersionStep> {
    if newer <= current {
        None
    } else if newer.major != current.major {
        Some(VersionStep::Major)
    } else if newer.minor != current.minor {
        Some(VersionStep::Minor)
    } else {
        Some(VersionStep::Patch)
    }
}

// ---------- matching ----------

/// A chart name as Helm accepts one (letters, digits, `-`, `_`, `.`), else `invalid`.
fn check_chart(installed: &InstalledChart) -> CoreResult<()> {
    let name_ok = !installed.chart.is_empty()
        && installed.chart.len() <= 250
        && installed
            .chart
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if name_ok && installed.version.len() <= 128 {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{:?} is not a chart name Helm accepts", installed.chart),
        ))
    }
}

fn unknown(installed: &InstalledChart, error: Option<CoreError>) -> ChartUpdate {
    ChartUpdate {
        chart: installed.chart.clone(),
        version: installed.version.clone(),
        chart_ref: None,
        latest: None,
        latest_app_version: None,
        step: None,
        up_to_date: false,
        other_repos: Vec::new(),
        error,
    }
}

/// The repository and the newest version for `installed` among `hits` (search results of any chart name; only
/// `<repo>/<chart>` with the same chart name count).
pub fn match_chart(installed: &InstalledChart, hits: &[ChartHit]) -> ChartUpdate {
    let mut by_repo: BTreeMap<&str, Vec<&ChartHit>> = BTreeMap::new();
    for hit in hits {
        if let Some((repo, name)) = hit.name.split_once('/')
            && name == installed.chart
        {
            by_repo.entry(repo).or_default().push(hit);
        }
    }
    if by_repo.is_empty() {
        return unknown(installed, None);
    }
    let current = SemVer::parse(&installed.version);
    let allow_pre = current.as_ref().is_some_and(SemVer::is_prerelease);
    let newest = |hits: &[&ChartHit]| -> Option<(SemVer, ChartHit)> {
        hits.iter()
            .filter_map(|h| {
                let v = SemVer::parse(&h.version)?;
                (allow_pre || !v.is_prerelease()).then(|| (v, (*h).clone()))
            })
            .max_by(|a, b| a.0.cmp(&b.0))
    };
    let lists_current = |hits: &[&ChartHit]| {
        hits.iter().any(|h| {
            h.version == installed.version
                || (current.is_some() && SemVer::parse(&h.version) == current)
        })
    };
    let listing: Vec<&str> = by_repo
        .iter()
        .filter(|(_, hits)| lists_current(hits))
        .map(|(repo, _)| *repo)
        .collect();
    let candidates: Vec<&str> = if listing.is_empty() {
        by_repo.keys().copied().collect()
    } else {
        listing
    };
    // The candidate with the newest version; on a tie the first by name.
    let mut chosen = candidates[0];
    let mut best = newest(&by_repo[chosen]);
    for repo in &candidates[1..] {
        let found = newest(&by_repo[repo]);
        let newer = match (&found, &best) {
            (Some((a, _)), Some((b, _))) => a > b,
            (Some(_), None) => true,
            _ => false,
        };
        if newer {
            chosen = repo;
            best = found;
        }
    }
    let (latest, latest_app_version, step, up_to_date) = match best {
        Some((version, hit)) => {
            let (step, up_to_date) = match &current {
                Some(current) => (version_step(current, &version), &version <= current),
                None => (None, hit.version == installed.version),
            };
            (Some(hit.version), Some(hit.app_version), step, up_to_date)
        }
        None => (None, None, None, false),
    };
    ChartUpdate {
        chart: installed.chart.clone(),
        version: installed.version.clone(),
        chart_ref: Some(format!("{chosen}/{}", installed.chart)),
        latest,
        latest_app_version: latest_app_version.filter(|v| !v.is_empty()),
        step,
        up_to_date,
        other_repos: by_repo
            .keys()
            .filter(|repo| **repo != chosen)
            .map(|repo| (*repo).to_owned())
            .collect(),
        error: None,
    }
}

/// Helm's warnings about repositories it could not read (`WARNING: Repo "x" is corrupt or missing. …`).
fn repo_problems(warnings: &str) -> Vec<RepoProblem> {
    warnings
        .lines()
        .filter_map(|line| {
            let message = line.trim().trim_start_matches("WARNING:").trim();
            let rest = message.strip_prefix("Repo \"")?;
            let (repo, _) = rest.split_once('"')?;
            Some(RepoProblem {
                repo: repo.to_owned(),
                message: message.to_owned(),
            })
        })
        .collect()
}

/// The newest version of each installed chart in the repositories Helm has (see the module's notes). A chart whose
/// search fails gets its own `error`; only a failure to run `helm` at all (or to list its repositories) fails the call.
pub async fn chart_updates(
    cli: &HelmCli,
    installed: &[InstalledChart],
) -> CoreResult<ChartUpdates> {
    if installed.len() > MAX_CHARTS * 10 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("at most {} charts can be checked at once", MAX_CHARTS * 10),
        ));
    }
    let repos = cli.repos().await?;
    let mut asked: Vec<&InstalledChart> = Vec::new();
    for chart in installed {
        if !asked.contains(&chart) {
            asked.push(chart);
        }
    }
    let mut names: Vec<&str> = Vec::new();
    for chart in &asked {
        if check_chart(chart).is_ok() && !names.contains(&chart.chart.as_str()) {
            names.push(&chart.chart);
        }
    }
    let skipped = names.len().saturating_sub(MAX_CHARTS);
    names.truncate(MAX_CHARTS);
    let searched: BTreeMap<String, CoreResult<(Vec<ChartHit>, String)>> = if repos.is_empty() {
        BTreeMap::new()
    } else {
        // Owned names: a future borrowing them would not be `Send` for every lifetime, as a command needs.
        let names: Vec<String> = names.iter().map(|n| (*n).to_owned()).collect();
        stream::iter(names)
            .map(|name| async move {
                let found =
                    match tokio::time::timeout(SEARCH_TIMEOUT, cli.chart_versions(&name)).await {
                        Ok(found) => found,
                        Err(_) => Err(CoreError::new(
                            ErrorCode::Timeout,
                            format!(
                                "searching the repositories for {name} did not finish in {} s",
                                SEARCH_TIMEOUT.as_secs()
                            ),
                        )),
                    };
                (name, found)
            })
            .buffer_unordered(PARALLEL_SEARCHES)
            .collect()
            .await
    };
    let mut problems: BTreeMap<String, RepoProblem> = BTreeMap::new();
    for (_, warnings) in searched.values().flatten() {
        for problem in repo_problems(warnings) {
            problems.entry(problem.repo.clone()).or_insert(problem);
        }
    }
    let charts = asked
        .into_iter()
        .map(|chart| {
            if let Err(e) = check_chart(chart) {
                return unknown(chart, Some(e));
            }
            match searched.get(chart.chart.as_str()) {
                Some(Ok((hits, _))) => match_chart(chart, hits),
                Some(Err(e)) => unknown(chart, Some(e.clone())),
                None => unknown(chart, None),
            }
        })
        .collect();
    let known: BTreeSet<&str> = repos.iter().map(|r| r.name.as_str()).collect();
    Ok(ChartUpdates {
        charts,
        repos: u32::try_from(known.len()).unwrap_or(u32::MAX),
        repo_problems: problems.into_values().collect(),
        skipped: u32::try_from(skipped).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> SemVer {
        SemVer::parse(text).unwrap_or_else(|| panic!("{text} does not parse"))
    }

    fn hit(name: &str, version: &str) -> ChartHit {
        ChartHit {
            name: name.into(),
            version: version.into(),
            app_version: format!("app-{version}"),
            description: String::new(),
        }
    }

    fn installed(chart: &str, version: &str) -> InstalledChart {
        InstalledChart {
            chart: chart.into(),
            version: version.into(),
        }
    }

    #[test]
    fn versions_order_as_semantic_versions() {
        let ordered = [
            "0.9.0",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "v1.0.1",
            "1.2",
            "1.10.0",
            "2.0.0+build.5",
        ];
        for pair in ordered.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("1.2"), v("1.2.0"));
        assert_eq!(v("1.0.0+a"), v("1.0.0+b"));
        for bad in [
            "",
            "latest",
            "1.x",
            "1.2.3.4",
            "1..2",
            "1.0.0-",
            "1.0.0-rc..1",
            "-1.0.0",
        ] {
            assert!(SemVer::parse(bad).is_none(), "{bad} parsed");
        }
    }

    #[test]
    fn the_step_is_patch_minor_or_major() {
        let step = |a: &str, b: &str| version_step(&v(a), &v(b));
        assert_eq!(step("1.2.3", "1.2.4"), Some(VersionStep::Patch));
        assert_eq!(step("1.2.3", "1.3.0"), Some(VersionStep::Minor));
        assert_eq!(step("1.2.3", "2.0.0"), Some(VersionStep::Major));
        assert_eq!(step("1.2.3-rc.1", "1.2.3"), Some(VersionStep::Patch));
        assert_eq!(step("1.2.3", "1.2.3"), None);
        assert_eq!(step("1.2.3", "1.2.2"), None);
    }

    #[test]
    fn prereleases_count_only_when_a_prerelease_is_installed() {
        let hits = [
            hit("bitnami/nginx", "15.1.0"),
            hit("bitnami/nginx", "15.2.0"),
            hit("bitnami/nginx", "16.0.0-rc.1"),
        ];
        let stable = match_chart(&installed("nginx", "15.1.0"), &hits);
        assert_eq!(stable.latest.as_deref(), Some("15.2.0"));
        assert_eq!(stable.step, Some(VersionStep::Minor));
        assert_eq!(stable.chart_ref.as_deref(), Some("bitnami/nginx"));
        assert_eq!(stable.latest_app_version.as_deref(), Some("app-15.2.0"));
        assert!(!stable.up_to_date);
        let pre = match_chart(&installed("nginx", "15.3.0-beta.1"), &hits);
        assert_eq!(pre.latest.as_deref(), Some("16.0.0-rc.1"));
        assert_eq!(pre.step, Some(VersionStep::Major));
        let newest = match_chart(&installed("nginx", "15.2.0"), &hits);
        assert!(newest.up_to_date && newest.step.is_none());
    }

    #[test]
    fn a_chart_in_several_repositories_matches_the_one_that_lists_the_installed_version() {
        let hits = [
            hit("mirror/nginx", "99.0.0"),
            hit("bitnami/nginx", "15.1.0"),
            hit("bitnami/nginx", "15.1.1"),
            hit("bitnami/nginx-ingress", "1.0.0"),
            hit("other/ingress-nginx", "4.0.0"),
        ];
        let found = match_chart(&installed("nginx", "15.1.0"), &hits);
        assert_eq!(found.chart_ref.as_deref(), Some("bitnami/nginx"));
        assert_eq!(found.latest.as_deref(), Some("15.1.1"));
        assert_eq!(found.step, Some(VersionStep::Patch));
        assert_eq!(found.other_repos, ["mirror"]);
        // No repository lists the installed version: the newest wins.
        let found = match_chart(&installed("nginx", "1.0.0"), &hits);
        assert_eq!(found.chart_ref.as_deref(), Some("mirror/nginx"));
        assert_eq!(found.step, Some(VersionStep::Major));
        // A chart no repository has is unknown, not up to date.
        let missing = match_chart(&installed("redis", "1.0.0"), &hits);
        assert!(missing.chart_ref.is_none() && missing.latest.is_none() && !missing.up_to_date);
    }

    #[test]
    fn helm_warnings_name_the_repositories_it_could_not_read() {
        let warnings = "WARNING: Repo \"stale\" is corrupt or missing. Try 'helm repo update'.\nWARNING: open /x/stale-index.yaml: no such file or directory\n";
        let problems = repo_problems(warnings);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].repo, "stale");
        assert!(
            problems[0].message.starts_with("Repo \"stale\" is corrupt"),
            "{problems:?}"
        );
    }

    /// A fake `helm`: `repo list` answers two repositories, `search repo` answers from a fixture by the chart name in
    /// its pattern (and warns about one repository); every call is recorded in `dir/args`.
    #[cfg(unix)]
    fn fake_helm(dir: &std::path::Path) -> HelmCli {
        use std::os::unix::fs::PermissionsExt;
        let script = format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> '{record}'
case "$1 $2" in
  "repo list") printf '%s' '[{{"name":"bitnami","url":"https://charts.example/bitnami"}},{{"name":"stale","url":"https://stale.example"}}]' ;;
  "search repo")
    echo 'WARNING: Repo "stale" is corrupt or missing. Try '"'"'helm repo update'"'"'.' >&2
    case "$*" in
      *nginx*) printf '%s' '[{{"name":"bitnami/nginx","version":"15.2.0","app_version":"1.26.0","description":"d"}},{{"name":"bitnami/nginx","version":"15.1.0","app_version":"1.25.3","description":"d"}}]' ;;
      *broken*) echo 'Error: boom' >&2; exit 1 ;;
      *) printf '[]' ;;
    esac ;;
esac
"#,
            record = dir.join("args").display()
        );
        let fake = dir.join("helm");
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        HelmCli::default().with_binary(fake)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chart_updates_search_each_chart_once_and_report_failures_per_chart() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_helm(dir.path());
        let asked = [
            installed("nginx", "15.1.0"),
            installed("nginx", "15.1.0"),
            installed("nginx", "15.2.0"),
            installed("broken", "1.0.0"),
            installed("redis", "1.0.0"),
            installed("bad name", "1.0.0"),
        ];
        let report = chart_updates(&cli, &asked).await.unwrap();
        assert_eq!(report.repos, 2);
        assert_eq!(report.skipped, 0);
        assert_eq!(report.repo_problems.len(), 1, "{:?}", report.repo_problems);
        assert_eq!(report.repo_problems[0].repo, "stale");
        let charts: Vec<(&str, &str)> = report
            .charts
            .iter()
            .map(|c| (c.chart.as_str(), c.version.as_str()))
            .collect();
        assert_eq!(
            charts,
            [
                ("nginx", "15.1.0"),
                ("nginx", "15.2.0"),
                ("broken", "1.0.0"),
                ("redis", "1.0.0"),
                ("bad name", "1.0.0")
            ]
        );
        assert_eq!(report.charts[0].step, Some(VersionStep::Minor));
        assert_eq!(
            report.charts[0].latest_app_version.as_deref(),
            Some("1.26.0")
        );
        assert!(report.charts[1].up_to_date);
        assert!(
            report.charts[2]
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("boom")
        );
        assert!(report.charts[3].error.is_none() && report.charts[3].latest.is_none());
        assert_eq!(
            report.charts[4].error.as_ref().unwrap().code,
            ErrorCode::Invalid
        );
        let calls = std::fs::read_to_string(dir.path().join("args")).unwrap();
        let searches: Vec<&str> = calls
            .lines()
            .filter(|l| l.starts_with("search repo"))
            .collect();
        // One search per valid chart name, never `repo update`.
        assert_eq!(searches.len(), 3, "{calls}");
        assert!(!calls.contains("update"), "{calls}");
        for flag in [
            "--regexp",
            "--versions",
            "--devel",
            "--output json",
            r"(^|/)nginx(\v|$)",
        ] {
            assert!(searches.iter().any(|l| l.contains(flag)), "{flag}: {calls}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn without_repositories_nothing_is_searched() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("helm");
        let record = dir.path().join("args");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\necho 'Error: no repositories to show' >&2\nexit 1\n", record.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = HelmCli::default().with_binary(fake);
        let report = chart_updates(&cli, &[installed("nginx", "1.0.0")])
            .await
            .unwrap();
        assert_eq!(report.repos, 0);
        assert!(report.charts[0].latest.is_none());
        assert_eq!(std::fs::read_to_string(record).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_search_that_prints_too_much_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("helm");
        let limit_kib = crate::helm::cli::SEARCH_OUTPUT_LIMIT / 1024 + 64;
        std::fs::write(
            &fake,
            // `dd`, not `head -c 1K`: the BSD `head` of macOS takes no size suffix.
            format!("#!/bin/sh\ndd if=/dev/zero bs=1024 count={limit_kib} 2>/dev/null\n"),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = HelmCli::default().with_binary(fake);
        let err = cli.chart_versions("nginx").await.unwrap_err();
        assert!(err.message.contains("printed more than"), "{}", err.message);
    }
}
