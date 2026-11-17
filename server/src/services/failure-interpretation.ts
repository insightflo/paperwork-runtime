// server/src/services/failure-interpretation.ts
// [원인 해석 레지스트리 2026-11-17 — 운영자 방침: "패턴이 한두가지가 아니다 — 쉬운 해석이 그래서 있는 것"]
// 미션 오너의 reason/evidence에 실리는 도구 오류 원문을 사람 카드 '쉬운 해석'의 원인 문장으로
// 번역하는 순서가 있는 패턴 레지스트리다. 첫 매치가 승리하며, 어느 패턴에도 걸리지 않으면
// null 을 반환해 기존 진행 안내 문장만 나가게 한다. 전부 순수 함수 — 부수효과 없음.

/** scrapling 계열 원격 도구의 구조화 대상실패 진단({"targetStatus":<n>,"url":"…"})에서
 *  상태 코드를 꺼낸다. 텍스트 전체가 JSON인 경우와, 산문 안에 진단 JSON 조각이 포함된
 *  경우(예: `… returned status 424: {"targetStatus":502,"url":"…"}`)를 모두 인식한다. */
function readStructuredTargetFailure(text: string): { targetStatus: number; url: string } | null {
  const extract = (record: Record<string, unknown>) => {
    const targetStatus = record.targetStatus;
    const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : null;
    return typeof targetStatus === "number" && Number.isFinite(targetStatus) && url !== null
      ? { targetStatus, url }
      : null;
  };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const found = extract(parsed as Record<string, unknown>);
      if (found) return found;
    }
  } catch { /* 산문 속 JSON 조각은 아래 정규식 경로로 */ }
  const status = /"targetStatus"\s*:\s*(\d{3})\b/.exec(text);
  const url = /"url"\s*:\s*"([^"\\]*)"/.exec(text);
  return status && url ? { targetStatus: Number(status[1]), url: url[1]! } : null;
}

/** 구조화 대상실패의 targetStatus → 한국어 원인 문장. #757(http-tool-response.ts)에서
 *  이동한 단일 매핑 — 도구 응답 프리픽스와 카드 원인 해석이 같은 문구를 공유한다.
 *  해석 계열이 없는 상태 코드(2xx 등)에는 null. */
export function interpretTargetFailureStatusSentence(targetStatus: number): string | null {
  if (targetStatus === 404) {
    return "수집 대상 주소는 없는 페이지입니다(404). 재시작으로는 해결되지 않습니다 — 입력 주소를 확인·수정한 뒤 다시 시도하세요.";
  }
  if (targetStatus === 403) {
    return "대상 사이트가 접근을 거부했습니다(403). 차단 또는 로그인 필요 여부를 확인하세요.";
  }
  if (targetStatus >= 500 && targetStatus < 600) {
    return `대상 사이트 자체 오류(${targetStatus})입니다. 잠시 후 재시도를 고려하세요.`;
  }
  if (targetStatus >= 400 && targetStatus < 500) {
    return `대상 사이트가 ${targetStatus}를 반환했습니다. 주소·요청 조건을 확인하세요.`;
  }
  return null;
}

type FailureCauseRule = {
  readonly name: string;
  readonly match: (text: string) => string | null;
};

const byPattern = (pattern: RegExp, sentence: string) => (text: string) =>
  pattern.test(text) ? sentence : null;

/** 순서가 있는 원인 해석 레지스트리 — 위에서 첫 매치가 승리한다.
 *  새 패턴 계열은 배열 끝(폴백 직전)에 추가한다. */
