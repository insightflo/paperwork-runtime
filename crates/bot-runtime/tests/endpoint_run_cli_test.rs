//! Real CLI + bounded loopback HTTP tests; no production service or inherited tokens.
#![cfg(unix)]
#[allow(dead_code)]
mod common;
use common::{assert_failed_cleanly, assert_succeeded_cleanly, bot_command, stdout_json, TempDir};
use paperwork_bot_runtime::token::sha256_hex;
use serde_json::{json, Value};
use std::{fs, io::{Read, Write}, net::TcpListener, os::unix::fs::PermissionsExt,
    process::{Command, Output}, thread, time::{Duration, Instant}};
const TOKEN: &str = "stage35-device-secret-0123456789";
fn server(replies: Vec<Value>) -> (String, thread::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (url, thread::spawn(move || replies.into_iter().map(|reply| {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut stream = loop {
            if let Ok((stream, _)) = listener.accept() { break stream; }
            assert!(Instant::now() < deadline, "expected HTTP request never arrived");
            thread::sleep(Duration::from_millis(5));
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut raw = Vec::new();
        let (head, body) = loop {
            let mut buf = [0; 4096];
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0, "incomplete request");
            raw.extend_from_slice(&buf[..n]);
            if let Some(end) = raw.windows(4).position(|s| s == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..end]).into_owned();
                let len: usize = head.lines().find_map(|l| l.split_once(':')
                    .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .map(|(_, v)| v.trim().parse().unwrap())).unwrap();
                if raw.len() >= end + 4 + len { break (head, serde_json::from_slice(&raw[end+4..end+4+len]).unwrap()); }
            }
        };
        let status = reply.get("httpStatus").and_then(Value::as_u64).unwrap_or(200);
        let reply_body = reply.to_string();
        write!(stream, "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply_body}", reply_body.len()).unwrap();
        (head, body)
    }).collect()))
}
fn fixture(dir: &TempDir, url: &str, mode: &str) {
    fs::create_dir_all(dir.join("work")).unwrap();
    fs::write(dir.join("work/entry.txt"), "Bearer private-audit-value").unwrap();
    fs::write(dir.join("endpoint.json"), json!({"server_url":url,"endpoint_name":"test",
        "allowed_folders":[format!("{}:{mode}", dir.join("work").display())]}).to_string()).unwrap();
    fs::write(dir.join("credentials.json"), json!({"deviceId":"dev-35","botName":"test",
        "companyId":"company-35","serverUrl":url,"tokenHash":sha256_hex(TOKEN),
        "issuedAtMs":0,"expiresAtMs":u64::MAX,"allowedFolders":[]}).to_string()).unwrap();
    fs::write(dir.join("device.token"), TOKEN).unwrap();
    fs::set_permissions(dir.join("device.token"), fs::Permissions::from_mode(0o600)).unwrap();
}
fn run_command(dir: &TempDir) -> Command {
    let mut cmd = bot_command(dir, &["endpoint-run"]);
    cmd.env_remove("PAPERWORK_ENDPOINT_TOKEN").arg("--config").arg(dir.join("endpoint.json"))
        .arg("--cred").arg(dir.join("credentials.json")).arg("--audit-log").arg(dir.join("audit.jsonl"))
        .args(["--poll-ms", "1", "--heartbeat-ms", "60000", "--max-ticks", "1"]);
    cmd
}
fn clean(out: &Output) {
    assert_succeeded_cleanly(out);
    assert!(!format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).contains(TOKEN));
}
fn task(dir: &TempDir, kind: &str, rel: &str) -> Value {
    json!({"taskId":"task-35","kind":kind,"targetPath":dir.join(rel)})
}
#[test]
fn heartbeat_poll_list_ack_and_redacted_audit() {
    let dir = TempDir::new("run-ok");
    let (url, http) = server(vec![json!({}), json!({"tasks":[task(&dir,"list_dir","work")]}), json!({})]);
    fixture(&dir, &url, "ro");
    clean(&run_command(&dir).output().unwrap());
    let requests = http.join().unwrap();
    for (i, path) in ["heartbeat", "tasks/poll", "tasks/task-35/ack"].iter().enumerate() {
        assert!(requests[i].0.starts_with(&format!("POST /api/endpoints/dev-35/{path} HTTP/1.1")));
        assert!(requests[i].0.contains(&format!("Authorization: Bearer {TOKEN}")));
        assert!(requests[i].0.to_lowercase().contains("x-company-id: company-35"));
        assert_eq!(requests[i].1["companyId"], "company-35");
    }
    assert!(requests[0].1.get("timestampMs").is_none()); // Live server is strict.
    assert!(requests[2].1.get("durationMs").is_none());
    assert_eq!(requests[2].1["ok"], true);
    let entries: Value = serde_json::from_str(requests[2].1["output"].as_str().unwrap()).unwrap();
    assert_eq!(entries[0]["name"], "entry.txt");
    let audit: Value = serde_json::from_str(fs::read_to_string(dir.join("audit.jsonl")).unwrap().trim()).unwrap();
    assert_eq!(audit["allowed"], true);
}
#[test]
fn outside_traversal_and_read_only_tasks_are_denied_and_audited() {
    for (kind, path) in [("list_dir","outside"), ("list_dir","work/../work"), ("write_file","work/entry.txt")] {
        let dir = TempDir::new("run-deny");
        let mut denied = task(&dir, kind, path); denied["content"] = json!("replace");
        let (url, http) = server(vec![json!({}), json!([denied]), json!({})]);
        fixture(&dir, &url, "ro");
        clean(&run_command(&dir).output().unwrap());
        assert_eq!(http.join().unwrap()[2].1["ok"], false);
        let audit: Value = serde_json::from_str(fs::read_to_string(dir.join("audit.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(audit["allowed"], false);
        assert_eq!(fs::read_to_string(dir.join("work/entry.txt")).unwrap(), "Bearer private-audit-value");
    }
}
#[test]
fn missing_credentials_or_token_fail_closed() {
    let dir = TempDir::new("run-missing");
    for missing in ["credentials.json", "device.token"] {
        fixture(&dir, "http://127.0.0.1:1", "ro"); fs::remove_file(dir.join(missing)).unwrap();
        let out = run_command(&dir).output().unwrap();
        assert_eq!(out.status.code(), Some(1)); assert!(assert_failed_cleanly(&out).contains(if missing == "device.token" { "token" } else { "credentials" }));
    }
}
#[test]
fn write_read_shell_detect_and_env_token_work_without_leaking_audit_secrets() {
    let dir = TempDir::new("run-tools");
    let mut write = task(&dir,"write_file","work/new.txt"); write["args"] = json!([format!("{TOKEN} Bearer audit-secret")]);
    let read = json!({"taskId":"read","kind":"read_file","targetPath":dir.join("work/new.txt")});
    let shell = json!({"taskId":"shell","kind":"shell_exec","targetPath":dir.join("work"),"command":"printf","args":["safe argument"]});
    let detect = json!({"taskId":"detect","kind":"detect_clis"});
    let (url, http) = server(vec![json!({}),json!([write,read,shell,detect]),json!({}),json!({}),json!({}),json!({})]);
    fixture(&dir, &url, "rw"); fs::remove_file(dir.join("device.token")).unwrap();
    clean(&run_command(&dir).env("PAPERWORK_ENDPOINT_TOKEN", TOKEN).output().unwrap());
    let requests = http.join().unwrap();
    assert!(requests[2..].iter().all(|r| r.1["ok"] == true));
    assert!(requests[4].1["output"].as_str().unwrap().contains("safe argument"));
    let audit = fs::read_to_string(dir.join("audit.jsonl")).unwrap();
    assert_eq!(audit.lines().count(), 4); assert!(audit.contains("[REDACTED]"));
    assert!(!audit.contains(TOKEN) && !audit.contains("audit-secret"));
}
#[test]
fn pairing_persists_private_token_and_hash_only_credentials() {
    let dir = TempDir::new("run-pair");
    let (url, http) = server(vec![json!({"deviceId":"dev-35","botName":"test","companyId":"company-35",
        "deviceToken":TOKEN,"tokenPreview":"safe-preview"}),json!({}),json!([])]);
    let out = bot_command(&dir, &["endpoint-pair","--server",&url,"--code","ABC234"])
        .arg("--cred").arg(dir.join("credentials.json")).arg("--token-file").arg(dir.join("private/device.secret")).output().unwrap();
    clean(&out); assert_eq!(stdout_json(&out)["ok"], true);
    assert_eq!(fs::read_to_string(dir.join("private/device.secret")).unwrap(), TOKEN);
    assert_eq!(fs::metadata(dir.join("private/device.secret")).unwrap().permissions().mode() & 0o777, 0o600);
    fs::write(dir.join("endpoint.json"),json!({"server_url":url,"allowed_folders":[]}).to_string()).unwrap();
    clean(&run_command(&dir).arg("--token-file").arg(dir.join("private/device.secret")).output().unwrap()); http.join().unwrap();
    let cred = fs::read_to_string(dir.join("credentials.json")).unwrap();
    assert!(!cred.contains(TOKEN)); assert_eq!(serde_json::from_str::<Value>(&cred).unwrap()["companyId"], "company-35");
}
#[test]
fn retries_acks_without_reexecution_and_throttles_heartbeats() {
    let dir = TempDir::new("run-retry");
    let (url, http) = server(vec![json!({}),json!([task(&dir,"list_dir","work")]),
        json!({"httpStatus":503,"error":TOKEN}),json!({"httpStatus":503}),json!({}),json!([])]);
    fixture(&dir,&url,"ro"); let out = run_command(&dir).args(["--max-ticks","3"]).output().unwrap();
    // Use one option occurrence: duplicate CLI flags must fail closed.
    assert_failed_cleanly(&out);
    let cmd = run_command(&dir); let args: Vec<_> = cmd.get_args().map(|s| s.to_os_string()).collect();
    let out = Command::new(common::BIN).args(&args[..args.len()-1]).arg("3").env_remove("PAPERWORK_ENDPOINT_TOKEN").output().unwrap();
    clean(&out); let summary = stdout_json(&out);
    assert_eq!((summary["ticks"].as_u64(),summary["heartbeats"].as_u64(),summary["executed"].as_u64()),(Some(3),Some(1),Some(1)));
    assert_eq!(summary["pending"],0); assert_eq!(summary["transport_errors"],2);
    let requests = http.join().unwrap(); assert_eq!(requests.len(),6);
    assert_eq!(requests[2].1, requests[4].1);
    assert_eq!(fs::read_to_string(dir.join("audit.jsonl")).unwrap().lines().count(),1);
}
#[test]
fn rejects_bad_token_audit_paths_and_renders_live_services() {
    let dir = TempDir::new("run-preflight"); fixture(&dir,"http://127.0.0.1:1","ro");
    fs::set_permissions(dir.join("device.token"),fs::Permissions::from_mode(0o644)).unwrap();
    assert!(assert_failed_cleanly(&run_command(&dir).output().unwrap()).contains("0600"));
    fs::set_permissions(dir.join("device.token"),fs::Permissions::from_mode(0o600)).unwrap();
    assert!(assert_failed_cleanly(&run_command(&dir).env("PAPERWORK_ENDPOINT_TOKEN","wrong").output().unwrap()).contains("match"));
    std::os::unix::fs::symlink(dir.join("device.token"),dir.join("audit.jsonl")).unwrap();
    assert!(assert_failed_cleanly(&run_command(&dir).output().unwrap()).contains("overlaps"));
    for os in ["macos","linux","windows"] {
        let out = bot_command(&dir,&["render-service","--os",os,"--server","https://paperwork.insightflo.si","--name","test"]).output().unwrap();
        assert!(out.status.success()); assert!(String::from_utf8(out.stdout).unwrap().contains("endpoint-run"));
    }
}
