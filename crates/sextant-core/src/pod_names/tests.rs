//! Pod names made as the controllers and the API server make them, checked against the patterns.

use regex::Regex;

use super::*;

/// `names.SimpleNameGenerator.GenerateName`: the base cut to 58 characters, then 5 random safe characters.
fn generate(base: &str) -> String {
    format!("{}x2b4q", cut(base, MAX_GENERATED_BASE))
}

/// An indexed Job's `generateName` (`podGenerateNameWithIndex`).
fn indexed(job: &str, index: u32) -> String {
    let append = format!("-{index}-");
    let prefix = format!("{job}{append}");
    if prefix.len() > MAX_GENERATED_BASE {
        format!("{}{append}", &prefix[..MAX_GENERATED_BASE - append.len()])
    } else {
        prefix
    }
}

fn matches(kind: &str, name: &str, pod: &str) -> bool {
    let pattern = pod_name_pattern(kind, name);
    Regex::new(&format!("^(?:{pattern})$"))
        .unwrap_or_else(|e| panic!("{pattern}: {e}"))
        .is_match(pod)
}

/// A name of `len` characters.
fn name_of(len: usize) -> String {
    let base = "checkout-service-with-a-really-long-name-for-the-tests-of-pod-names";
    base[..len].trim_end_matches('-').to_owned()
        + &"x".repeat(len - base[..len].trim_end_matches('-').len())
}

#[test]
fn a_deployment_s_pods_match_whatever_the_name_and_hash_length() {
    let hashes = [
        "5",
        "7d",
        "7d9",
        "7d9c",
        "7d9c8",
        "7d9c8b",
        "7d9c8b6",
        "7d9c8b6f",
        "7d9c8b6f5",
        "7d9c8b6f5d",
    ];
    for len in [3, 40, 50, 54, 55, 56, 57, 58, 60, 63] {
        let name = name_of(len);
        assert_eq!(name.len(), len);
        for hash in hashes {
            let pod = generate(&format!("{name}-{hash}-"));
            assert!(matches("Deployment", &name, &pod), "{name} / {pod}");
        }
    }
    // A 60-character Deployment: the pod keeps 58 characters of `<name>-<hash>-`, so neither the hash nor its dash.
    let name = name_of(60);
    let pod = generate(&format!("{name}-7d9c8b6f5d-"));
    assert_eq!(pod, format!("{}x2b4q", &name[..58]));
    assert!(matches("Deployment", &name, &pod));
}

#[test]
fn other_workloads_pods_are_not_taken_for_a_deployment_s() {
    assert!(matches("Deployment", "web", "web-7d9c8b6f5d-x2x4q"));
    assert!(matches("Deployment", "web", "web-5d-x2x4q"));
    assert!(!matches("Deployment", "web", "web-api-7d9c8b6f5d-x2x4q"));
    assert!(!matches("Deployment", "web", "web-x2x4q"));
    assert!(!matches("Deployment", "web", "web-7d9c8b6f5d1-x2x4q"));
    assert!(!matches("Deployment", "web.v2", "webxv2-7d9c8b6f5d-x2x4q"));
}

#[test]
fn replica_set_daemon_set_and_job_pods_are_cut_to_58_before_the_random_part() {
    for kind in ["ReplicaSet", "DaemonSet", "Job"] {
        for len in [5, 56, 57, 58, 60, 63] {
            let name = name_of(len);
            let pod = generate(&format!("{name}-"));
            assert!(matches(kind, &name, &pod), "{kind} {name} / {pod}");
            assert!(!matches(kind, &name, &format!("{pod}x")), "{kind} {name}");
        }
    }
    assert!(!matches("DaemonSet", "agent", "agent-x2x4q-x2x4q"));
}

#[test]
fn an_indexed_job_s_pods_keep_their_index() {
    for len in [7, 50, 54, 55, 56, 57, 60, 63] {
        let name = name_of(len);
        for index in [0, 7, 42, 999, 99_999] {
            let pod = generate(&indexed(&name, index));
            assert!(matches("Job", &name, &pod), "{name} / {pod}");
        }
    }
}

#[test]
fn a_cron_job_s_pods_go_through_its_jobs() {
    for len in [6, 40, 49, 50, 52] {
        let name = name_of(len);
        for minutes in [5, 29_000_000, 99_999_999] {
            let job = format!("{name}-{minutes}");
            let pod = generate(&format!("{job}-"));
            assert!(matches("CronJob", &name, &pod), "{name} / {pod}");
        }
    }
    assert!(!matches("CronJob", "backup", "backup-db-29000000-x2x4q"));
}

#[test]
fn a_stateful_set_s_pods_are_numbered_and_never_cut() {
    let name = name_of(60);
    assert!(matches("StatefulSet", &name, &format!("{name}-0")));
    assert!(matches("StatefulSet", "db", "db-12"));
    assert!(!matches("StatefulSet", "db", "db-a"));
}
