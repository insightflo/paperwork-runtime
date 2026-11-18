use std::process::Command;

fn settler_bin() -> &'static str {
    env!("CARGO_BIN_EXE_paperclip-settler")
}

#[test]
fn rejects_missing_and_unknown_subcommands() {
    let out = Command::new(settler_bin()).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("missing subcommand"));

    let bad = Command::new(settler_bin()).arg("unknown-cmd").output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("unsupported subcommand"));
}

#[test]
fn rejects_invalid_flags_and_missing_database_url() {
    let bad_ts = Command::new(settler_bin())
        .args(["recover-once", "--now", "not-rfc3339", "--grace-ms", "1000"])
        .output()
        .unwrap();
    assert_eq!(bad_ts.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&bad_ts.stderr).contains("invalid --now"));

    let neg_grace = Command::new(settler_bin())
        .args(["recover-once", "--grace-ms", "999999999999999"])
        .output()
        .unwrap();
    assert_eq!(neg_grace.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&neg_grace.stderr).contains("out of range"));

    let missing_env = Command::new(settler_bin())
        .env_remove("DATABASE_URL")
        .args(["recover-once", "--now", "2026-11-18T14:00:00Z", "--grace-ms", "5000"])
        .output()
        .unwrap();
    assert_eq!(missing_env.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing_env.stderr).contains("DATABASE_URL"));
}
