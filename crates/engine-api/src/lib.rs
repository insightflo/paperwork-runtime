#![forbid(unsafe_code)]
//! Bounded Tokio HTTP/1.1 API gateway foundation with SSE and fail-closed JSON-RPC validation.

pub mod bridge; pub mod routes;

use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::Arc, task::Poll, time::{Duration, Instant}};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::watch, task::JoinSet};

pub const MAX_HEADER_BYTES: usize = 16 * 1024; pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_PARAMS_BYTES: usize = 512 * 1024;
const MAX_CONNECTIONS: usize = 128; const READ_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2); const SSE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug)] pub struct RpcRequest { pub id: Value, pub method: String, pub params: Option<Value> }
pub type RpcFuture<'a> = Pin<Box<dyn Future<Output = Value> + Send + 'a>>;

pub trait RpcDispatcher: Send + Sync {
    fn dispatch(&self, request: RpcRequest) -> RpcFuture<'_>;
}

#[derive(Debug, Default)]
pub struct MethodNotFoundDispatcher;
impl RpcDispatcher for MethodNotFoundDispatcher {
    fn dispatch(&self, request: RpcRequest) -> RpcFuture<'_> {
        Box::pin(async move { rpc_error(request.id, -32601, "method_not_found") })
    }
}
pub fn default_dispatcher() -> Arc<dyn RpcDispatcher> { Arc::new(MethodNotFoundDispatcher) }
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[derive(Debug, Clone, Copy)]
struct Reject { status: u16, error: &'static str }
fn bad() -> Reject { Reject { status: 400, error: "bad_request" } }
fn too_large() -> Reject { Reject { status: 413, error: "payload_too_large" } }
struct Request { method: String, path: String, body: Vec<u8> }

enum Either<A, B> { First(A), Second(B) }
async fn select2<F: Future, G: Future>(first: F, second: G) -> Either<F::Output, G::Output> {
    let (mut first, mut second) = (Box::pin(first), Box::pin(second));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = first.as_mut().poll(cx) { return Poll::Ready(Either::First(value)); }
        if let Poll::Ready(value) = second.as_mut().poll(cx) { return Poll::Ready(Either::Second(value)); }
        Poll::Pending
    }).await
}

fn is_token(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'))
}

fn parse_content_length(value: &str) -> Result<usize, Reject> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(bad()); }
    let mut length = 0usize;
    for digit in value.bytes() {
        length = length.checked_mul(10).and_then(|n| n.checked_add(usize::from(digit - b'0'))).ok_or_else(too_large)?;
    }
    if length > MAX_BODY_BYTES { Err(too_large()) } else { Ok(length) }
}

fn parse_request_head(head: &[u8]) -> Result<(String, String, usize), Reject> {
    let text = std::str::from_utf8(head).map_err(|_| bad())?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().filter(|line| !line.is_empty()).ok_or_else(bad)?;
    let parts: Vec<&str> = request_line.split(' ').collect();
    if parts.len() != 3 || parts[..2].iter().any(|part| part.is_empty()) || parts[2] != "HTTP/1.1" { return Err(bad()); }
    let target = parts[1];
    if target.bytes().any(|byte| byte <= b' ' || byte == 127) { return Err(bad()); }
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    if !is_token(parts[0]) || !path.starts_with('/') { return Err(bad()); }
    let mut content_length = None;
    for line in lines {
        if line.is_empty() { return Err(bad()); }
        let (name, value) = line.split_once(':').ok_or_else(bad)?;
        if !is_token(name) { return Err(bad()); }
        let value = value.trim_matches(|ch| ch == ' ' || ch == '\t');
        if value.bytes().any(|b| (b < 32 && b != b'\t') || b == 127) { return Err(bad()); }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() { return Err(bad()); }
            content_length = Some(parse_content_length(value)?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") { return Err(bad()); }
    }
    Ok((parts[0].to_owned(), path.to_owned(), content_length.unwrap_or(0)))
}

async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Request, Reject> {
    let (mut buf, mut chunk) = (Vec::with_capacity(8192), [0u8; 2048]);
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") { break pos; }
        if buf.len() >= MAX_HEADER_BYTES { return Err(too_large()); }
        let n = match tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => return Err(bad()), Ok(Ok(n)) => n, _ => return Err(bad()),
        };
        buf.extend_from_slice(&chunk[..n]);
    };
    if head_end + 4 > MAX_HEADER_BYTES { return Err(too_large()); }
    let (method, path, content_length) = parse_request_head(&buf[..head_end])?;
    if method == "GET" && content_length > 0 { return Err(bad()); }
    let mut body = buf.split_off(head_end + 4);
    if body.len() > content_length { return Err(bad()); }
    if body.len() < content_length {
        let mut tail = vec![0; content_length - body.len()];
        match tokio::time::timeout(READ_TIMEOUT, stream.read_exact(&mut tail)).await {
            Ok(Ok(_)) => body.extend_from_slice(&tail), _ => return Err(bad()),
        }
    }
    Ok(Request { method, path, body })
}

