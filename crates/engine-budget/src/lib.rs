#![forbid(unsafe_code)]

mod queries;

use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetScopeType { Company, Agent, Project }

const ALL_SCOPE_TYPES: [BudgetScopeType; 3] =
    [BudgetScopeType::Company, BudgetScopeType::Agent, BudgetScopeType::Project];
const SCOPE_TYPE_NAMES: [&str; 3] = ["company", "agent", "project"];

impl BudgetScopeType {
    pub fn as_str(&self) -> &'static str { SCOPE_TYPE_NAMES[*self as usize] }
    pub fn parse(raw: &str) -> Option<BudgetScopeType> {
        ALL_SCOPE_TYPES.into_iter().find(|s| s.as_str() == raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetWindowKind { CalendarMonthUtc, Lifetime }

const ALL_WINDOW_KINDS: [BudgetWindowKind; 2] =
    [BudgetWindowKind::CalendarMonthUtc, BudgetWindowKind::Lifetime];
const WINDOW_KIND_NAMES: [&str; 2] = ["calendar_month_utc", "lifetime"];

impl BudgetWindowKind {
    pub fn as_str(&self) -> &'static str { WINDOW_KIND_NAMES[*self as usize] }
    pub fn parse(raw: &str) -> Option<BudgetWindowKind> {
        ALL_WINDOW_KINDS.into_iter().find(|s| s.as_str() == raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetThresholdType { Soft, Hard }

const ALL_THRESHOLD_TYPES: [BudgetThresholdType; 2] =
    [BudgetThresholdType::Soft, BudgetThresholdType::Hard];
const THRESHOLD_TYPE_NAMES: [&str; 2] = ["soft", "hard"];

impl BudgetThresholdType {
    pub fn as_str(&self) -> &'static str { THRESHOLD_TYPE_NAMES[*self as usize] }
    pub fn parse(raw: &str) -> Option<BudgetThresholdType> {
        ALL_THRESHOLD_TYPES.into_iter().find(|s| s.as_str() == raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetIncidentStatus { Open, Resolved, Dismissed }

const ALL_INCIDENT_STATUSES: [BudgetIncidentStatus; 3] = [
    BudgetIncidentStatus::Open, BudgetIncidentStatus::Resolved, BudgetIncidentStatus::Dismissed,
];
const INCIDENT_STATUS_NAMES: [&str; 3] = ["open", "resolved", "dismissed"];

impl BudgetIncidentStatus {
    pub fn as_str(&self) -> &'static str { INCIDENT_STATUS_NAMES[*self as usize] }
    pub fn parse(raw: &str) -> Option<BudgetIncidentStatus> {
        ALL_INCIDENT_STATUSES.into_iter().find(|s| s.as_str() == raw)
    }
}

#[derive(Debug)]
pub enum BudgetDbError {
    InvalidAmount { field: &'static str, value: i64 },
    InvalidWarnPercent { warn_percent: i32 },
    InvalidWindow { window_start: DateTime<Utc>, window_end: DateTime<Utc> },
    InvalidTransition { from: BudgetIncidentStatus, to: BudgetIncidentStatus },
    InvalidScope { scope_type: BudgetScopeType, scope_id: Uuid, company_id: Uuid },
    Db(postgres::Error),
}

impl fmt::Display for BudgetDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAmount { field, value } => write!(f, "invalid amount {field}: {value}"),
            Self::InvalidWarnPercent { warn_percent } => {
                write!(f, "invalid warn percent: {warn_percent}")
            }
            Self::InvalidWindow { window_start, window_end } => {
                write!(f, "invalid window: {window_start} .. {window_end}")
            }
            Self::InvalidTransition { from, to } => write!(
                f,
                "invalid incident transition: {} -> {}",
                from.as_str(),
                to.as_str()
            ),
            Self::InvalidScope { scope_type, scope_id, company_id } => write!(
                f,
                "invalid scope: {} {scope_id} is not company {company_id}",
                scope_type.as_str()
            ),
            Self::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for BudgetDbError {}

impl From<postgres::Error> for BudgetDbError {
    fn from(err: postgres::Error) -> Self {
        BudgetDbError::Db(err)
    }
}

pub fn utc_month_window(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let (year, month) = (now.year(), now.month());
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let start = Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).unwrap();
    let end = Utc.with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0).unwrap();
    (start, end)
}

pub fn evaluate_threshold(
    limit_cents: i64,
    observed_cents: i64,
    warn_percent: i32,
    hard_stop_enabled: bool,
) -> Option<BudgetThresholdType> {
    if hard_stop_enabled && limit_cents > 0 && observed_cents >= limit_cents {
        return Some(BudgetThresholdType::Hard);
    }
    if limit_cents > 0
        && warn_percent > 0
        && i128::from(observed_cents) * 100 >= i128::from(limit_cents) * i128::from(warn_percent)
    {
        return Some(BudgetThresholdType::Soft);
    }
    None
}

pub fn validate_warn_percent(warn_percent: i32) -> Result<(), BudgetDbError> {
    if (1..=99).contains(&warn_percent) {
        Ok(())
    } else {
        Err(BudgetDbError::InvalidWarnPercent { warn_percent })
    }
}

pub fn validate_incident_transition(
    from: BudgetIncidentStatus,
    to: BudgetIncidentStatus,
) -> Result<(), BudgetDbError> {
    if matches!(
        (from, to),
        (BudgetIncidentStatus::Open, BudgetIncidentStatus::Resolved)
            | (BudgetIncidentStatus::Open, BudgetIncidentStatus::Dismissed)
    ) {
        Ok(())
    } else {
        Err(BudgetDbError::InvalidTransition { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::BudgetIncidentStatus::*;
    use super::*;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
    }

    #[test]
    fn utc_month_window_rolls_and_bounds() {
        let (start, end) = utc_month_window(utc(2026, 12, 20, 15, 30));
        assert_eq!((start, end), (utc(2026, 12, 1, 0, 0), utc(2027, 1, 1, 0, 0)));
        let (start, end) = utc_month_window(utc(2026, 11, 1, 0, 0));
        assert_eq!((start, end), (utc(2026, 11, 1, 0, 0), utc(2026, 12, 1, 0, 0)));
        let (start, end) = utc_month_window(utc(2026, 1, 31, 23, 59));
        assert_eq!((start, end), (utc(2026, 1, 1, 0, 0), utc(2026, 2, 1, 0, 0)));
    }

    #[test]
    fn evaluate_threshold_boundaries_and_guards() {
        use BudgetThresholdType::*;
        assert_eq!(evaluate_threshold(1000, 999, 80, true), Some(Soft));
        assert_eq!(evaluate_threshold(1000, 800, 80, true), Some(Soft));
        assert_eq!(evaluate_threshold(1000, 799, 80, true), None);
        assert_eq!(evaluate_threshold(1000, 1000, 80, true), Some(Hard));
        assert_eq!(evaluate_threshold(1000, 1200, 0, true), Some(Hard));
        assert_eq!(evaluate_threshold(1000, 1000, 50, false), Some(Soft));
        assert_eq!(evaluate_threshold(0, i64::MAX, 80, true), None);
        assert_eq!(evaluate_threshold(-5, i64::MAX, 80, true), None);
        assert_eq!(evaluate_threshold(1000, 1000, 0, false), None);
        assert_eq!(evaluate_threshold(1000, -10, 80, true), None);
    }

    #[test]
    fn evaluate_threshold_uses_wide_math() {
        use BudgetThresholdType::*;
        assert_eq!(evaluate_threshold(i64::MAX, i64::MAX, 100, false), Some(Soft));
        assert_eq!(evaluate_threshold(i64::MAX, i64::MAX - 1, 100, false), None);
        assert_eq!(evaluate_threshold(i64::MAX, i64::MAX, 100, true), Some(Hard));
        assert_eq!(evaluate_threshold(i64::MAX, i64::MAX / 2 + 1, 50, false), Some(Soft));
        assert_eq!(evaluate_threshold(i64::MAX, i64::MAX / 2, 50, false), None);
    }

    #[test]
    fn incident_transition_matrix() {
        const LEGAL: &[(BudgetIncidentStatus, BudgetIncidentStatus)] =
            &[(Open, Resolved), (Open, Dismissed)];
        for from in ALL_INCIDENT_STATUSES {
            for to in ALL_INCIDENT_STATUSES {
                assert_eq!(
                    validate_incident_transition(from, to).is_ok(),
                    LEGAL.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn warn_percent_bounds() {
        assert!(validate_warn_percent(1).is_ok() && validate_warn_percent(99).is_ok());
        for bad in [0, 100, -1, 200] {
            assert!(matches!(
                validate_warn_percent(bad),
                Err(BudgetDbError::InvalidWarnPercent { warn_percent }) if warn_percent == bad
            ));
        }
    }

    #[test]
    fn enums_serde_and_parse_roundtrip() {
        macro_rules! roundtrip {
            ($all:expr, $ty:ty) => {
                for v in $all {
                    let json = serde_json::to_value(v).unwrap();
                    assert_eq!(json, serde_json::json!(v.as_str()));
                    assert_eq!(serde_json::from_value::<$ty>(json).unwrap(), v);
                    assert_eq!(<$ty>::parse(v.as_str()), Some(v));
                }
            };
        }
        roundtrip!(ALL_SCOPE_TYPES, BudgetScopeType);
        roundtrip!(ALL_WINDOW_KINDS, BudgetWindowKind);
        roundtrip!(ALL_THRESHOLD_TYPES, BudgetThresholdType);
        roundtrip!(ALL_INCIDENT_STATUSES, BudgetIncidentStatus);
        assert_eq!(BudgetScopeType::parse("tenant"), None);
        assert_eq!(BudgetIncidentStatus::parse("closed"), None);
    }
    #[test]
    fn sql_reads_are_parameterized_and_company_scoped() {
        assert!(SQL_INSERT_COST_EVENT.starts_with("INSERT INTO cost_events"));
        assert!(SQL_INSERT_COST_EVENT.contains("company_id"));
        assert!(SQL_INSERT_COST_EVENT.contains("$16"));
        assert!(SQL_INSERT_COST_EVENT.contains("RETURNING id, company_id"));
        for sql in [
            SQL_SUM_SCOPE_SPEND_COMPANY,
            SQL_SUM_SCOPE_SPEND_AGENT,
            SQL_SUM_SCOPE_SPEND_PROJECT,
        ] {
            assert!(sql.contains("FROM cost_events"));
            assert!(sql.contains("company_id = $1"));
            assert!(sql.contains("COALESCE(SUM(cost_cents), 0)::bigint"));
            assert!(sql.contains("occurred_at >= $"));
            assert!(sql.contains("occurred_at < $"));
        }
        assert!(SQL_SUM_SCOPE_SPEND_AGENT.contains("agent_id = $2"));
        assert!(SQL_SUM_SCOPE_SPEND_PROJECT.contains("project_id = $2"));
        assert!(!SQL_SUM_SCOPE_SPEND_COMPANY.contains("agent_id"));
        assert!(!SQL_SUM_SCOPE_SPEND_COMPANY.contains("project_id"));
        assert!(SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE.contains("FROM budget_policies"));
        assert!(SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE
            .contains("company_id = $1 AND scope_type = $2 AND scope_id = $3"));
        assert!(SQL_LIST_ACTIVE_POLICIES_FOR_SCOPE.contains("is_active = true"));
    }

    #[test]
    fn sql_incident_writes_are_fenced() {
        assert!(SQL_UPSERT_OPEN_INCIDENT.starts_with("INSERT INTO budget_incidents"));
        assert!(SQL_UPSERT_OPEN_INCIDENT.contains("'open'"));
        assert!(SQL_UPSERT_OPEN_INCIDENT.contains(
            "ON CONFLICT (policy_id, window_start, threshold_type) WHERE status <> 'dismissed'"
        ));
        assert!(SQL_UPSERT_OPEN_INCIDENT.contains("amount_observed = EXCLUDED.amount_observed"));
        assert!(SQL_UPSERT_OPEN_INCIDENT.contains("updated_at = now()"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("UPDATE budget_incidents"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("status = $3"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("resolved_at = now()"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED
            .contains("id = $1 AND company_id = $2 AND status = 'open'"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("RETURNING"));
    }
}
