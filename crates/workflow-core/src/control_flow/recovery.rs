//! edge-condition.ts 의 회복 채널/기계 QA 절 포트 — failed 선행의 연결 실행 이슈 기반 회복 채널
//!   판정과 기계 QA 콘텐츠 반려 서명 화이트리스트. 순수 함수만 제공한다.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

/// 종결 이슈 상태 — 이 상태의 연결 이슈는 회복 채널이 닫혀 있다.
pub const TERMINAL_RECOVERY_ISSUE_STATUSES: [&str; 2] = ["done", "cancelled"];

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryChannel {
    Open,
    Closed,
}

/// failed 선행의 연결 실행 이슈 기반 회복 채널 상태. falsy issueId(빈 문자열 포함) → closed.
///   이슈 상태 미제공은 fail-closed 로 open 취급(TS resolveFailureRecoveryChannel 과 동일).
pub fn resolve_failure_recovery_channel(
    issue_id: Option<&str>,
    issue_status: Option<&str>,
) -> RecoveryChannel {
    if issue_id.is_none_or(str::is_empty) {
        return RecoveryChannel::Closed;
    }
    match issue_status {
        Some(status) if TERMINAL_RECOVERY_ISSUE_STATUSES.contains(&status) => {
            RecoveryChannel::Closed
        }
        _ => RecoveryChannel::Open,
    }
}

/// 기계 QA 콘텐츠 반려 서명 화이트리스트 — 이 패턴만 판정 도출(judgable) 대상.
fn mechanical_qa_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^qa_artifact_(?:verdict_failed|runtime_checks_failed:.+)$").unwrap()
    })
}

/// 마지막 디스패치 실패 요약 — 컬럼 우선, metadata.toolInvocation.dispatchError 보조.
fn read_step_run_error_summary(last: Option<&str>, metadata: Option<&Value>) -> Option<String> {
    if let Some(summary) = last {
        if !summary.is_empty() {
            return Some(summary.to_string());
        }
    }
    metadata?
        .as_object()?
        .get("toolInvocation")?
        .as_object()?
        .get("dispatchError")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 콘텐츠 반려 화이트리스트에 정확히 일치하면 그 서명을, 그 외(infra/알 수 없음)는 None.
pub fn mechanical_qa_rejection_summary(
    last_dispatch_error_summary: Option<&str>,
    metadata: Option<&Value>,
) -> Option<String> {
    read_step_run_error_summary(last_dispatch_error_summary, metadata)
        .filter(|summary| mechanical_qa_pattern().is_match(summary))
}
