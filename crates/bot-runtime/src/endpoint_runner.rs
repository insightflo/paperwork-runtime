//! Live endpoint wiring. Secrets travel over curl stdin, never argv or summaries.
use crate::endpoint_audit::{redact_sensitive, AuditEntry, AuditLogger};
use crate::endpoint_daemon::{DaemonConfig, DaemonExecutor, DaemonTask, DaemonTaskResult, DaemonTransport, EndpointDaemon};
use crate::endpoint_dispatch::{execute_endpoint_task, EndpointTaskRequest};
use crate::endpoint_http::{post_json, HttpTransportConfig};
use crate::endpoint_pairing::DeviceCredential;
use crate::endpoint_protocol::{AckTaskRequest, DetectedCli, EndpointUrls, HeartbeatRequest, PollTasksRequest};
use crate::local_tools::{detect_local_clis, FolderGrant, FolderMode};
use crate::token::verify_token_sha256;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::{Component, Path, PathBuf}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

pub struct EndpointRunOptions {
    pub config_path: PathBuf,
    pub credential_path: PathBuf,
    pub token_file: PathBuf,
    pub audit_log: PathBuf,
    pub poll_ms: u64,
    pub heartbeat_ms: u64,
    pub max_ticks: Option<u64>,
}
#[derive(Default, Serialize)]
pub struct EndpointRunSummary {
    pub ticks: u64,
    pub heartbeats: usize,
    pub executed: usize,
    pub acked: usize,
    pub pending: usize,
    pub transport_errors: usize,
    pub dropped: usize,
}
pub struct HttpDaemonTransport {
    pub config: HttpTransportConfig,
    pub urls: EndpointUrls,
    pub device_id: String,
    pending_acks: HashSet<String>,
}
impl HttpDaemonTransport {
    fn post(&self, url: String, body: Value) -> Result<Value, String> {
        let response = post_json(&self.config, &url, &body.to_string())
            .map_err(|_| "endpoint HTTP transport failed".to_string())?;
        if !(200..300).contains(&response.status) { return Err(format!("endpoint HTTP {}", response.status)); }
        if response.body.trim().is_empty() { return Ok(Value::Null); }
        serde_json::from_str(&response.body).map_err(|_| "invalid endpoint JSON response".into())
    }
    fn company(&self) -> String { self.config.company_id.clone().unwrap_or_default() }
}
impl DaemonTransport for HttpDaemonTransport {
    fn send_heartbeat(&mut self, pending: usize, now: u64) -> Result<(), String> {
        let request = HeartbeatRequest { company_id: self.company(), pending_outbox_count: pending as u64,
            timestamp_ms: now, detected_clis: detect_local_clis().into_iter().filter(|c| c.available)
                .map(|c| DetectedCli::Name(c.id.into())).collect() };
        let mut body = serde_json::to_value(request).map_err(|_| "heartbeat serialization failed")?;
        // The live server's strict DTO does not accept the local clock field.
        if let Some(object) = body.as_object_mut() { object.remove("timestampMs"); }
        self.post(self.urls.heartbeat_url(&self.device_id)?, body).map(|_| ())
    }
    fn poll_tasks(&mut self, max: usize) -> Result<Vec<DaemonTask>, String> {
        if !self.pending_acks.is_empty() { return Ok(Vec::new()); }
        let request = PollTasksRequest { company_id: self.company(), limit: max.min(u32::MAX as usize) as u32 };
        let value = self.post(self.urls.poll_tasks_url(&self.device_id)?, json!(request))?;
        let tasks = value.get("tasks").unwrap_or(&value).as_array().ok_or("invalid endpoint tasks")?;
        tasks.iter().take(max).map(|v| {
            let id = v.get("taskId").and_then(Value::as_str).ok_or("missing taskId")?;
            self.urls.ack_task_url(&self.device_id, id)?;
            Ok(DaemonTask {
                task_id: id.into(),
                kind: v.get("kind").and_then(Value::as_str).ok_or("missing task kind")?.into(), payload: v.to_string(),
            })
        }).collect()
    }
    fn ack_result(&mut self, result: &DaemonTaskResult) -> Result<(), String> {
        let request = AckTaskRequest { company_id: self.company(), ok: result.ok,
            output: Some(result.output.clone()), error: result.error.clone(), duration_ms: 0 };
        let mut body = json!(request);
        if let Some(object) = body.as_object_mut() { object.remove("durationMs"); }
        let sent = self.post(self.urls.ack_task_url(&self.device_id, &result.task_id)?, body).map(|_| ());
        if sent.is_ok() { self.pending_acks.remove(&result.task_id); }
        else { self.pending_acks.insert(result.task_id.clone()); }
        sent
    }
}

