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
    let secrets = ExecSecrets::collect(&exec, []);
    assert_eq!(format!("{secrets:?}"), "ExecSecrets(<3 hidden>)");
    let text = "using ENV-VALUE-123 and team-prod; ARG-SECRET rejected; exit 1 after get";
    assert_eq!(
        masked_stderr(text.as_bytes(), &secrets).unwrap(),
        "using <hidden> and <hidden>; <hidden> rejected; exit 1 after get"
    );
}

#[test]
fn positional_arguments_and_secret_named_process_variables_are_masked() {
    let exec: kube::config::ExecConfig = serde_yaml::from_str(
        "command: /home/u/yandex-cloud/bin/yc\n\
         args: [\"k8s\", \"create-token\", \"get-credentials\", \"Zq9xLm2PwR7\", \"/etc/kube/ca.pem\", \"short1\"]\n",
    )
    .unwrap();
    let process = [
        ("GITHUB_TOKEN", "process-token-1234"),
        ("DB_PASSWORD", "Pa55-word-x"),
        ("AWS_SECRET_ACCESS_KEY", "aws-secret-xyz"),
        ("PWD", "/home/u/work"),
        ("HOME", "/home/u"),
        ("EDITOR", "vim-but-long"),
    ]
    .map(|(n, v)| (n.to_owned(), v.to_owned()));
    let secrets = ExecSecrets::collect(&exec, process);
    assert_eq!(format!("{secrets:?}"), "ExecSecrets(<4 hidden>)");
    let text = "yc k8s create-token get-credentials: Zq9xLm2PwR7 refused for /home/u/work; \
                env process-token-1234 Pa55-word-x aws-secret-xyz vim-but-long short1 /etc/kube/ca.pem";
    assert_eq!(
        masked_stderr(text.as_bytes(), &secrets).unwrap(),
        "yc k8s create-token get-credentials: <hidden> refused for /home/u/work; \
         env <hidden> <hidden> <hidden> vim-but-long short1 /etc/kube/ca.pem"
    );
}

#[test]
fn short_and_plain_word_literals_do_not_split_tokens_before_the_patterns_run() {
    // "dev" and "json" (too short) and "production" (a plain word) are not masked by themselves; and literals are
    // replaced only after the patterns, so the JWT and the base64 run around "dev" are hidden whole.
    let secrets = ExecSecrets::from_parts(
        ["dev".to_owned(), "production".to_owned()],
        &["--format".to_owned(), "json".to_owned()],
    );
    assert_eq!(format!("{secrets:?}"), "ExecSecrets(<0 hidden>)");
    let run = "Qm9vZGV2aGVsbG8xMjM0NTY3ODkwQUJDREVGR0hJSktMTU5PUA";
    let text = format!("dev json production {JWT_TOKEN} {run} end");
    assert_eq!(
        masked_stderr(text.as_bytes(), &secrets).unwrap(),
        "dev json production <hidden> <hidden> end"
    );
    // A literal that sits inside a token the patterns hide does not leave a fragment either.
    let secrets = ExecSecrets::from_parts(["Zm9vYmFy".to_owned()], &[]);
    let text = format!("got {JWT_TOKEN}Zm9vYmFy and Zm9vYmFy");
    assert_eq!(
        masked_stderr(text.as_bytes(), &secrets).unwrap(),
        "got <hidden> and <hidden>"
    );
}

