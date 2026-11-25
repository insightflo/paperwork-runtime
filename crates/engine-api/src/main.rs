#![forbid(unsafe_code)]

use paperwork_engine_api::{default_dispatcher, serve};
use std::io;
use tokio::{net::TcpListener, runtime::Builder, sync::watch};

fn main() -> io::Result<()> {
    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(run())
}

async fn run() -> io::Result<()> {
    let bind = std::env::var("PAPERWORK_API_BIND").unwrap_or_else(|_| "127.0.0.1:3101".to_owned());
    let listener = TcpListener::bind(&bind).await?;
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    serve(listener, default_dispatcher(), shutdown_rx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use paperwork_engine_api::{RpcDispatcher, RpcFuture, RpcRequest};
    use serde_json::{json, Value};
    use std::{future::Future, net::SocketAddr, sync::Arc};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, task::JoinHandle};

    struct EchoDispatcher;
    impl RpcDispatcher for EchoDispatcher {
        fn dispatch(&self, request: RpcRequest) -> RpcFuture<'_> {
            Box::pin(async move {
                if request.method == "test.echo" {
                    json!({"jsonrpc": "2.0", "id": request.id, "result": {"method": request.method, "params": request.params}})
                } else {
                    json!({"jsonrpc": "2.0", "id": request.id, "error": {"code": -32601, "message": "method_not_found"}})
                }
            })
        }
    }

    type TestServer = (SocketAddr, watch::Sender<bool>, JoinHandle<io::Result<()>>);
    fn block_on<F: Future>(future: F) -> F::Output {
        Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }
    async fn start_server() -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = watch::channel(false);
        let task = tokio::spawn(serve(listener, Arc::new(EchoDispatcher), rx));
        (addr, tx, task)
    }
    async fn stop_server(tx: watch::Sender<bool>, task: JoinHandle<io::Result<()>>) {
        tx.send(true).unwrap();
        task.await.unwrap().unwrap();
    }
    async fn raw_request(addr: SocketAddr, bytes: &[u8]) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(bytes).await.unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        String::from_utf8(out).unwrap()
    }
    fn json_body(response: &str) -> Value {
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }
    async fn read_byte(stream: &mut TcpStream) -> u8 {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.unwrap();
        byte[0]
    }
    async fn read_head(stream: &mut TcpStream) -> String {
        let mut out = Vec::new();
        while !out.ends_with(b"\r\n\r\n") {
            out.push(read_byte(stream).await);
            assert!(out.len() < 4096);
        }
        String::from_utf8(out).unwrap()
    }
    async fn read_two_frames(stream: &mut TcpStream) -> String {
        let (mut out, mut frames) = (Vec::new(), 0);
        while frames < 2 {
            out.push(read_byte(stream).await);
            if out.ends_with(b"\n\n") { frames += 1; }
            assert!(out.len() < 4096);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn health_endpoint_over_localhost() {
        block_on(async {
            let (addr, tx, task) = start_server().await;
            let response = raw_request(addr, b"GET /api/health HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").await;
            stop_server(tx, task).await;
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(response.contains("cache-control: no-store\r\n"));
            let body = json_body(&response);
            assert_eq!((body["status"].clone(), body["engine"].clone()), (json!("ok"), json!("paperwork-engine-api")));
            assert!(body["version"].is_string() && body["uptime_ms"].is_number());
        });
    }

    #[test]
    fn events_endpoint_emits_bounded_sse_frames() {
        block_on(async {
            let (addr, tx, task) = start_server().await;
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(b"GET /api/events HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").await.unwrap();
            let head = read_head(&mut stream).await;
            let frames = read_two_frames(&mut stream).await;
            drop(stream);
            stop_server(tx, task).await;
            assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(head.contains("content-type: text/event-stream\r\n"));
            assert!(frames.starts_with(": connected\n\n"));
            assert!(frames.contains("event: heartbeat\ndata: ") && frames.contains("\"engine\":\"paperwork-engine-api\""));
        });
    }

    #[test]
    fn rpc_endpoint_valid_and_invalid_json_over_localhost() {
        block_on(async {
            let (addr, tx, task) = start_server().await;
            let valid = json!({"jsonrpc": "2.0", "id": 7, "method": "test.echo", "params": {"x": 1}}).to_string();
            let request = format!("POST /api/rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: {}\r\n\r\n{valid}", valid.len());
            let response = raw_request(addr, request.as_bytes()).await;
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            let body = json_body(&response);
            assert_eq!((body["id"].clone(), body["result"]["method"].clone()), (json!(7), json!("test.echo")));
            let invalid = "POST /api/rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 1\r\n\r\n{";
            let body = json_body(&raw_request(addr, invalid.as_bytes()).await);
            assert_eq!(body["error"]["code"], json!(-32700));
            let bad_id = json!({"jsonrpc": "2.0", "id": {"bad": 1}, "method": "test.echo"}).to_string();
            let request = format!("POST /api/rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: {}\r\n\r\n{bad_id}", bad_id.len());
            let body = json_body(&raw_request(addr, request.as_bytes()).await);
            assert_eq!((body["id"].clone(), body["error"]["code"].clone()), (Value::Null, json!(-32600)));
            stop_server(tx, task).await;
        });
    }

    #[test]
    fn http_rejects_malformed_oversized_unknown_and_unsupported_requests() {
        block_on(async {
            let (addr, tx, task) = start_server().await;
            let malformed = raw_request(addr, b"POST /api/rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: x\r\n\r\n").await;
            let bad_target = raw_request(addr, b"GET /api/health\tbad HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").await;
            let oversized = raw_request(addr, b"POST /api/rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 1048577\r\n\r\n").await;
            let long_header = format!("GET /api/health HTTP/1.1\r\nhost: 127.0.0.1\r\nx-long: {}\r\n\r\n", "x".repeat(17 * 1024));
            let oversized_head = raw_request(addr, long_header.as_bytes()).await;
            let unknown = raw_request(addr, b"GET /nope HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").await;
            let unsupported = raw_request(addr, b"POST /api/health HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\n\r\n").await;
            stop_server(tx, task).await;
            assert!(malformed.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(bad_target.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(oversized.starts_with("HTTP/1.1 413 Payload Too Large\r\n"));
            assert!(oversized_head.starts_with("HTTP/1.1 413 Payload Too Large\r\n"));
            assert!(unknown.starts_with("HTTP/1.1 404 Not Found\r\n"));
            assert!(unsupported.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"));
            assert!(unsupported.contains("allow: GET\r\n"));
        });
    }
}
