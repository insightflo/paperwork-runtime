//! HTTP JSON client for the personal endpoint bot, on top of a `curl` subprocess.
//!
//! Transport uses `curl --config -`: every option — including the
//! `Authorization` bearer header and body — is written to the child's stdin,
//! so tokens never appear in process argv (`ps` output). Only `std` and the
//! crate's existing dependencies are used.
//!
//! Security posture (all fail closed before any process is spawned):
//! - remote URLs must use `https://`; plain `http://` is accepted only for
//!   exact loopback hosts (`127.0.0.1`, `localhost`), mirroring
//!   `service_install::validate_server_url` (so `127.0.0.1.evil.com` is not
//!   loopback).
//! - whitespace/control characters (CRLF included) in the URL or in
//!   authentication header values, and control characters in the body, are
//!   rejected; bodies must be single-line JSON (`serde_json::to_string`
//!   output always is).
//! - redirects are never followed; non-2xx responses fail closed in
//!   [`parse_json_response`].
//! - loopback traffic is always excluded from proxies via `noproxy`.
use crate::endpoint_protocol::build_auth_headers;
use serde::de::DeserializeOwned;
use std::io::Write;
use std::process::{Command, Stdio};

/// One HTTP response: raw status code and body as received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Transport configuration for the endpoint bot's server contact.
#[derive(Debug, Clone)]
pub struct HttpTransportConfig {
    pub server_url: String,
    pub timeout_secs: u64,
    pub company_id: Option<String>,
    pub device_token: Option<String>,
}

/// POSTs single-line `body_json` to `url` via the curl subprocess transport.
///
/// `url` must belong to `config.server_url` (prefix match, trailing slashes
/// ignored), so configured credentials can never be sent to a foreign server.
/// Fails closed on invalid URL/header/body values, curl transport errors, or
/// unparseable status output; never includes request secrets in errors.
pub fn post_json(
    config: &HttpTransportConfig,
    url: &str,
    body_json: &str,
) -> Result<HttpResponse, String> {
    validate_post_url(url)?;
    let server_base = config.server_url.trim_end_matches('/');
    if server_base.is_empty() {
        return Err("server_url is empty".into());
    }
    if !url.starts_with(server_base) {
        return Err("request URL does not match the configured server_url".into());
    }
    validate_body(body_json)?;
    let headers = build_request_headers(config)?;
    let curl_config = build_curl_config(url, body_json, &headers, config.timeout_secs)?;
    let stdout = run_curl(&curl_config)?;
    let (status, body) = split_status(&stdout)?;
    Ok(HttpResponse { status, body })
}

/// Fails closed on non-2xx status with status code plus a truncated error
/// body; parse errors also stay truncated and never include request secrets.
pub fn parse_json_response<T: DeserializeOwned>(resp: &HttpResponse) -> Result<T, String> {
    if !(200..300).contains(&resp.status) {
        return Err(format!("HTTP {} {}", resp.status, truncate_for_error(&resp.body, 200)));
    }
    serde_json::from_str(&resp.body).map_err(|error| {
        format!(
            "invalid JSON response: {error}; body: {}",
            truncate_for_error(&resp.body, 200)
        )
    })
}

/// `https://` is always allowed; `http://` only for exact loopback hosts.
fn validate_post_url(url: &str) -> Result<(), String> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("request URL contains whitespace or control characters".into());
    }
    if let Some(rest) = url.strip_prefix("https://") {
        if rest.split('/').next().unwrap_or("").is_empty() {
            return Err("request URL is missing a host".into());
        }
        return Ok(());
    }
    let loopback = ["http://127.0.0.1", "http://localhost"].iter().any(|host| {
        url.strip_prefix(host)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with(':') || tail.starts_with('/'))
    });
    if loopback {
        return Ok(());
    }
    Err("plain http:// is allowed only for 127.0.0.1 or localhost; remote URLs require https://".into())
}

/// Headers for one request: `Content-Type` always, auth headers only when
/// configured. Both-values case reuses the protocol module's validated
/// builder; single-value cases reuse the same emptiness/control checks.
fn build_request_headers(config: &HttpTransportConfig) -> Result<Vec<(String, String)>, String> {
    let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    match (config.device_token.as_deref(), config.company_id.as_deref()) {
        (Some(token), Some(company)) => headers.extend(build_auth_headers(token, company)?),
        (Some(token), None) => {
            validate_header_value(token)?;
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        (None, Some(company)) => {
            validate_header_value(company)?;
            headers.push(("X-Company-Id".to_string(), company.to_string()));
        }
        (None, None) => {}
    }
    Ok(headers)
}

/// Same rule as `endpoint_protocol::build_auth_headers`, for a single value.
fn validate_header_value(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err("authentication header value is empty or contains control characters".into());
    }
    Ok(())
}

/// Bodies must be single-line JSON: control characters would break the
/// line-oriented curl config stream, so they fail closed.
fn validate_body(body_json: &str) -> Result<(), String> {
    if body_json.chars().any(char::is_control) {
        return Err("request body contains control characters".into());
    }
    Ok(())
}

/// Renders the curl config file text sent over stdin (secrets included).
fn build_curl_config(
    url: &str,
    body_json: &str,
    headers: &[(String, String)],
    timeout_secs: u64,
) -> Result<String, String> {
    if timeout_secs == 0 {
        return Err("timeout must be greater than zero".into());
    }
    let mut text = String::from("--silent\n--show-error\nrequest = \"POST\"\n");
    text.push_str(&format!("url = {}\n", quote_config_value(url)));
    text.push_str(&format!("max-time = {timeout_secs}\n"));
    text.push_str("noproxy = \"127.0.0.1,localhost\"\n");
    for (name, value) in headers {
        text.push_str(&format!("header = {}\n", quote_config_value(&format!("{name}: {value}"))));
    }
    text.push_str(&format!("data-binary = {}\n", quote_config_value(body_json)));
    // `\\n` unescapes to the two chars `\n`, which the write-out parser then
    // renders as a newline; `%{http_code}` becomes the status code.
    text.push_str("write-out = \"\\\\n%{http_code}\"\n");
    Ok(text)
}

/// Quotes a curl config parameter, escaping backslash and double quote.
fn quote_config_value(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

/// Spawns `curl --config -`, writes the config (secrets) to stdin, and
/// returns stdout (body + status line). curl reads its whole config from
/// stdin before any transfer, so the blocking write cannot deadlock; a
/// broken pipe means curl already failed and the exit check reports it.
fn run_curl(config_text: &str) -> Result<String, String> {
    let mut child = Command::new("curl")
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start curl: {error}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("curl stdin unavailable")?;
        let _ = stdin.write_all(config_text.as_bytes());
        let _ = stdin.flush();
    }
    let output = child.wait_with_output().map_err(|error| format!("waiting for curl: {error}"))?;
    if !output.status.success() {
        let stderr = truncate_for_error(&String::from_utf8_lossy(&output.stderr), 200);
        return Err(format!("curl failed ({}): {stderr}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Splits the write-out tail: body, then newline, then the status code.
fn split_status(stdout: &str) -> Result<(u16, String), String> {
    let (body, status) = stdout.rsplit_once('\n').ok_or("curl output missing status line")?;
    let status: u16 = status
        .trim()
        .parse()
        .map_err(|_| format!("curl wrote an invalid status code: {}", truncate_for_error(status, 16)))?;
    Ok((status, body.to_string()))
}

fn truncate_for_error(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}
