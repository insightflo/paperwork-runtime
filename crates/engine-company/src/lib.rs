#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

mod queries;

pub use queries::*;

macro_rules! closed_enum {
    ($ty:ident, $all:ident, $err:ident; $($variant:ident = $name:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $ty {
            $($variant),+
        }

        const $all: &[$ty] = &[$($ty::$variant),+];

        impl $ty {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $($ty::$variant => $name),+
                }
            }

            pub fn parse(raw: &str) -> Result<Self, CompanyDbError> {
                $all.iter()
                    .copied()
                    .find(|value| value.as_str() == raw)
                    .ok_or_else(|| CompanyDbError::$err(raw.to_string()))
            }
        }
    };
}

closed_enum!(CompanyStatus, ALL_COMPANY_STATUSES, InvalidStatus;
    Active = "active", Paused = "paused", Archived = "archived");
closed_enum!(CompanyKind, ALL_COMPANY_KINDS, InvalidKind;
    Business = "business", Maintenance = "maintenance");
closed_enum!(CompanyDefaultLanguage, ALL_COMPANY_LANGUAGES, InvalidLanguage;
    En = "en", Ko = "ko");

#[derive(Debug)]
pub enum CompanyDbError {
    InvalidStatus(String),
    InvalidKind(String),
    InvalidLanguage(String),
    InvalidName,
    InvalidIssuePrefix,
    NegativeCents,
    NotFound,
    Pg(postgres::Error),
}

impl fmt::Display for CompanyDbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompanyDbError::InvalidStatus(raw) => write!(f, "invalid company status: {raw}"),
            CompanyDbError::InvalidKind(raw) => write!(f, "invalid company kind: {raw}"),
            CompanyDbError::InvalidLanguage(raw) => write!(f, "invalid company default language: {raw}"),
            CompanyDbError::InvalidName => write!(f, "company name must not be empty"),
            CompanyDbError::InvalidIssuePrefix => write!(f, "company issue prefix must not be empty"),
            CompanyDbError::NegativeCents => write!(f, "company cent amounts must not be negative"),
            CompanyDbError::NotFound => write!(f, "company not found"),
            CompanyDbError::Pg(err) => write!(f, "postgres error: {err}"),
        }
    }
}

impl std::error::Error for CompanyDbError {}

impl From<postgres::Error> for CompanyDbError {
    fn from(err: postgres::Error) -> Self {
        CompanyDbError::Pg(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_status_round_trips_and_rejects_junk() {
        for status in ALL_COMPANY_STATUSES {
            let json = serde_json::to_value(status).unwrap();
            assert_eq!(json, serde_json::json!(status.as_str()));
            assert_eq!(serde_json::from_value::<CompanyStatus>(json).unwrap(), *status);
            assert_eq!(CompanyStatus::parse(status.as_str()).unwrap(), *status);
        }
        assert!(matches!(
            CompanyStatus::parse("Active"),
            Err(CompanyDbError::InvalidStatus(raw)) if raw == "Active"
        ));
    }

    #[test]
    fn company_kind_round_trips_and_rejects_junk() {
        for kind in ALL_COMPANY_KINDS {
            let json = serde_json::to_value(kind).unwrap();
            assert_eq!(json, serde_json::json!(kind.as_str()));
            assert_eq!(serde_json::from_value::<CompanyKind>(json).unwrap(), *kind);
            assert_eq!(CompanyKind::parse(kind.as_str()).unwrap(), *kind);
        }
        assert!(matches!(
            CompanyKind::parse("business "),
            Err(CompanyDbError::InvalidKind(raw)) if raw == "business "
        ));
    }

    #[test]
    fn company_language_round_trips_and_rejects_junk() {
        for language in ALL_COMPANY_LANGUAGES {
            let json = serde_json::to_value(language).unwrap();
            assert_eq!(json, serde_json::json!(language.as_str()));
            assert_eq!(
                serde_json::from_value::<CompanyDefaultLanguage>(json).unwrap(),
                *language
            );
            assert_eq!(
                CompanyDefaultLanguage::parse(language.as_str()).unwrap(),
                *language
            );
        }
        assert!(matches!(
            CompanyDefaultLanguage::parse("EN"),
            Err(CompanyDbError::InvalidLanguage(raw)) if raw == "EN"
        ));
    }

    #[test]
    fn error_display_is_stable_for_non_pg_variants() {
        let cases = [
            (CompanyDbError::InvalidStatus("x".to_string()), "invalid company status: x"),
            (CompanyDbError::InvalidKind("x".to_string()), "invalid company kind: x"),
            (CompanyDbError::InvalidLanguage("x".to_string()), "invalid company default language: x"),
            (CompanyDbError::InvalidName, "company name must not be empty"),
            (CompanyDbError::InvalidIssuePrefix, "company issue prefix must not be empty"),
            (CompanyDbError::NegativeCents, "company cent amounts must not be negative"),
            (CompanyDbError::NotFound, "company not found"),
        ];
        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
        }
    }
}