export const FAILURE_CAUSE_REGISTRY: readonly FailureCauseRule[] = [
  // 1. 구조화 대상실패(JSON에 targetStatus+url) — 상태 코드별 단일 문장 매핑.
  { name: "structured-target-failure", match: (text) => {
    const target = readStructuredTargetFailure(text);
    return target ? interpretTargetFailureStatusSentence(target.targetStatus) : null;
  } },
  // 2. 타임아웃 계열 — 일시적 느림·장애 가능성을 함께 안내.
  { name: "timeout", match: byPattern(
    /deadline exceeded|ETIMEDOUT|timed?[- ]?out|timeout/i,
    "대상이 시간 내에 응답하지 못했습니다(시간 초과) — 일시적인 느림이나 장애일 수 있으니 잠시 후 재시도를 고려하세요.") },
  // 3. 연결·DNS 계열 — 상대 서비스 자체 상태 확인 안내.
  { name: "connection-dns", match: byPattern(
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection (refused|reset)|network error/i,
    "대상 서비스에 연결하지 못했습니다(네트워크/DNS 문제) — 상대 서비스 상태를 확인하세요.") },
  // 4. 게이트웨이·중계 5xx — 원인이 가려질 수 있는 중계 구간 오류로 해석.
  { name: "gateway-5xx", match: byPattern(
    /bad gateway|origin_bad_gateway|error 50[234]|invalid or incomplete response|service unavailable/i,
    "중계 구간(게이트웨이) 오류입니다 — 뒷단 서비스의 일시 장애일 수 있고, 원인이 가려질 수 있으니 서비스 상태를 확인하세요.") },
  // 5. 권한·거부 계열 — 자격증명·권한 설정 확인 안내(구조화 매치가 먼저 승리).
  { name: "auth-denied", match: byPattern(
    /unauthorized|forbidden|status 40[13]\b/i,
    "권한이 없거나 접근이 거부되었습니다 — 자격증명·권한 설정을 확인하세요.") },
  // 6. 비구조화 404 문자열(영어 + 한국어 요약) — 1번과 동일한 404 문장.
  { name: "unstructured-404", match: byPattern(
    /status 404|HTTP 404|404\s*(?:차단|오류|에러|응답|없는 페이지)|없는\s*페이지입니다\s*\(404\)/i,
    interpretTargetFailureStatusSentence(404)!) },
  // 7. 한국어 403 차단 산문 — 자격증명 지적(auth-denied)이 아닌 대상 거부 문장이 정확한 한국어 요약 전용.
  { name: "korean-target-403", match: byPattern(
    /403\s*(?:차단|거부|오류|에러|응답)|403으로\s*접근\s*불가|접근을\s*거부했습니다\s*\(403\)/i,
    interpretTargetFailureStatusSentence(403)!) },
  // 8. 응답 형식·구조 계열 — 페이지 구조·계약 변경 가능성 안내.
  { name: "contract-shape", match: byPattern(
    /selector matched no elements|contract violated|non-JSON|missing required fields/i,
    "응답 내용이 예상 형식과 다릅니다 — 페이지 구조나 계약이 바뀌었을 수 있으니 확인하세요.") },
];

/** 증상·reason·evidence 텍스트에서 첫 매치 패턴의 한국어 원인 문장을 만든다.
 *  어느 패턴에도 걸리지 않으면 null — 호출부는 기존 안내만 내보낸다. */
export function interpretFailureCause(text: string): string | null {
  if (!text || !text.trim()) return null;
  for (const rule of FAILURE_CAUSE_REGISTRY) {
    const sentence = rule.match(text);
    if (sentence !== null) return sentence;
  }
  return null;
}

/** 카드 빌더 공용 헬퍼 — spec 의 reason/evidence 를 합쳐 원인 해석을 시도하고,
 *  문장이 나오면 첫 줄(첫 문장)으로, 기존 해석 문장을 뒤에 붙인다. 원인이 없으면
 *  기존 문장을 그대로 반환한다. 호출부의 줄 형식(1줄 클립 등)은 각 빌더가 유지한다. */
export function withFailureCauseInterpretation(
  spec: { readonly reason?: string | null; readonly evidence?: string | null },
  baseInterpretation: string,
): string {
  const cause = interpretFailureCause([spec.reason, spec.evidence].filter(Boolean).join("\n"));
  return cause ? `${cause}\n${baseInterpretation}` : baseInterpretation;
}
