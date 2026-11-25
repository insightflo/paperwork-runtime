#![forbid(unsafe_code)]
//! Bounded Tokio HTTP/1.1 API gateway foundation with SSE and fail-closed JSON-RPC validation.

pub mod bridge;
mod http;
pub mod routes;

pub use http::{MAX_BODY_BYTES, MAX_HEADER_BYTES};
use http::{read_request, Reject};

use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::Arc, task::Poll, time::{Duration, Instant}};
use tokio::{io::{AsyncWrite, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::watch, task::JoinSet};

pub const MAX_PARAMS_BYTES: usize = 512 * 1024;
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 128;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2); const SSE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Tunable server-side resource bounds. `write_timeout` bounds the complete non-SSE response write plus flush.
#[derive(Debug, Clone, Copy)]
pub struct ServerConfig { pub write_timeout: Duration }
impl Default for ServerConfig { fn default() -> Self { Self { write_timeout: WRITE_TIMEOUT } } }

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
fn rpc_error(id: Value, code: i64, message: &str) -> Value { json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}) }

enum Either<A, B> { First(A), Second(B) }
async fn select2<F: Future, G: Future>(first: F, second: G) -> Either<F::Output, G::Output> {
    let (mut first, mut second) = (Box::pin(first), Box::pin(second));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = first.as_mut().poll(cx) { return Poll::Ready(Either::First(value)); }
        if let Poll::Ready(value) = second.as_mut().poll(cx) { return Poll::Ready(Either::Second(value)); }
        Poll::Pending
    }).await
}

