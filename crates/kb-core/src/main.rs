mod compile;
mod lint;
mod scoring;

use std::io::{self, Read};

fn run() -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    let subcommand = args.next().ok_or_else(|| {
        "missing subcommand (expected: score-nodes | lint-nodes | compile-mission)".to_string()
    })?;
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;

    match subcommand.as_str() {
        "score-nodes" => {
            let req: scoring::ScoreNodesRequest =
                serde_json::from_str(&buf).map_err(|e| format!("invalid score-nodes JSON: {e}"))?;
            let res = scoring::score_nodes(req)?;
            serde_json::to_string(&res).map_err(|e| format!("serialize error: {e}"))
        }
        "lint-nodes" => {
            let req: lint::LintNodesRequest =
                serde_json::from_str(&buf).map_err(|e| format!("invalid lint-nodes JSON: {e}"))?;
            let res = lint::lint_nodes(req)?;
            serde_json::to_string(&res).map_err(|e| format!("serialize error: {e}"))
        }
        "compile-mission" => {
            let req: compile::CompileMissionRequest = serde_json::from_str(&buf)
                .map_err(|e| format!("invalid compile-mission JSON: {e}"))?;
            let res = compile::compile_mission(req)?;
            serde_json::to_string(&res).map_err(|e| format!("serialize error: {e}"))
        }
        other => Err(format!("unknown subcommand: {other}")),
    }
}

fn main() {
    match run() {
        Ok(json) => println!("{json}"),
        Err(msg) => {
            eprintln!(
                "{{\"error\":{}}}",
                serde_json::to_string(&msg).unwrap_or_else(|_| "\"internal error\"".into())
            );
            std::process::exit(1);
        }
    }
}
