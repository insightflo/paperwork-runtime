use std::io::Read;
use std::process::ExitCode;

use paperwork_engine_heartbeat::{validate_transition, RunStatus};

const MAX_STDIN_BYTES: usize = 65_536;

fn usage() -> &'static str {
    "paperwork-engine-heartbeat\n\nUSAGE:\n    paperwork-engine-heartbeat <SUBCOMMAND>\n\n\
     SUBCOMMANDS:\n    validate-transition  Read \
     {\"expected_statuses\":[\"running\"],\"next_status\":\"succeeded\"} from stdin \
     and print the transition plan as JSON"
}

fn json_error(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

fn validate_transition_from_stdin(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_STDIN_BYTES {
        return Err(format!("stdin exceeds {} byte limit", MAX_STDIN_BYTES));
    }
    #[derive(serde::Deserialize)]
    struct Input {
        expected_statuses: Vec<String>,
        next_status: String,
    }
    let input: Input =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid JSON input: {e}"))?;
    let mut expected = Vec::with_capacity(input.expected_statuses.len());
    for raw in &input.expected_statuses {
        expected.push(RunStatus::parse(raw).ok_or_else(|| format!("unknown run status: {raw}"))?);
    }
    let next = RunStatus::parse(&input.next_status)
        .ok_or_else(|| format!("unknown run status: {}", input.next_status))?;
    let plan = validate_transition(&expected, next).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "sets_started_at": plan.sets_started_at,
        "sets_finished_at": plan.sets_finished_at,
    })
    .to_string())
}

fn run() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(sub) = args.next() else {
        eprintln!("{}", json_error("missing subcommand"));
        return ExitCode::from(2);
    };
    match sub.as_str() {
        "-h" | "--help" => {
            println!("{}", usage());
            ExitCode::SUCCESS
        }
        "validate-transition" => {
            let mut buf = Vec::new();
            if let Err(e) = std::io::stdin()
                .take(MAX_STDIN_BYTES as u64 + 1)
                .read_to_end(&mut buf)
            {
                eprintln!("{}", json_error(&format!("failed to read stdin: {e}")));
                return ExitCode::FAILURE;
            }
            match validate_transition_from_stdin(&buf) {
                Ok(line) => {
                    println!("{line}");
                    ExitCode::SUCCESS
                }
                Err(msg) => {
                    eprintln!("{}", json_error(&msg));
                    ExitCode::FAILURE
                }
            }
        }
        other => {
            eprintln!("{}", json_error(&format!("unknown argument: {other}")));
            ExitCode::from(2)
        }
    }
}

fn main() -> ExitCode {
    run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_transition_accepts_legal() {
        let out = validate_transition_from_stdin(
            br#"{"expected_statuses":["running"],"next_status":"succeeded"}"#,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["sets_finished_at"], true);
        assert_eq!(v["sets_started_at"], false);
    }

    #[test]
    fn validate_transition_rejects_illegal() {
        assert!(validate_transition_from_stdin(
            br#"{"expected_statuses":["succeeded"],"next_status":"running"}"#,
        )
        .is_err());
        assert!(validate_transition_from_stdin(
            br#"{"expected_statuses":[],"next_status":"running"}"#,
        )
        .is_err());
        assert!(validate_transition_from_stdin(b"not json").is_err());
        assert!(validate_transition_from_stdin(
            br#"{"expected_statuses":["bogus"],"next_status":"running"}"#,
        )
        .is_err());
    }
}
