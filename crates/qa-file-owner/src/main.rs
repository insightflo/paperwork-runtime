// crates/qa-file-owner/src/main.rs
//
// [purpose] C5 — kernel-owned exclusive file-publication helper; a Rust drop-in replacement for
//   server/src/services/workflow/control-flow/qa-remediation-file-owner.py. While the parent
//   (Node) re-verifies DB authority, this process holds flock(LOCK_EX) on guard files for the
//   declared canonical targets and performs all real IO (temp write/fsync/chmod/rename/readback
//   verify/dir fsync) inside itself; the parent never writes protected targets directly.
// [protocol] stdin/stdout private stdio — one JSON object per line, v=1 integer, bounded
//   non-empty string id. Sequence: begin → ready → publish* → close (or EOF). Locks are held
//   until close/EOF/process death; guard files are never unlinked or recreated.

mod guard;
mod protocol;
mod publish;
mod publish_io;

use crate::guard::{open_guard_fd, require_canonical_path};
use crate::protocol::{
    py_err, py_repr, read_line, refuse, send, Denied, FrameErr, Outcome, State, MAX_ID_BYTES, V,
};
use crate::publish::handle_publish;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::RawFd;
use std::process::exit;

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

fn op_begin(msg: &Map<String, Value>, rid: &Value, st: &mut State) -> Result<Outcome, Denied> {
    if st.begun {
        return Err(refuse("already_begun", "begin requested twice"));
    }
    let lock_root = require_canonical_path(msg.get("lockRoot"), "lock_root")?;
    let root_md = fs::metadata(lock_root).map_err(|e| Denied::Internal(py_err(&e)))?;
    if !root_md.is_dir() {
        return Err(refuse("bad_lock_root", "lockRoot is not a directory"));
    }
    if root_md.mode() & 0o022 != 0 {
        return Err(refuse("unsafe_lock_root", "lockRoot is group or world writable"));
    }
    let arr = match msg.get("targets") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Err(refuse("targets_empty", "targets must be a non-empty list")),
    };
    let mut targets: Vec<String> = Vec::with_capacity(arr.len());
    for entry in arr {
        targets.push(require_canonical_path(Some(entry), "target")?.to_string());
    }
    let mut uniq: HashSet<&str> = HashSet::with_capacity(targets.len());
    if !targets.iter().all(|t| uniq.insert(t.as_str())) {
        return Err(refuse("duplicate_targets", "targets contains duplicates"));
    }
    let mut sorted = targets;
    sorted.sort();
    let mut acquired: Vec<(String, RawFd)> = Vec::with_capacity(sorted.len());
    for target in &sorted {
        match open_guard_fd(lock_root, target) {
            Ok(fd) => acquired.push((target.clone(), fd)),
            Err(error) => {
                for (_, fd) in &acquired {
                    unsafe { libc::close(*fd) };
                }
                return Err(error);
            }
        }
    }
    st.guards = acquired.into_iter().collect();
    st.begun = true;
    let ready_targets: Vec<String> = {
        let mut keys: Vec<String> = st.guards.keys().cloned().collect();
        keys.sort();
        keys
    };
    send(&json!({"v": V, "id": rid, "type": "ready", "targets": ready_targets}));
    Ok(Outcome::Continue)
}

fn op_publish(msg: &Map<String, Value>, rid: &Value, st: &mut State) -> Result<Outcome, Denied> {
    if !st.begun {
        return Err(refuse("not_begun", "publish before begin"));
    }
    let mut reply = handle_publish(msg, &st.guards)?;
    let obj = reply.as_object_mut().expect("publish reply object");
    obj.insert("v".to_string(), json!(V));
    obj.insert("id".to_string(), rid.clone());
    send(&reply); // locks stay held until close/EOF — replies never lead the sync IO
    Ok(Outcome::Continue)
}

