#![forbid(unsafe_code)]

pub mod anomaly;
mod queries;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

pub use queries::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingType {
    MeteredApi,
    SubscriptionIncluded,
    SubscriptionOverage,
    Credits,
    Fixed,
    Unknown,
}

const ALL_BILLING_TYPES: [BillingType; 6] = [
    BillingType::MeteredApi,
    BillingType::SubscriptionIncluded,
    BillingType::SubscriptionOverage,
    BillingType::Credits,
    BillingType::Fixed,
    BillingType::Unknown,
];

const BILLING_TYPE_NAMES: [&str; 6] = [
    "metered_api",
    "subscription_included",
    "subscription_overage",
    "credits",
    "fixed",
    "unknown",
];

impl BillingType {
    pub fn as_str(&self) -> &'static str {
        BILLING_TYPE_NAMES[*self as usize]
    }

    pub fn parse(raw: &str) -> Result<BillingType, CostDbError> {
        ALL_BILLING_TYPES
            .into_iter()
            .find(|t| t.as_str() == raw)
            .ok_or_else(|| CostDbError::InvalidBillingType(raw.to_string()))
    }
}

#[derive(Debug)]
pub enum CostDbError {
    InvalidAmount { field: &'static str, value: i64 },
    InvalidWindow { window_start: DateTime<Utc>, window_end: DateTime<Utc> },
    InvalidBillingType(String),
    EmptyField(&'static str),
    CrossCompanyReference,
    UndecodableRow { column: String, detail: String },
    Db(postgres::Error),
}

impl fmt::Display for CostDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CostDbError::InvalidAmount { field, value } => {
                write!(f, "invalid amount {field}: {value}")
            }
            CostDbError::InvalidWindow { window_start, window_end } => {
                write!(f, "invalid window: {window_start} .. {window_end}")
            }
            CostDbError::InvalidBillingType(raw) => write!(f, "invalid billing type: {raw}"),
            CostDbError::EmptyField(field) => write!(f, "empty {field}"),
            CostDbError::CrossCompanyReference => write!(f, "cross-company reference rejected"),
            CostDbError::UndecodableRow { column, detail } => {
                write!(f, "undecodable row column {column}: {detail}")
            }
            CostDbError::Db(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for CostDbError {}

impl From<postgres::Error> for CostDbError {
    fn from(err: postgres::Error) -> Self {
        CostDbError::Db(err)
    }
}

pub fn validate_cost_cents(value: i64) -> Result<i32, CostDbError> {
    i32::try_from(value)
        .ok()
        .filter(|v| *v >= 0)
        .ok_or(CostDbError::InvalidAmount { field: "cost_cents", value })
}

pub fn validate_cost_window(
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<(), CostDbError> {
    if let (Some(window_start), Some(window_end)) = (from, to) {
        if window_end < window_start {
            return Err(CostDbError::InvalidWindow { window_start, window_end });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).unwrap()
    }

    #[test]
    fn billing_type_parse_and_serde_roundtrip() {
        for ty in ALL_BILLING_TYPES {
            let json = serde_json::to_value(ty).unwrap();
            assert_eq!(json, serde_json::json!(ty.as_str()));
            assert_eq!(serde_json::from_value::<BillingType>(json).unwrap(), ty);
            assert_eq!(BillingType::parse(ty.as_str()).unwrap(), ty);
        }
        for raw in ["bogus", "METERED_API", "", "metered-api"] {
            assert!(matches!(
                BillingType::parse(raw),
                Err(CostDbError::InvalidBillingType(got)) if got == raw
            ));
            assert!(serde_json::from_value::<BillingType>(serde_json::json!(raw)).is_err());
        }
    }

    #[test]
    fn cost_cents_bounds() {
        assert_eq!(validate_cost_cents(0).unwrap(), 0);
        assert_eq!(validate_cost_cents(i32::MAX as i64).unwrap(), i32::MAX);
        for bad in [-1_i64, i32::MAX as i64 + 1, i64::MAX, i64::MIN] {
            assert!(matches!(
                validate_cost_cents(bad),
                Err(CostDbError::InvalidAmount { field: "cost_cents", value }) if value == bad
            ));
        }
    }

    #[test]
    fn window_validation_matrix() {
        let (a, b) = (ts(1_000), ts(2_000));
        assert!(validate_cost_window(None, None).is_ok());
        assert!(validate_cost_window(Some(a), None).is_ok());
        assert!(validate_cost_window(None, Some(b)).is_ok());
        assert!(validate_cost_window(Some(a), Some(a)).is_ok());
        assert!(validate_cost_window(Some(a), Some(b)).is_ok());
        assert!(matches!(
            validate_cost_window(Some(b), Some(a)),
            Err(CostDbError::InvalidWindow { window_start, window_end })
                if window_start == b && window_end == a
        ));
    }

    #[test]
    fn error_display_and_matching() {
        let e = CostDbError::InvalidAmount { field: "cost_cents", value: -3 };
        assert!(e.to_string().contains("cost_cents"));
        assert!(e.to_string().contains("-3"));
        assert!(CostDbError::InvalidBillingType("x".to_string()).to_string().contains('x'));
        assert!(CostDbError::EmptyField("provider").to_string().contains("provider"));
        assert!(CostDbError::CrossCompanyReference.to_string().contains("cross-company"));
        assert!(CostDbError::UndecodableRow {
            column: "billing_type".to_string(),
            detail: "bad".to_string(),
        }
        .to_string()
        .contains("billing_type"));
        let w = CostDbError::InvalidWindow { window_start: ts(2), window_end: ts(1) };
        assert!(w.to_string().contains("invalid window"));
        let _: &dyn std::error::Error = &e;
    }

    #[test]
    fn postgres_error_converts_into_db_variant() {
        let pg_err = postgres::Client::connect("bogus", postgres::NoTls).err().unwrap();
        let converted = CostDbError::from(pg_err);
        assert!(matches!(converted, CostDbError::Db(_)));
        assert!(converted.to_string().starts_with("postgres error"));
    }
}
