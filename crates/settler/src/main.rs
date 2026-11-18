mod quiescence;
mod settle;

use std::str::FromStr;
use std::time::Duration;
use chrono::{DateTime, Utc};
use postgres::{Config, NoTls};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverOutput {
    processed: usize,
    settled: Vec<settle::SettledRunReport>,
}

struct CliArgs {
    now: DateTime<Utc>,
    grace_ms: i64,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<CliArgs, String> {
    let mut iter = args.into_iter().skip(1);
    let Some(subcmd) = iter.next() else {
        return Err("missing subcommand (expected recover-once)".to_string());
    };
    if subcmd != "recover-once" {
        return Err(format!("unsupported subcommand: {subcmd}"));
    }
    let mut now: Option<DateTime<Utc>> = None;
    let mut grace_ms: i64 = 5 * 60 * 1000;
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--now" => {
                let parsed = DateTime::parse_from_rfc3339(&value)
                    .map_err(|e| format!("invalid --now timestamp: {e}"))?;
                now = Some(parsed.with_timezone(&Utc));
            }
            "--grace-ms" => {
                grace_ms = value
                    .parse::<i64>()
                    .map_err(|e| format!("invalid --grace-ms integer: {e}"))?;
                if !(-86_400_000_000..=86_400_000_000).contains(&grace_ms) {
                    return Err("--grace-ms out of range".to_string());
                }
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    Ok(CliArgs {
        now: now.unwrap_or_else(Utc::now),
        grace_ms,
    })
}

fn connect_db() -> Result<postgres::Client, String> {
    let url = std::env::var("DATABASE_URL")
        .map_err(|_| "DATABASE_URL environment variable is required".to_string())?;
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("DATABASE_URL environment variable is empty".to_string());
    }
    let mut config = Config::from_str(trimmed).map_err(|e| format!("invalid DATABASE_URL: {e}"))?;
    config.connect_timeout(Duration::from_secs(5));
    config.connect(NoTls).map_err(|e| format!("postgres connect failed: {e}"))
}

fn is_finalization_v1_enabled(client: &mut postgres::Client) -> Result<bool, postgres::Error> {
    let row = client.query_opt(
        "SELECT COALESCE((experimental->>'enableHeartbeatFinalizationV1') = 'true', false)
         FROM instance_settings WHERE singleton_key = 'default' LIMIT 1",
        &[],
    )?;
    Ok(row.map(|r| r.get::<_, bool>(0)).unwrap_or(false))
}

fn run_recover_once(args: CliArgs) -> Result<RecoverOutput, String> {
    let mut client = connect_db()?;
    if !is_finalization_v1_enabled(&mut client).map_err(|e| e.to_string())? {
        return Ok(RecoverOutput { processed: 0, settled: Vec::new() });
    }
    let cutoff = args.now - chrono::Duration::milliseconds(args.grace_ms);
    let candidate_rows = client
        .query(
            "SELECT id FROM heartbeat_runs
             WHERE status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
               AND finalization_version = 1
               AND settled_at IS NULL
               AND COALESCE(finished_at, updated_at) < $1
             LIMIT 50",
            &[&cutoff],
        )
        .map_err(|e| e.to_string())?;

    let mut processed = 0usize;
    let mut settled = Vec::new();
    for row in candidate_rows {
        let run_id: Uuid = row.get(0);
        let Ok(Some(run)) = quiescence::load_run(&mut client, run_id) else {
            continue;
        };
        if run.finalization_version != 1 || run.settled_at.is_some() {
            continue;
        }
        if let Ok(maybe_report) = settle::attempt_full_settlement_and_report(&mut client, &run, args.now) {
            if let Some(report) = maybe_report {
                settled.push(report);
            }
            processed += 1;
        }
    }
    Ok(RecoverOutput { processed, settled })
}

fn main() {
    let args = match parse_args(std::env::args()) {
        Ok(parsed) => parsed,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    match run_recover_once(args) {
        Ok(output) => match serde_json::to_string(&output) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("failed to encode settler output: {err}");
                std::process::exit(1);
            }
        },
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(1);
        }
    }
}
