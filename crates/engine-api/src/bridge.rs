#![forbid(unsafe_code)]
//! Fail-closed line-delimited JSON-RPC 2.0 subprocess dispatcher plus closure test dispatcher.

use crate::{RpcDispatcher, RpcFuture, RpcRequest};
use serde_json::{json, Value};
use std::{io::{Read, Write}, path::Path, process::{Child, Command, Stdio}, sync::{mpsc, Arc, Mutex, MutexGuard}, thread, time::{Duration, Instant}};
use tokio::task::spawn_blocking;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_PENDING: usize = 64;

fn internal_error(id: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": "internal_error"}})
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Synchronous function adapter useful for focused in-memory dispatcher tests.
pub struct ClosureDispatcher<F> { f: F }
impl<F> ClosureDispatcher<F> {
    pub fn new(f: F) -> Self { Self { f } }
}
impl<F> RpcDispatcher for ClosureDispatcher<F> where F: Fn(RpcRequest) -> Value + Send + Sync {
    fn dispatch(&self, request: RpcRequest) -> RpcFuture<'_> {
        Box::pin(async move { (self.f)(request) })
    }
}

type JobResult = Result<String, ()>;
struct Job { payload: Vec<u8>, response: mpsc::Sender<JobResult> }
struct Worker { tx: mpsc::SyncSender<Job>, child: Arc<Mutex<Child>> }
struct WorkerHandle { tx: mpsc::SyncSender<Job>, child: Arc<Mutex<Child>> }
impl Drop for Worker {
    fn drop(&mut self) { finish_child(&self.child); }
}

/// Resident backend process with serialized NDJSON exchange. A bounded queue prevents
/// unbounded pending work; every transport/protocol/timeout failure resets the child and
/// collapses to a sanitized -32603 without exposing process or panic details.
#[derive(Clone)]
pub struct EngineSubprocessDispatcher {
    program: String,
    args: Vec<String>,
    timeout: Duration,
    worker: Arc<Mutex<Option<Worker>>>,
}

impl EngineSubprocessDispatcher {
    pub fn new(program: impl Into<String>, args: Vec<String>, timeout: Duration) -> Self {
        Self { program: program.into(), args, timeout: timeout.max(Duration::from_millis(1)), worker: Arc::new(Mutex::new(None)) }
    }

    pub fn from_env() -> Option<Self> {
        std::env::var("PAPERWORK_ENGINE_BIN").ok().and_then(configured)
    }

    /// Matches the server-side runtime convention: explicit absolute binary first, then
    /// release/debug workspace binary locations. Unconfigured or invalid paths fail closed.
    pub fn resolve_default() -> Option<Self> {
        if std::env::var_os("PAPERWORK_ENGINE_BIN").is_some() { return Self::from_env(); }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        ["target/release/paperwork-engine", "target/debug/paperwork-engine"].iter()
            .map(|suffix| root.join(suffix))
            .find(|path| path.is_file())
            .and_then(|path| path.to_str().map(str::to_owned))
            .and_then(configured)
    }

    fn envelope(request: RpcRequest) -> Result<(Value, String), Value> {
        let id = request.id.clone();
        let mut object = serde_json::Map::new();
        object.insert("jsonrpc".to_owned(), json!("2.0"));
        object.insert("id".to_owned(), request.id);
        object.insert("method".to_owned(), json!(request.method));
        if let Some(params) = request.params { object.insert("params".to_owned(), params); }
        let payload = serde_json::to_string(&Value::Object(object)).map_err(|_| internal_error(id.clone()))?;
        if payload.len() > MAX_REQUEST_BYTES { return Err(internal_error(id)); }
        Ok((id, payload))
    }

    fn spawn_worker(&self) -> Option<Worker> {
        let program = Path::new(&self.program);
        if !program.is_absolute() || self.program.contains('\0') { return None; }
        let mut child = Command::new(program).args(&self.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill(); let _ = child.wait();
            return None;
        };
        let (tx, rx) = mpsc::sync_channel(MAX_PENDING);
        if thread::Builder::new().name("paperwork-engine-io".to_owned()).spawn(move || worker_loop(stdin, stdout, rx)).is_err() {
            let _ = child.kill(); let _ = child.wait();
            return None;
        }
        Some(Worker { tx, child: Arc::new(Mutex::new(child)) })
    }

    fn ensure_worker(&self) -> Option<WorkerHandle> {
        let mut slot = lock(&self.worker);
        if slot.is_none() { *slot = Some(self.spawn_worker()?); }
        slot.as_ref().map(|worker| WorkerHandle { tx: worker.tx.clone(), child: Arc::clone(&worker.child) })
    }

    fn clear_worker(&self, child: &Arc<Mutex<Child>>) {
        let mut slot = lock(&self.worker);
        if slot.as_ref().is_some_and(|worker| Arc::ptr_eq(&worker.child, child)) { drop(slot.take()); }
    }

