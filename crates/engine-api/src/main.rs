#![forbid(unsafe_code)]

use paperwork_engine_api::{bridge::EngineSubprocessDispatcher, default_dispatcher, serve, RpcDispatcher};
use std::{io, sync::Arc};
use tokio::{net::TcpListener, runtime::Builder, sync::watch};

fn main() -> io::Result<()> {
    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(run())
}

fn configured_dispatcher() -> Arc<dyn RpcDispatcher> {
    match EngineSubprocessDispatcher::resolve_default() {
        Some(dispatcher) => Arc::new(dispatcher) as Arc<dyn RpcDispatcher>,
        None => default_dispatcher(),
    }
}

async fn run() -> io::Result<()> {
    let bind = std::env::var("PAPERWORK_API_BIND").unwrap_or_else(|_| "127.0.0.1:3101".to_owned());
    let listener = TcpListener::bind(&bind).await?;
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    serve(listener, configured_dispatcher(), shutdown_rx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use paperwork_engine_api::{bridge::ClosureDispatcher, RpcRequest};
    use serde_json::{json, Value};
    use std::{future::Future, net::SocketAddr, sync::Mutex};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, task::JoinHandle};

    fn echo_dispatcher() -> Arc<dyn RpcDispatcher> {
        Arc::new(ClosureDispatcher::new(|request: RpcRequest| {
            if request.method == "test.echo" {
                json!({"jsonrpc":"2.0","id":request.id,"result":{"method":request.method,"params":request.params}})
            } else {
                json!({"jsonrpc":"2.0","id":request.id,"error":{"code":-32601,"message":"method_not_found"}})
            }
        }))
    }
    fn error_dispatcher() -> Arc<dyn RpcDispatcher> {
        Arc::new(ClosureDispatcher::new(|request: RpcRequest| {
            let code = match request.method.as_str() { "company.list" => -32602, "mission.list" => -32601, _ => -32000 };
            json!({"jsonrpc":"2.0","id":request.id,"error":{"code":code,"message":"backend_error"}})
        }))
    }
    type Calls = Arc<Mutex<Vec<(String, Value)>>>;
    fn recording_dispatcher() -> (Arc<dyn RpcDispatcher>, Calls) {
        let calls: Calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        let dispatcher = Arc::new(ClosureDispatcher::new(move |request: RpcRequest| {
            seen.lock().unwrap().push((request.method.clone(), request.params.clone().unwrap_or(Value::Null)));
            let result = match request.method.as_str() {
                "company.list" => json!({"companies":[]}), "mission.list" => json!({"missions":[]}),
                "workflow.list" => json!({"workflows":[]}), "issue.list" => json!({"issues":[]}),
                _ => json!({"agents":[]}),
            };
            json!({"jsonrpc":"2.0","id":request.id,"result":result})
        }));
        (dispatcher, calls)
    }

    type TestServer = (SocketAddr, watch::Sender<bool>, JoinHandle<io::Result<()>>);
    fn block_on<F: Future>(future: F) -> F::Output {
        Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }
    async fn start_server(dispatcher: Arc<dyn RpcDispatcher>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = watch::channel(false);
        let task = tokio::spawn(serve(listener, dispatcher, rx));
        (addr, tx, task)
    }
    async fn start_echo_server() -> TestServer { start_server(echo_dispatcher()).await }
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
    async fn get(addr: SocketAddr, path: &str) -> String {
        raw_request(addr, format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await
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
            let (addr, tx, task) = start_echo_server().await;
            let response = get(addr, "/api/health").await;
            stop_server(tx, task).await;
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n") && response.contains("cache-control: no-store\r\n"));
            let body = json_body(&response);
            assert_eq!((body["status"].clone(), body["engine"].clone()), (json!("ok"), json!("paperwork-engine-api")));
            assert!(body["version"].is_string() && body["uptime_ms"].is_number());
        });
    }

    #[test]
    fn events_endpoint_emits_bounded_sse_frames() {
        block_on(async {
            let (addr, tx, task) = start_echo_server().await;
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let head = read_head(&mut stream).await;
            let frames = read_two_frames(&mut stream).await;
            drop(stream);
            stop_server(tx, task).await;
            assert!(head.starts_with("HTTP/1.1 200 OK\r\n") && head.contains("content-type: text/event-stream\r\n"));
            assert!(frames.starts_with(": connected\n\n"));
            assert!(frames.contains("event: heartbeat\ndata: ") && frames.contains("\"engine\":\"paperwork-engine-api\""));
        });
    }

    #[test]
    fn rpc_endpoint_valid_and_invalid_json_over_localhost() {
        block_on(async {
            let (addr, tx, task) = start_echo_server().await;
            let valid = json!({"jsonrpc":"2.0","id":7,"method":"test.echo","params":{"x":1}}).to_string();
            let request = format!("POST /api/rpc HTTP/1.1\r\nHost: localhost\r\ncontent-length: {}\r\n\r\n{valid}", valid.len());
            let response = raw_request(addr, request.as_bytes()).await;
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            let body = json_body(&response);
            assert_eq!((body["id"].clone(), body["result"]["method"].clone()), (json!(7), json!("test.echo")));
            let invalid = "POST /api/rpc HTTP/1.1\r\nHost: localhost\r\ncontent-length: 1\r\n\r\n{";
            assert_eq!(json_body(&raw_request(addr, invalid.as_bytes()).await)["error"]["code"], json!(-32700));
            let bad_id = json!({"jsonrpc":"2.0","id":{"bad":1},"method":"test.echo"}).to_string();
            let request = format!("POST /api/rpc HTTP/1.1\r\nHost: localhost\r\ncontent-length: {}\r\n\r\n{bad_id}", bad_id.len());
            let body = json_body(&raw_request(addr, request.as_bytes()).await);
            assert_eq!((body["id"].clone(), body["error"]["code"].clone()), (Value::Null, json!(-32600)));
            stop_server(tx, task).await;
        });
    }

    #[test]
    fn http_rejects_malformed_oversized_unknown_and_unsupported_requests() {
        block_on(async {
            let (addr, tx, task) = start_echo_server().await;
            let malformed = raw_request(addr, b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\ncontent-length: x\r\n\r\n").await;
            let bad_target = raw_request(addr, b"GET /api/health\tbad HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
            let oversized = raw_request(addr, b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\ncontent-length: 1048577\r\n\r\n").await;
            let long_header = format!("GET /api/health HTTP/1.1\r\nHost: localhost\r\nx-long: {}\r\n\r\n", "x".repeat(17 * 1024));
            let oversized_head = raw_request(addr, long_header.as_bytes()).await;
            let unknown = get(addr, "/nope").await;
            let unsupported = raw_request(addr, b"POST /api/health HTTP/1.1\r\nHost: localhost\r\ncontent-length: 0\r\n\r\n").await;
            stop_server(tx, task).await;
            assert!(malformed.starts_with("HTTP/1.1 400 Bad Request\r\n") && bad_target.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(oversized.starts_with("HTTP/1.1 413 Payload Too Large\r\n") && oversized_head.starts_with("HTTP/1.1 413 Payload Too Large\r\n"));
            assert!(unknown.starts_with("HTTP/1.1 404 Not Found\r\n") && unsupported.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"));
            assert!(unsupported.contains("allow: GET\r\n"));
        });
    }

    #[test]
    fn http11_requires_exactly_one_nonempty_host_header() {
        block_on(async {
            let (addr, tx, task) = start_echo_server().await;
            let missing = raw_request(addr, b"GET /api/health HTTP/1.1\r\n\r\n").await;
            let duplicate = raw_request(addr, b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nhost: localhost\r\n\r\n").await;
            let blank = raw_request(addr, b"GET /api/health HTTP/1.1\r\nHost: \t \r\n\r\n").await;
            stop_server(tx, task).await;
            assert!(missing.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(duplicate.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert!(blank.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        });
    }

    #[test]
    fn all_five_read_routes_map_to_rpc_with_company_scope_and_query_stripping() {
        block_on(async {
            let (dispatcher, calls) = recording_dispatcher();
            let (addr, tx, task) = start_server(dispatcher).await;
            let id = "11111111-1111-1111-1111-111111111111";
            let cases = [
                ("/api/companies?ignored=yes".to_owned(), "company.list", "companies"),
                (format!("/api/companies/{id}/missions?x=1"), "mission.list", "missions"),
                (format!("/api/companies/{id}/workflows?x=1"), "workflow.list", "workflows"),
                (format!("/api/companies/{id}/issues?x=1"), "issue.list", "issues"),
                (format!("/api/companies/{id}/agents?x=1"), "agent.list", "agents"),
            ];
            for (path, rpc_method, key) in &cases {
                let response = get(addr, path).await;
                assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{rpc_method}: {response}");
                assert!(json_body(&response)[key].is_array(), "{rpc_method}");
            }
            stop_server(tx, task).await;
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), 5);
            for ((_, rpc_method, _), (called, params)) in cases.iter().zip(calls.iter()) {
                assert_eq!(called, rpc_method);
                let expected = if *rpc_method == "company.list" { json!({}) } else { json!({"company_id": id}) };
                assert_eq!(*params, expected);
            }
        });
    }

    #[test]
    fn invalid_uuid_400_and_wrong_method_405_do_not_dispatch() {
        block_on(async {
            let (dispatcher, calls) = recording_dispatcher();
            let (addr, tx, task) = start_server(dispatcher).await;
            let invalid = get(addr, "/api/companies/not-a-uuid/issues").await;
            let valid = "11111111-1111-1111-1111-111111111111";
            let wrong = raw_request(addr, format!("POST /api/companies/{valid}/issues HTTP/1.1\r\nHost: localhost\r\ncontent-length: 0\r\n\r\n").as_bytes()).await;
            stop_server(tx, task).await;
            assert!(invalid.starts_with("HTTP/1.1 400 Bad Request\r\n"));
            assert_eq!(json_body(&invalid)["error"], json!("bad_request"));
            assert!(wrong.starts_with("HTTP/1.1 405 Method Not Allowed\r\n") && wrong.contains("allow: GET\r\n"));
            assert_eq!(calls.lock().unwrap().len(), 0);
        });
    }

    #[test]
    fn rpc_error_codes_map_to_http_statuses() {
        block_on(async {
            let (addr, tx, task) = start_server(error_dispatcher()).await;
            let id = "11111111-1111-1111-1111-111111111111";
            let cases = [
                ("/api/companies".to_owned(), "400 Bad Request", -32602),
                (format!("/api/companies/{id}/missions"), "501 Not Implemented", -32601),
                (format!("/api/companies/{id}/workflows"), "502 Bad Gateway", -32000),
            ];
            for (path, reason, code) in cases {
                let response = get(addr, &path).await;
                assert!(response.starts_with(&format!("HTTP/1.1 {reason}\r\n")), "{response}");
                assert_eq!(json_body(&response)["rpc_code"], json!(code));
            }
            stop_server(tx, task).await;
        });
    }
}
