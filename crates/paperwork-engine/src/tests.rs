#![forbid(unsafe_code)]
use super::*;
use std::io::BufReader;

fn run(input: &[u8], cap: usize) -> Vec<Value> {
    let mut out = Vec::new();
    serve_stdio(BufReader::with_capacity(cap, input), &mut out).unwrap();
    std::str::from_utf8(&out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}
fn call(v: &Value) -> Vec<Value> {
    run(format!("{v}\n").as_bytes(), 8)
}
fn code(v: &Value) -> i64 {
    v["error"]["code"].as_i64().unwrap_or(0)
}
fn health_req(id: i64) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "engine.health"})
}
/// Valid request padded with trailing spaces to exactly `size` payload bytes.
fn padded(size: usize) -> Vec<u8> {
    let mut v = health_req(1).to_string().into_bytes();
    v.resize(size, b' ');
    v
}
fn result(out: Vec<Value>) -> Value {
    out.into_iter().next().unwrap()["result"].clone()
}

#[test]
fn health_and_error_codes() {
    let out = call(&health_req(7));
    let r = &out[0]["result"];
    assert_eq!(r["ok"], true);
    assert_eq!(r["engine"], "paperwork-engine");
    assert_eq!(r["protocol_version"], 1);
    assert_eq!(r["capabilities"].as_array().unwrap().len(), 106);
    assert_eq!(out[0]["id"], 7);
    let out = call(&json!({"jsonrpc": "2.0", "id": "x1", "method": "nope"}));
    assert_eq!((code(&out[0]), out[0]["id"].as_str().unwrap()), (-32601, "x1"));
    let bad = [
        json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text","params":{"text":1}}),
        json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text"}),
        json!({"jsonrpc":"2.0","id":1,"method":"provider.check_blocklist","params":{"provider":"gpt","version":"1","blocklist":{"versions":[],"sha256s":[]}}}),
        json!({"jsonrpc":"2.0","id":1,"method":"provider.check_blocklist","params":{"provider":"claude","version":"a/b","blocklist":{"versions":[],"sha256s":[]}}}),
    ];
    for p in bad {
        assert_eq!(code(&call(&p)[0]), -32602);
    }
    let p = json!({"jsonrpc":"2.0","id":1,"method":"redactor.redact_text","params":{"text":"y".repeat(MAX_TEXT_BYTES + 1)}});
    assert_eq!(code(&call(&p)[0]), -32602);
}
#[test]
fn redact_text_secret_and_plain() {
    let p = json!({"jsonrpc":"2.0","id":2,"method":"redactor.redact_text","params":{"text":"tok sk-ant-abc123def456 ok"}});
    let r = result(call(&p));
    assert!(r["redacted"].as_str().unwrap().contains("[redacted]"));
    assert!(!r["redacted"].as_str().unwrap().contains("sk-ant-abc123def456"));
    assert_eq!(r["changed"], true);
    let p = json!({"jsonrpc":"2.0","id":3,"method":"redactor.redact_text","params":{"text":"plain"}});
    let r = result(call(&p));
    assert_eq!((r["redacted"].clone(), r["changed"].clone()), (json!("plain"), json!(false)));
}

#[test]
fn check_blocklist_variants() {
    let mk = |params: Value| json!({"jsonrpc":"2.0","id":9,"method":"provider.check_blocklist","params":params});
    let r = result(call(&mk(json!({"provider":"claude","version":"1.0","blocklist":{"versions":["2.*","1.0"],"sha256s":[]}}))));
    assert_eq!((r["blocked"].clone(), r["reason"].clone()), (json!(true), json!("version")));
    let r = result(call(&mk(json!({"provider":"devin","version":"9","sha256":"aabb","blocklist":{"versions":[],"sha256s":["AABB"]}}))));
    assert_eq!((r["blocked"].clone(), r["reason"].clone()), (json!(true), json!("sha256")));
    let r = result(call(&mk(json!({"provider":"pi","version":"3","blocklist":{"versions":["2.*"],"sha256s":[]}}))));
    assert_eq!((r["blocked"].clone(), r["reason"].clone(), r["provider"].clone()), (json!(false), Value::Null, json!("pi")));
}

#[test]
fn parse_errors_and_recovery() {
    let mut input = b"\nnot json\n".to_vec();
    input.extend_from_slice(b"{\"jsonrpc\":\"1.9\",\"id\":1,\"method\":\"engine.health\"}\n");
    input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"method\":\"engine.health\"}\n");
    input.extend_from_slice(b"\xff\xfe{\n");
    input.extend_from_slice(format!("{}\n", health_req(5)).as_bytes());
    let out = run(&input, 8);
    assert_eq!(out.len(), 5);
    for v in &out[..4] {
        assert_eq!((code(v), v["id"].clone()), (-32700, Value::Null));
    }
    assert_eq!(out[4]["result"]["ok"], true);
}

#[test]
fn boundary_max_accepted_lf_and_crlf() {
    for tail in [b"\n".as_slice(), b"\r\n".as_slice()] {
        let mut input = padded(MAX_REQUEST_BYTES);
        input.extend_from_slice(tail);
        let out = run(&input, 64);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["result"]["ok"], true);
    }
}

#[test]
fn boundary_over_max_rejected_then_recovers() {
    for tail in [b"\n".as_slice(), b"\r\n".as_slice()] {
        let mut input = padded(MAX_REQUEST_BYTES + 1);
        input.extend_from_slice(tail);
        input.extend_from_slice(format!("{}\n", health_req(2)).as_bytes());
        let out = run(&input, 64);
        assert_eq!(out.len(), 2);
        assert_eq!((code(&out[0]), out[0]["id"].clone()), (-32600, Value::Null));
        assert_eq!(out[1]["result"]["ok"], true);
    }
}

#[test]
fn unterminated_final_line_processed() {
    let out = run(health_req(4).to_string().as_bytes(), 8);
    assert_eq!(out[0]["result"]["ok"], true);
}

struct Spy {
    buf: Vec<u8>,
    marks: Vec<usize>,
}
impl Write for Spy {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.marks.push(self.buf.len());
        Ok(())
    }
}

#[test]
fn flush_after_every_response_line() {
    let mut spy = Spy { buf: Vec::new(), marks: Vec::new() };
    let mut input = vec![b'x'; MAX_REQUEST_BYTES + 10];
    input.extend_from_slice(b"\n");
    input.extend_from_slice(format!("{}\n", health_req(1)).as_bytes());
    serve_stdio(BufReader::with_capacity(32, &input[..]), &mut spy).unwrap();
    assert_eq!(spy.marks.len(), 2);
    for (i, &m) in spy.marks.iter().enumerate() {
        assert_eq!(spy.buf[m - 1], b'\n');
        assert_eq!(spy.buf[..m].iter().filter(|&&b| b == b'\n').count(), i + 1);
    }
    assert_eq!(*spy.marks.last().unwrap(), spy.buf.len());
}
