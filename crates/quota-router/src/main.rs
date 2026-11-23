//! paperclip-quota-router CLI: JSON-in/JSON-out model failover selection.
//! Usage: paperclip-quota-router select-model '<json RouteRequest>'
//! Output: RouteResponse JSON on stdout with exit 0; {"error": ...} exit 1.
use paperclip_quota_router::{route, RouteRequest};
use serde_json::json;
use std::process;

const USAGE: &str = "usage: paperclip-quota-router select-model '<json>'";

/// Returns (exit code, single JSON output line) so tests can drive it in-process.
fn cli(args: &[String]) -> (i32, String) {
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("select-model"), Some(raw)) => match serde_json::from_str::<RouteRequest>(raw.as_str()) {
            Ok(req) => match serde_json::to_string(&route(&req)) {
                Ok(line) => (0, line),
                Err(e) => (1, json!({ "error": e.to_string() }).to_string()),
            },
            Err(e) => (1, json!({ "error": format!("bad json arg: {e}") }).to_string()),
        },
        _ => (1, json!({ "error": USAGE }).to_string()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (code, line) = cli(&args);
    println!("{line}");
    process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::cli;

    fn run(args: &[&str]) -> (i32, String) {
        cli(&args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn select_model_emits_exact_json() {
        let req = concat!(
            r#"{"primary":{"provider":"p","model":"m"},"backup_order":[],"quotas":"#,
            r#"[{"provider":"p","model":"m","observed_at_epoch_ms":999,"stale_after_ms":100,"remaining_pct":80.0}],"#,
            r#""now_epoch_ms":1000,"min_remaining_pct":50.0}"#
        );
        let (code, out) = run(&["select-model", req]);
        assert_eq!(code, 0);
        assert_eq!(
            out,
            r#"{"selected":{"provider":"p","model":"m"},"reason":"eligible","tried":[{"provider":"p","model":"m","reason":"eligible"}],"earliest_reset_epoch_ms":null}"#
        );
    }

    #[test]
    fn malformed_or_missing_input_exits_nonzero() {
        let (code, out) = run(&["select-model", "{not json"]);
        assert_ne!(code, 0);
        assert!(out.contains("\"error\""));
        assert_ne!(run(&["select-model"]).0, 0); // missing json arg
        assert_ne!(run(&["bogus", "{}"]).0, 0); // unknown subcommand
        assert_ne!(run(&[]).0, 0); // no args at all
    }
}
