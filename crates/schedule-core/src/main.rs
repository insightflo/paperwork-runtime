//! paperclip-schedule-core — stdin/stdout JSON subcommands mirroring the pure
//! cron surface of server/src/services/cron.ts (parse / validate / next-run).
//! Domain errors (Err) mirror TS `throw new Error(...)` and go to stderr with
//! exit 1, matching the established sibling crate convention.

#[rustfmt::skip]
mod cron;

use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

fn read_stdin_bounded(max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let cap = u64::try_from(max_bytes + 1).unwrap_or(u64::MAX);
    io::stdin()
        .take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > max_bytes {
        return Err("stdin_payload_too_large".to_string());
    }
    Ok(buf)
}

fn read_expression(input: &Value) -> Result<&str, String> {
    input
        .get("expression")
        .and_then(Value::as_str)
        .ok_or_else(|| "expression must be a string".to_string())
}

fn dispatch(subcommand: &str, raw: &[u8]) -> Result<Value, String> {
    let input: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    match subcommand {
        "parse" => {
            let parsed = cron::parse_cron(read_expression(&input)?)?;
            Ok(json!({
                "ok": true,
                "parsed": {
                    "minutes": parsed.minutes,
                    "hours": parsed.hours,
                    "daysOfMonth": parsed.days_of_month,
                    "months": parsed.months,
                    "daysOfWeek": parsed.days_of_week,
                }
            }))
        }
        "validate" => match cron::validate_cron(read_expression(&input)?) {
            None => Ok(json!({ "valid": true, "error": null })),
            Some(message) => Ok(json!({ "valid": false, "error": message })),
        },
        "next-run" => {
            let expression = read_expression(&input)?;
            let after_ms = input
                .get("afterMs")
                .and_then(Value::as_f64)
                .ok_or("afterMs must be a number")?;
            let parsed = cron::parse_cron(expression)?;
            Ok(match cron::next_cron_tick(&parsed, after_ms) {
                Some(ms) => json!({ "ok": true, "nextMs": ms }),
                None => json!({ "ok": true, "nextMs": null }),
            })
        }
        other => Err(format!(
            "usage: paperclip-schedule-core <parse|validate|next-run> (got \"{other}\")"
        )),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err("usage: paperclip-schedule-core <parse|validate|next-run>".to_string());
    };
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let out = dispatch(subcommand, &raw)?;
    println!(
        "{}",
        serde_json::to_string(&out).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

// Pinned fixtures (epochs are stable Z-instants, no TZ dependence): the
// differential parity suite in server/src/__tests__ is the primary gate;
// these keep `cargo test` meaningful on its own.
#[cfg(test)]
#[rustfmt::skip] // one-line fixtures keep the tables diffable
mod tests {
    use super::dispatch;
    use crate::cron::{next_cron_tick, parse_cron, validate_cron};
    use serde_json::json;

    #[test]
    fn parses_fields_sorted_and_deduped() {
        let c = parse_cron("45,5,5 */15 1-7 1,4 0-6").unwrap();
        assert_eq!(c.minutes, vec![5, 45]);
        assert_eq!(c.hours, vec![0, 15]);
        assert_eq!(c.days_of_month, (1..=7).collect::<Vec<_>>());
        assert_eq!(c.months, vec![1, 4]);
        assert_eq!(c.days_of_week, (0..=6).collect::<Vec<_>>());
    }

    #[test]
    fn parse_int_quirks_match_js() {
        assert_eq!(parse_cron("1e2,5 * * * *").unwrap().minutes, vec![1, 5]); // parseInt("1e2")=1
        assert_eq!(parse_cron("+5 * * * *").unwrap().minutes, vec![5]); // parseInt("+5")=5
        assert_eq!(parse_cron("0x10 * * * *").unwrap().minutes, vec![0]); // radix 10 stops at 'x'
        assert_eq!(parse_cron("07,08 * * * *").unwrap().minutes, vec![7, 8]);
        assert_eq!(parse_cron("1.5,2 * * * *").unwrap().minutes, vec![1, 2]); // parseInt("1.5")=1
        assert_eq!(parse_cron("1-2-3 * * * *").unwrap().minutes, vec![1, 2]); // destructure [a,b]
        assert_eq!(parse_cron("5/2/3 * * * *").unwrap().minutes, (5..=59).step_by(2).collect::<Vec<_>>()); // step "2/3"->2
        assert_eq!(parse_cron("1-2abc/5 * * * *").unwrap().minutes, vec![1]); // parseInt("2abc")=2
    }

    #[test]
    fn error_messages_match_ts_verbatim() {
        assert_eq!(validate_cron(""), Some("Cron expression must not be empty".to_string()));
        assert_eq!(validate_cron("* * *").map(|e: String| e.starts_with("Cron expression must have exactly 5 fields, got 3:")), Some(true));
        assert_eq!(validate_cron("60 * * * *"), Some("Value 60 out of range [0–59] for cron minute field".to_string()));
        assert_eq!(validate_cron("99999999999999999999 * * * *"), Some("Value 100000000000000000000 out of range [0–59] for cron minute field".to_string()));
        assert_eq!(validate_cron("9223372036854775808 * * * *"), Some("Value 9223372036854776000 out of range [0–59] for cron minute field".to_string())); // 2^63 shortest round-trip, not exact i128
        assert_eq!(validate_cron("12345678901234567890 * * * *"), Some("Value 12345678901234567000 out of range [0–59] for cron minute field".to_string()));
        assert_eq!(validate_cron("1234567890123456789012 * * * *"), Some("Value 1.2345678901234568e+21 out of range [0–59] for cron minute field".to_string()));
        assert_eq!(validate_cron("\u{85}5 * * * *"), Some("Invalid value \"\u{85}5\" in cron minute field".to_string())); // NEL is not JS whitespace
        assert_eq!(validate_cron("\u{feff}5 * * * *"), None); // BOM is JS whitespace
        assert_eq!(validate_cron("1-0 * * * *"), Some("Invalid range 1-0 in cron minute field (start > end)".to_string()));
        assert_eq!(validate_cron("-5 * * * *"), Some("Invalid range \"-5\" in cron minute field".to_string()));
        assert_eq!(validate_cron("*/0 * * * *"), Some("Invalid step \"0\" in cron minute field".to_string()));
        assert_eq!(validate_cron("a,,2 * * * *"), Some("Invalid value \"a\" in cron minute field".to_string()));
        assert_eq!(validate_cron("1,,2 * * * *"), Some("Empty element in cron minute field".to_string()));
        assert_eq!(validate_cron("6-0/2 * * * *"), Some("Empty result for cron minute field".to_string()));
        assert_eq!(validate_cron("* * * * *"), None);
    }

    #[test]
    fn next_tick_pins_match_utc_wall_clock() {
        let cron = |e: &str| parse_cron(e).unwrap();
        assert_eq!(next_cron_tick(&cron("* * * * *"), 1736937045678.0), Some(1736937060000)); // 10:30:45.678 -> 10:31:00
        assert_eq!(next_cron_tick(&cron("* * * * *"), 1000.5), Some(60000)); // TimeClip truncation
        assert_eq!(next_cron_tick(&cron("*/15 * * * *"), 1736935600000.0 /* 10:06:40 */), Some(1736936100000)); // 10:15
        assert_eq!(next_cron_tick(&cron("0 0 * * *"), 1767206370000.0 /* 2025-12-31T23:59:30 */), Some(1767225600000)); // 2026-01-01T00:00
        assert_eq!(next_cron_tick(&cron("0 0 * * *"), -30000.0 /* 1969-12-31T23:59:30 */), Some(0)); // 1970-01-01T00:00 (minute 60 roll)
        assert_eq!(next_cron_tick(&cron("0 0 29 2 *"), 1735689600000.0 /* 2025-01-01 */), Some(1835395200000)); // 2028-02-29
        assert_eq!(next_cron_tick(&cron("0 0 29 2 *"), 3981484860000.0 /* 2096-03-01T00:01 */), Some(4233686400000)); // 2104-02-29 (2100 not leap)
        assert_eq!(next_cron_tick(&cron("59 10 * * *"), 1736938770000.0 /* 2025-01-15T10:59:30 */), Some(1737025140000)); // next day 10:59 (60-min roll)
    }

    #[test]
    fn impossible_schedules_exhaust_the_search_cap() {
        let cron = parse_cron("0 0 30 2 *").unwrap(); // Feb 30 never exists
        assert_eq!(next_cron_tick(&cron, 1735689600000.0), None);
    }

    #[test]
    fn dispatch_contract_mirrors_json_shapes() {
        let ok = dispatch("validate", br#"{"expression":"* * * * *"}"#).unwrap();
        assert_eq!(ok, json!({ "valid": true, "error": null }));
        let bad = dispatch("validate", br#"{"expression":"60 * * * *"}"#).unwrap();
        assert_eq!(bad, json!({ "valid": false, "error": "Value 60 out of range [0–59] for cron minute field" }));
        assert_eq!(dispatch("parse", br#"{"expression":42}"#), Err("expression must be a string".to_string()));
        assert!(dispatch("nope", br#"{}"#).unwrap_err().starts_with("usage: paperclip-schedule-core"));
    }
}
