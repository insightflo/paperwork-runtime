// ui/src/components/wikiHumanize.ts
//
// [목적] Mistology 위키의 기계값(kind/source/status/UUID·에러코드)을 회사/전역 설정 언어(en/ko)로
//   사람이 바로 읽을 수 있는 라벨·문구로 바꾸는 순수 변환 헬퍼. 3탭 분류와 나이·TTL 표기도 담당.
//   표시 전용 — 서버 값을 변경하지 않으며 뮤테이션과 무관하다.
// [연결] consumer: ui/src/components/MistologyCardList.tsx, ui/src/pages/AgentWiki.tsx.
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";
import { L } from "../lib/companyLanguage";

export type MistologyTab = "canon" | "recent" | "retired";

// [탭 분류] 은퇴·초안·대체됨 → retired / 내구 규약·레시피 → canon / 나머지(오답 등) → recent.
export function classifyMistologyTab(card: KnowledgePatternCardDto): MistologyTab {
  if (card.status === "retired" || card.status === "draft" || !!card.supersededById) return "retired";
  if (card.kind === "constraint" || card.kind === "success_recipe") return "canon";
  return "recent";
}

const KIND_LABELS: Record<string, { en: string; ko: string }> = {
  constraint: { en: "★ Standard Rule", ko: "★ 표준 규약" },
  success_recipe: { en: "Success Recipe", ko: "성공 레시피" },
  failure_mode: { en: "Mistake Record", ko: "오답 기록" },
};

export function humanizeKind(kind: string, lang: CompanyDefaultLanguage = "en"): string {
  const pair = KIND_LABELS[kind];
  return pair ? L(lang, pair) : kind;
}

const SOURCE_LABELS: Record<string, { en: string; ko: string }> = {
  auto_rework_draft: { en: "Auto-collected", ko: "자동 수집" },
  agent_candidate: { en: "Agent note", ko: "에이전트 기록" },
  operator: { en: "Operator note", ko: "운영자 기록" },
  mission_owner_compile: { en: "Mission summary", ko: "미션 정리" },
};

export function humanizeSource(source: string, lang: CompanyDefaultLanguage = "en"): string {
  const pair = SOURCE_LABELS[source];
  return pair ? L(lang, pair) : source;
}

// [은퇴 사유] supersedeReason(선택 필드) → supersededById → status 순으로 설정 언어로 표기.
export function humanizeRetireReason(
  card: KnowledgePatternCardDto,
  lang: CompanyDefaultLanguage = "en",
): string | null {
  const reason = (card as { supersedeReason?: string | null }).supersedeReason ?? "";
  if (reason.includes("stale_over_30d")) {
    return L(lang, { en: "Auto-retired (30d TTL)", ko: "30일 만료로 자동 은퇴" });
  }
  if (reason.includes("draft_queue")) {
    return L(lang, { en: "Retired (draft queue removed)", ko: "수동 승인 폐지로 은퇴" });
  }
  if (card.supersededById) {
    return L(lang, { en: "Superseded by newer version", ko: "상위 버전으로 대체됨" });
  }
  if (card.status === "retired") {
    return L(lang, { en: "Resolved & retired", ko: "해결·은퇴 완료" });
  }
  return null;
}

// [기계 토큰 번역] 암호 같은 코드를 설정 언어 풀이 + 원 코드 괄호 병기로 바꾼다(검색 가능성 유지).
const CODE_LABELS: Record<string, { en: string; ko: string }> = {
  issue_status_blocked: { en: "Issue blocked", ko: "이슈 차단 상태" },
  "55P03": { en: "DB lock timeout", ko: "DB 잠금 초과" },
  RUN_CANCELLED: { en: "Run cancelled", ko: "실행 취소" },
  PROVIDER_AUTH: { en: "Model auth error", ko: "모델 인증 오류" },
};
const CODE_RE = /issue_status_blocked|55P03|RUN_CANCELLED|PROVIDER_AUTH/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RUN_NOISE_RE = /\s*\(run [0-9a-f]{6,}\)/gi;

export function humanizeText(
  raw: string | null | undefined,
  lang: CompanyDefaultLanguage = "en",
): string {
  if (!raw?.trim()) return "";
  return raw
    .replace(UUID_RE, "")
    .replace(RUN_NOISE_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(CODE_RE, (m) => `${L(lang, CODE_LABELS[m])}(${m})`)
    .replace(/\s+/g, " ")
    .trim();
}

const DAY_MS = 86_400_000;

// [나이·TTL] 내구 규약·레시피는 영속, 오답은 30일 TTL 카운트다운(설정 언어 적용).
export function formatAgeAndTtl(
  createdAt: string,
  kind: string,
  lang: CompanyDefaultLanguage = "en",
  nowMs = Date.now(),
): string {
  const daysAgo = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / DAY_MS));
  if (kind === "constraint" || kind === "success_recipe") {
    return L(lang, { en: "Durable rule", ko: "영속 규약" });
  }
  if (daysAgo >= 30) {
    return L(lang, { en: `${daysAgo}d ago · TTL expired`, ko: `${daysAgo}일 전 · TTL 만료` });
  }
  const rem = 30 - daysAgo;
  return L(lang, {
    en: `${daysAgo === 0 ? "Today" : `${daysAgo}d ago`} · D-${rem}`,
    ko: `${daysAgo === 0 ? "오늘" : `${daysAgo}일 전`} · 만료 D-${rem}`,
  });
}

export interface GroupedWikiEntry extends AgentWikiEntryDto {
  totalFrequency: number;
  agentCount: number;
}

const seenMs = (entry: AgentWikiEntryDto): number =>
  Date.parse(entry.lastSeenAt || entry.createdAt) || 0;

// [패턴 그룹화] 정규화된 pattern(양끝 공백·대소문자 무시)이 같은 entry를 1장으로 묶고
//   frequency 합계·관측 에이전트 수를 합산한다. 대표 행은 최신 관측(lastSeenAt→createdAt)
//   우선이고, 비어 있는 cause/solution은 그룹 내 최신 비어있지 않은 값으로 채운다.
export function groupAgentWikiEntries(entries: AgentWikiEntryDto[]): GroupedWikiEntry[] {
  const groups = new Map<string, AgentWikiEntryDto[]>();
  for (const entry of entries) {
    const key = entry.pattern.trim().toLowerCase();
    const members = groups.get(key);
    if (members) members.push(entry);
    else groups.set(key, [entry]);
  }
  const grouped = [...groups.values()].map((members) => {
    members.sort((a, b) => seenMs(b) - seenMs(a));
    const rep = members[0];
    return {
      ...rep,
      cause: rep.cause.trim() ? rep.cause : (members.find((m) => m.cause.trim())?.cause ?? rep.cause),
      solution: rep.solution.trim() ? rep.solution : (members.find((m) => m.solution.trim())?.solution ?? rep.solution),
      totalFrequency: members.reduce((sum, m) => sum + m.frequency, 0),
      agentCount: new Set(members.map((m) => m.agentId)).size,
    };
  });
  return grouped.sort((a, b) => b.totalFrequency - a.totalFrequency || seenMs(b) - seenMs(a));
}
