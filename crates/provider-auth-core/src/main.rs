//! provider-auth-core CLI: JSON subcommands for auth evidence probes.
//! Usage: provider-auth-core <probe-all | probe <provider> | plan-login <provider>>
#![forbid(unsafe_code)]

use paperclip_provider_auth_core::{plan_login, probe_all, probe_provider, ProbeEnv};
use paperclip_provider_runtime_core::ProviderId;
use serde_json::{json, Value};

fn provider(s: Option<&String>) -> Result<ProviderId, String> {
    s.and_then(|v| ProviderId::parse(v)).ok_or_else(|| "provider must be one of: claude, codex, pi, commandcode, devin".to_string())
}
fn run(args: &[String]) -> Result<Value, String> {
    let env = ProbeEnv::from_process();
    match args.first().map(String::as_str) {
        Some("probe-all") => serde_json::to_value(probe_all(&env)).map_err(|e| e.to_string()),
        Some("probe") => serde_json::to_value(probe_provider(provider(args.get(1))?, &env)).map_err(|e| e.to_string()),
        Some("plan-login") => serde_json::to_value(plan_login(provider(args.get(1))?)).map_err(|e| e.to_string()),
        _ => Err("usage: provider-auth-core <probe-all | probe <provider> | plan-login <provider>>".to_string()),
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "error": e }));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_dispatch_smoke() {
        assert!(run(&["probe-all".to_string()]).unwrap().is_array());
        assert_eq!(run(&["probe".to_string(), "claude".to_string()]).unwrap()["provider"], json!("claude"));
        assert_eq!(run(&["plan-login".to_string(), "codex".to_string()]).unwrap()["command"], json!("codex"));
        assert!(run(&["probe".to_string(), "bogus".to_string()]).is_err());
        assert!(run(&["nope".to_string()]).is_err());
    }
    #[test]
    fn cli_binary_smoke() {
        let Some(exe) = option_env!("CARGO_BIN_EXE_paperclip-provider-auth-core") else {
            return;
        };
        let out = std::process::Command::new(exe).arg("probe-all").output().unwrap();
        assert!(out.status.success());
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(v.as_array().is_some_and(|a| !a.is_empty()));
    }
}
