use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);
const ZAI_DEFAULT_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusInput {
    home_dir: Option<String>,
    pi_agent_dir: Option<String>,
    command_overrides: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncInput {
    home_dir: Option<String>,
    pi_agent_dir: Option<String>,
    direction: Option<String>,
    #[serde(default)]
    web_providers: Vec<WebProviderInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebProviderInput {
    id: String,
    #[allow(dead_code)]
    name: String,
    base_url: String,
    model: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoutInput {
    home_dir: Option<String>,
    pi_agent_dir: Option<String>,
    runtime_id: Option<String>,
    provider_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiCliProviderStatus {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api: Option<String>,
    model_count: usize,
    models: Vec<String>,
    auth_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliRuntimeStatus {
    id: &'static str,
    name: &'static str,
    adapter_type: &'static str,
    installed: bool,
    executable_path: Option<String>,
    version: Option<String>,
    auth_configured: bool,
    auth_source: Option<String>,
    model_count: usize,
    sample_models: Vec<String>,
    supports_self_update: bool,
    supports_model_update: bool,
    supports_provider_sync: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    installed: bool,
    executable_path: Option<String>,
    version: Option<String>,
    agent_dir: String,
    providers: Vec<PiCliProviderStatus>,
    catalog_models: Vec<String>,
    runtimes: Vec<CliRuntimeStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedProvider {
    id: String,
    name: String,
    base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOutput {
    pushed: usize,
    imported_providers: Vec<ImportedProvider>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutOutput {
    removed: bool,
}

struct RuntimeSpec {
    id: &'static str,
    name: &'static str,
    adapter_type: &'static str,
    binaries: &'static [&'static str],
    version_args: &'static [&'static str],
    fallback_version_args: Option<&'static [&'static str]>,
    supports_self_update: bool,
    supports_model_update: bool,
    supports_provider_sync: bool,
}

const RUNTIMES: &[RuntimeSpec] = &[
    RuntimeSpec {
        id: "pi",
        name: "Pi CLI",
        adapter_type: "pi_local",
        binaries: &["pi"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: true,
        supports_provider_sync: true,
    },
    RuntimeSpec {
        id: "codex",
        name: "OpenAI Codex",
        adapter_type: "codex_local",
        binaries: &["codex"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "claude",
        name: "Claude Code",
        adapter_type: "claude_local",
        binaries: &["claude"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "opencode",
        name: "OpenCode",
        adapter_type: "opencode_local",
        binaries: &["opencode"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: true,
    },
    RuntimeSpec {
        id: "commandcode",
        name: "CommandCode",
        adapter_type: "commandcode_local",
        binaries: &["commandcode", "cmd"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "antigravity",
        name: "Antigravity (AGY)",
        adapter_type: "antigravity_local",
        binaries: &["agy"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: false,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "gemini",
        name: "Gemini CLI",
        adapter_type: "gemini_local",
        binaries: &["gemini"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "hermes",
        name: "Hermes Agent",
        adapter_type: "hermes_local",
        binaries: &["hermes"],
        version_args: &["acp", "--version"],
        fallback_version_args: Some(&["--version"]),
        supports_self_update: true,
        supports_model_update: false,
        supports_provider_sync: false,
    },
    RuntimeSpec {
        id: "cursor",
        name: "Cursor Agent",
        adapter_type: "cursor",
        binaries: &["cursor-agent", "agent"],
        version_args: &["--version"],
        fallback_version_args: None,
        supports_self_update: false,
        supports_model_update: false,
        supports_provider_sync: false,
    },
];

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn default_home_dir() -> PathBuf {
    env::var("HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn resolve_home_dir(override_dir: Option<&str>) -> PathBuf {
    override_dir
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_home_dir)
}

fn resolve_pi_agent_dir(home_dir: &Path, override_dir: Option<&str>) -> PathBuf {
    override_dir
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".pi").join("agent"))
}

fn is_valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn write_json_atomic(path: &Path, value: &Value, mode: Option<u32>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        process::id(),
        stamp
    ));
    let mut serialized = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    serialized.push('\n');

    let mut open_opts = OpenOptions::new();
    open_opts.write(true).create_new(true);
    if let Some(m) = mode {
        open_opts.mode(m);
    }
    let mut file = open_opts.open(&tmp_path).map_err(|err| err.to_string())?;
    file.write_all(serialized.as_bytes())
        .map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())?;
    drop(file);
    if let Some(m) = mode {
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(m));
    }
    fs::rename(&tmp_path, path).map_err(|err| err.to_string())
}

fn has_credential(entry: &Value) -> bool {
    match entry {
        Value::String(s) => !s.trim().is_empty(),
        Value::Object(map) => map
            .iter()
            .any(|(k, v)| k != "type" && matches!(v, Value::String(s) if !s.trim().is_empty())),
        _ => false,
    }
}

fn extract_api_key(entry: Option<&Value>) -> Option<String> {
    match entry? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(map) => map
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn model_entry_id(entry: &Value) -> Option<String> {
    match entry {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(map) => map
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn read_pi_providers(pi_agent_dir: &Path) -> Vec<PiCliProviderStatus> {
    let models_json = read_json_object(&pi_agent_dir.join("models.json"));
    let auth_json = read_json_object(&pi_agent_dir.join("auth.json"));
    let Some(Value::Object(providers)) = models_json.get("providers") else {
        return Vec::new();
    };
    let mut sorted: BTreeMap<String, &Value> = BTreeMap::new();
    for (id, raw) in providers {
        sorted.insert(id.clone(), raw);
    }
    sorted
        .into_iter()
        .map(|(id, raw)| {
            let obj = raw.as_object();
            let models: Vec<String> = obj
                .and_then(|m| m.get("models"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(model_entry_id)
                        .map(|m| {
                            if m.starts_with(&format!("{id}/")) {
                                m
                            } else {
                                format!("{id}/{m}")
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let auth_configured = auth_json.get(&id).is_some_and(has_credential);
            PiCliProviderStatus {
                id,
                base_url: obj
                    .and_then(|m| m.get("baseUrl"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                api: obj
                    .and_then(|m| m.get("api"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model_count: models.len(),
                models,
                auth_configured,
            }
        })
        .collect()
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn resolve_binary(
    spec: &RuntimeSpec,
    home_dir: &Path,
    overrides: Option<&HashMap<String, String>>,
) -> Option<PathBuf> {
    if let Some(map) = overrides {
        if let Some(custom) = map.get(spec.id).map(String::as_str).map(str::trim) {
            if !custom.is_empty() {
                let p = PathBuf::from(custom);
                if is_executable_file(&p) {
                    return Some(p);
                }
            }
        }
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path_env) = env::var("PATH") {
        for dir in env::split_paths(&path_env) {
            if !dir.as_os_str().is_empty() {
                search_dirs.push(dir);
            }
        }
    }
    search_dirs.push(home_dir.join(".npm-global").join("bin"));
    search_dirs.push(home_dir.join(".bun").join("bin"));
    search_dirs.push(home_dir.join(".local").join("bin"));
    search_dirs.push(home_dir.join(".cargo").join("bin"));
    search_dirs.push(PathBuf::from("/opt/homebrew/bin"));
    search_dirs.push(PathBuf::from("/usr/local/bin"));
    search_dirs.push(PathBuf::from("/usr/bin"));

    for bin_name in spec.binaries {
        for dir in &search_dirs {
            let candidate = dir.join(bin_name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn run_command_capture(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String), String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|err| err.to_string())? {
            Some(_) => break,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("command_timed_out".to_string());
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
    let output = child.wait_with_output().map_err(|err| err.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let first = stderr
            .lines()
            .chain(stdout.lines())
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("command_failed");
        return Err(first.chars().take(200).collect());
    }
    Ok((stdout, stderr))
}

fn parse_version_text(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    for token in line.split_whitespace() {
        let trimmed = token.trim_start_matches('v').trim_end_matches([',', ';']);
        let parts: Vec<&str> = trimmed.split('.').collect();
        if parts.len() >= 3
            && parts[0].chars().all(|c| c.is_ascii_digit())
            && parts[1].chars().all(|c| c.is_ascii_digit())
            && parts[2]
                .split(['-', '+'])
                .next()
                .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        {
            return Some(trimmed.to_string());
        }
    }
    Some(line.chars().take(80).collect())
}

fn parse_pi_catalog_models(stdout: &str, stderr: &str) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for text in [stdout, stderr] {
        let lines: Vec<&str> = text.lines().collect();
        let header_idx = lines.iter().position(|line| {
            let cols: Vec<String> = line
                .split("  ")
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_lowercase)
                .collect();
            cols.first().is_some_and(|c| c == "provider")
                && cols.get(1).is_some_and(|c| c == "model")
        });
        let start = header_idx.map(|i| i + 1).unwrap_or(0);
        for line in &lines[start..] {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parts: Vec<&str> = trimmed
                .split("  ")
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() >= 2 {
                let provider = parts[0];
                let model = parts[1];
                if !provider.is_empty()
                    && !model.is_empty()
                    && provider != "provider"
                    && !model.chars().any(char::is_whitespace)
                {
                    ids.insert(format!("{provider}/{model}"));
                }
            }
        }
    }
    ids.into_iter().take(300).collect()
}

fn check_runtime_auth(
    runtime_id: &str,
    home_dir: &Path,
    pi_agent_dir: &Path,
) -> (bool, Option<String>) {
    let has_env = |key: &str| env::var(key).ok().is_some_and(|v| !v.trim().is_empty());
    match runtime_id {
        "pi" => {
            let auth = read_json_object(&pi_agent_dir.join("auth.json"));
            if auth.values().any(has_credential) {
                (true, Some("~/.pi/agent/auth.json".to_string()))
            } else {
                (false, None)
            }
        }
        "codex" => {
            let auth = read_json_object(&home_dir.join(".codex").join("auth.json"));
            if !auth.is_empty() {
                (true, Some("~/.codex/auth.json".to_string()))
            } else if has_env("OPENAI_API_KEY") {
                (true, Some("OPENAI_API_KEY".to_string()))
            } else {
                (false, None)
            }
        }
        "claude" => {
            let claude_dir = home_dir.join(".claude");
            if claude_dir.join(".credentials.json").is_file()
                || home_dir.join(".claude.json").is_file()
                || claude_dir.join("settings.json").is_file()
            {
                (true, Some("~/.claude".to_string()))
            } else if has_env("ANTHROPIC_API_KEY") {
                (true, Some("ANTHROPIC_API_KEY".to_string()))
            } else {
                (false, None)
            }
        }
        "opencode" => {
            let auth = read_json_object(&home_dir.join(".local/share/opencode/auth.json"));
            if auth.values().any(has_credential) {
                (true, Some("~/.local/share/opencode/auth.json".to_string()))
            } else {
                (false, None)
            }
        }
        "commandcode" => {
            if home_dir.join(".commandcode").exists()
                || home_dir.join(".config/commandcode").exists()
                || home_dir.join(".local/share/opencode/auth.json").is_file()
            {
                (true, Some("~/.commandcode".to_string()))
            } else {
                (false, None)
            }
        }
        "antigravity" => {
            if home_dir.join(".gemini/oauth_creds.json").is_file()
                || home_dir.join(".gemini/antigravity-cli").exists()
            {
                (true, Some("~/.gemini".to_string()))
            } else {
                (false, None)
            }
        }
        "gemini" => {
            if home_dir.join(".gemini/oauth_creds.json").is_file() {
                (true, Some("~/.gemini/oauth_creds.json".to_string()))
            } else if has_env("GEMINI_API_KEY") {
                (true, Some("GEMINI_API_KEY".to_string()))
            } else {
                (false, None)
            }
        }
        "hermes" => {
            let hermes_dir = home_dir.join(".hermes");
            if hermes_dir.join("auth.json").is_file() || hermes_dir.join(".env").is_file() {
                (true, Some("~/.hermes".to_string()))
            } else {
                (false, None)
            }
        }
        "cursor" => {
            if home_dir.join(".cursor").exists() || home_dir.join(".config/cursor").exists() {
                (true, Some("~/.cursor".to_string()))
            } else {
                (false, None)
            }
        }
        _ => (false, None),
    }
}

fn probe_single_runtime(
    spec: &'static RuntimeSpec,
    home_dir: &Path,
    pi_agent_dir: &Path,
    overrides: Option<&HashMap<String, String>>,
) -> (CliRuntimeStatus, Vec<String>) {
    let bin = resolve_binary(spec, home_dir, overrides);
    let (auth_configured, auth_source) = check_runtime_auth(spec.id, home_dir, pi_agent_dir);
    let mut installed = false;
    let mut executable_path = None;
    let mut version = None;
    let mut error = None;
    let mut catalog_models = Vec::new();
    let mut model_count = 0;
    let mut sample_models = Vec::new();

    if let Some(bin_path) = bin {
        let ver_res = run_command_capture(&bin_path, spec.version_args, VERSION_TIMEOUT).or_else(
            |first_err| {
                if let Some(fallback_args) = spec.fallback_version_args {
                    run_command_capture(&bin_path, fallback_args, VERSION_TIMEOUT)
                } else {
                    Err(first_err)
                }
            },
        );
        match ver_res {
            Ok((stdout, stderr)) => {
                installed = true;
                executable_path = Some(bin_path.to_string_lossy().into_owned());
                let combined = if stdout.trim().is_empty() {
                    stderr
                } else {
                    stdout
                };
                version = parse_version_text(&combined);
                if spec.id == "pi" {
                    match run_command_capture(&bin_path, &["--list-models"], CATALOG_TIMEOUT) {
                        Ok((cat_out, cat_err)) => {
                            catalog_models = parse_pi_catalog_models(&cat_out, &cat_err);
                            model_count = catalog_models.len();
                            sample_models = catalog_models.iter().take(5).cloned().collect();
                        }
                        Err(err) => {
                            error = Some(err);
                        }
                    }
                }
            }
            Err(err) => {
                error = Some(err);
            }
        }
    } else if spec.id == "pi" {
        error = Some("pi CLI not found".to_string());
    }

    (
        CliRuntimeStatus {
            id: spec.id,
            name: spec.name,
            adapter_type: spec.adapter_type,
            installed,
            executable_path,
            version,
            auth_configured,
            auth_source,
            model_count,
            sample_models,
            supports_self_update: spec.supports_self_update,
            supports_model_update: spec.supports_model_update,
            supports_provider_sync: spec.supports_provider_sync,
            error,
        },
        catalog_models,
    )
}

fn handle_status(input: StatusInput) -> StatusOutput {
    let home_dir = resolve_home_dir(input.home_dir.as_deref());
    let pi_agent_dir = resolve_pi_agent_dir(&home_dir, input.pi_agent_dir.as_deref());
    let providers = read_pi_providers(&pi_agent_dir);
    let overrides = input.command_overrides.as_ref();

    let results: Vec<(CliRuntimeStatus, Vec<String>)> = thread::scope(|scope| {
        let handles: Vec<_> = RUNTIMES
            .iter()
            .map(|spec| {
                scope.spawn(|| probe_single_runtime(spec, &home_dir, &pi_agent_dir, overrides))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    let mut catalog_models = Vec::new();
    let mut runtimes = Vec::with_capacity(results.len());
    for (rt, rt_catalog) in results {
        if rt.id == "pi" {
            catalog_models = rt_catalog;
        }
        runtimes.push(rt);
    }

    let pi = runtimes.iter().find(|r| r.id == "pi");
    let pi_installed = pi.is_some_and(|r| r.installed);
    let pi_executable_path = pi.and_then(|r| r.executable_path.clone());
    let pi_version = pi.and_then(|r| r.version.clone());
    let pi_error = pi.and_then(|r| r.error.clone());
    StatusOutput {
        installed: pi_installed,
        executable_path: pi_executable_path,
        version: pi_version,
        agent_dir: pi_agent_dir.to_string_lossy().into_owned(),
        providers,
        catalog_models,
        runtimes,
        error: pi_error,
    }
}

fn handle_sync(input: SyncInput) -> Result<SyncOutput, String> {
    let direction = input.direction.as_deref().unwrap_or("both");
    if !matches!(direction, "both" | "to_pi" | "from_pi") {
        return Err(format!("invalid direction: {direction}"));
    }
    let home_dir = resolve_home_dir(input.home_dir.as_deref());
    let pi_agent_dir = resolve_pi_agent_dir(&home_dir, input.pi_agent_dir.as_deref());
    let models_path = pi_agent_dir.join("models.json");
    let auth_path = pi_agent_dir.join("auth.json");
    let mut pushed = 0_usize;

    if direction != "from_pi" && !input.web_providers.is_empty() {
        fs::create_dir_all(&pi_agent_dir).map_err(|err| err.to_string())?;
        let _ = fs::set_permissions(&pi_agent_dir, fs::Permissions::from_mode(0o700));
        let mut models_json = read_json_object(&models_path);
        let mut auth_json = read_json_object(&auth_path);
        let mut provider_map = match models_json.get("providers") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let mut auth_dirty = false;

        let opencode_dir = home_dir.join(".local/share/opencode");
        let opencode_auth_path = opencode_dir.join("auth.json");
        let has_opencode = opencode_dir.is_dir();
        let mut opencode_auth = if has_opencode {
            read_json_object(&opencode_auth_path)
        } else {
            Map::new()
        };
        let mut opencode_dirty = false;

        for p in &input.web_providers {
            let mut existing = match provider_map.get(&p.id) {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            let mut models = match existing.get("models") {
                Some(Value::Array(arr)) => arr.clone(),
                _ => Vec::new(),
            };
            if let Some(raw_model) = p.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                let prefix = format!("{}/", p.id);
                let model_id = raw_model.strip_prefix(&prefix).unwrap_or(raw_model);
                if !models
                    .iter()
                    .any(|entry| model_entry_id(entry).as_deref() == Some(model_id))
                {
                    models.push(json!({ "id": model_id }));
                }
            }
            let api = existing
                .get("api")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("openai-completions")
                .to_string();
            existing.insert("baseUrl".to_string(), Value::String(p.base_url.clone()));
            existing.insert("api".to_string(), Value::String(api));
            existing.insert("models".to_string(), Value::Array(models));
            provider_map.insert(p.id.clone(), Value::Object(existing));

            if let Some(key) = p
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
            {
                auth_json.insert(p.id.clone(), json!({ "type": "api_key", "key": key }));
                auth_dirty = true;
                if has_opencode {
                    opencode_auth.insert(p.id.clone(), json!({ "type": "api", "key": key }));
                    opencode_dirty = true;
                }
            }
            pushed += 1;
        }

        models_json.insert("providers".to_string(), Value::Object(provider_map));
        write_json_atomic(&models_path, &Value::Object(models_json), None)?;
        if auth_dirty {
            write_json_atomic(&auth_path, &Value::Object(auth_json), Some(0o600))?;
        }
        if opencode_dirty {
            write_json_atomic(
                &opencode_auth_path,
                &Value::Object(opencode_auth),
                Some(0o600),
            )?;
        }
    }

    let mut imported_providers = Vec::new();
    if direction != "to_pi" {
        let models_json = read_json_object(&models_path);
        let auth_json = read_json_object(&auth_path);
        if let Some(Value::Object(provider_map)) = models_json.get("providers") {
            for (id, raw) in provider_map {
                if !is_valid_provider_id(id) || input.web_providers.iter().any(|wp| wp.id == *id) {
                    continue;
                }
                let entry = raw.as_object();
                let base_url = entry
                    .and_then(|m| m.get("baseUrl"))
                    .and_then(Value::as_str)
                    .filter(|url| is_http_url(url))
                    .map(str::to_string)
                    .or_else(|| {
                        if id == "zai" {
                            Some(ZAI_DEFAULT_BASE_URL.to_string())
                        } else {
                            None
                        }
                    });
                let Some(base_url) = base_url else {
                    continue;
                };
                let model = entry
                    .and_then(|m| m.get("models"))
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.iter().find_map(model_entry_id))
                    .filter(|m| is_valid_model_id(m));
                let name = entry
                    .and_then(|m| m.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .unwrap_or(id)
                    .to_string();
                let api_key = extract_api_key(auth_json.get(id));
                imported_providers.push(ImportedProvider {
                    id: id.clone(),
                    name,
                    base_url,
                    model,
                    api_key,
                });
            }
        }
    }

    Ok(SyncOutput {
        pushed,
        imported_providers,
    })
}

fn handle_logout(input: LogoutInput) -> Result<LogoutOutput, String> {
    if !is_valid_provider_id(&input.provider_id) {
        return Err("invalid providerId".to_string());
    }
    let home_dir = resolve_home_dir(input.home_dir.as_deref());
    let pi_agent_dir = resolve_pi_agent_dir(&home_dir, input.pi_agent_dir.as_deref());
    let runtime_id = input.runtime_id.as_deref().unwrap_or("pi");
    let auth_path = match runtime_id {
        "opencode" => home_dir.join(".local/share/opencode/auth.json"),
        _ => pi_agent_dir.join("auth.json"),
    };
    let mut auth_json = read_json_object(&auth_path);
    let removed = auth_json.remove(&input.provider_id).is_some();
    if removed {
        write_json_atomic(&auth_path, &Value::Object(auth_json), Some(0o600))?;
    }
    Ok(LogoutOutput { removed })
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let subcommand = args.first().map(String::as_str);
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    match subcommand {
        Some("status") => {
            let input: StatusInput = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            let out = handle_status(input);
            println!(
                "{}",
                serde_json::to_string(&out).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Some("sync") => {
            let input: SyncInput = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            let out = handle_sync(input)?;
            println!(
                "{}",
                serde_json::to_string(&out).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        Some("logout") => {
            let input: LogoutInput = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            let out = handle_logout(input)?;
            println!(
                "{}",
                serde_json::to_string(&out).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        _ => Err("usage: paperclip-cli-runtime <status|sync|logout>".to_string()),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = env::temp_dir().join(format!("{prefix}-{}-{nanos}", process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn parses_cli_versions() {
        assert_eq!(
            parse_version_text("pi 0.67.68\n").as_deref(),
            Some("0.67.68")
        );
        assert_eq!(
            parse_version_text("codex-cli 0.156.0").as_deref(),
            Some("0.156.0")
        );
        assert_eq!(
            parse_version_text("2.1.232 (Claude Code)").as_deref(),
            Some("2.1.232")
        );
        assert_eq!(
            parse_version_text("Hermes Agent v0.21.5+5805").as_deref(),
            Some("0.21.5+5805")
        );
    }

    #[test]
    fn status_and_sync_never_leak_secrets_and_set_0600() {
        let root = make_temp_dir("cli-runtime-test");
        let home_dir = root.join("home");
        let pi_dir = home_dir.join(".pi/agent");
        let opencode_dir = home_dir.join(".local/share/opencode");
        fs::create_dir_all(&pi_dir).unwrap();
        fs::create_dir_all(&opencode_dir).unwrap();

        let fake_pi = root.join("fake-pi");
        fs::write(
            &fake_pi,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"pi 9.9.9\"; exit 0; fi\nif [ \"$1\" = \"--list-models\" ]; then printf \"provider  model\\nzai  glm-4.6\\n\"; exit 0; fi\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&fake_pi, fs::Permissions::from_mode(0o755)).unwrap();

        let secret = "super-secret-token-123";
        let sync_res = handle_sync(SyncInput {
            home_dir: Some(home_dir.to_string_lossy().into_owned()),
            pi_agent_dir: Some(pi_dir.to_string_lossy().into_owned()),
            direction: Some("both".to_string()),
            web_providers: vec![WebProviderInput {
                id: "zai".to_string(),
                name: "Z.AI".to_string(),
                base_url: ZAI_DEFAULT_BASE_URL.to_string(),
                model: Some("zai/glm-4.6".to_string()),
                api_key: Some(secret.to_string()),
            }],
        })
        .unwrap();
        assert_eq!(sync_res.pushed, 1);

        let pi_auth_mode = fs::metadata(pi_dir.join("auth.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(pi_auth_mode, 0o600);

        let oc_auth_mode = fs::metadata(opencode_dir.join("auth.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(oc_auth_mode, 0o600);

        let mut overrides = HashMap::new();
        overrides.insert("pi".to_string(), fake_pi.to_string_lossy().into_owned());
        let status = handle_status(StatusInput {
            home_dir: Some(home_dir.to_string_lossy().into_owned()),
            pi_agent_dir: Some(pi_dir.to_string_lossy().into_owned()),
            command_overrides: Some(overrides),
        });
        let status_json = serde_json::to_string(&status).unwrap();
        assert!(!status_json.contains(secret));
        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("9.9.9"));
        assert_eq!(status.catalog_models, vec!["zai/glm-4.6".to_string()]);
        assert_eq!(status.runtimes.len(), RUNTIMES.len());
        assert!(status
            .runtimes
            .iter()
            .any(|r| r.id == "opencode" && r.auth_configured));

        let logout = handle_logout(LogoutInput {
            home_dir: Some(home_dir.to_string_lossy().into_owned()),
            pi_agent_dir: Some(pi_dir.to_string_lossy().into_owned()),
            runtime_id: Some("pi".to_string()),
            provider_id: "zai".to_string(),
        })
        .unwrap();
        assert!(logout.removed);

        let _ = fs::remove_dir_all(&root);
    }
}
