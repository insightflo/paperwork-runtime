#![forbid(unsafe_code)]

mod queries;

use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub use queries::*;

macro_rules! str_enum {
    ($ty:ident, $all:ident; $($variant:ident = $name:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $ty { $($variant),+ }
        const $all: &[$ty] = &[$($ty::$variant),+];
        impl $ty {
            pub fn as_str(&self) -> &'static str {
                match self { $($ty::$variant => $name),+ }
            }
            pub fn parse(raw: &str) -> Option<$ty> {
                $all.iter().copied().find(|s| s.as_str() == raw)
            }
        }
    };
}

str_enum!(BudgetScopeType, ALL_SCOPE_TYPES;
    Company = "company", Agent = "agent", Project = "project");
str_enum!(BudgetWindowKind, ALL_WINDOW_KINDS;
    CalendarMonthUtc = "calendar_month_utc", Lifetime = "lifetime");
str_enum!(BudgetThresholdType, ALL_THRESHOLD_TYPES;
    Soft = "soft", Hard = "hard");
str_enum!(BudgetIncidentStatus, ALL_INCIDENT_STATUSES;
    Open = "open", Resolved = "resolved", Dismissed = "dismissed");

#[derive(Debug)]
pub enum BudgetDbError {
    InvalidAmount { field: &'static str, value: i64 },
    InvalidWarnPercent { warn_percent: i32 },
    InvalidWindow { window_start: DateTime<Utc>, window_end: DateTime<Utc> },
    InvalidTransition { from: BudgetIncidentStatus, to: BudgetIncidentStatus },
    InvalidScope { scope_type: BudgetScopeType, scope_id: Uuid, company_id: Uuid },
    CrossCompanyReference,
    CrossCompanyOrClosedIncident,
    Db(postgres::Error),
}

impl fmt::Display for BudgetDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAmount { field, value } => write!(f, "invalid amount {field}: {value}"),
            Self::InvalidWarnPercent { warn_percent } => write!(f, "invalid warn percent: {warn_percent}"),
            Self::InvalidWindow { window_start, window_end } => write!(f, "invalid window: {window_start} .. {window_end}"),
            Self::InvalidTransition { from, to } => write!(f, "invalid incident transition: {} -> {}", from.as_str(), to.as_str()),
            Self::InvalidScope { scope_type, scope_id, company_id } => write!(f, "invalid scope: {} {scope_id} is not company {company_id}", scope_type.as_str()),
            Self::CrossCompanyReference => write!(f, "cross-company reference rejected"),
            Self::CrossCompanyOrClosedIncident => write!(f, "policy not company-owned or incident not open"),
            Self::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for BudgetDbError {}

impl From<postgres::Error> for BudgetDbError {
    fn from(err: postgres::Error) -> Self { BudgetDbError::Db(err) }
}

pub fn utc_month_window(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let (y, m) = (now.year(), now.month());
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0).unwrap(), Utc.with_ymd_and_hms(ny, nm, 1, 0, 0, 0).unwrap())
}

pub fn evaluate_threshold(limit_cents: i64, observed_cents: i64, warn_percent: i32, hard_stop_enabled: bool) -> Option<BudgetThresholdType> {
    if hard_stop_enabled && limit_cents > 0 && observed_cents >= limit_cents {
        return Some(BudgetThresholdType::Hard);
    }
    if limit_cents > 0 && warn_percent > 0 && i128::from(observed_cents) * 100 >= i128::from(limit_cents) * i128::from(warn_percent) {
        return Some(BudgetThresholdType::Soft);
    }
    None
}

pub fn validate_warn_percent(warn_percent: i32) -> Result<(), BudgetDbError> {
    if (1..=99).contains(&warn_percent) { Ok(()) } else { Err(BudgetDbError::InvalidWarnPercent { warn_percent }) }
}

