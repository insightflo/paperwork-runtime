//! Strict 5-field UTC cron core ported 1:1 from `server/src/services/cron.ts`
//! (soft-mode stage 4.A). JS semantics reproduced deliberately: parseInt
//! radix-10 quirks, ECMAScript trim/split sets, Date setter normalization,
//! non-Vixie DOM+DOW AND, search cap, exact error messages (en dash U+2013).
#[rustfmt::skip]
use std::collections::BTreeSet;

/// Field bounds and display name, mirroring `FIELD_SPECS` in cron.ts.
struct FieldSpec { min: i64, max: i64, name: &'static str }

#[rustfmt::skip]
const FIELD_SPECS: [FieldSpec; 5] = [
    FieldSpec { min: 0, max: 59, name: "minute" },
    FieldSpec { min: 0, max: 23, name: "hour" },
    FieldSpec { min: 1, max: 31, name: "day of month" },
    FieldSpec { min: 1, max: 12, name: "month" },
    FieldSpec { min: 0, max: 6, name: "day of week" },
];

/// Parsed cron schedule; every field is sorted ascending and deduplicated.
pub struct ParsedCron {
    pub minutes: Vec<i64>,
    pub hours: Vec<i64>,
    pub days_of_month: Vec<i64>,
    pub months: Vec<i64>,
    pub days_of_week: Vec<i64>,
}

/// ECMAScript WhiteSpace/LineTerminator minus U+0085 (NEL), plus U+FEFF.
/// Serves both String#trim and the /\s+/ token split (same set).
#[rustfmt::skip]
fn is_js_space_char(c: char) -> bool { (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}' }

#[rustfmt::skip]
fn js_trim(s: &str) -> &str { s.trim_matches(is_js_space_char) }

/// `parseInt(s, 10)`: skip leading WS, optional sign, ASCII digits;
/// correctly rounded f64 (JS rounds the mathematical integer the same way).
pub(crate) fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(is_js_space_char);
    let bytes = t.as_bytes();
    let mut i = 0usize;
    let mut negative = false;
    if let Some(&b) = bytes.first() {
        if b == b'+' || b == b'-' { negative = b == b'-'; i = 1; }
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
    if i == start { return None; }
    let mut lit = String::with_capacity(i + 1);
    if negative { lit.push('-'); }
    lit.push_str(&t[start..i]);
    lit.parse::<f64>().ok()
}

/// JS `String(number)` (ECMA-262 `Number::toString`) plus +/-Infinity: shortest
/// round-trip digits via `{:e}` — never the exact binary expansion (2^63 prints
/// "9223372036854776000", not "9223372036854775808"). Same algorithm as
/// crates/mission-core `js_num_str`.
pub(crate) fn js_fmt_number(v: f64) -> String {
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if v == 0.0 { return "0".to_string(); } // covers -0
    let neg = v.is_sign_negative();
    let a = v.abs();
    let e = format!("{a:e}");
    let (mant, exp) = e.split_once('e').unwrap_or((e.as_str(), "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let k = digits.len() as i32;
    let body = if (k..=21).contains(&n) {
        format!("{digits}{}", "0".repeat((n - k).max(0) as usize))
    } else if (1..=21).contains(&n) {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if n > -6 && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n).max(0) as usize))
    } else if k == 1 {
        format!("{digits}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
    } else {
        let (h, t) = (&digits[..1], &digits[1..]);
        format!("{h}.{t}e{}{}", if n >= 1 { "+" } else { "-" }, (n - 1).abs())
    };
    if neg { format!("-{body}") } else { body }
}

/// `validateBounds` — message copied verbatim from cron.ts (en dash U+2013).
fn validate_bounds(value: f64, spec: &FieldSpec) -> Result<(), String> {
    let name = spec.name;
    if !(spec.min as f64..=spec.max as f64).contains(&value) {
        return Err(format!("Value {} out of range [{}–{}] for cron {name} field", js_fmt_number(value), spec.min, spec.max));
    }
    Ok(())
}

fn parse_field(token: &str, spec: &FieldSpec) -> Result<Vec<i64>, String> {
    let name = spec.name;
    let mut values: BTreeSet<i64> = BTreeSet::new();
    for part in token.split(',') {
        let trimmed = js_trim(part);
        if trimmed.is_empty() { return Err(format!("Empty element in cron {name} field")); }
        // Step syntax "X/S": X is "*", a range, or a plain start value.
        if let Some(slash_idx) = trimmed.find('/') {
            let base = &trimmed[..slash_idx];
            let step_str = &trimmed[slash_idx + 1..];
            // TS: isNaN(step) || step <= 0 — NaN comes back as None here.
            let step = match js_parse_int(step_str) {
                Some(s) if s > 0.0 => s,
                _ => return Err(format!("Invalid step \"{step_str}\" in cron {name} field")),
            };
            let (mut range_start, mut range_end) = (spec.min as f64, spec.max as f64);
            if base == "*" {} else if base.contains('-') { // TS keeps only the first two parseInt results
                let mut it = base.split('-');
                let a = js_parse_int(it.next().unwrap_or(""));
                let b = js_parse_int(it.next().unwrap_or(""));
                match (a, b) {
                    (Some(av), Some(bv)) => { range_start = av; range_end = bv; }
                    _ => return Err(format!("Invalid range \"{base}\" in cron {name} field")),
                }
            } else {
                match js_parse_int(base) {
                    Some(start) => range_start = start,
                    None => return Err(format!("Invalid start \"{base}\" in cron {name} field")),
                }
            }
            validate_bounds(range_start, spec)?;
            validate_bounds(range_end, spec)?;
            let mut i = range_start as i64;
            while i <= range_end as i64 { values.insert(i); i = i.saturating_add(step as i64); } // exact: f64 sums are integers here
            continue;
        }
        // Range syntax "N-M" (start > end is an error; no wrap-around).
        if trimmed.contains('-') {
            let mut it = trimmed.split('-');
            let a = js_parse_int(it.next().unwrap_or(""));
            let b = js_parse_int(it.next().unwrap_or(""));
            let (Some(av), Some(bv)) = (a, b)
                else { return Err(format!("Invalid range \"{trimmed}\" in cron {name} field")) };
            validate_bounds(av, spec)?;
            validate_bounds(bv, spec)?;
            if av > bv {
                return Err(format!("Invalid range {}-{} in cron {name} field (start > end)", js_fmt_number(av), js_fmt_number(bv)));
            }
            let mut i = av as i64;
            while i <= bv as i64 { values.insert(i); i += 1; }
            continue;
        }
        if trimmed == "*" { values.extend(spec.min..=spec.max); continue; }
        let Some(val) = js_parse_int(trimmed)
            else { return Err(format!("Invalid value \"{trimmed}\" in cron {name} field")) };
        validate_bounds(val, spec)?;
        values.insert(val as i64);
    }
    if values.is_empty() { return Err(format!("Empty result for cron {name} field")); }
    Ok(values.into_iter().collect())
}

/// `parseCron` — Err carries the exact TS error message.
pub fn parse_cron(expression: &str) -> Result<ParsedCron, String> {
    let trimmed = js_trim(expression);
    if trimmed.is_empty() { return Err("Cron expression must not be empty".to_string()); }
    let tokens: Vec<&str> = trimmed.split(is_js_space_char).filter(|t| !t.is_empty()).collect();
    if tokens.len() != 5 {
        return Err(format!("Cron expression must have exactly 5 fields, got {}: \"{trimmed}\"", tokens.len()));
    }
    Ok(ParsedCron {
        minutes: parse_field(tokens[0], &FIELD_SPECS[0])?,
        hours: parse_field(tokens[1], &FIELD_SPECS[1])?,
        days_of_month: parse_field(tokens[2], &FIELD_SPECS[2])?,
        months: parse_field(tokens[3], &FIELD_SPECS[3])?,
        days_of_week: parse_field(tokens[4], &FIELD_SPECS[4])?,
    })
}

/// `validateCron` — None when valid, Some(message) mirroring the caught error.
pub fn validate_cron(expression: &str) -> Option<String> { parse_cron(expression).err() }

const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 from a civil date (Hinnant; works for any year).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil (year, month 1-12, day 1-31) from days since 1970-01-01.
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Minimal UTC `Date` mirror: epoch ms plus JS's linear setter normalization.
struct JsDate { ms: i64 }

#[rustfmt::skip]
impl JsDate {
    fn new(epoch_ms: f64) -> Self { JsDate { ms: epoch_ms.trunc() as i64 } } // TimeClip truncates
    fn day_number(&self) -> i64 { self.ms.div_euclid(MS_PER_DAY) }
    fn time_of_day(&self) -> i64 { self.ms.rem_euclid(MS_PER_DAY) }
    fn civil(&self) -> (i64, i64, i64) { civil_from_days(self.day_number()) }
    fn get_utc_year(&self) -> i64 { self.civil().0 }
    fn get_utc_month(&self) -> i64 { self.civil().1 - 1 } // JS getUTCMonth is 0-based
    fn get_utc_date(&self) -> i64 { self.civil().2 }
    fn get_utc_day(&self) -> i64 { (self.day_number() + 4).rem_euclid(7) } // 0 = Sunday (1970-01-01 = Thu)
    fn get_utc_hour(&self) -> i64 { self.time_of_day() / 3_600_000 }
    fn get_utc_minutes(&self) -> i64 { (self.time_of_day() % 3_600_000) / 60_000 }
    fn set_utc_seconds_zero(&mut self) { self.ms -= self.ms.rem_euclid(60_000); } // setUTCSeconds(0, 0)
    fn set_utc_minutes(&mut self, m: i64) { // setUTCMinutes(m, 0, 0): keeps hour, zeroes sec/ms
        self.ms = self.day_number() * MS_PER_DAY + (self.get_utc_hour() * 60 + m) * 60_000;
    }
    fn set_utc_hours(&mut self, h: i64) { self.ms = self.day_number() * MS_PER_DAY + h * 3_600_000; } // setUTCHours(h, 0, 0, 0)
    /// setUTCDate(dom) + setUTCHours(0, 0, 0, 0) — the only combo used.
    fn advance_to_day_midnight(&mut self, next_dom: i64) {
        let (y, m, _) = self.civil();
        self.ms = days_from_civil(y, m, next_dom) * MS_PER_DAY;
    }
    /// setUTCFullYear(y, monthIndex, 1) — JS rolls out-of-range months
    /// linearly; keeps time-of-day.
    fn set_utc_year_month_day(&mut self, year: i64, month_index: i64, dom: i64) {
        let total = year * 12 + month_index;
        let (y, m0) = (total.div_euclid(12), total.rem_euclid(12));
        self.ms = days_from_civil(y, m0 + 1, dom) * MS_PER_DAY + self.time_of_day();
    }
}

/// First value strictly greater than `current` in a sorted field set.
#[rustfmt::skip]
fn find_next(sorted: &[i64], current: i64) -> Option<i64> { sorted.iter().find(|&&v| v > current).copied() }

/// `advanceToNextMonth` — walk up to 48 months forward; if none matches, the
/// date stays untouched (TS parity; parsed month sets are non-empty).
fn advance_to_next_month(d: &mut JsDate, months: &[i64]) {
    let mut year = d.get_utc_year();
    let mut month = d.get_utc_month() + 1; // 1-based
    for _ in 0..48 {
        month += 1;
        if month > 12 { month = 1; year += 1; }
        if months.contains(&month) {
            d.set_utc_year_month_day(year, month - 1, 1); // setUTCFullYear(year, month-1, 1)
            d.set_utc_hours(0);
            return;
        }
    }
}

/// `nextCronTick` — strictly-after UTC next run or None at the search cap
/// (4 x 366 x 24 x 60). Non-Vixie: DOM and DOW must BOTH match.
pub fn next_cron_tick(cron: &ParsedCron, after_ms: f64) -> Option<i64> {
    let mut d = JsDate::new(after_ms);
    d.set_utc_seconds_zero();
    let m = d.get_utc_minutes();
    d.set_utc_minutes(m + 1);
    for _ in 0..(4i64 * 366 * 24 * 60) {
        let month = d.get_utc_month() + 1;
        let day_of_month = d.get_utc_date();
        let day_of_week = d.get_utc_day();
        let hour = d.get_utc_hour();
        let minute = d.get_utc_minutes();
        if !cron.months.contains(&month) { advance_to_next_month(&mut d, &cron.months); continue; }
        if !cron.days_of_month.contains(&day_of_month) || !cron.days_of_week.contains(&day_of_week) {
            d.advance_to_day_midnight(d.get_utc_date() + 1);
            continue;
        }
        if !cron.hours.contains(&hour) {
            match find_next(&cron.hours, hour) {
                Some(next_hour) => d.set_utc_hours(next_hour),
                None => d.advance_to_day_midnight(d.get_utc_date() + 1),
            }
            continue;
        }
        if !cron.minutes.contains(&minute) {
            match find_next(&cron.minutes, minute) {
                Some(next_minute) => d.set_utc_minutes(next_minute),
                None => {
                    let h = d.get_utc_hour();
                    d.set_utc_hours(h + 1); // hour 24 normalizes to next day 00:00
                }
            }
            continue;
        }
        return Some(d.ms);
    }
    None
}
