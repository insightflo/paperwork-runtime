//! TDD tests for personal-endpoint pairing validation and device-credential
//! storage (`endpoint_pairing`): pairing-code normalization, token masking,
//! credential expiration, and atomic `0600` persistence.
#![cfg(unix)]

// The module under test is compiled directly from its source file so that no
// existing crate file needs to be modified to register it.
#[path = "../src/endpoint_pairing.rs"]
mod endpoint_pairing;

use endpoint_pairing::{
    mask_secret_token, normalize_pairing_code, read_credentials, write_credentials_atomic,
    DeviceCredential,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pwork-pairing-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn sample_credential() -> DeviceCredential {
    DeviceCredential {
        device_id: "dev-001".into(),
        bot_name: "filing-bot".into(),
        server_url: "http://127.0.0.1:3100".into(),
        token_hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".into(),
        issued_at_ms: 1_760_000_000_000,
        expires_at_ms: 1_760_086_400_000,
        allowed_folders: vec!["~/Documents/paperwork-inbox".into()],
    }
}

#[test]
fn normalize_pairing_code_strips_separators_and_uppercases() {
    assert_eq!(normalize_pairing_code("abc-234"), Ok("ABC234".to_string()));
    assert_eq!(normalize_pairing_code("a b c 2 3 4"), Ok("ABC234".to_string()));
    assert_eq!(normalize_pairing_code("k7m2xq"), Ok("K7M2XQ".to_string()));
}

#[test]
fn normalize_pairing_code_rejects_ambiguous_characters() {
    assert!(normalize_pairing_code("ABC10P").is_err(), "0 and 1 must be rejected");
    assert!(normalize_pairing_code("ABCO23").is_err(), "letter O must be rejected");
    assert!(normalize_pairing_code("ABCI23").is_err(), "letter I must be rejected");
    assert!(normalize_pairing_code("abc023").is_err(), "digit 0 must be rejected");
}

#[test]
fn normalize_pairing_code_rejects_wrong_length_and_non_ascii() {
    assert!(normalize_pairing_code("ABC23").is_err(), "5 characters must be rejected");
    assert!(normalize_pairing_code("ABC2345").is_err(), "7 characters must be rejected");
    assert!(normalize_pairing_code("").is_err(), "empty input must be rejected");
    assert!(normalize_pairing_code("ABC23한").is_err(), "non-ASCII must be rejected");
}

#[test]
fn mask_secret_token_hides_long_token_body() {
    assert_eq!(mask_secret_token("pcp_bot_abcdef123456"), "pcp_...3456");
    assert_eq!(mask_secret_token("abcdefghijkl"), "abcd...ijkl");
    let masked = mask_secret_token("pcp_bot_sup3rs3cretvalue");
    assert!(!masked.contains("s3cret"), "masked token must not leak the body");
}

#[test]
fn mask_secret_token_returns_stars_for_short_tokens() {
    assert_eq!(mask_secret_token(""), "***");
    assert_eq!(mask_secret_token("abc"), "***");
    assert_eq!(
        mask_secret_token("shorttok123"),
        "***",
        "11 chars is below the mask threshold"
    );
}

#[test]
fn device_credential_expiration_boundary_is_inclusive() {
    let active = DeviceCredential {
        expires_at_ms: 5_000,
        ..sample_credential()
    };
    assert!(!active.is_expired(4_999));
    let expired = DeviceCredential {
        expires_at_ms: 5_000,
        ..sample_credential()
    };
    assert!(expired.is_expired(5_000));
    assert!(expired.is_expired(5_001));
}

#[test]
fn credential_json_contract_uses_camel_case_keys() {
    let cred = sample_credential();
    let json = serde_json::to_string(&cred).expect("credential must serialize");
    assert!(json.contains("\"deviceId\""), "camelCase key contract: {json}");
    assert!(json.contains("\"tokenHash\""), "camelCase key contract: {json}");
    assert!(!json.contains("token_hash"), "snake_case keys must not appear: {json}");
    let parsed: DeviceCredential = serde_json::from_str(&json).expect("credential must deserialize");
    assert_eq!(parsed, cred);
}

#[test]
fn credentials_atomic_write_and_read_roundtrip() {
    let dir = temp_dir("roundtrip");
    let path = dir.join("device-credential.json");
    assert!(matches!(read_credentials(&path), Ok(None)), "missing file reads as None");

    let cred = sample_credential();
    write_credentials_atomic(&path, &cred).expect("atomic write must succeed");
    assert_eq!(read_credentials(&path).expect("read back"), Some(cred));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_credentials_reports_io_errors_with_display() {
    let dir = temp_dir("errdir");
    let err = read_credentials(&dir).expect_err("reading a directory must fail");
    assert!(err.to_string().contains("credential io error"), "display: {err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn credentials_file_has_0600_permissions_on_unix() {
    let dir = temp_dir("permissions");
    let path = dir.join("device-credential.json");
    write_credentials_atomic(&path, &sample_credential()).expect("atomic write must succeed");
    let mode = fs::metadata(&path)
        .expect("credential file must exist")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "credential file must be 0600");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn credentials_overwrite_leaves_no_temp_files_behind() {
    let dir = temp_dir("overwrite");
    let path = dir.join("device-credential.json");
    let mut cred = sample_credential();
    write_credentials_atomic(&path, &cred).expect("first write");
    cred.bot_name = "renamed-bot".into();
    write_credentials_atomic(&path, &cred).expect("second write");
    assert_eq!(read_credentials(&path).expect("read back"), Some(cred));
    let entries = fs::read_dir(&dir).expect("readdir").count();
    assert_eq!(entries, 1, "temporary files must not remain after rename");
    let _ = fs::remove_dir_all(&dir);
}