pub struct LocalDaemonExecutor {
    pub grants: Vec<FolderGrant>,
    pub audit: AuditLogger,
    token: String,
    audit_failed: bool,
}
fn task_request(value: &Value) -> Result<EndpointTaskRequest, String> {
    let kind = value["kind"].as_str().ok_or("missing task kind")?;
    let path = value.get("targetPath").and_then(Value::as_str).unwrap_or("");
    if kind != "detect_clis" && (path.is_empty() || std::path::Path::new(path).components()
        .any(|c| c == Component::ParentDir)) { return Err("path_outside_allowed_folders".into()); }
    let required = |key: &str| value[key].as_str().map(str::to_owned).ok_or_else(|| format!("missing {key}"));
    let request = match kind {
        "read_file" => EndpointTaskRequest::ReadFile { path: path.into(), max_bytes: None },
        // The live enqueue DTO carries args, not content: one arg is the complete file body.
        "write_file" => EndpointTaskRequest::WriteFile { path: path.into(), content: value.get("content")
            .and_then(Value::as_str).or_else(|| value["args"].as_array().filter(|a| a.len() == 1)
                .and_then(|a| a[0].as_str())).ok_or("missing write content")?.into() },
        "list_dir" => EndpointTaskRequest::ListDir { path: path.into(), max_entries: None },
        "shell_exec" => {
            let mut command = required("command")?;
            if let Some(args) = value.get("args") {
                for arg in args.as_array().ok_or("invalid task args")? {
                    let arg = arg.as_str().ok_or("invalid task arg")?;
                    if cfg!(windows) {
                        if arg.contains(['"', '%', '!', '^', '&', '|', '<', '>', '\r', '\n', '\0']) {
                            return Err("unsafe Windows shell argument".into());
                        }
                        command.push_str(&format!(" \"{arg}\""));
                    } else { command.push_str(&format!(" '{}'", arg.replace('\'', "'\\''"))); }
                }
            }
            EndpointTaskRequest::RunShell { cwd: path.into(), command, timeout_ms: None }
        }
        "detect_clis" => EndpointTaskRequest::DetectClis,
        _ => return Err("unsupported endpoint task".into()),
    };
    Ok(request)
}
impl DaemonExecutor for LocalDaemonExecutor {
    fn execute(&mut self, task: &DaemonTask) -> DaemonTaskResult {
        if self.audit_failed { return DaemonTaskResult { task_id: task.task_id.clone(), ok: false,
            output: "null".into(), error: Some("endpoint audit write failed".into()) }; }
        let start = Instant::now();
        let parsed = serde_json::from_str::<Value>(&task.payload).map_err(|_| "invalid task JSON".into());
        let outcome = parsed.as_ref().map_err(Clone::clone).and_then(task_request)
            .map(|request| execute_endpoint_task(&task.task_id, &self.grants, &request));
        let (mut ok, output, mut error) = match outcome {
            Ok(result) => (result.ok, result.output.to_string(), result.error),
            Err(e) => (false, "null".into(), Some(e)),
        };
        let safe = |s: &str| redact_sensitive(&s.replace(&self.token, "[REDACTED]"));
        let entry = AuditEntry { timestamp_ms: now_ms(), task_id: safe(&task.task_id), action: safe(&task.kind),
            target_path: safe(parsed.as_ref().ok().and_then(|v| v["targetPath"].as_str()).unwrap_or("")),
            allowed: ok, exit_code: None, duration_ms: start.elapsed().as_millis() as u64,
            summary: safe(&error.clone().unwrap_or_else(|| output.clone())) };
        if self.audit.append(&entry).is_err() {
            self.audit_failed = true; ok = false; error = Some("endpoint audit write failed".into());
        }
        DaemonTaskResult { task_id: task.task_id.clone(), ok,
            output: output.replace(&self.token, "[REDACTED]"), error: error.map(|e| safe(&e)) }
    }
}
/// Resolve existing ancestors too, so alias paths cannot overwrite credentials with audit data.
pub fn endpoint_file_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() { return fs::canonicalize(path).map_err(|_| "invalid endpoint file path".into()); }
    let absolute = std::path::absolute(path).map_err(|_| "invalid endpoint file path")?;
    let parent = absolute.parent().ok_or("invalid endpoint file parent")?;
    let name = absolute.file_name().ok_or("invalid endpoint filename")?;
    Ok(endpoint_file_path(parent)?.join(name))
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
#[derive(Deserialize)]
struct Config { server_url: String, allowed_folders: Vec<String> }
#[derive(Deserialize)]
struct Credentials { #[serde(flatten)] identity: DeviceCredential, #[serde(rename = "companyId")] company_id: String }

pub fn run_endpoint_loop(opts: EndpointRunOptions) -> Result<EndpointRunSummary, String> {
    if opts.poll_ms == 0 || opts.heartbeat_ms == 0 { return Err("endpoint intervals must be positive".into()); }
    let audit_path = endpoint_file_path(&opts.audit_log)?;
    for protected in [&opts.config_path, &opts.credential_path, &opts.token_file] {
        if audit_path == endpoint_file_path(protected)? { return Err("audit path overlaps endpoint credentials or config".into()); }
    }
    let config: Config = serde_json::from_slice(&fs::read(&opts.config_path).map_err(|_| "cannot read endpoint config")?)
        .map_err(|_| "invalid endpoint config")?;
    let cred: Credentials = serde_json::from_slice(&fs::read(&opts.credential_path).map_err(|_| "cannot read endpoint credentials")?)
        .map_err(|_| "invalid endpoint credentials (re-pair to include companyId)")?;
    if cred.identity.is_expired(now_ms()) || config.server_url.trim_end_matches('/') != cred.identity.server_url.trim_end_matches('/') {
        return Err("expired credentials or server mismatch".into());
    }
    let token = match std::env::var("PAPERWORK_ENDPOINT_TOKEN") {
        Ok(token) => token,
        Err(std::env::VarError::NotPresent) => {
            let meta = fs::symlink_metadata(&opts.token_file).map_err(|_| "cannot read endpoint token file")?;
            if !meta.is_file() { return Err("endpoint token must be a regular file".into()); }
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o777 != 0o600 { return Err("endpoint token file must have 0600 permissions".into()); }
            }
            fs::read_to_string(&opts.token_file).map_err(|_| "cannot read endpoint token file")?.trim_end().into()
        }
        Err(_) => return Err("invalid endpoint token environment".into()),
    };
    crate::endpoint_protocol::build_auth_headers(&token, &cred.company_id)?;
    if !verify_token_sha256(&token, &cred.identity.token_hash) { return Err("endpoint token does not match credentials".into()); }
    let urls = EndpointUrls::new(&config.server_url)?;
    urls.heartbeat_url(&cred.identity.device_id)?;
    crate::service_install::validate_server_url(&config.server_url).map_err(|_| "invalid endpoint server URL")?;
    let grants = config.allowed_folders.iter().map(|raw| {
        let (path, mode) = match raw.rsplit_once(':') {
            Some((path, "rw")) => (path, FolderMode::Rw),
            Some((path, "ro")) => (path, FolderMode::Ro),
            _ => (raw.as_str(), FolderMode::Ro),
        };
        FolderGrant { path: PathBuf::from(path), mode }
    }).collect();
    // Check audit availability before polling any side-effecting task.
    let mut log_options = fs::OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    log_options.open(&opts.audit_log).map_err(|_| "endpoint audit open failed")?;
    let mut transport = HttpDaemonTransport { urls, pending_acks: HashSet::new(), device_id: cred.identity.device_id,
        config: HttpTransportConfig { server_url: config.server_url, timeout_secs: 15,
            company_id: Some(cred.company_id), device_token: Some(token.clone()) } };
    let mut executor = LocalDaemonExecutor { grants, audit: AuditLogger::new(opts.audit_log, 4 * 1024 * 1024), token, audit_failed: false };
    let mut daemon = EndpointDaemon::new(DaemonConfig { poll_batch_size: 16,
        heartbeat_interval_ms: opts.heartbeat_ms, max_outbox_entries: 1024 });
    let mut summary = EndpointRunSummary::default();
    while opts.max_ticks.is_none_or(|n| summary.ticks < n) {
        let report = daemon.tick(now_ms(), &mut transport, &mut executor);
        if executor.audit_failed { return Err("endpoint audit write failed".into()); }
        summary.ticks += 1; summary.heartbeats += usize::from(report.heartbeat_sent);
        summary.executed += report.executed_count; summary.acked += report.acked_count + report.flushed_count;
        summary.pending = report.buffered_count; summary.transport_errors += report.transport_errors.len();
        summary.dropped = daemon.dropped_count();
        if opts.max_ticks.is_none_or(|n| summary.ticks < n) { std::thread::sleep(Duration::from_millis(opts.poll_ms)); }
    }
    Ok(summary)
}
