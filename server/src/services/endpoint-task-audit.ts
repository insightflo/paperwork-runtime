// server/src/services/endpoint-task-audit.ts
//
// [파일 목적] 개인 엔드포인트 봇에 dispatch된 작업의 회사 범위 감사 링 버퍼(Stage 33 W2F).
//   감사 요약에 시크릿(Bearer/sk-/ghp_/xoxb-/token=·password=·api_key= 값)이 새지
//   않게 기록 시점에 마스킹하고, 회사별로 최근 이벤트만 유한 보관한다.
// [비고] 순수 인메모리 서비스 — DB·기존 서비스 import 없음. 표시·조회 전용이며
//   이 로그는 실행 권한(retry/branch/completion 등)의 근거로 읽히지 않는다(AGENTS.md 9조).

export type EndpointAuditOutcome = "enqueued" | "completed" | "failed" | "denied";

export interface EndpointAuditEvent {
  id: string;
  companyId: string;
  deviceId: string;
  botName: string;
  taskId: string;
  kind: string;
  targetPath: string;
  outcome: EndpointAuditOutcome;
  actorId?: string;
  summary: string;
  createdAtMs: number;
}

export interface EndpointAuditListOpts {
  deviceId?: string;
  limit?: number;
}

export interface EndpointAuditStats {
  total: number;
  enqueued: number;
  completed: number;
  failed: number;
  denied: number;
}

export interface EndpointAuditStore {
  /** 요약을 마스킹해 회사 버퍼에 append하고, 저장된 불변 사본을 반환한다(최근 것부터 퇴거). */
  record(event: EndpointAuditEvent): EndpointAuditEvent;
  /** 해당 회사 이벤트를 최신순으로 반환한다. deviceId 필터·limit(기본 50) 지원. */
  list(companyId: string, opts?: EndpointAuditListOpts): EndpointAuditEvent[];
  /** 해당 회사의 보관 중 이벤트에 대한 outcome별 카운트를 반환한다. */
  stats(companyId: string): EndpointAuditStats;
}

const REDACTED = "[REDACTED]";

/** 감사 텍스트에서 알려진 시크릿 패턴을 마스킹한다. 과대 마스킹은 안전한 쪽이다. */
export function redactAuditSecrets(text: string): string {
  return text
    // Authorization 헤더 계열 — Bearer 뒤 토큰 한 토큰만 치환(라벨은 보존).
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    // OpenAI 계열 API 키(sk-... / sk-proj-...).
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, REDACTED)
    // GitHub PAT(ghp_...).
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, REDACTED)
    // Slack 봇 토큰(xoxb-...).
    .replace(/\bxoxb-[A-Za-z0-9-]{10,}/g, REDACTED)
    // query/form 계열 키=값 — 값은 공백·&·따옴표 앞까지 전부 치환.
    .replace(/(token|password|api_key)=([^\s&"']+)/gi, `$1=${REDACTED}`);
}

export function createEndpointAuditStore(maxPerCompany = 200): EndpointAuditStore {
  if (!Number.isInteger(maxPerCompany) || maxPerCompany < 1) {
    throw new RangeError(`maxPerCompany must be a positive integer, got ${maxPerCompany}`);
  }

  // [구조] companyId → 시간순(append) 배열. 최신 = 배열 끝. 퇴거는 선두 shift.
  const byCompany = new Map<string, EndpointAuditEvent[]>();

  function record(event: EndpointAuditEvent): EndpointAuditEvent {
    // 저장 사본은 입력과 분리하고 freeze해 반환값·보관본 모두 불변으로 만든다.
    const stored: EndpointAuditEvent = Object.freeze({
      ...event,
      summary: redactAuditSecrets(event.summary),
    });
    let events = byCompany.get(event.companyId);
    if (!events) {
      events = [];
      byCompany.set(event.companyId, events);
    }
    events.push(stored);
    while (events.length > maxPerCompany) {
      events.shift();
    }
    return stored;
  }

  function list(companyId: string, opts?: EndpointAuditListOpts): EndpointAuditEvent[] {
    const events = byCompany.get(companyId);
    if (!events || events.length === 0) return [];
    const filtered =
      opts?.deviceId === undefined ? events : events.filter((e) => e.deviceId === opts.deviceId);
    const limit = opts?.limit ?? 50;
    return filtered.slice(-limit).reverse();
  }

  function stats(companyId: string): EndpointAuditStats {
    const counters: EndpointAuditStats = { total: 0, enqueued: 0, completed: 0, failed: 0, denied: 0 };
    const events = byCompany.get(companyId);
    for (const e of events ?? []) {
      counters.total += 1;
      counters[e.outcome] += 1;
    }
    return counters;
  }

  return { record, list, stats };
}
