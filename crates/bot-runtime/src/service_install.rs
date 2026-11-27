//! Deterministic config and OS service-unit generators for personal endpoint
//! installation. Pure logic plus one file write; standalone so tests can
//! include this file by path without wiring it into lib.rs.

use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Everything needed to install one personal endpoint bot.
pub struct EndpointInitConfig {
    pub server_url: String,
    pub endpoint_name: String,
    pub binary_path: PathBuf,
    pub config_path: PathBuf,
    pub allowed_folders: Vec<String>,
}

/// Validate a server URL for the endpoint config: `https://` is required,
/// except plain `http://` on loopback hosts (`127.0.0.1` / `localhost`) for
/// local development. Rejects empty strings, whitespace, and control chars.
pub fn validate_server_url(url: &str) -> Result<String, String> {
    if url.is_empty() {
        return Err("server url is empty".to_string());
    }
    for ch in url.chars() {
        if ch.is_whitespace() || ch.is_control() {
            return Err(format!(
                "server url contains whitespace or control character: {ch:?}"
            ));
        }
    }
    if url.starts_with("https://") || is_local_http(url) {
        Ok(url.to_string())
    } else {
        Err("server url must use https:// (or http://127.0.0.1 / http://localhost for local dev)"
            .to_string())
    }
}

/// Plain http is only accepted when the host is exactly loopback:
/// the prefix must be followed by end-of-string, `:port`, or `/path`.
fn is_local_http(url: &str) -> bool {
    ["http://127.0.0.1", "http://localhost"].iter().any(|host| {
        url.strip_prefix(host).is_some_and(|rest| {
            rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')
        })
    })
}

/// Write the endpoint JSON config atomically-safe: create missing parent dirs
/// as owner-only (`0700` on Unix), then write the file with `0600` on Unix
/// before any content is placed in it.
pub fn write_endpoint_config(
    path: &Path,
    server_url: &str,
    endpoint_name: &str,
    allowed_folders: &[String],
) -> Result<(), String> {
    let server_url = validate_server_url(server_url)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            create_private_dir(parent)?;
        }
    }
    let value = json!({
        "server_url": server_url,
        "endpoint_name": endpoint_name,
        "allowed_folders": allowed_folders,
    });
    let body = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize endpoint config: {e}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("open endpoint config {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("restrict endpoint config {}: {e}", path.display()))?;
    }
    file.write_all(body.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("write endpoint config {}: {e}", path.display()))?;
    Ok(())
}

/// Create `dir` (and any missing ancestors) so that every newly created
/// directory is owner-only (`0700` on Unix). Existing directories keep their
/// current permissions.
#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut missing: Vec<&Path> = Vec::new();
    let mut cursor = dir;
    while !cursor.as_os_str().is_empty() && !cursor.exists() {
        missing.push(cursor);
        match cursor.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => cursor = parent,
            _ => break,
        }
    }
    for component in missing.iter().rev() {
        fs::create_dir(component)
            .map_err(|e| format!("create dir {}: {e}", component.display()))?;
        fs::set_permissions(component, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("restrict dir {}: {e}", component.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create dir {}: {e}", dir.display()))
}

/// Escape a string for embedding inside XML text/attribute values.
fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Render the macOS LaunchAgent plist that starts the bot at login and keeps
/// it alive. All user-provided paths are XML-escaped.
pub fn render_macos_launch_agent_plist(cfg: &EndpointInitConfig) -> String {
    let binary = xml_escape(&cfg.binary_path.to_string_lossy());
    let config = xml_escape(&cfg.config_path.to_string_lossy());
    let mut plist = String::new();
    plist.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    plist.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ");
    plist.push_str("\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    plist.push_str("<plist version=\"1.0\">\n<dict>\n");
    plist.push_str("  <key>Label</key>\n  <string>si.insightflo.paperwork-bot</string>\n");
    plist.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    plist.push_str(&format!("    <string>{binary}</string>\n"));
    plist.push_str("    <string>--config</string>\n");
    plist.push_str(&format!("    <string>{config}</string>\n"));
    plist.push_str("  </array>\n");
    plist.push_str("  <key>RunAtLoad</key>\n  <true/>\n");
    plist.push_str("  <key>KeepAlive</key>\n  <true/>\n");
    plist.push_str("</dict>\n</plist>\n");
    plist
}

/// Render the `systemd --user` unit that restarts the bot on failure.
pub fn render_linux_systemd_user_unit(cfg: &EndpointInitConfig) -> String {
    let binary = cfg.binary_path.to_string_lossy();
    let config = cfg.config_path.to_string_lossy();
    let name = &cfg.endpoint_name;
    format!(
        "[Unit]\nDescription=Paperwork personal endpoint bot ({name})\nAfter=network-online.target\n\n\
         [Service]\nExecStart=\"{binary}\" --config \"{config}\"\nRestart=on-failure\nRestartSec=5\n\n\
         [Install]\nWantedBy=default.target\n"
    )
}

/// Escape `'` for embedding inside a single-quoted PowerShell string.
fn powershell_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// Render the PowerShell snippet that registers a Windows scheduled task
/// starting the bot at user logon.
pub fn render_windows_task_script(cfg: &EndpointInitConfig) -> String {
    let binary = powershell_quote(&cfg.binary_path.to_string_lossy());
    let config = powershell_quote(&cfg.config_path.to_string_lossy());
    let name = powershell_quote(&cfg.endpoint_name);
    format!(
        "$action = New-ScheduledTaskAction -Execute '{binary}' -Argument '--config ''{config}'''\n\
         $trigger = New-ScheduledTaskTrigger -AtLogOn\n\
         Register-ScheduledTask -TaskName 'PaperworkBot' -Action $action -Trigger $trigger \
         -Description 'Paperwork personal endpoint bot ({name})' | Out-Null\n"
    )
}