fn status_reason(status: u16) -> &'static str {
    match status { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", 413 => "Payload Too Large", 501 => "Not Implemented", 502 => "Bad Gateway", _ => "Internal Server Error" }
}
async fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8], extra_headers: &str) -> tokio::io::Result<()> {
    let head = format!("HTTP/1.1 {} {}\r\ncontent-length: {}\r\ncontent-type: {}\r\ncache-control: no-store\r\nconnection: close\r\n{}\r\n",
        status, status_reason(status), body.len(), content_type, extra_headers);
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}
fn drain_available(stream: &mut TcpStream) {
    let (mut chunk, mut remaining) = ([0u8; 2048], 64 * 1024);
    while remaining > 0 { match stream.try_read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => remaining -= n.min(remaining) } }
}
async fn write_error(stream: &mut TcpStream, reject: Reject, extra_headers: &str) -> tokio::io::Result<()> {
    let body = json!({"error": reject.error}).to_string();
    write_response(stream, reject.status, "application/json", body.as_bytes(), extra_headers).await?;
    drain_available(stream); Ok(())
}
fn uptime_ms(started: Instant) -> u64 { u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX) }
fn heartbeat_frame(started: Instant) -> String {
    let data = json!({"engine": "paperwork-engine-api", "uptime_ms": uptime_ms(started)});
    format!("event: heartbeat\ndata: {data}\n\n")
}

async fn write_sse(stream: &mut TcpStream, started: Instant, mut shutdown: watch::Receiver<bool>) -> tokio::io::Result<()> {
    stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n\r\n").await?;
    stream.write_all(b": connected\n\n").await?;
    stream.write_all(heartbeat_frame(started).as_bytes()).await?;
    stream.flush().await?;
    let mut interval = tokio::time::interval(SSE_HEARTBEAT_INTERVAL);
    interval.tick().await;
    while !*shutdown.borrow() {
        match select2(shutdown.changed(), interval.tick()).await {
            Either::First(_) => break,
            Either::Second(_) => {
                stream.write_all(heartbeat_frame(started).as_bytes()).await?;
                stream.flush().await?;
            }
        }
    }
    Ok(())
}

fn invalid_request(id: Value) -> Value { rpc_error(id, -32600, "invalid_request") }
fn parse_rpc(body: &[u8]) -> Result<RpcRequest, Value> {
    let value: Value = serde_json::from_slice(body).map_err(|_| rpc_error(Value::Null, -32700, "parse_error"))?;
    let obj = value.as_object().ok_or_else(|| invalid_request(Value::Null))?;
    let fallback_id = obj.get("id").filter(|id| id.is_string() || id.is_number()).cloned().unwrap_or(Value::Null);
    let invalid = || invalid_request(fallback_id.clone());
    if obj.keys().any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params")) { return Err(invalid()); }
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return Err(invalid()); }
    let id = match obj.get("id") {
        Some(id) if id.is_string() || id.is_number() => id.clone(), _ => return Err(invalid()),
    };
    let Some(method) = obj.get("method").and_then(Value::as_str).filter(|method| !method.is_empty()) else { return Err(invalid()); };
    let params = match obj.get("params") {
        None => None,
        Some(params) if params.is_object() || params.is_array() => {
            let len = serde_json::to_vec(params).map(|encoded| encoded.len()).unwrap_or(usize::MAX);
            if len > MAX_PARAMS_BYTES { return Err(invalid()); }
            Some(params.clone())
        }
        Some(_) => return Err(invalid()),
    };
    Ok(RpcRequest { id, method: method.to_owned(), params })
}
async fn handle_rpc(body: &[u8], dispatcher: &Arc<dyn RpcDispatcher>) -> Value {
    match parse_rpc(body) { Ok(request) => dispatcher.dispatch(request).await, Err(response) => response }
}

async fn try_handle_connection(mut stream: TcpStream, dispatcher: Arc<dyn RpcDispatcher>, started: Instant, shutdown: watch::Receiver<bool>) -> tokio::io::Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request, Err(reject) => return write_error(&mut stream, reject, "").await,
    };
    match routes::handle_rest(&request.method, &request.path, &dispatcher).await {
        routes::RestOutcome::NotMatched => {}
        routes::RestOutcome::MethodNotAllowed => return write_error(&mut stream, Reject { status: 405, error: "method_not_allowed" }, "allow: GET\r\n").await,
        routes::RestOutcome::Response { status, body } => return write_response(&mut stream, status, "application/json", &body, "").await,
    }
    let expected = match request.path.as_str() {
        "/api/health" | "/api/events" => "GET", "/api/rpc" => "POST", _ => "",
    };
    if expected.is_empty() { return write_error(&mut stream, Reject { status: 404, error: "not_found" }, "").await; }
    if request.method != expected {
        let allow = format!("allow: {expected}\r\n");
        return write_error(&mut stream, Reject { status: 405, error: "method_not_allowed" }, &allow).await;
    }
    match request.path.as_str() {
        "/api/health" => {
            let body = json!({"status": "ok", "engine": "paperwork-engine-api", "version": env!("CARGO_PKG_VERSION"), "uptime_ms": uptime_ms(started)}).to_string();
            write_response(&mut stream, 200, "application/json", body.as_bytes(), "").await
        }
        "/api/events" => write_sse(&mut stream, started, shutdown).await,
        _ => {
            let response = handle_rpc(&request.body, &dispatcher).await;
            let body = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, 200, "application/json", &body, "").await
        }
    }
}

