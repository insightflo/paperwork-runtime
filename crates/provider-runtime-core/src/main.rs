//! provider-runtime-core CLI: JSON-in/JSON-out subcommands for the control plane.
//! Usage: provider-runtime-core <verify-sha256|check-blocklist|stage-commit|inspect> '<json-args>'
use paperclip_provider_runtime_core::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{self, Command};

fn jarg() -> Result<Value, String> {
    let s = std::env::args().nth(2).ok_or("usage: provider-runtime-core <cmd> '<json>'")?;
    serde_json::from_str(&s).map_err(|e| format!("bad json arg: {e}"))
}
fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> { v.get(k).and_then(Value::as_str).ok_or_else(|| format!("missing string field {k}")) }
fn provider(v: &Value) -> Result<ProviderId, String> { ProviderId::parse(s(v, "provider")?).ok_or_else(|| "unknown provider".to_string()) }
fn blocklist(v: &Value) -> Result<Blocklist, String> { serde_json::from_value(v.get("blocklist").cloned().unwrap_or_else(|| json!({}))).map_err(|e| e.to_string()) }
fn path_dirs(v: &Value) -> Vec<PathBuf> {
    v.get("pathDirs").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_else(|| std::env::var("PATH").map(|p| p.split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect()).unwrap_or_default())
}
fn probe(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace().find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit())).map(str::to_string)
}

fn run(cmd: &str) -> Result<Value, String> {
    let a = jarg()?;
    match cmd {
        "verify-sha256" => verify_sha256(Path::new(s(&a, "path")?), s(&a, "sha256")?)
            .map(|ok| json!({ "ok": ok })).map_err(|e| e.to_string()),
        "check-blocklist" => {
            let bl = blocklist(&a)?;
            Ok(json!({ "blocked": bl.blocks(s(&a, "version")?, s(&a, "sha256")?) }))
        }
        "stage-commit" => stage_and_activate(
            Path::new(s(&a, "root")?), provider(&a)?, s(&a, "version")?,
            Path::new(s(&a, "source")?), s(&a, "sha256")?,
        ).map(|r| serde_json::to_value(r).unwrap_or_else(|_| json!({}))).map_err(|e| e.to_string()),
        "inspect" => resolve_runtime(
            Path::new(s(&a, "root")?), provider(&a)?, &blocklist(&a)?, &path_dirs(&a), probe,
        ).map(|r| json!({
            "version": r.version, "binaryPath": r.binary_path, "sha256": r.sha256,
            "source": match r.source { RuntimeSource::Managed => "managed", RuntimeSource::SystemPath => "systemPath" },
        })).map_err(|e| e.to_string()),
        _ => Err(format!("unknown subcommand {cmd:?}")),
    }
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match run(&cmd) {
        Ok(v) => println!("{v}"),
        Err(e) => { println!("{}", json!({ "error": e })); process::exit(1); }
    }
}