fn status_reason(status: u16) -> &'static str {
    match status { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", 413 => "Payload Too Large", 501 => "Not Implemented", 502 => "Bad Gateway", _ => "Internal Server Error" }
}
async fn write_response_with_timeout<S: AsyncWrite + Unpin>(stream: &mut S, status: u16, content_type: &str, body: &[u8], extra_headers: &str, write_timeout: Duration) -> tokio::io::Result<()> {
    let head = format!("HTTP/1.1 {} {}\r\ncontent-length: {}\r\ncontent-type: {}\r\ncache-control: no-store\r\nconnection: close\r\n{}\r\n",
        status, status_reason(status), body.len(), content_type, extra_headers);
    let write = async {
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(body).await?;
        stream.flush().await
    };
    match tokio::time::timeout(write_timeout, write).await {
        Ok(result) => result,
        Err(_) => Err(tokio::io::Error::new(tokio::io::ErrorKind::TimedOut, "response write timeout")),
    }
}
async fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8], extra_headers: &str, write_timeout: Duration) -> tokio::io::Result<()> {
    write_response_with_timeout(stream, status, content_type, body, extra_headers, write_timeout).await
}
fn drain_available(stream: &mut TcpStream) {
    let (mut chunk, mut remaining) = ([0u8; 2048], 64 * 1024);
    while remaining > 0 { match stream.try_read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => remaining -= n.min(remaining) } }
}
async fn write_error(stream: &mut TcpStream, reject: Reject, extra_headers: &str, write_timeout: Duration) -> tokio::io::Result<()> {
    let body = json!({"error": reject.error}).to_string();
    write_response(stream, reject.status, "application/json", body.as_bytes(), extra_headers, write_timeout).await?;
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

async fn try_handle_connection(mut stream: TcpStream, dispatcher: Arc<dyn RpcDispatcher>, started: Instant, shutdown: watch::Receiver<bool>, write_timeout: Duration) -> tokio::io::Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request, Err(reject) => return write_error(&mut stream, reject, "", write_timeout).await,
    };
    match routes::handle_rest(&request.method, &request.path, &dispatcher).await {
        routes::RestOutcome::NotMatched => {}
        routes::RestOutcome::MethodNotAllowed => return write_error(&mut stream, Reject { status: 405, error: "method_not_allowed" }, "allow: GET\r\n", write_timeout).await,
        routes::RestOutcome::Response { status, body } => return write_response(&mut stream, status, "application/json", &body, "", write_timeout).await,
    }
    let expected = match request.path.as_str() {
        "/api/health" | "/api/events" => "GET", "/api/rpc" => "POST", _ => "",
    };
    if expected.is_empty() { return write_error(&mut stream, Reject { status: 404, error: "not_found" }, "", write_timeout).await; }
    if request.method != expected {
        let allow = format!("allow: {expected}\r\n");
        return write_error(&mut stream, Reject { status: 405, error: "method_not_allowed" }, &allow, write_timeout).await;
    }
    match request.path.as_str() {
        "/api/health" => {
            let body = json!({"status": "ok", "engine": "paperwork-engine-api", "version": env!("CARGO_PKG_VERSION"), "uptime_ms": uptime_ms(started)}).to_string();
            write_response(&mut stream, 200, "application/json", body.as_bytes(), "", write_timeout).await
        }
        "/api/events" => write_sse(&mut stream, started, shutdown).await,
        _ => {
            let response = handle_rpc(&request.body, &dispatcher).await;
            let body = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
            write_response(&mut stream, 200, "application/json", &body, "", write_timeout).await
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

pub async fn serve(listener: TcpListener, dispatcher: Arc<dyn RpcDispatcher>, shutdown: watch::Receiver<bool>) -> tokio::io::Result<()> {
    serve_with_config(listener, dispatcher, shutdown, ServerConfig::default()).await
}

pub async fn serve_with_config(listener: TcpListener, dispatcher: Arc<dyn RpcDispatcher>, mut shutdown: watch::Receiver<bool>, config: ServerConfig) -> tokio::io::Result<()> {
    let started = Instant::now();
    let mut connections = JoinSet::new();
    loop {
        if *shutdown.borrow() || !wait_for_capacity(&mut connections, &mut shutdown).await { break; }
        match select2(shutdown.changed(), listener.accept()).await {
            Either::First(_) => break,
            Either::Second(Ok((stream, _))) => {
                let (dispatcher, connection_shutdown) = (Arc::clone(&dispatcher), shutdown.clone());
                connections.spawn(async move { let _ = try_handle_connection(stream, dispatcher, started, connection_shutdown, config.write_timeout).await; });
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

/// Serves until `shutdown_signal` completes, then performs the same bounded drain as `serve`.
/// Embedders that enable tokio's `signal` feature can drive this boundary directly with `tokio::signal::ctrl_c()`; any completion or signal-listener error triggers the same conservative drain.
/// This crate does not enable that feature, so the binary cannot link a ctrl-c hook while its
/// dependency features remain unchanged; the signal-agnostic boundary is the supported hook here.
pub async fn serve_until<F>(listener: TcpListener, dispatcher: Arc<dyn RpcDispatcher>, shutdown_signal: F) -> tokio::io::Result<()>
where F: Future {
    serve_until_with_config(listener, dispatcher, shutdown_signal, ServerConfig::default()).await
}

/// Configurable form of `serve_until` for embedders that need non-default resource bounds.
pub async fn serve_until_with_config<F>(listener: TcpListener, dispatcher: Arc<dyn RpcDispatcher>, shutdown_signal: F, config: ServerConfig) -> tokio::io::Result<()>
where F: Future {
    enum Outcome { Shutdown, Exited(tokio::io::Result<()>) }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut shutdown_signal = Box::pin(shutdown_signal);
    let mut server = Box::pin(serve_with_config(listener, dispatcher, shutdown_rx, config));
    let outcome = std::future::poll_fn(|cx| {
        if shutdown_signal.as_mut().poll(cx).is_ready() { return Poll::Ready(Outcome::Shutdown); }
        if let Poll::Ready(result) = server.as_mut().poll(cx) { return Poll::Ready(Outcome::Exited(result)); }
        Poll::Pending
    }).await;
    match outcome {
        Outcome::Shutdown => { let _ = shutdown_tx.send(true); server.await }
        Outcome::Exited(result) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn block_on<F: Future>(future: F) -> F::Output { tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future) }

    #[test]
    fn rpc_envelope_is_fail_closed() {
        assert_eq!(parse_rpc(b"{").unwrap_err()["error"]["code"], json!(-32700));
        for body in [
            &br#"{"jsonrpc":"2.0","id":1}"#[..], br#"{"jsonrpc":"1.0","id":1,"method":"m"}"#, br#"{"jsonrpc":"2.0","id":1,"method":""}"#, br#"{"jsonrpc":"2.0","id":1,"method":"m","params":1}"#, br#"{"jsonrpc":"2.0","id":null,"method":"m"}"#,
        ] { assert_eq!(parse_rpc(body).unwrap_err()["error"]["code"], json!(-32600)); }
        let bad_id = parse_rpc(br#"{"jsonrpc":"2.0","id":{"bad":1},"method":"m"}"#).unwrap_err();
        assert_eq!((bad_id["id"].clone(), bad_id["error"]["code"].clone()), (Value::Null, json!(-32600)));
        let body = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"m","params":["{big}"]}}"#, big = "x".repeat(MAX_PARAMS_BYTES));
        assert_eq!(parse_rpc(body.as_bytes()).unwrap_err()["error"]["code"], json!(-32600));
        let ok = parse_rpc(br#"{"jsonrpc":"2.0","id":1,"method":"m","params":{"x":1}}"#).unwrap();
        assert_eq!((ok.method.as_str(), ok.params.is_some()), ("m", true));
    }

    #[test]
    fn default_dispatcher_returns_method_not_found() { let response = block_on(MethodNotFoundDispatcher.dispatch(RpcRequest { id: json!("id-1"), method: "missing".into(), params: None })); assert_eq!((response["id"].clone(), response["error"]["code"].clone()), (json!("id-1"), json!(-32601))); }

    #[test]
    fn response_write_timeout_aborts_stalled_non_sse_write() {
        block_on(async {
            let (mut peer, mut server) = tokio::io::duplex(64);
            let body = vec![b'x'; 4096];
            let started = Instant::now();
            let result = write_response_with_timeout(&mut server, 200, "application/json", &body, "", Duration::from_millis(20)).await;
            assert_eq!(result.unwrap_err().kind(), tokio::io::ErrorKind::TimedOut);
            assert!(started.elapsed() < Duration::from_millis(500));
            drop(server);
            let mut received = Vec::new();
            peer.read_to_end(&mut received).await.unwrap();
            assert!(!received.is_empty());
        });
    }

    #[test]
    fn serve_until_shutdown_drains_open_sse_and_returns_ok() {
        block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(serve_until(listener, default_dispatcher(), rx));
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let mut first = [0u8; 1];
            stream.read_exact(&mut first).await.unwrap();
            tx.send(()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(1), server).await.unwrap().unwrap();
            assert!(result.is_ok(), "{result:?}");
            let mut rest = Vec::new();
            stream.read_to_end(&mut rest).await.unwrap();
        });
    }
}
