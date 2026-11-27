//! Personal endpoint HTTP wire contracts, independent of transport and execution.
use serde::{Deserialize, Serialize};

/// Validated server base, with trailing slashes removed (proxy paths are retained).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointUrls {
    base: String,
}

impl EndpointUrls {
    pub fn new(server_url: &str) -> Result<Self, String> {
        let rest = server_url
            .strip_prefix("https://")
            .or_else(|| server_url.strip_prefix("http://"))
            .ok_or("server URL must use http:// or https://")?;
        if server_url.chars().any(|c| c.is_whitespace() || c.is_control()) || server_url.contains(['\\', '?', '#', '@'])
        {
            return Err("server URL contains unsafe characters".into());
        }
        let authority = rest.split('/').next().ok_or("missing server host")?;
        validate_authority(authority)?;
        Ok(Self {
            base: server_url.trim_end_matches('/').into(),
        })
    }

    pub fn pair_url(&self) -> String {
        format!("{}/api/endpoints/pair", self.base)
    }

    pub fn heartbeat_url(&self, device_id: &str) -> Result<String, String> {
        validate_id(device_id)?;
        Ok(format!("{}/api/endpoints/{device_id}/heartbeat", self.base))
    }

    pub fn poll_tasks_url(&self, device_id: &str) -> Result<String, String> {
        validate_id(device_id)?;
        Ok(format!("{}/api/endpoints/{device_id}/tasks/poll", self.base))
    }

    pub fn ack_task_url(&self, device_id: &str, task_id: &str) -> Result<String, String> {
        validate_id(device_id)?;
        validate_id(task_id)?;
        Ok(format!("{}/api/endpoints/{device_id}/tasks/{task_id}/ack", self.base))
    }
}

fn validate_authority(authority: &str) -> Result<(), String> {
    let (host, port) = if let Some(ipv6) = authority.strip_prefix('[') {
        let (ip, suffix) = ipv6.split_once(']').ok_or("invalid IPv6 host")?;
        ip.parse::<std::net::Ipv6Addr>().map_err(|_| "invalid IPv6 host")?;
        (ip, suffix.strip_prefix(':').or_else(|| suffix.is_empty().then_some("")))
    } else {
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        if !host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)) {
            return Err("invalid server host".into());
        }
        (host, Some(port))
    };
    if host.is_empty() || port.is_none() || authority.ends_with(':') {
        return Err("invalid server authority".into());
    }
    if let Some(port) = port.filter(|p| !p.is_empty()) {
        if !port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u16>().is_err() {
            return Err("invalid server port".into());
        }
    }
    Ok(())
}

// Only unreserved ASCII characters can enter a path segment; encoded separators,
// query/fragment delimiters, backslashes and traversal markers fail closed.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id == "."
        || id.contains("..")
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return Err("invalid endpoint path identifier".into());
    }
    Ok(())
}

/// The server accepts both CLI names and detailed local CLI discovery records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DetectedCli {
    Name(String),
    Details {
        id: String,
        binary: String,
        path: Option<String>,
        available: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub os: String,
    pub arch: String,
    pub detected_clis: Vec<DetectedCli>,
}

// Intentionally no Debug: this response contains the raw device credential.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub bot_name: String,
    pub company_id: String,
    pub device_token: String,
    pub token_preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub company_id: String,
    pub detected_clis: Vec<DetectedCli>,
    pub pending_outbox_count: u64,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollTasksRequest {
    pub company_id: String,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolledTask {
    pub task_id: String,
    pub kind: String,
    pub target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckTaskRequest {
    pub company_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// Build transport headers only after validating both values; errors omit secrets.
pub fn build_auth_headers(device_token: &str, company_id: &str) -> Result<Vec<(String, String)>, String> {
    for value in [device_token, company_id] {
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err("authentication header value is empty or contains control characters".into());
        }
    }
    Ok(vec![
        ("Authorization".into(), format!("Bearer {device_token}")),
        ("X-Company-Id".into(), company_id.into()),
    ])
}
