#[path = "../src/endpoint_doctor.rs"]
mod endpoint_doctor;
use endpoint_doctor::{run_endpoint_doctor, CheckStatus, DoctorInput, DoctorReport};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
static SEQ: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> (Self, DoctorInput) {
        let path = std::env::temp_dir().join(format!(
            "paperwork-doctor-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("config.json"), b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path.join("config.json"), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        let input = DoctorInput {
            server_url: "https://paperwork.example/api".into(),
            config_path: path.join("config.json"),
            allowed_folders: vec![(path.clone(), "rw".into())],
            outbox_dir: path.clone(),
            detected_clis: vec!["codex".into()],
        };
        (Self(path), input)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn status(input: &DoctorInput, id: &str) -> CheckStatus {
    run_endpoint_doctor(input).checks.iter().find(|check| check.id == id).unwrap().status
}
#[test]
fn healthy_setup_is_ready_and_leaves_no_probes() {
    let (fixture, input) = Fixture::new();
    let first = run_endpoint_doctor(&input);
    assert!(first.ready);
    assert!(first.format_human().starts_with("Ready:"));
    assert_eq!((first.pass_count, first.warn_count, first.fail_count), (5, 0, 0));
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    assert_eq!(first, run_endpoint_doctor(&input));
}
// Table-driven cases remain separate named tests in the Cargo report.
macro_rules! url_cases {
    ($name:ident, $ready:expr, $($url:literal),+ $(,)?) => {
        #[test]
        fn $name() {
            let (_fixture, mut input) = Fixture::new();
            for url in [$($url),+] {
                input.server_url = url.into();
                assert_eq!(run_endpoint_doctor(&input).ready, $ready, "{url:?}");
            }
        }
    };
}
url_cases!(
    rejects_remote_http_and_deceptive_hosts,
    false,
    "http://example.com",
    "http://127.0.0.1.evil.com",
    "http://localhost.evil.com",
    "http://localhost:80@evil.com",
    "http://127.0.0.1:80.evil.com"
);
url_cases!(
    accepts_exact_loopback_hosts_with_ports_paths_and_queries,
    true,
    "http://127.0.0.1",
    "http://localhost:3100/api",
    "http://localhost?dev=1",
    "https://[::1]:443/api"
);
url_cases!(
    rejects_malformed_urls,
    false,
    "", "https://", "https:///api",
    "https://exa mple.com",
    "ftp://localhost",
    "https://localhost:bad",
    "http://localhost\\@evil.com",
    "https://example.com/\n"
);
#[test]
fn missing_or_file_folder_fails() {
    let (fixture, mut input) = Fixture::new();
    for path in [fixture.0.join("missing"), input.config_path.clone()] {
        input.allowed_folders = vec![(path, "ro".into())];
        assert_eq!(status(&input, "folder:0"), CheckStatus::Fail);
    }
}
#[test]
fn invalid_folder_mode_fails_and_read_only_mode_passes() {
    let (_fixture, mut input) = Fixture::new();
    input.allowed_folders[0].1 = "write".into();
    assert!(!run_endpoint_doctor(&input).ready);
    input.allowed_folders[0].1 = "ro".into();
    assert!(run_endpoint_doctor(&input).ready);
}
#[test]
fn missing_or_directory_config_fails() {
    let (fixture, mut input) = Fixture::new();
    for path in [fixture.0.join("missing"), fixture.0.clone()] {
        input.config_path = path;
        assert_eq!(status(&input, "config"), CheckStatus::Fail);
    }
}
#[test]
#[cfg(unix)]
fn open_config_permissions_fail() {
    use std::os::unix::fs::PermissionsExt;
    let (_fixture, input) = Fixture::new();
    fs::set_permissions(&input.config_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(status(&input, "config"), CheckStatus::Fail);
}
#[test]
fn no_clis_warns_but_stays_ready() {
    let (_fixture, mut input) = Fixture::new();
    input.detected_clis.clear();
    let report = run_endpoint_doctor(&input);
    assert!(report.ready);
    assert_eq!(report.warn_count, 1);
    assert_eq!(status(&input, "clis"), CheckStatus::Warn);
}
#[test]
fn outbox_checks_existing_directory_or_immediate_parent() {
    let (fixture, mut input) = Fixture::new();
    input.outbox_dir = fixture.0.join("outbox");
    assert!(run_endpoint_doctor(&input).ready);
    assert!(!input.outbox_dir.exists());
    for path in [PathBuf::new(), fixture.0.join("missing/outbox"), input.config_path.clone()] {
        input.outbox_dir = path;
        assert_eq!(status(&input, "outbox"), CheckStatus::Fail);
    }
}
#[test]
#[cfg(unix)]
fn unwritable_folder_and_outbox_fail_but_ro_grant_passes() {
    use std::os::unix::fs::PermissionsExt;
    let (fixture, mut input) = Fixture::new();
    let dir = fixture.0.join("locked");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
    input.allowed_folders = vec![(dir.clone(), "rw".into())];
    input.outbox_dir = dir.clone();
    let report = run_endpoint_doctor(&input);
    assert_eq!(report.fail_count, 2);
    input.allowed_folders[0].1 = "ro".into();
    input.outbox_dir = fixture.0.clone();
    let ro_ready = run_endpoint_doctor(&input).ready;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(ro_ready);
}
#[test]
fn human_markers_counts_and_json_round_trip() {
    let (_fixture, mut input) = Fixture::new();
    input.detected_clis.clear();
    input.server_url = "http://remote.example".into();
    let report = run_endpoint_doctor(&input);
    let text = report.format_human();
    for marker in ["[OK]", "[WARN]", "[FAIL]", "Not ready"] {
        assert!(text.contains(marker));
    }
    assert_eq!(report.checks.len(), report.pass_count + report.warn_count + report.fail_count);
    let json = serde_json::to_string(&report).unwrap();
    assert_eq!(report, serde_json::from_str::<DoctorReport>(&json).unwrap());
}
