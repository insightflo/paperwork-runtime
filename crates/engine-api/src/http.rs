#![forbid(unsafe_code)]
//! Strict HTTP/1.1 request-head validation and bounded reading under one absolute deadline.

use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Reject { pub(crate) status: u16, pub(crate) error: &'static str }
fn bad() -> Reject { Reject { status: 400, error: "bad_request" } }
fn too_large() -> Reject { Reject { status: 413, error: "payload_too_large" } }
pub(crate) struct Request { pub(crate) method: String, pub(crate) path: String, pub(crate) body: Vec<u8> }

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
    let (mut content_length, mut host_count) = (None, 0usize);
    for line in lines {
        if line.is_empty() { return Err(bad()); }
        let (name, value) = line.split_once(':').ok_or_else(bad)?;
        if !is_token(name) { return Err(bad()); }
        let value = value.trim_matches(|ch| ch == ' ' || ch == '\t');
        if value.bytes().any(|b| (b < 32 && b != b'\t') || b == 127) { return Err(bad()); }
        if name.eq_ignore_ascii_case("host") { host_count += 1; if value.trim().is_empty() { return Err(bad()); } }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() { return Err(bad()); }
            content_length = Some(parse_content_length(value)?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") { return Err(bad()); }
    }
    if host_count != 1 { return Err(bad()); }
    Ok((parts[0].to_owned(), path.to_owned(), content_length.unwrap_or(0)))
}

pub(crate) async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Request, Reject> {
    let deadline = tokio::time::Instant::now() + READ_TIMEOUT;
    read_request_within(stream, deadline).await
}
async fn read_request_within<S: AsyncRead + Unpin>(stream: &mut S, deadline: tokio::time::Instant) -> Result<Request, Reject> {
    let (mut buf, mut chunk) = (Vec::with_capacity(8192), [0u8; 2048]);
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") { break pos; }
        if buf.len() >= MAX_HEADER_BYTES { return Err(too_large()); }
        let n = match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
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
        match tokio::time::timeout_at(deadline, stream.read_exact(&mut tail)).await {
            Ok(Ok(_)) => body.extend_from_slice(&tail), _ => return Err(bad()),
        }
    }
    Ok(Request { method, path, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    #[test]
    fn head_parser_enforces_strict_content_length_and_host() {
        let (method, path, len) = parse_request_head(b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2").unwrap();
        assert_eq!((method.as_str(), path.as_str(), len), ("POST", "/api/rpc", 2));
        let (_, query_path, _) = parse_request_head(b"GET /api/health?x=1 HTTP/1.1\r\nHost: localhost").unwrap();
        assert_eq!(query_path, "/api/health");
        for head in [
            &b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: x"[..], b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\nContent-Length: 1", b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked",
            b"POST /api/rpc HTTP/1.0\r\nHost: localhost\r\nContent-Length: 1", b"GET /api/health\tbad HTTP/1.1\r\nHost: localhost", b"POST /api/rpc HTTP/1.1\r\nContent-Length: 1", b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nHost: localhost", b"POST /api/rpc HTTP/1.1\r\nHost:  \t \r\nContent-Length: 1",
        ] { assert_eq!(parse_request_head(head).unwrap_err().status, 400); }
        assert_eq!(parse_request_head(b"POST /api/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048577").unwrap_err().status, 413);
    }

    #[test]
    fn request_read_deadline_is_overall_not_per_read() {
        block_on(async {
            let (mut writer, mut reader) = tokio::io::duplex(64);
            tokio::spawn(async move {
                for byte in b"GET /api/health HTTP/1.1\r\nHost: localhost\r\n" {
                    if writer.write_all(&[*byte]).await.is_err() { return; }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                std::future::pending::<()>().await;
            });
            let deadline = tokio::time::Instant::now() + Duration::from_millis(60);
            let result = tokio::time::timeout(Duration::from_secs(1), read_request_within(&mut reader, deadline)).await;
            assert!(matches!(result, Ok(Err(reject)) if reject.status == 400));
        });
    }
}
