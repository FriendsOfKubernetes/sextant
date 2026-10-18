use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

/// A leaf (RSA 2048, `shop.example.test`, 2025-06-01 → 2035-06-01) and its intermediate (EC P-384).
const CHAIN: &str = include_str!("testdata/chain.pem");
/// The self-signed root (EC P-256) the intermediate was signed by.
const CA: &str = include_str!("testdata/ca.pem");
/// Self-signed, 2020-01-01 → 2021-01-01.
const EXPIRED: &str = include_str!("testdata/expired.pem");
/// Not a real key: what the test looks for in every answer.
const KEY: &str =
    "-----BEGIN PRIVATE KEY-----\nU0VYVEFOVC1URVNULUtFWS1NQVJLRVI=\n-----END PRIVATE KEY-----\n";
const KEY_MARK: &str = "U0VYVEFOVC1URVNULUtFWS1NQVJLRVI";

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

fn b64(text: &str) -> String {
    STANDARD.encode(text)
}

fn secret_json(namespace: &str, name: &str, data: &[(&str, &str)]) -> String {
    let data: serde_json::Map<String, serde_json::Value> = data
        .iter()
        .map(|(k, v)| ((*k).to_owned(), serde_json::Value::String(b64(v))))
        .collect();
    serde_json::json!({
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "kubernetes.io/tls",
        "metadata": { "name": name, "namespace": namespace, "uid": format!("{namespace}-{name}") },
        "data": data,
    })
    .to_string()
}

fn forbidden() -> Reply {
    Reply::json(
        403,
        r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"secrets is forbidden","reason":"Forbidden","code":403}"#,
    )
}

#[test]
fn a_chain_is_parsed_leaf_first_with_its_names_validity_key_and_fingerprint() {
    let (chain, truncated) = parse_certificates(CHAIN.as_bytes(), TLS_CERT_KEY).unwrap();
    assert!(!truncated);
    assert_eq!(chain.len(), 2);
    let leaf = &chain[0];
    assert_eq!(leaf.common_name.as_deref(), Some("shop.example.test"));
    assert_eq!(leaf.subject, "O=Shop, CN=shop.example.test");
    assert_eq!(
        leaf.issuer_common_name.as_deref(),
        Some("Sextant Test Intermediate CA")
    );
    assert_eq!(leaf.serial, "0A:1B:2C:3D:4E:5F");
    assert_eq!(leaf.dns_names, ["shop.example.test", "*.shop.example.test"]);
    assert_eq!(leaf.ip_addresses, ["10.0.0.1", "2001:db8::1"]);
    assert_eq!(leaf.emails, ["ops@example.test"]);
    assert_eq!(leaf.uris, ["spiffe://example.test/shop"]);
    assert_eq!(leaf.not_before, "2025-06-01T00:00:00Z");
    assert_eq!(leaf.not_after, "2035-06-01T00:00:00Z");
    assert_eq!(leaf.key_algorithm, "RSA");
    assert_eq!(leaf.key_size, Some(2048));
    assert_eq!(leaf.signature_algorithm, "ecdsa-with-SHA256");
    assert!(!leaf.is_ca && !leaf.self_signed);
    // `openssl x509 -fingerprint -sha256` of the leaf.
    assert_eq!(
        leaf.fingerprint_sha256,
        "2D:5C:6D:46:EF:37:2B:E2:BE:B7:94:27:6B:E5:FB:C0:4E:21:5B:D8:3A:F7:F0:9E:62:D0:99:B0:93:69:12:B3"
    );
    let intermediate = &chain[1];
    assert!(intermediate.is_ca);
    assert_eq!(intermediate.key_algorithm, "ECDSA");
    assert_eq!(intermediate.key_size, Some(384));
    assert_eq!(intermediate.not_after, "2040-01-01T00:00:00Z");

    let (ca, _) = parse_certificates(CA.as_bytes(), CA_CERT_KEY).unwrap();
    assert!(ca[0].self_signed && ca[0].is_ca);
    assert_eq!(ca[0].key_size, Some(256));
}

#[test]
fn a_key_block_next_to_the_certificates_is_skipped_unread() {
    let bundle = format!("{KEY}{CHAIN}");
    let (chain, _) = parse_certificates(bundle.as_bytes(), TLS_CERT_KEY).unwrap();
    assert_eq!(chain.len(), 2);
    assert!(!format!("{chain:?}").contains(KEY_MARK));
}