    fn roundtrip(&self, request: RpcRequest) -> Value {
        let (id, payload) = match Self::envelope(request) { Ok(ok) => ok, Err(response) => return response };
        let started = Instant::now();
        let Some(handle) = self.ensure_worker() else { return internal_error(id) };
        let (tx, rx) = mpsc::channel();
        match handle.tx.try_send(Job { payload: payload.into_bytes(), response: tx }) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => return internal_error(id),
            Err(mpsc::TrySendError::Disconnected(_)) => { self.clear_worker(&handle.child); return internal_error(id); }
        }
        let remaining = self.timeout.saturating_sub(started.elapsed());
        let outcome = if remaining.is_zero() { Err(mpsc::RecvTimeoutError::Timeout) } else { rx.recv_timeout(remaining) };
        match outcome {
            Ok(Ok(line)) => {
                let parsed = parse_response(&id, &line);
                if parsed.is_none() { self.clear_worker(&handle.child); }
                parsed.unwrap_or_else(|| internal_error(id))
            }
            Ok(Err(())) | Err(_) => { self.clear_worker(&handle.child); internal_error(id) }
        }
    }
}

fn configured(program: String) -> Option<EngineSubprocessDispatcher> {
    let path = Path::new(&program);
    if program.is_empty() || program.contains('\0') || !path.is_absolute() || !path.is_file() { return None; }
    Some(EngineSubprocessDispatcher::new(program, Vec::new(), DEFAULT_TIMEOUT))
}

fn worker_loop(mut stdin: impl Write, mut stdout: impl Read, rx: mpsc::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        let result = exchange(&mut stdin, &mut stdout, &job.payload);
        let broken = result.is_err();
        let _ = job.response.send(result);
        if broken { break; }
    }
}

fn exchange(stdin: &mut impl Write, stdout: &mut impl Read, payload: &[u8]) -> Result<String, ()> {
    stdin.write_all(payload).and_then(|()| stdin.write_all(b"\n")).and_then(|()| stdin.flush()).map_err(|_| ())?;
    let (mut out, mut chunk, mut complete) = (Vec::new(), [0u8; 8192], false);
    loop {
        let n = stdout.read(&mut chunk).map_err(|_| ())?;
        if n == 0 { break; }
        let newline = chunk[..n].iter().position(|byte| *byte == b'\n');
        let end = newline.map_or(n, |pos| pos + 1);
        out.extend_from_slice(&chunk[..end]);
        if out.len() > MAX_RESPONSE_BYTES { return Err(()); }
        if newline.is_some() { complete = true; break; }
    }
    if !complete || out.is_empty() { return Err(()); }
    if out.ends_with(b"\n") { out.pop(); }
    if out.ends_with(b"\r") { out.pop(); }
    String::from_utf8(out).map_err(|_| ())
}

fn finish_child(child: &Arc<Mutex<Child>>) {
    let mut child = lock(child);
    if child.try_wait().ok().flatten().is_none() { let _ = child.kill(); }
    let _ = child.wait();
}

fn parse_response(id: &Value, line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    if object.keys().any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "result" | "error")) { return None; }
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || object.get("id") != Some(id) { return None; }
    match (object.get("result"), object.get("error")) {
        (Some(_), None) => Some(value),
        (None, Some(error)) => {
            let error = error.as_object()?;
            let valid_shape = error.get("code").and_then(Value::as_i64).is_some()
                && error.get("message").and_then(Value::as_str).is_some()
                && error.keys().all(|key| matches!(key.as_str(), "code" | "message" | "data"));
            valid_shape.then_some(value)
        }
        _ => None,
    }
}

impl RpcDispatcher for EngineSubprocessDispatcher {
    fn dispatch(&self, request: RpcRequest) -> RpcFuture<'_> {
        let id = request.id.clone();
        let bridge = self.clone();
        Box::pin(async move {
            match spawn_blocking(move || bridge.roundtrip(request)).await {
                Ok(response) => response,
                Err(_) => internal_error(id),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(dispatcher: &EngineSubprocessDispatcher, id: Value) -> Value {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            dispatcher.dispatch(RpcRequest { id, method: "test.echo".to_owned(), params: None }).await
        })
    }

    #[test]
    fn subprocess_roundtrip_uses_jsonrpc_envelope() {
        let script = "while IFS= read -r line; do printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}'; done";
        let dispatcher = EngineSubprocessDispatcher::new("/bin/sh", vec!["-c".into(), script.into()], Duration::from_secs(2));
        let response = call(&dispatcher, json!(1));
        assert_eq!(response["result"], json!({"ok": true}));
    }

    #[test]
    fn malformed_response_and_timeout_are_sanitized_and_reset() {
        let bad_script = "IFS= read -r line; printf '%s\\n' 'not-json-secret-detail'";
        let bad = EngineSubprocessDispatcher::new("/bin/sh", vec!["-c".into(), bad_script.into()], Duration::from_secs(2));
        assert_eq!(call(&bad, json!(2))["error"]["message"], json!("internal_error"));
        let slow_script = "IFS= read -r line; sleep 2";
        let slow = EngineSubprocessDispatcher::new("/bin/sh", vec!["-c".into(), slow_script.into()], Duration::from_millis(30));
        let started = Instant::now();
        let response = call(&slow, json!(3));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!((response["error"]["code"].clone(), response["error"]["message"].clone()), (json!(-32603), json!("internal_error")));
    }

    #[test]
    fn closure_dispatcher_supports_in_memory_tests() {
        let dispatcher = ClosureDispatcher::new(|request: RpcRequest| json!({"jsonrpc":"2.0","id":request.id,"result":{"method":request.method}}));
        let response = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            dispatcher.dispatch(RpcRequest { id: json!("x"), method: "m".to_owned(), params: None }).await
        });
        assert_eq!(response["result"]["method"], json!("m"));
    }
}
