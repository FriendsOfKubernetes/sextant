use super::*;

fn none() -> ExecSecrets {
    ExecSecrets::default()
}

fn shown(stderr: &str) -> String {
    masked_stderr(stderr.as_bytes(), &none()).unwrap()
}

const JWT_TOKEN: &str = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

#[test]
fn every_secret_shape_is_masked_and_the_words_around_it_stay() {
    let cases: &[(&str, &str)] = &[
        (
            "ERROR: Failed to get credentials: not logged in, run 'yc init'",
            "ERROR: Failed to get credentials: not logged in, run 'yc init'",
        ),
        (
            &format!("token rejected: {JWT_TOKEN}"),
            "token rejected: <hidden>",
        ),
        (
            "Authorization: Bearer abc.DEF-123",
            "Authorization: <hidden> <hidden>",
        ),
        (
            "header Bearer abc.DEF-123 refused",
            "header Bearer <hidden> refused",
        ),
        (
            "got Basic dXNlcjpwYXNzd29yZA== back",
            "got Basic <hidden> back",
        ),
        ("token=s3cr3t&x=1", "token=<hidden>&x=1"),
        ("VAULT_TOKEN=s3cr3t", "VAULT_TOKEN=<hidden>"),
        ("password: hunter22", "password: <hidden>"),
        ("passwd=hunter22", "passwd=<hidden>"),
        (
            r#"{"access_token":"abc","expires":3}"#,
            r#"{"access_token":"<hidden>","expires":3}"#,
        ),
        (
            r#"{"refresh_token": "abc def"}"#,
            r#"{"refresh_token": "<hidden>"}"#,
        ),
        ("id_token='x y'", "id_token='<hidden>'"),
        (
            "--client-secret=abc --verbose",
            "--client-secret=<hidden> --verbose",
        ),
        (
            "--client_secret abc --verbose",
            "--client_secret <hidden> --verbose",
        ),
        (
            "apikey=k1, api_key: k2; api-key=k3",
            "apikey=<hidden>, api_key: <hidden>; api-key=<hidden>",
        ),
        ("secret=abc", "secret=<hidden>"),
        (
            "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "aws_secret_access_key = <hidden>",
        ),
        (
            "key AKIAIOSFODNN7EXAMPLE is not valid",
            "key <hidden> is not valid",
        ),
        (
            "sig 0123456789abcdef0123456789abcdef end",
            "sig <hidden> end",
        ),
        (
            "blob dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZSAx== end",
            "blob <hidden> end",
        ),
        (
            "-----BEGIN PRIVATE KEY-----\nMIIEvQ\nabc\n-----END PRIVATE KEY-----\nafter",
            "<hidden>\nafter",
        ),
        // Names, paths and ids that are not secrets stay.
        (
            "cluster cat1b2c3d4e5f6g7h8i9j0 in folder b1g2h3 not found",
            "cluster cat1b2c3d4e5f6g7h8i9j0 in folder b1g2h3 not found",
        ),
        (
            "/home/user/yandex-cloud/bin/yc: profile-name-for-production missing",
            "/home/user/yandex-cloud/bin/yc: profile-name-for-production missing",
        ),
        (
            "id 123e4567-e89b-12d3-a456-426614174000 unknown",
            "id 123e4567-e89b-12d3-a456-426614174000 unknown",
        ),
        ("secretName: web, tokens: 5", "secretName: web, tokens: 5"),
    ];
    for (input, expected) in cases {
        assert_eq!(&shown(input), expected, "input: {input}");
    }
}

#[test]
fn the_exec_configs_own_values_are_masked_where_they_appear() {
    let exec: kube::config::ExecConfig = serde_yaml::from_str(
        "command: vault-login\nargs: [\"get\", \"--profile\", \"team-prod\", \"--password=ARG-SECRET\", \"-v\"]\n\
         env:\n  - name: VAULT_ADDR\n    value: ENV-VALUE-123\n  - name: X\n    value: \"1\"\n",
    )
    .unwrap();
    let secrets = ExecSecrets::of(&exec);
    assert_eq!(format!("{secrets:?}"), "ExecSecrets(<3 hidden>)");
    let text = "using ENV-VALUE-123 and team-prod; ARG-SECRET rejected; exit 1 after get";
    assert_eq!(
        masked_stderr(text.as_bytes(), &secrets).unwrap(),
        "using <hidden> and <hidden>; <hidden> rejected; exit 1 after get"
    );
}

#[test]
fn escapes_and_control_characters_are_removed() {
    let text = "\x1b[31mERROR\x1b[0m:\tnot\r\nlogged\x07 in\u{202E}\x1b]0;title\x07!\r";
    assert_eq!(shown(text), "ERROR: not\nlogged in!");
}

#[test]
fn only_the_last_lines_within_the_limits_are_kept() {
    let many: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    let text = shown(&format!("{many}\n\n"));
    assert!(text.starts_with("…\nline 11\n"), "{text}");
    assert!(text.ends_with("line 30"), "{text}");
    assert_eq!(text.lines().count(), MAX_LINES + 1);

    let long: String = (0..10)
        .map(|i| format!("{i}{}\n", "x".repeat(299)))
        .collect();
    let text = shown(&long);
    assert!(text.len() <= MAX_BYTES + "…\n".len(), "{}", text.len());
    assert!(text.starts_with("…\n"), "{text}");
    assert!(
        text.lines().skip(1).all(|l| l.len() == 300),
        "whole lines only"
    );

    let one = "y".repeat(5000);
    let text = shown(&one);
    assert!(
        text.starts_with('…') && text.len() <= MAX_BYTES + "…\n".len(),
        "{}",
        text.len()
    );

    let huge = format!("{}\nthe end", "z".repeat(MAX_READ_BYTES * 2));
    assert_eq!(shown(&huge), "…\nthe end");
}

#[test]
fn nothing_readable_is_none() {
    assert_eq!(masked_stderr(b"", &none()), None);
    assert_eq!(masked_stderr(b"  \n\x1b[0m\n", &none()), None);
    assert_eq!(
        masked_stderr(b"\xff\xfe bad", &none()).as_deref(),
        Some("\u{FFFD}\u{FFFD} bad")
    );
}
