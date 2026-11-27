//! Integration tests for the remote endpoint task dispatcher and the offline JSONL
//! result outbox (`endpoint_dispatch`): task routing through fail-closed `local_tools`,
//! grant denials (escape / read-only), the tagged wire format, and append → load → ack.
#![cfg(unix)]

// This target only uses `TempDir` from the shared helpers; silence the rest.
#[allow(dead_code)]
mod common;

#[path = "../src/endpoint_dispatch.rs"]
mod endpoint_dispatch;

use common::TempDir;
use endpoint_dispatch::{
    execute_endpoint_task, EndpointTaskRequest, EndpointTaskResult, OfflineResultQueue, MAX_READ_BYTES,
};
use paperwork_bot_runtime::local_tools::{FolderGrant, FolderMode};
use std::fs;
use std::path::Path;

fn grant(dir: &Path, mode: FolderMode) -> FolderGrant {
    FolderGrant { path: dir.to_path_buf(), mode }
}

fn rw_grants(tag: &str) -> (TempDir, Vec<FolderGrant>) {
    let tmp = TempDir::new(tag);
    let rw = tmp.join("rw");
    fs::create_dir_all(&rw).expect("rw dir");
    (tmp, vec![grant(&rw, FolderMode::Rw)])
}

fn result(task_id: &str) -> EndpointTaskResult {
    EndpointTaskResult { task_id: task_id.to_string(), ok: true, output: serde_json::json!({ "note": task_id }), error: None }
}

fn dispatch(task_id: &str, grants: &[FolderGrant], req: EndpointTaskRequest) -> EndpointTaskResult {
    execute_endpoint_task(task_id, grants, &req)
}

fn pending_ids(queue_path: &Path) -> Vec<String> {
    OfflineResultQueue::load_pending(queue_path).expect("load pending").into_iter().map(|r| r.task_id).collect()
}

#[test]
fn read_file_dispatch_returns_file_content() {
    let (_tmp, grants) = rw_grants("ed-read");
    let rw = grants[0].path.clone();
    fs::write(rw.join("note.txt"), "hello endpoint").expect("fixture");
    let res = dispatch("t-read", &grants, EndpointTaskRequest::ReadFile { path: rw.join("note.txt").to_string_lossy().into_owned(), max_bytes: None });
    assert!(res.ok, "expected ok, got {:?}", res.error);
    assert_eq!(res.task_id, "t-read");
    assert_eq!(res.output, serde_json::json!("hello endpoint"));
    assert_eq!(res.error, None);
}

#[test]
fn read_file_default_cap_enforced_with_fail_closed_error() {
    let (_tmp, grants) = rw_grants("ed-cap");
    let rw = grants[0].path.clone();
    fs::write(rw.join("big.txt"), "a".repeat(MAX_READ_BYTES + 1)).expect("fixture");
    let res = dispatch("t-cap", &grants, EndpointTaskRequest::ReadFile { path: rw.join("big.txt").to_string_lossy().into_owned(), max_bytes: None });
    assert!(!res.ok, "oversized read must fail");
    assert_eq!(res.error.as_deref(), Some("file_exceeds_max_bytes"));
    assert!(res.output.is_null());
}

#[test]
fn write_file_dispatch_writes_content_and_reports_path() {
    let (_tmp, grants) = rw_grants("ed-write");
    let rw = grants[0].path.clone();
    let target = rw.join("out/note.txt");
    let res = dispatch("t-write", &grants, EndpointTaskRequest::WriteFile { path: target.to_string_lossy().into_owned(), content: "written".into() });
    assert!(res.ok, "expected ok, got {:?}", res.error);
    assert!(target.exists(), "file must exist after write");
    assert_eq!(fs::read_to_string(&target).expect("read back"), "written");
    assert_eq!(res.output, serde_json::json!(target.to_string_lossy().into_owned()));
}

#[test]
fn list_dir_dispatch_returns_sorted_entries() {
    let (_tmp, grants) = rw_grants("ed-list");
    let rw = grants[0].path.clone();
    fs::write(rw.join("b.txt"), "second").expect("fixture");
    fs::write(rw.join("a.txt"), "first").expect("fixture");
    fs::create_dir(rw.join("zdir")).expect("fixture dir");
    let res = dispatch("t-list", &grants, EndpointTaskRequest::ListDir { path: rw.to_string_lossy().into_owned(), max_entries: None });
    assert!(res.ok, "expected ok, got {:?}", res.error);
    let names: Vec<&str> = res.output.as_array().expect("array").iter().map(|e| e["name"].as_str().expect("name")).collect();
    assert_eq!(names, ["a.txt", "b.txt", "zdir"]);
    assert_eq!(res.output[2]["is_dir"], serde_json::json!(true));
}

#[test]
fn run_shell_dispatch_executes_inside_granted_cwd() {
    let (_tmp, grants) = rw_grants("ed-shell");
    let rw = grants[0].path.clone();
    let res = dispatch("t-shell", &grants, EndpointTaskRequest::RunShell { cwd: rw.to_string_lossy().into_owned(), command: "echo hi".into(), timeout_ms: None });
    assert!(res.ok, "expected ok, got {:?}", res.error);
    assert_eq!(res.output["exit_code"], serde_json::json!(0));
    assert_eq!(res.output["stdout"], serde_json::json!("hi\n"));
    assert_eq!(res.output["timed_out"], serde_json::json!(false));
}

