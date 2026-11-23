//! paperclip-ops-control CLI: JSON-in/JSON-out subcommands for the control plane.
//! Usage: paperclip-ops-control <verify-skills|hold-status> '<json-args>'
//!  - verify-skills '{"root":"/path","lock":{"skills":[{"path":"rel","sha256":"hex"}]}}'
//!  - hold-status   '{"dir":"/path/to/state"}'
use paperclip_ops_control::*;
use serde_json::{json, Value};
use std::path::Path;
use std::process;

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| format!("missing string field {k}"))
}

fn dispatch(cmd: &str, a: &Value) -> Result<Value, String> {
    match cmd {
        "verify-skills" => {
            let lock: SkillsLock = serde_json::from_value(a.get("lock").cloned().ok_or("missing field lock")?).map_err(|e| format!("bad lock: {e}"))?;
            verify_skills_lock(Path::new(s(a, "root")?), &lock)
                .map(|r| serde_json::to_value(r).unwrap_or_else(|_| json!({})))
                .map_err(|e| e.to_string())
        }
        "hold-status" => read_routine_hold(Path::new(s(a, "dir")?))
            .map(|h| json!({ "hold": h }))
            .map_err(|e| e.to_string()),
        _ => Err(format!("unknown subcommand {cmd:?}")),
    }
}

fn run() -> Result<Value, String> {
    let cmd = std::env::args().nth(1).ok_or("usage: paperclip-ops-control <verify-skills|hold-status> '<json>'")?;
    let arg = std::env::args().nth(2).ok_or("missing json arg")?;
    let a: Value = serde_json::from_str(&arg).map_err(|e| format!("bad json arg: {e}"))?;
    dispatch(&cmd, &a)
}

fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "error": e }));
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn hex_str(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    #[test]
    fn cli_verify_skills_and_hold_status_smoke() {
        let d = std::env::temp_dir().join(format!("opsctl-cli-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("s.txt"), b"skill").unwrap();
        let a = json!({ "root": d, "lock": { "skills": [ { "path": "s.txt", "sha256": hex_str(&Sha256::digest(b"skill")) } ] } });
        let v = dispatch("verify-skills", &a).unwrap();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["checked"], json!(1));
        assert!(dispatch("verify-skills", &json!({ "root": d, "lock": { "skills": [ { "path": "s.txt", "sha256": "zz" } ] } })).is_err());
        let h = dispatch("hold-status", &json!({ "dir": d.join("none") })).unwrap();
        assert!(h["hold"].is_null());
        assert!(dispatch("bogus-cmd", &a).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
