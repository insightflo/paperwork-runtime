//! Tests for the personal endpoint installer: config validation, config file
//! writing, and the three OS service-unit renderers. The module is included by
//! path so this target compiles with zero edits to lib.rs / main.rs / Cargo.toml.

#[path = "../src/service_install.rs"]
mod service_install;

use service_install::{validate_server_url, write_endpoint_config, EndpointInitConfig};
use std::path::PathBuf;

fn sample_cfg() -> EndpointInitConfig {
    EndpointInitConfig {
        server_url: "https://paperwork.insightflo.si".to_string(),
        endpoint_name: "my-laptop".to_string(),
        binary_path: PathBuf::from("/usr/local/bin/paperwork-bot & <go>"),
        config_path: PathBuf::from("/tmp/with space & <angle>/config.json"),
        allowed_folders: vec!["~/Projects".to_string()],
    }
}

fn temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "paperwork-bot-installer-test-{}-{name}",
        std::process::id()
    ))
}

fn remove_dir_all_lossy(dir: &PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

// --- EndpointInitConfig contract -------------------------------------------

#[test]
fn init_config_exposes_public_fields() {
    let cfg = sample_cfg();
    assert_eq!(cfg.server_url, "https://paperwork.insightflo.si");
    assert_eq!(cfg.allowed_folders, vec!["~/Projects".to_string()]);
}

// --- validate_server_url ---------------------------------------------------

#[test]
fn rejects_plain_http_url() {
    assert!(validate_server_url("http://example.com").is_err());
    assert!(validate_server_url("http://127.0.0.1.evil.example").is_err());
}

#[test]
fn accepts_https_url() {
    let url = "https://paperwork.insightflo.si";
    assert_eq!(validate_server_url(url).expect("https must be allowed"), url);
}

#[test]
fn allows_local_loopback_http_for_dev() {
    assert!(validate_server_url("http://127.0.0.1").is_ok());
    assert!(validate_server_url("http://127.0.0.1:3100/api").is_ok());
    assert!(validate_server_url("http://localhost:3000").is_ok());
}

#[test]
fn rejects_empty_whitespace_and_control_chars() {
    assert!(validate_server_url("").is_err());
    assert!(validate_server_url("   ").is_err());
    assert!(validate_server_url("https://exa mple.si").is_err());
    assert!(validate_server_url("https://example.si/\u{7}bel").is_err());
}

// --- write_endpoint_config -------------------------------------------------

#[test]
#[cfg(unix)]
fn writes_config_json_with_owner_only_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("cfg-perms");
    remove_dir_all_lossy(&dir);
    let path = dir.join("nested/config.json");
    let folders = vec![
        "~/Projects".to_string(),
        "~/Documents/paper \"q\"".to_string(),
    ];

    write_endpoint_config(
        &path,
        "https://paperwork.insightflo.si",
        "my-laptop",
        &folders,
    )
    .expect("config must be written");

    let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(file_mode, 0o600, "config file must be 0600");
    let parent_mode = std::fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(parent_mode, 0o700, "created parent dir must be 0700");

    let raw = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON config");
    assert_eq!(parsed["server_url"], "https://paperwork.insightflo.si");
    assert_eq!(parsed["endpoint_name"], "my-laptop");
    assert_eq!(parsed["allowed_folders"][1], "~/Documents/paper \"q\"");
    remove_dir_all_lossy(&dir);
}

#[test]
fn rejects_invalid_server_url_in_config_write() {
    let dir = temp_dir("cfg-invalid-url");
    let path = dir.join("config.json");
    let err = write_endpoint_config(&path, "http://example.com", "my-laptop", &[])
        .expect_err("plain http must be rejected");
    assert!(!path.exists(), "no file may be written for a rejected URL");
    assert!(!err.is_empty());
    remove_dir_all_lossy(&dir);
}

// --- OS service unit renderers ---------------------------------------------

#[test]
fn macos_plist_escapes_xml_and_sets_keepalive() {
    let plist = service_install::render_macos_launch_agent_plist(&sample_cfg());
    assert!(plist.contains("<key>Label</key>"));
    assert!(plist.contains("si.insightflo.paperwork-bot"));
    assert!(plist.contains("<key>RunAtLoad</key>"));
    assert!(plist.contains("<key>KeepAlive</key>"));
    assert!(plist.contains("<true/>"));
    assert!(plist.contains("with space &amp; &lt;angle&gt;/config.json"));
    assert!(plist.contains("&amp; &lt;go&gt;"));
    assert!(!plist.contains("& <go>"), "raw unescaped ampersand must not leak");
}

#[test]
fn linux_systemd_user_unit_restarts_on_failure() {
    let unit = service_install::render_linux_systemd_user_unit(&sample_cfg());
    assert!(unit.contains("[Unit]"));
    assert!(unit.contains("[Service]"));
    assert!(unit.contains("[Install]"));
    assert!(unit.contains("ExecStart="));
    assert!(unit.contains("--config"));
    assert!(unit.contains("Restart=on-failure"));
    assert!(unit.contains("RestartSec=5"));
    assert!(unit.contains("WantedBy=default.target"));
    assert!(unit.contains("/tmp/with space & <angle>/config.json"));
}

#[test]
fn windows_script_registers_logon_task() {
    let cfg = sample_cfg();
    let script = service_install::render_windows_task_script(&cfg);
    assert!(script.contains("Register-ScheduledTask"));
    assert!(script.contains("-AtLogOn"));
    assert!(script.contains("New-ScheduledTaskAction"));
    assert!(script.contains(&cfg.binary_path.to_string_lossy().to_string()));
    assert!(script.contains("--config"));
    assert!(script.contains("/tmp/with space & <angle>/config.json"));
}