async fn drain_connections(connections: &mut JoinSet<()>) {
    let drain = async { while connections.join_next().await.is_some() {} };
    if tokio::time::timeout(SHUTDOWN_GRACE, drain).await.is_err() { connections.abort_all(); }
}
async fn wait_for_capacity(connections: &mut JoinSet<()>, shutdown: &mut watch::Receiver<bool>) -> bool {
    while connections.len() >= MAX_CONNECTIONS {
        match select2(shutdown.changed(), connections.join_next()).await {
            Either::First(_) => return false,
            Either::Second(Some(_)) => {}
            Either::Second(None) => break,
        }
    }
    true
}

pub async fn serve(listener: TcpListener, dispatcher: Arc<dyn RpcDispatcher>, mut shutdown: watch::Receiver<bool>) -> tokio::io::Result<()> {
    let started = Instant::now();
    let mut connections = JoinSet::new();
    loop {
        if *shutdown.borrow() || !wait_for_capacity(&mut connections, &mut shutdown).await { break; }
        match select2(shutdown.changed(), listener.accept()).await {
            Either::First(_) => break,
            Either::Second(Ok((stream, _))) => {
                let (dispatcher, connection_shutdown) = (Arc::clone(&dispatcher), shutdown.clone());
                connections.spawn(async move { let _ = try_handle_connection(stream, dispatcher, started, connection_shutdown).await; });
            }
            Either::Second(Err(err)) => {
                drain_connections(&mut connections).await;
                return Err(err);
            }
        }
    }
    drain_connections(&mut connections).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    #[test]
    fn head_parser_enforces_strict_content_length() {
        let (method, path, len) = parse_request_head(b"POST /api/rpc HTTP/1.1\r\nContent-Length: 2").unwrap();
        assert_eq!((method.as_str(), path.as_str(), len), ("POST", "/api/rpc", 2));
        let (_, query_path, _) = parse_request_head(b"GET /api/health?x=1 HTTP/1.1").unwrap();
        assert_eq!(query_path, "/api/health");
        for head in [
            &b"POST /api/rpc HTTP/1.1\r\nContent-Length: x"[..],
            b"POST /api/rpc HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1",
            b"POST /api/rpc HTTP/1.1\r\nTransfer-Encoding: chunked",
            b"POST /api/rpc HTTP/1.0\r\nContent-Length: 1",
            b"GET /api/health\tbad HTTP/1.1",
        ] { assert_eq!(parse_request_head(head).unwrap_err().status, 400); }
        assert_eq!(parse_request_head(b"POST /api/rpc HTTP/1.1\r\nContent-Length: 1048577").unwrap_err().status, 413);
    }

    #[test]
    fn rpc_envelope_is_fail_closed() {
        assert_eq!(parse_rpc(b"{").unwrap_err()["error"]["code"], json!(-32700));
        for body in [
            &br#"{"jsonrpc":"2.0","id":1}"#[..],
            br#"{"jsonrpc":"1.0","id":1,"method":"m"}"#,
            br#"{"jsonrpc":"2.0","id":1,"method":""}"#,
            br#"{"jsonrpc":"2.0","id":1,"method":"m","params":1}"#,
            br#"{"jsonrpc":"2.0","id":null,"method":"m"}"#,
        ] { assert_eq!(parse_rpc(body).unwrap_err()["error"]["code"], json!(-32600)); }
        let bad_id = parse_rpc(br#"{"jsonrpc":"2.0","id":{"bad":1},"method":"m"}"#).unwrap_err();
        assert_eq!((bad_id["id"].clone(), bad_id["error"]["code"].clone()), (Value::Null, json!(-32600)));
        let big = "x".repeat(MAX_PARAMS_BYTES);
        let body = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"m","params":["{big}"]}}"#);
        assert_eq!(parse_rpc(body.as_bytes()).unwrap_err()["error"]["code"], json!(-32600));
        let ok = parse_rpc(br#"{"jsonrpc":"2.0","id":1,"method":"m","params":{"x":1}}"#).unwrap();
        assert_eq!((ok.method.as_str(), ok.params.is_some()), ("m", true));
    }

    #[test]
    fn default_dispatcher_returns_method_not_found() {
        let request = RpcRequest { id: json!("id-1"), method: "missing".into(), params: None };
        let response = block_on(MethodNotFoundDispatcher.dispatch(request));
        assert_eq!((response["id"].clone(), response["error"]["code"].clone()), (json!("id-1"), json!(-32601)));
    }
}
