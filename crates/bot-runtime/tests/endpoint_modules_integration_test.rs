use paperwork_bot_runtime::endpoint_audit::{AuditEntry, AuditLogger};
use paperwork_bot_runtime::endpoint_daemon::{
    DaemonConfig, DaemonExecutor, DaemonTask, DaemonTaskResult, DaemonTransport, EndpointDaemon,
};
use paperwork_bot_runtime::endpoint_dispatch::{execute_endpoint_task, EndpointTaskRequest};
use paperwork_bot_runtime::endpoint_doctor::{run_endpoint_doctor, DoctorInput, DoctorReport};
use paperwork_bot_runtime::endpoint_pairing::normalize_pairing_code;
use paperwork_bot_runtime::endpoint_protocol::{build_auth_headers, EndpointUrls, PairRequest};
use paperwork_bot_runtime::endpoint_sync::{BackoffPolicy, SyncController};
use paperwork_bot_runtime::local_tools::{FolderGrant, FolderMode};
use paperwork_bot_runtime::service_install::write_endpoint_config;
use std::{fs, path::PathBuf, process::Command, sync::atomic::{AtomicU64, Ordering}};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("endpoint-integration-{}-{}",
            std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        write_endpoint_config(&dir.join("endpoint.json"), "http://localhost:3100", "test",
            &[dir.to_string_lossy().into_owned()]).unwrap();
        Self(dir)
    }
    fn command(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_paperwork-bot"));
        cmd.env_clear().env("HOME", &self.0).env("USERPROFILE", &self.0);
        cmd.arg("endpoint-doctor");
        cmd
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

struct Transport { task: Option<DaemonTask>, acked: Vec<DaemonTaskResult> }
impl DaemonTransport for Transport {
    fn send_heartbeat(&mut self, pending: usize, now: u64) -> Result<(), String> {
        assert_eq!((pending, now), (0, 42));
        Ok(())
    }
    fn poll_tasks(&mut self, max: usize) -> Result<Vec<DaemonTask>, String> {
        assert_eq!(max, 1);
        Ok(self.task.take().into_iter().collect())
    }
    fn ack_result(&mut self, result: &DaemonTaskResult) -> Result<(), String> {
        self.acked.push(result.clone());
        Ok(())
    }
}
struct Executor { grants: Vec<FolderGrant>, audit: AuditLogger }
impl DaemonExecutor for Executor {
    fn execute(&mut self, task: &DaemonTask) -> DaemonTaskResult {
        let request: EndpointTaskRequest = serde_json::from_str(&task.payload).unwrap();
        let result = execute_endpoint_task(&task.task_id, &self.grants, &request);
        self.audit.append(&AuditEntry {
            timestamp_ms: 42, task_id: task.task_id.clone(), action: task.kind.clone(),
            target_path: self.grants[0].path.display().to_string(), allowed: result.ok,
            exit_code: None, duration_ms: 0, summary: result.output.to_string(),
        }).unwrap();
        DaemonTaskResult { task_id: result.task_id, ok: result.ok,
            output: result.output.to_string(), error: result.error }
    }
}

#[test]
fn public_modules_form_a_local_endpoint_pipeline() {
    let fixture = Fixture::new();
    let pair = PairRequest { code: normalize_pairing_code("ab-cd 23").unwrap(),
        os: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(), detected_clis: vec![] };
    assert_eq!(serde_json::to_value(pair).unwrap()["code"], "ABCD23");
    assert!(normalize_pairing_code("000000").is_err());
    let urls = EndpointUrls::new("http://localhost:3100/").unwrap();
    assert_eq!(urls.pair_url(), "http://localhost:3100/api/endpoints/pair");
    assert!(urls.poll_tasks_url("device-1").unwrap().ends_with("/device-1/tasks/poll"));
    assert_eq!(build_auth_headers("integration-secret", "company-1").unwrap(), vec![
        ("Authorization".into(), "Bearer integration-secret".into()),
        ("X-Company-Id".into(), "company-1".into())]);
    let mut sync = SyncController::new(BackoffPolicy { base_ms: 10, max_ms: 100, jitter_pct: 0 });
    sync.on_connect_attempt();
    sync.on_connected("session-1", 42);
    let heartbeat = sync.build_heartbeat("test", "test", "test", &[], &[], 0, 42);
    assert_eq!(heartbeat.pending_outbox_count, 0);
    let file = fixture.0.join("task.txt");
    fs::write(&file, "Bearer integration-secret token=private-value").unwrap();
    let request = EndpointTaskRequest::ReadFile { path: file.display().to_string(), max_bytes: None };
    let mut transport = Transport { task: Some(DaemonTask { task_id: "task-1".into(),
        kind: "read_file".into(), payload: serde_json::to_string(&request).unwrap() }), acked: vec![] };
    let log_path = fixture.0.join("audit.jsonl");
    let mut executor = Executor { grants: vec![FolderGrant { path: fixture.0.clone(), mode: FolderMode::Ro }],
        audit: AuditLogger::new(log_path.clone(), 4096) };
    let mut daemon = EndpointDaemon::new(DaemonConfig {
        poll_batch_size: 1, heartbeat_interval_ms: 1000, max_outbox_entries: 4 });
    let report = daemon.tick(heartbeat.timestamp_ms, &mut transport, &mut executor);
    assert_eq!((report.executed_count, report.acked_count, report.buffered_count), (1, 1, 0));
    assert!(report.heartbeat_sent && report.transport_errors.is_empty());
    assert!(transport.acked[0].ok);
    assert!(transport.acked[0].output.contains("integration-secret"));
    let entries = executor.audit.read_recent(1).unwrap();
    assert_eq!(entries[0].task_id, "task-1");
    let disk = fs::read_to_string(log_path).unwrap();
    assert!(disk.contains("[REDACTED]") && !disk.contains("integration-secret") && !disk.contains("private-value"));
    assert!(run_endpoint_doctor(&DoctorInput {
        server_url: "http://localhost:3100".into(), config_path: fixture.0.join("endpoint.json"),
        allowed_folders: vec![(fixture.0.clone(), "ro".into())],
        outbox_dir: fixture.0.join("outbox"), detected_clis: vec![],
    }).ready);
}

#[test]
fn endpoint_doctor_cli_reports_readiness_and_failures() {
    let fixture = Fixture::new();
    let config = fixture.0.join("endpoint.json");
    let output = fixture.command().arg("--config").arg(&config).arg("--json").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let report: DoctorReport = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report.ready && report.fail_count == 0);
    assert_eq!(report.warn_count, 1); // Empty PATH: no CLI is a warning, not a failure.
    fs::create_dir(fixture.0.join(".paperwork")).unwrap();
    fs::copy(&config, fixture.0.join(".paperwork/endpoint.json")).unwrap();
    let output = fixture.command().arg("--json").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(serde_json::from_slice::<DoctorReport>(&output.stdout).unwrap().ready);
    for args in [vec!["--config"], vec!["--config", "--json"], vec!["--unknown"]] {
        let output = fixture.command().args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty() && !output.stderr.is_empty());
    }
    let output = fixture.command().arg("--config").arg(&config).output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(String::from_utf8(output.stdout).unwrap().starts_with("Ready:"));
    fs::write(fixture.0.join("outbox"), "not a directory").unwrap();
    let output = fixture.command().arg("--config").arg(&config).arg("--json").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(!serde_json::from_slice::<DoctorReport>(&output.stdout).unwrap().ready);
    let output = fixture.command().arg("--config").arg(&config).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stdout).unwrap().starts_with("Not ready:"));
    fs::write(&config, "{}").unwrap();
    let output = fixture.command().arg("--config").arg(&config).arg("--json").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(serde_json::from_slice::<serde_json::Value>(&output.stderr).unwrap()["error"].is_string());
}