#[test]
fn a_single_der_certificate_parses_too() {
    let block = Pem::iter_from_buffer(EXPIRED.as_bytes())
        .next()
        .unwrap()
        .unwrap();
    let (chain, _) = parse_certificates(&block.contents, TLS_CERT_KEY).unwrap();
    assert_eq!(chain[0].common_name.as_deref(), Some("old.example.test"));
    assert_eq!(chain[0].not_after, "2021-01-01T00:00:00Z");
}

#[test]
fn garbage_too_large_or_empty_values_are_invalid_without_their_content() {
    let secretish =
        "-----BEGIN CERTIFICATE-----\nc2VjcmV0LXNlY3JldA==\n-----END CERTIFICATE-----\n";
    for (input, needle) in [
        (secretish.as_bytes().to_vec(), "c2VjcmV0"),
        (b"just some secret text".to_vec(), "secret text"),
        (KEY.as_bytes().to_vec(), KEY_MARK),
        (Vec::new(), "\u{0}"),
    ] {
        let err = parse_certificates(&input, TLS_CERT_KEY).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{input:?}");
        assert!(err.message.starts_with("tls.crt "), "{}", err.message);
        assert!(!err.message.contains(needle), "{}", err.message);
    }
    let large = vec![b'A'; MAX_PEM_BYTES + 1];
    let err = parse_certificates(&large, TLS_CERT_KEY).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("256 KiB"), "{}", err.message);
}

#[test]
fn a_bundle_longer_than_the_cap_is_cut() {
    let bundle = EXPIRED.repeat(MAX_CERTIFICATES + 3);
    let (chain, truncated) = parse_certificates(bundle.as_bytes(), CA_CERT_KEY).unwrap();
    assert_eq!(chain.len(), MAX_CERTIFICATES);
    assert!(truncated);
}

#[tokio::test]
async fn a_secret_gives_its_chain_and_ca_but_never_its_key() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/shop/secrets/shop-tls" => Reply::json(
            200,
            secret_json(
                "shop",
                "shop-tls",
                &[("tls.crt", CHAIN), ("tls.key", KEY), ("ca.crt", CA)],
            ),
        ),
        "/api/v1/namespaces/shop/secrets/no-crt" => {
            Reply::json(200, secret_json("shop", "no-crt", &[("tls.key", KEY)]))
        }
        "/api/v1/namespaces/shop/secrets/bad-ca" => Reply::json(
            200,
            secret_json(
                "shop",
                "bad-ca",
                &[("tls.crt", EXPIRED), ("ca.crt", "not a cert")],
            ),
        ),
        "/api/v1/namespaces/locked/secrets/shop-tls" => forbidden(),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let info = secret_certificates(&mgr, &id, "shop", "shop-tls")
        .await
        .unwrap();
    assert_eq!(info.chain.len(), 2);
    assert_eq!(info.ca.len(), 1);
    assert!(!info.ca_invalid && !info.chain_truncated);
    let json = serde_json::to_string(&info).unwrap();
    assert!(
        !json.contains(KEY_MARK) && !json.contains("PRIVATE"),
        "{json}"
    );
    assert!(
        json.contains("\"notAfter\":\"2035-06-01T00:00:00Z\""),
        "{json}"
    );

    let missing = secret_certificates(&mgr, &id, "shop", "no-crt")
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert!(!missing.message.contains(KEY_MARK));

    let bad_ca = secret_certificates(&mgr, &id, "shop", "bad-ca")
        .await
        .unwrap();
    assert!(bad_ca.ca_invalid && bad_ca.ca.is_empty());

    let locked = secret_certificates(&mgr, &id, "locked", "shop-tls")
        .await
        .unwrap_err();
    assert_eq!(locked.code, ErrorCode::Forbidden);

    assert_eq!(
        secret_certificates(&mgr, &id, "", "x")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
}

