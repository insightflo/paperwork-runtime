function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateBriefLine(value: string, max = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

/**
 * [validation recheck — #10 goalpost moving] 재검수(recheck) 웨이크가 전달하는 직전
 * REQUEST_CHANGES findings(머신 계약: wake/contextSnapshot priorQaFindings)를 런타임
 * 브리프에 최우선 블록으로 렌더링한다. priorQaFindings가 없는 일반 실행에는 아무것도
 * 추가하지 않는다. 코멘트·stdout은 실행 권한이 아니므로 이 계약은 구조화된 wake
 * 컨텍스트 키만 읽는다.
 */
export function buildQaRecheckFindingsBriefLines(value: unknown): readonly string[] {
  const findings = Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const usable = findings
    .map((finding) => ({
      id: asString(finding.id),
      summary: asString(finding.summary),
      layer: asString(finding.layer),
    }))
    .filter((finding) => finding.id !== null || finding.summary !== null);
  if (usable.length === 0) return [];
  return [
    "=== VALIDATION RECHECK (prior REQUEST_CHANGES findings — verify these FIRST) ===",
    ...usable.slice(0, 8).map((finding) =>
      `- [${finding.layer ?? "unknown"}] ${finding.id ?? "unknown-finding"}: ${truncateBriefLine(finding.summary ?? "(no summary)")}`),
    RECHECK_JUDGMENT_PRINCIPLE,
    "- Verify each finding above against the current producer output before the full checklist; state resolved/unresolved per finding in the official verdict findings payload.",
    "=== end validation recheck ===",
  ];
}

/** Verbatim recheck-judgment principle mandated by the 2026-11-28 QA rework contract. */
export const RECHECK_JUDGMENT_PRINCIPLE =
  "재검수(recheck) 판정 원칙: 직전 회차 findings 해소 여부와 회귀(regression) 여부 중심으로 판정하고, 기존 범위 밖 새 기준으로 골대를 이동하지 마세요.";
