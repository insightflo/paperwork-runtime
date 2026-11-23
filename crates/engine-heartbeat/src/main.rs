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

fn run_with_args(args: &[String]) -> u8 {
    let Some(sub) = args.get(1).map(String::as_str) else {
        eprintln!("{}", json_error("missing subcommand"));
        return 2;
    };
    if !matches!(sub, "-h" | "--help" | "validate-transition") {
        eprintln!("{}", json_error(&format!("unknown argument: {sub}")));
        return 2;
    }
    if let Some(extra) = args.get(2) {
        eprintln!("{}", json_error(&format!("unexpected argument: {extra}")));
        return 2;
    }
    match sub {
        "-h" | "--help" => {
            println!("{}", usage());
            0
        }
        _ => {
            let mut buf = Vec::new();
            if let Err(e) = std::io::stdin()
                .take(MAX_STDIN_BYTES as u64 + 1)
                .read_to_end(&mut buf)
            {
                eprintln!("{}", json_error(&format!("failed to read stdin: {e}")));
                return 1;
            }
            match validate_transition_from_stdin(&buf) {
                Ok(line) => {
                    println!("{line}");
                    0
                }
                Err(msg) => {
                    eprintln!("{}", json_error(&msg));
                    1
                }
            }
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    ExitCode::from(run_with_args(&args))
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

    #[test]
    fn cli_rejects_trailing_args() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(run_with_args(&argv(&["bin", "validate-transition", "--bogus"])), 2);
        assert_eq!(run_with_args(&argv(&["bin", "--help", "extra"])), 2);
        assert_eq!(run_with_args(&argv(&["bin", "bogus"])), 2);
    }
}

#[cfg(test)]
mod pg_tests {
    use chrono::{Duration, Utc};
    use paperwork_engine_heartbeat::{
        claim_next_queued_wakeup, list_stale_running_runs_skip_locked,
        transition_run_status_fenced, ClaimWakeupInput, FencedTransitionInput,
        FencedTransitionResult, HeartbeatDbError, RunStatus,
    };
    use postgres::{Client, NoTls, Transaction};
    use uuid::Uuid;

    #[derive(Clone, Copy)]
    struct Seeded {
        company: Uuid,
        agent: Uuid,
        wakes: [Uuid; 2],
        runs: [Uuid; 2],
    }

    // Deletes seeded rows in reverse FK order, even while unwinding a panic.
    struct Cleanup {
        url: String,
        seeded: Seeded,
    }

    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(mut c) = Client::connect(&self.url, NoTls) {
                let s = &self.seeded;
                let _ = c.execute("DELETE FROM heartbeat_runs WHERE id = ANY($1)", &[&s.runs.to_vec()]);
                let _ = c.execute("DELETE FROM agent_wakeup_requests WHERE id = ANY($1)", &[&s.wakes.to_vec()]);
                let _ = c.execute("DELETE FROM agents WHERE id = $1", &[&s.agent]);
                let _ = c.execute("DELETE FROM companies WHERE id = $1", &[&s.company]);
            }
        }
    }

    fn run_row(tx: &mut Transaction<'_>, id: Uuid) -> (String, bool, bool) {
        let row = tx
            .query_one(
                "SELECT status, finished_at IS NOT NULL, error IS NOT NULL FROM heartbeat_runs WHERE id = $1",
                &[&id],
            )
            .unwrap();
        (row.get(0), row.get(1), row.get(2))
    }

    #[test]
    fn live_pg_two_session_skip_locked_and_fenced_transitions() {
        let url = std::env::var("PAPERWORK_HEARTBEAT_TEST_DATABASE_URL").unwrap_or_default();
        if url.is_empty() {
            eprintln!("PAPERWORK_HEARTBEAT_TEST_DATABASE_URL unset; skipping live PG test");
            return;
        }
        let seeded = Seeded {
            company: Uuid::new_v4(),
            agent: Uuid::new_v4(),
            wakes: [Uuid::new_v4(), Uuid::new_v4()],
            runs: [Uuid::new_v4(), Uuid::new_v4()],
        };
        let _cleanup = Cleanup { url: url.clone(), seeded };

        {
            let mut setup = Client::connect(&url, NoTls).unwrap();
            let prefix = format!("HBT{}", seeded.company.simple());
            setup.execute("INSERT INTO companies (id, name, issue_prefix) VALUES ($1, 'hb-pg-test', $2)", &[&seeded.company, &prefix]).unwrap();
            setup.execute("INSERT INTO agents (id, company_id, name) VALUES ($1, $2, 'hb-pg-test')", &[&seeded.agent, &seeded.company]).unwrap();
            for i in 0..2usize {
                // Index 0 (row 1) gets the strictly earlier timestamp; both are stale.
                let ts = Utc::now() - Duration::hours(3 - i as i64);
                setup.execute(
                    "INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, status, requested_at) VALUES ($1, $2, $3, 'pg_test', 'queued', $4)",
                    &[&seeded.wakes[i], &seeded.company, &seeded.agent, &ts],
                ).unwrap();
                setup.execute(
                    "INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at, updated_at) VALUES ($1, $2, $3, 'running', $4, $4)",
                    &[&seeded.runs[i], &seeded.company, &seeded.agent, &ts],
                ).unwrap();
            }
        }

        // Session A locks row 1 of each table; Session B must skip them. The
        // statement timeout makes a missing SKIP LOCKED fail fast, not hang.
        let mut a = Client::connect(&url, NoTls).unwrap();
        let mut tx_a = a.transaction().unwrap();
        tx_a.query("SELECT id FROM agent_wakeup_requests WHERE id = $1 FOR UPDATE", &[&seeded.wakes[0]]).unwrap();
        tx_a.query("SELECT id FROM heartbeat_runs WHERE id = $1 FOR UPDATE", &[&seeded.runs[0]]).unwrap();

        let mut b = Client::connect(&url, NoTls).unwrap();
        let mut tx_b = b.transaction().unwrap();
        tx_b.execute("SET LOCAL statement_timeout = '1500ms'", &[]).unwrap();
        let claimed = claim_next_queued_wakeup(&mut tx_b, &ClaimWakeupInput {
            company_id: seeded.company, agent_id: seeded.agent,
        }).unwrap().expect("unlocked wakeup row missing");
        assert_eq!(claimed.id, seeded.wakes[1]);
        assert!(claimed.claimed_at.is_some());
        let status: String = tx_b
            .query_one("SELECT status FROM agent_wakeup_requests WHERE id = $1", &[&seeded.wakes[1]])
            .unwrap().get(0);
        assert_eq!(status, "claimed");
        let stale = list_stale_running_runs_skip_locked(&mut tx_b, seeded.company, Utc::now(), 10).unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, seeded.runs[1]);
        tx_b.commit().unwrap();
        tx_a.rollback().unwrap();

        // Fenced transitions run only after Session A released the row-1 lock.
        let mut tx = b.transaction().unwrap();
        let input = |expected: Vec<RunStatus>, next: RunStatus, company: Uuid| FencedTransitionInput {
            run_id: seeded.runs[0],
            company_id: company,
            expected_statuses: expected,
            next_status: next,
            error: None,
            error_code: None,
        };
        let before = run_row(&mut tx, seeded.runs[0]);
        assert!(matches!(
            transition_run_status_fenced(&mut tx, &input(vec![RunStatus::Running], RunStatus::Succeeded, Uuid::new_v4())).unwrap(),
            FencedTransitionResult::Discarded
        ));
        assert_eq!(run_row(&mut tx, seeded.runs[0]), before);
        assert!(matches!(
            transition_run_status_fenced(&mut tx, &input(vec![RunStatus::Queued], RunStatus::Cancelled, seeded.company)).unwrap(),
            FencedTransitionResult::Discarded
        ));
        assert_eq!(run_row(&mut tx, seeded.runs[0]), before);
        match transition_run_status_fenced(&mut tx, &input(vec![RunStatus::Running], RunStatus::Succeeded, seeded.company)).unwrap() {
            FencedTransitionResult::Applied(t) => {
                assert_eq!(t.run_id, seeded.runs[0]);
                assert_eq!(t.status, RunStatus::Succeeded);
                assert!(t.finished_at.is_some());
            }
            FencedTransitionResult::Discarded => panic!("expected Applied"),
        }
        assert!(matches!(
            transition_run_status_fenced(&mut tx, &input(vec![RunStatus::Succeeded], RunStatus::Running, seeded.company)),
            Err(HeartbeatDbError::IllegalTransition { .. })
        ));
        assert_eq!(run_row(&mut tx, seeded.runs[0]).0, "succeeded");
        tx.commit().unwrap();
    }
}