#[tokio::test]
async fn the_scan_lists_tls_secrets_by_expiry_skips_forbidden_namespaces_and_returns_no_values() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/shop/secrets" => {
            assert!(
                req.query.contains("fieldSelector=type%3Dkubernetes.io%2Ftls"),
                "{}",
                req.query
            );
            Reply::json(
                200,
                format!(
                    r#"{{"kind":"SecretList","apiVersion":"v1","metadata":{{}},"items":[{},{},{}]}}"#,
                    secret_json("shop", "fresh", &[("tls.crt", CHAIN), ("tls.key", KEY)]),
                    secret_json("shop", "old", &[("tls.crt", EXPIRED), ("tls.key", KEY)]),
                    secret_json("shop", "broken", &[("tls.crt", "nope"), ("tls.key", KEY)]),
                ),
            )
        }
        "/api/v1/namespaces/locked/secrets" => forbidden(),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let namespaces = vec!["shop".to_owned(), "locked".to_owned(), "shop".to_owned()];
    let scan = expiry_scan(&mgr, &id, Some(&namespaces)).await.unwrap();
    let names: Vec<&str> = scan.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["broken", "old", "fresh"]);
    assert!(scan.items[0].invalid && scan.items[0].not_after.is_none());
    assert_eq!(
        scan.items[1].not_after.as_deref(),
        Some("2021-01-01T00:00:00Z")
    );
    // The leaf expires in 2035, before its intermediate (2040).
    assert_eq!(
        scan.items[2].not_after.as_deref(),
        Some("2035-06-01T00:00:00Z")
    );
    assert_eq!(
        scan.items[2].dns_names,
        ["shop.example.test", "*.shop.example.test"]
    );
    assert_eq!(scan.forbidden, ["locked"]);
    assert!(!scan.truncated);
    // Listed once, though named twice.
    assert_eq!(api.count("/api/v1/namespaces/shop/secrets"), 1);
    let json = serde_json::to_string(&scan).unwrap();
    assert!(
        !json.contains(KEY_MARK) && !json.contains("PRIVATE"),
        "{json}"
    );
}

#[tokio::test]
async fn the_scan_stops_at_its_cap_and_says_so() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/secrets" => {
            // Every page is full and says there is more.
            let items: Vec<String> = (0..SCAN_PAGE)
                .map(|i| secret_json("ns", &format!("s{i}"), &[("tls.crt", EXPIRED)]))
                .collect();
            Reply::json(
                200,
                format!(
                    r#"{{"kind":"SecretList","apiVersion":"v1","metadata":{{"continue":"more"}},"items":[{}]}}"#,
                    items.join(",")
                ),
            )
        }
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let scan = expiry_scan(&mgr, &id, None).await.unwrap();
    assert_eq!(scan.items.len(), SCAN_MAX_SECRETS);
    assert!(scan.truncated);
    assert_eq!(
        api.count("/api/v1/secrets"),
        SCAN_MAX_SECRETS / SCAN_PAGE as usize
    );
}

#[tokio::test]
async fn names_that_are_not_kubernetes_names_are_invalid_before_any_request() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let before = api.requests().len();
    for (namespace, name) in [
        ("shop", "a/../x"),
        ("shop/../kube-system", "x"),
        ("Shop", "x"),
        ("shop", "UPPER"),
        ("shop", "-x"),
        ("shop", ""),
        ("", "x"),
        ("shop", "x?watch=1"),
    ] {
        let err = secret_certificates(&mgr, &id, namespace, name)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{namespace} {name}");
    }
    let err = expiry_scan(&mgr, &id, Some(&["ok".to_owned(), "a/b".to_owned()]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert_eq!(api.requests().len(), before);
    // Dotted names are fine.
    let err = secret_certificates(&mgr, &id, "shop", "shop.example.com-tls")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn the_scan_reads_at_most_its_cap_of_namespaces() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        _ => Reply::json(
            200,
            r#"{"kind":"SecretList","apiVersion":"v1","metadata":{},"items":[]}"#,
        ),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let namespaces: Vec<String> = (0..SCAN_MAX_NAMESPACES + 50)
        .map(|i| format!("ns-{i:03}"))
        .collect();
    let scan = expiry_scan(&mgr, &id, Some(&namespaces)).await.unwrap();
    assert!(scan.namespaces_truncated && !scan.truncated);
    let lists = api
        .requests()
        .iter()
        .filter(|r| r.path.ends_with("/secrets"))
        .count();
    assert_eq!(lists, SCAN_MAX_NAMESPACES);
}

#[tokio::test]
async fn a_stalled_api_server_ends_the_read_with_a_timeout() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        _ => Reply::json(200, secret_json("shop", "shop-tls", &[("tls.crt", CHAIN)]))
            .after(STEP_TIMEOUT * 4),
    })
    .await;
    // Connect on the real clock: with the clock paused from the start, the runtime may jump past the connect
    // timeout while the TCP handshake is still in flight (seen on macOS).
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    tokio::time::pause();
    let err = secret_certificates(&mgr, &id, "shop", "shop-tls")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout, "{}", err.message);
    let err = expiry_scan(&mgr, &id, Some(&["shop".to_owned()]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout, "{}", err.message);
}