#[test]
fn provider_tokens_and_more_field_forms_are_masked() {
    let cases: &[(&str, &str)] = &[
        // Vault.
        (
            "token s.AbCdEfGhIjKlMnOpQrStUvWx expired",
            "token <hidden> expired",
        ),
        (
            "using hvs.CAESIJ1abcdefghijklmnopqrstuvwxyz0123 now",
            "using <hidden> now",
        ),
        // GitLab, GitHub, Slack.
        ("glpat-AbCdEfGh1234567890xyZ rejected", "<hidden> rejected"),
        ("ghp_0123456789abcdefABCDEF0123456789ab ok", "<hidden> ok"),
        ("gho_0123456789abcdefABCDEF ok", "<hidden> ok"),
        ("ghs_0123456789abcdefABCDEF ok", "<hidden> ok"),
        ("ghu_0123456789abcdefABCDEF ok", "<hidden> ok"),
        (
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop ok",
            "<hidden> ok",
        ),
        (
            "slack xoxb-1234567890-abcdefABCDEF fails",
            "slack <hidden> fails",
        ),
        ("xoxp-12345-67890-abcdef bad", "<hidden> bad"),
        // An Azure client secret, `~` and `.` inside.
        (
            "secret value Xyz8Q~abcDEF123ghi.JKL456mno_PQR789stuVWX0yz rejected",
            "secret value <hidden> rejected",
        ),
        // A flag's value ends before a closing bracket.
        (
            "failed (--password hunter22) twice",
            "failed (--password <hidden>) twice",
        ),
        // Escaped JSON.
        (
            r#"body: {\"access_token\":\"abc def\",\"expires_in\":3600}"#,
            r#"body: {\"access_token\":\"<hidden>\",\"expires_in\":3600}"#,
        ),
        // YAML block scalars.
        (
            "user:\n  token: |\n    line-one\n    line-two\n  name: dev\nafter",
            "user:\n  token: <hidden>\n  name: dev\nafter",
        ),
        (
            "private_key: >-\n  abc\n\n  def\nnext: 1",
            "private_key: <hidden>\nnext: 1",
        ),
        // More field names.
        ("pass=hunter22 user=bob", "pass=<hidden> user=bob"),
        ("pwd: hunter22", "pwd: <hidden>"),
        ("passphrase=correct horse", "passphrase=<hidden> horse"),
        ("private_key=abc", "private_key=<hidden>"),
        (
            r#"{"credentials":"abc","x":1}"#,
            r#"{"credentials":"<hidden>","x":1}"#,
        ),
        ("credential=abc", "credential=<hidden>"),
        ("--credentials abc", "--credentials <hidden>"),
        (
            "Set-Cookie: session=abc123; Path=/; HttpOnly",
            "Set-Cookie: <hidden>",
        ),
        ("Cookie: a=b; c=d\nnext", "Cookie: <hidden>\nnext"),
        ("cookie=abc", "cookie=<hidden>"),
        (
            "redirect https://x/cb?code=4%2F0AbCd&state=xyz",
            "redirect https://x/cb?code=<hidden>&state=xyz",
        ),
        (
            "https://acct.blob.core.windows.net/c?sv=2022&sig=AbC%2Bdef%3D&se=1",
            "https://acct.blob.core.windows.net/c?sv=2022&sig=<hidden>&se=1",
        ),
        // Prose with the weak names stays.
        (
            "error getting credentials: exec: exit code: 1",
            "error getting credentials: exec: exit code: 1",
        ),
        ("error_code=5 signal=9", "error_code=5 signal=9"),
        // Paths, UUIDs and cluster-local names stay.
        (
            "/home/u/yandex-cloud/bin/yc failed",
            "/home/u/yandex-cloud/bin/yc failed",
        ),
        (
            "id 123E4567-E89B-12D3-A456-426614174000 / 123e4567-e89b-12d3-a456-426614174000",
            "id 123E4567-E89B-12D3-A456-426614174000 / 123e4567-e89b-12d3-a456-426614174000",
        ),
        (
            "dial web-7f9c8d.Prod-EU1-namespace.svc.cluster.local:443 refused",
            "dial web-7f9c8d.Prod-EU1-namespace.svc.cluster.local:443 refused",
        ),
        (
            "kube-dns.kube-system.svc.cluster.local and my-service.my-namespace.svc.cluster.local",
            "kube-dns.kube-system.svc.cluster.local and my-service.my-namespace.svc.cluster.local",
        ),
    ];
    for (input, expected) in cases {
        assert_eq!(&shown(input), expected, "input: {input}");
    }
}

#[test]
fn the_whole_read_text_is_masked_before_the_last_lines_are_cut() {
    // A PEM block whose BEGIN is far above the last 20 lines.
    let body: String = (0..40)
        .map(|_| "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl\n")
        .collect();
    let pem = format!("error:\n-----BEGIN PRIVATE KEY-----\n{body}-----END PRIVATE KEY-----\ndone");
    let text = shown(&pem);
    assert!(!text.contains("abcdefghij"), "{text}");
    assert_eq!(text, "error:\n<hidden>\ndone");

    // A `--password` flag whose value is on the next line: the value line is among the last 20, the flag is not.
    let mut lines = vec![
        "running --password".to_owned(),
        "plainlowercasevalue".to_owned(),
    ];
    lines.extend((1..MAX_LINES).map(|i| format!("line {i}")));
    let text = shown(&lines.join("\n"));
    let tail: String = (1..MAX_LINES).map(|i| format!("\nline {i}")).collect();
    assert_eq!(text, format!("…\n<hidden>{tail}"));
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