pub fn validate_incident_transition(from: BudgetIncidentStatus, to: BudgetIncidentStatus) -> Result<(), BudgetDbError> {
    use BudgetIncidentStatus::*;
    if matches!((from, to), (Open, Resolved) | (Open, Dismissed)) {
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
        for &from in ALL_INCIDENT_STATUSES {
            for &to in ALL_INCIDENT_STATUSES {
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
                for &v in $all {
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
        assert!(SQL_INSERT_COST_EVENT.contains(
            "WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = $2 AND a.company_id = $1)"
        ));
        for (param, table) in [("$3", "issues"), ("$4", "projects"), ("$5", "goals"), ("$6", "heartbeat_runs")] {
            let guard = format!("{param}::uuid IS NULL OR EXISTS (SELECT 1 FROM {table} t WHERE t.id = {param} AND t.company_id = $1)");
            assert!(SQL_INSERT_COST_EVENT.contains(&guard), "{guard}");
        }
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
        for frag in ["FROM budget_policies p", "p.id = $2", "p.company_id = $1", "p.scope_type = $3",
            "p.scope_id = $4", "p.metric = $5", "p.window_kind = $6",
            "FROM approvals a WHERE a.id = $12 AND a.company_id = $1"] {
            assert!(SQL_UPSERT_OPEN_INCIDENT.contains(frag), "{frag}");
        }
        assert!(SQL_UPSERT_OPEN_INCIDENT.contains(
            "WHERE budget_incidents.company_id = EXCLUDED.company_id AND budget_incidents.status = 'open'"
        ));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("UPDATE budget_incidents"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("status = $3"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("resolved_at = now()"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED
            .contains("id = $1 AND company_id = $2 AND status = 'open'"));
        assert!(SQL_RESOLVE_INCIDENT_FENCED.contains("RETURNING"));
    }

    #[test]
    #[ignore = "requires PAPERWORK_TEST_DATABASE_URL"]
    fn pg_company_ownership_is_enforced() {
        let url = std::env::var("PAPERWORK_TEST_DATABASE_URL").unwrap();
        let mut client = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        let mut tx = client.transaction().unwrap();
        let (c1, c2, a1, a2, i2, p1, p2, ap2) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        tx.execute("INSERT INTO companies (id, name, issue_prefix) VALUES ($1,$2,$3)", &[&c1, &"c1", &"T1"]).unwrap();
        tx.execute("INSERT INTO companies (id, name, issue_prefix) VALUES ($1,$2,$3)", &[&c2, &"c2", &"T2"]).unwrap();
        tx.execute("INSERT INTO agents (id, company_id, name) VALUES ($1,$2,$3)", &[&a1, &c1, &"a1"]).unwrap();
        tx.execute("INSERT INTO agents (id, company_id, name) VALUES ($1,$2,$3)", &[&a2, &c2, &"a2"]).unwrap();
        tx.execute("INSERT INTO issues (id, company_id, title) VALUES ($1,$2,$3)", &[&i2, &c2, &"i2"]).unwrap();
        tx.execute("INSERT INTO approvals (id, company_id, type, payload) VALUES ($1,$2,$3,$4)", &[&ap2, &c2, &"budget_override", &serde_json::json!({})]).unwrap();
        let pol = "INSERT INTO budget_policies (id, company_id, scope_type, scope_id, metric, window_kind) VALUES ($1,$2,$3,$4,$5,$6)";
        tx.execute(pol, &[&p1, &c1, &"company", &c1, &"billed_cents", &"lifetime"]).unwrap();
        tx.execute(pol, &[&p2, &c2, &"company", &c2, &"billed_cents", &"lifetime"]).unwrap();
        let now = Utc::now();
        let event = |agent: Uuid, issue: Option<Uuid>| RecordCostEventInput {
            company_id: c1, agent_id: agent, issue_id: issue, project_id: None, goal_id: None,
            heartbeat_run_id: None, billing_code: None, provider: "openai".into(), biller: None,
            billing_type: None, model: "m".into(), input_tokens: 1, cached_input_tokens: 0,
            output_tokens: 1, cost_cents: 5, occurred_at: now,
        };
        let incident = |policy: Uuid| UpsertIncidentInput {
            company_id: c1, policy_id: policy, scope_type: BudgetScopeType::Company, scope_id: c1,
            metric: "billed_cents".into(), window_kind: BudgetWindowKind::Lifetime,
            window_start: now, window_end: now + chrono::Duration::days(1),
            threshold_type: BudgetThresholdType::Hard, amount_limit: 100, amount_observed: 150,
            approval_id: None,
        };
        use BudgetDbError::*;
        for e in [event(a2, None), event(a1, Some(i2))] {
            assert!(matches!(record_cost_event(&mut tx, &e), Err(CrossCompanyReference)));
        }
        assert!(record_cost_event(&mut tx, &event(a1, None)).is_ok());
        assert!(matches!(upsert_open_incident_fenced(&mut tx, &incident(p2)), Err(CrossCompanyOrClosedIncident)));
        for bad in [
            UpsertIncidentInput { scope_id: c2, ..incident(p1) },
            UpsertIncidentInput { metric: "other".into(), ..incident(p1) },
            UpsertIncidentInput { approval_id: Some(ap2), ..incident(p1) },
        ] {
            assert!(matches!(upsert_open_incident_fenced(&mut tx, &bad), Err(CrossCompanyOrClosedIncident)));
        }
        let row = upsert_open_incident_fenced(&mut tx, &incident(p1)).unwrap();
        assert!(upsert_open_incident_fenced(&mut tx, &incident(p1)).is_ok());
        assert!(resolve_incident_fenced(&mut tx, row.id, c1, Resolved).unwrap().is_some());
        assert!(matches!(upsert_open_incident_fenced(&mut tx, &incident(p1)), Err(CrossCompanyOrClosedIncident)));
        let kept = tx.query_one("SELECT status, amount_observed FROM budget_incidents WHERE id = $1 AND company_id = $2", &[&row.id, &c1]).unwrap();
        assert_eq!((kept.get::<_, String>(0).as_str(), kept.get::<_, i32>(1)), ("resolved", 150));
    }
}