#[test]
fn detect_clis_dispatch_lists_known_cli_entries() {
    let (_tmp, grants) = rw_grants("ed-clis");
    let res = dispatch("t-clis", &grants, EndpointTaskRequest::DetectClis);
    assert!(res.ok, "expected ok, got {:?}", res.error);
    let entries = res.output.as_array().expect("array");
    assert!(!entries.is_empty(), "known-CLI table must be non-empty");
    for entry in entries {
        assert!(entry["id"].is_string() && entry["binary"].is_string() && entry["available"].is_boolean());
    }
}

#[test]
fn escape_and_read_only_grants_are_denied_fail_closed() {
    let tmp = TempDir::new("ed-deny");
    let (rw, ro) = (tmp.join("rw"), tmp.join("ro"));
    fs::create_dir_all(&rw).expect("rw dir");
    fs::create_dir_all(&ro).expect("ro dir");
    let grants = [grant(&rw, FolderMode::Rw), grant(&ro, FolderMode::Ro)];

    let escape = dispatch("t-escape", &grants, EndpointTaskRequest::ReadFile { path: rw.join("../outside.txt").to_string_lossy().into_owned(), max_bytes: None });
    assert!(!escape.ok);
    assert_eq!(escape.error.as_deref(), Some("path_outside_allowed_folders"));

    let ro_write = dispatch("t-ro-write", &grants, EndpointTaskRequest::WriteFile { path: ro.join("blocked.txt").to_string_lossy().into_owned(), content: "no".into() });
    assert!(!ro_write.ok);
    assert_eq!(ro_write.error.as_deref(), Some("folder_read_only"));
    assert!(!ro.join("blocked.txt").exists(), "denied write must leave no file");

    let ro_shell = dispatch("t-ro-shell", &grants, EndpointTaskRequest::RunShell { cwd: ro.to_string_lossy().into_owned(), command: "echo hi".into(), timeout_ms: None });
    assert!(!ro_shell.ok);
    assert_eq!(ro_shell.error.as_deref(), Some("folder_read_only"));
}

#[test]
fn endpoint_task_request_wire_format_is_kind_tagged() {
    let read = EndpointTaskRequest::ReadFile { path: "/tmp/x".into(), max_bytes: Some(1024) };
    let json = serde_json::to_value(&read).expect("serialize");
    assert_eq!(json["kind"], serde_json::json!("read_file"));
    assert_eq!(json["max_bytes"], serde_json::json!(1024));
    let back = serde_json::from_value::<EndpointTaskRequest>(json.clone()).expect("deserialize");
    assert_eq!(serde_json::to_value(&back).expect("re-serialize"), json);

    let shell = EndpointTaskRequest::RunShell { cwd: "/tmp".into(), command: "echo".into(), timeout_ms: None };
    let json = serde_json::to_value(&shell).expect("serialize");
    assert_eq!(json["kind"], serde_json::json!("run_shell"));
    let back = serde_json::from_value::<EndpointTaskRequest>(json.clone()).expect("deserialize");
    assert_eq!(serde_json::to_value(&back).expect("re-serialize"), json);
}

#[test]
fn offline_queue_append_load_ack_roundtrip_survives_reack() {
    let tmp = TempDir::new("ed-queue");
    let queue = tmp.join("results.jsonl");
    OfflineResultQueue::append_result(&queue, &result("task-a")).expect("append a");
    OfflineResultQueue::append_result(&queue, &result("task-b")).expect("append b");
    assert_eq!(pending_ids(&queue), ["task-a", "task-b"]);

    OfflineResultQueue::ack_task(&queue, "task-a").expect("ack a");
    assert_eq!(pending_ids(&queue), ["task-b"], "acked task must be removed exactly once");

    OfflineResultQueue::ack_task(&queue, "task-a").expect("re-ack");
    assert_eq!(pending_ids(&queue), ["task-b"], "duplicate ack must stay a no-op");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&queue).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "queue file must stay owner-only 0600");
    }
}

#[test]
fn offline_queue_tolerates_torn_line_and_compacts_on_ack() {
    use std::io::Write;
    let tmp = TempDir::new("ed-torn");
    let queue = tmp.join("results.jsonl");
    OfflineResultQueue::append_result(&queue, &result("task-a")).expect("append");

    let mut file = fs::OpenOptions::new().append(true).open(&queue).expect("open queue");
    file.write_all(b"{\"task_id\": \"torn\"").expect("torn residue"); // crash residue, no newline
    drop(file);

    assert_eq!(pending_ids(&queue), ["task-a"], "torn tail must be skipped, not fatal");

    OfflineResultQueue::ack_task(&queue, "task-a").expect("ack");
    assert!(pending_ids(&queue).is_empty());
    assert!(!fs::read_to_string(&queue).expect("read").contains("torn"), "ack rewrite must compact invalid lines");
}