fn op_close(rid: &Value, st: &mut State) -> Result<Outcome, Denied> {
    if !st.begun {
        return Err(refuse("not_begun", "close before begin"));
    }
    for (_, fd) in st.guards.drain() {
        if unsafe { libc::close(fd) } != 0 {
            return Err(Denied::Internal(py_err(&io::Error::last_os_error())));
        }
    }
    send(&json!({"v": V, "id": rid, "type": "closed"}));
    Ok(Outcome::Done(0))
}

// ---------------------------------------------------------------------------
// frame dispatch + main loop
// ---------------------------------------------------------------------------

fn deny_with(id: &Value, denied: Denied) -> FrameErr {
    match denied {
        Denied::Refusal(code, message) => FrameErr::Refusal { code, message, id: id.clone() },
        Denied::Internal(m) => FrameErr::Internal(m),
    }
}

fn frame_err(code: &'static str, message: &str, id: Value) -> FrameErr {
    FrameErr::Refusal { code, message: message.to_string(), id }
}

/// Envelope validation order matches the Python helper exactly:
/// JSON parse → object → extract id/valid_id → v (integer 1) → valid_id → op dispatch.
fn frame(line: &str, st: &mut State) -> Result<Outcome, FrameErr> {
    let msg: Value = match serde_json::from_str(line.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))) {
        Ok(v) => v,
        Err(_) => return Err(frame_err("bad_json", "line is not JSON", Value::Null)),
    };
    let obj = match msg.as_object() {
        Some(o) => o,
        None => return Err(frame_err("bad_json", "frame is not a JSON object", Value::Null)),
    };
    let rid = obj.get("id");
    let valid_id = matches!(rid, Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= MAX_ID_BYTES);
    let id_out = if valid_id { rid.cloned().unwrap_or(Value::Null) } else { Value::Null };
    let version_ok = matches!(obj.get("v"), Some(Value::Number(n)) if n.as_i64() == Some(V));
    if !version_ok {
        return Err(deny_with(&id_out, refuse("bad_version", "unsupported protocol version")));
    }
    if !valid_id {
        return Err(deny_with(&id_out, refuse("bad_request_id", "request id must be a non-empty bounded string")));
    }
    let rid = rid.cloned().unwrap_or(Value::Null); // valid_id ⇒ Value::String
    let result = match obj.get("op").and_then(Value::as_str) {
        Some("begin") => op_begin(obj, &rid, st),
        Some("publish") => op_publish(obj, &rid, st),
        Some("close") => op_close(&rid, st),
        _ => {
            return Err(deny_with(
                &id_out,
                refuse("unknown_op", format!("unsupported op: {}", py_repr(obj.get("op")))),
            ))
        }
    };
    result.map_err(|d| deny_with(&id_out, d))
}

fn error_frame(id: Value, code: &str, message: &str) -> Value {
    json!({"v": V, "id": id, "type": "error", "code": code, "message": message})
}

fn run() -> i32 {
    let mut buf: Vec<u8> = Vec::new();
    let mut state = State { guards: HashMap::new(), begun: false };
    loop {
        let line = match read_line(&mut buf) {
            Ok(Some(l)) => l,
            Ok(None) => return 0, // EOF — locks die with the process; guard files remain
            Err(Denied::Refusal(code, message)) => {
                send(&error_frame(Value::Null, code, &message));
                return 2;
            }
            Err(Denied::Internal(message)) => {
                send(&error_frame(Value::Null, "internal", &message));
                return 3;
            }
        };
        match frame(&line, &mut state) {
            Ok(Outcome::Continue) => {}
            Ok(Outcome::Done(code)) => return code,
            Err(FrameErr::Refusal { code, message, id }) => {
                send(&error_frame(id, code, &message));
                return 2;
            }
            Err(FrameErr::Internal(message)) => {
                send(&error_frame(Value::Null, "internal", &message));
                return 3;
            }
        }
    }
}

fn main() {
    // Optional positional args (e.g. the legacy helper path passed by
    // spawn(pythonCommand, [helperPath])) are accepted and ignored — drop-in compatibility.
    exit(run());
}
