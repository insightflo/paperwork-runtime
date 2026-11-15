// server/src/services/knowledge-pattern-brief.ts
//
// [파일 목적] 지식 패턴 카드의 초압축 브리핑 포매터(T2b — mistology 후보⑤ 흡수).
//   카드 한 장을 2~3줄·최대 BRIEF_MAX_CHARS자로 압축해 실행 프롬프트 주입/보드 조회에
//   쓸 수 있는 문자열 배열을 만든다. 순수 함수 — DB·서비스 import는 타입만.
// [형식 — 카드당]
//   v{versionNumber}(via 결합엔티티) [kind] 제목          ← 1행(버전·경유·종류·제목)
//   피할 오답: pitfalls 첫 항목 / 최우선 대처: whatWorked 첫 문장  ← 2행(있는 쪽만)
//   → 동시변경: coupled 목록                              ← 3행(파일·심볼 일치로 떠 있을 때만)
// [불변식]
//   - 최대 BRIEF_CARD_LIMIT(2)장 — 보고서 Do-Not-Absorb의 k=6 상시 주입 금지와 같은 원칙.
//     초과분은 본문 없이 `외 N장 유사(제목 목록)` 한 줄로 요약한다.
//   - pitfalls는 표시 전용(랭킹 기여 없음 — T2a 계약 유지). via는 전파 경유일 때만 표시.
//   - 점수·랭킹을 다시 계산하지 않는다 — 순서는 호출자가 준 랭킹 결과를 그대로 신뢰한다.

import {
  corpusHasEntityKey,
  extractFileRefs,
  normalizeCodePathRef,
  normalizeKnowledgeTokens,
} from "./knowledge-text-normalizer.js";
import type { KnowledgePattern } from "./knowledge-patterns.js";

/** 카드 한 장 브리핑 상한(문자). */
export const BRIEF_MAX_CHARS = 280;
/** 본문에 실을 카드 수 상한 — 초과는 요약 행으로만. */
export const BRIEF_CARD_LIMIT = 2;

const MIN_ENTITY_KEY_LENGTH = 3;
const TITLE_MAX = 90;
const VIA_MAX = 60;
const FIELD_MAX = 110;
const OVERFLOW_TITLE_MAX = 40;

// 행 라벨 — 표시 문자열은 여기서만 고친다(브리핑 테스트가 이 문구를 핀다).
const PITFALL_LABEL = "피할 오답";
const WHAT_WORKED_LABEL = "최우선 대처";
const COUPLED_LABEL = "→ 동시변경";
const overflowLabel = (overflow: number, titles: string): string => `외 ${overflow}장 유사(${titles})`;

export type BriefCard = Pick<
  KnowledgePattern,
  "id" | "title" | "kind" | "versionNumber" | "whatWorked" | "pitfalls" | "coupled" | "files" | "symbols"
>;

export type BriefOptions = {
  /** 관련도 문맥(q/files/symbols 원문) — 파일·심볼 일치 판정에 사용. 없으면 동시변경 행 생략. */
  contextTexts?: readonly string[];
  /** 카드 id → 전파 경유 엔티티(selectRelatedKnowledgePatterns의 via). 없으면 (via …) 생략. */
  viaById?: ReadonlyMap<string, readonly string[]>;
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** UTF-16 코드유닛 상한 절단 — 서로게이트 쌍 중간에서 끊지 않는다(끝 유닛이
 *  고서로게이트면 1유닛 더 빼 이모지·보충평면 문자가 깨진 채 붙지 않게 한다). */
function sliceUtf16Safe(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function truncate(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length <= max ? flat : `${sliceUtf16Safe(flat, max - 1)}…`;
}

/** whatWorked 첫 문장 — 첫 문장부호(. ! ? 。)까지, 없으면 max 절단.
 *  숫자에 둘러싸인 점(v1.2·2.4.1 같은 버전 표기)은 문장 끝으로 보지 않는다. */
function firstSentence(text: string, max: number): string {
  const flat = oneLine(text);
  for (const match of flat.matchAll(/[.!?。]/g)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const isVersionDot =
      flat[index] === "." && /\d/.test(flat[index - 1] ?? "") && /\d/.test(flat[index + 1] ?? "");
    if (isVersionDot) continue;
    return truncate(flat.slice(0, index + 1), max);
  }
  return truncate(flat, max);
}

/** 파일·심볼 직접 일치 — 엔진의 strong-entity 조건과 같은 정규화·같은 매칭 규칙으로
 *  표시 판정만 재현한다(점수 재계산 아님: 문맥이 이 카드를 띄운 근거가 파일·심볼인지만 본다).
 *  짧은 심볼은 corpusHasEntityKey의 토큰 경계 규칙 — 부분문자열 오탐("get"⊂"target")을 막는다. */
function matchedByFileOrSymbol(
  card: Pick<BriefCard, "files" | "symbols">,
  fileRefSet: ReadonlySet<string>,
  corpus: string,
  contextTokens: ReadonlySet<string>,
): boolean {
  if (card.files.some((ref) => fileRefSet.has(normalizeCodePathRef(ref)))) return true;
  return card.symbols.some((symbol) => {
    const key = oneLine(symbol).toLowerCase();
    return key.length >= MIN_ENTITY_KEY_LENGTH && corpusHasEntityKey(key, corpus, contextTokens);
  });
}

function buildCardBrief(
  card: BriefCard,
  via: readonly string[],
  fieldMax: number,
  titleMax: number,
  fileRefSet: ReadonlySet<string>,
  corpus: string,
  contextTokens: ReadonlySet<string>,
): string {
  const viaLabel = via.length > 0 ? `(via ${truncate(via.join(", "), VIA_MAX)})` : "";
  const head = `v${card.versionNumber}${viaLabel} [${card.kind}] ${truncate(card.title, titleMax)}`;
  const body = [
    card.pitfalls[0] ? `${PITFALL_LABEL}: ${truncate(card.pitfalls[0], fieldMax)}` : "",
    card.whatWorked ? `${WHAT_WORKED_LABEL}: ${firstSentence(card.whatWorked, fieldMax)}` : "",
  ].filter(Boolean).join(" / ");
  const coupled = card.coupled.length > 0 && (via.length > 0 || matchedByFileOrSymbol(card, fileRefSet, corpus, contextTokens))
    ? `${COUPLED_LABEL}: ${truncate(card.coupled.join(", "), fieldMax)}`
    : "";
  return [head, body, coupled].filter(Boolean).join("\n");
}

/** 카드 배열 → 초압축 브리핑 문자열 배열. 상위 BRIEF_CARD_LIMIT 장만 본문으로,
 *  나머지는 `외 N장 유사(제목 목록)` 요약 행 하나로 묶는다. */
export function formatKnowledgePatternBriefs(
  cards: readonly BriefCard[],
  options: BriefOptions = {},
): string[] {
  const contextTexts = options.contextTexts ?? [];
  const fileRefSet = new Set(
    extractFileRefs(contextTexts).map((ref) => normalizeCodePathRef(ref)).filter((ref) => ref.length > 0),
  );
  const contextText = contextTexts.join(" ");
  const corpus = oneLine(contextText).toLowerCase();
  const contextTokens = new Set(normalizeKnowledgeTokens(contextText));

  const briefs: string[] = [];
  for (const card of cards.slice(0, BRIEF_CARD_LIMIT)) {
    const via = options.viaById?.get(card.id) ?? [];
    let brief = buildCardBrief(card, via, FIELD_MAX, TITLE_MAX, fileRefSet, corpus, contextTokens);
    if (brief.length > BRIEF_MAX_CHARS) {
      // 예산 축소 2차 — 필드·제목을 반쯤 줄여 재조립하고 그래도 넘치면 최종 절단.
      brief = buildCardBrief(card, via, Math.floor(FIELD_MAX / 2), 60, fileRefSet, corpus, contextTokens);
      if (brief.length > BRIEF_MAX_CHARS) brief = `${sliceUtf16Safe(brief, BRIEF_MAX_CHARS - 1)}…`;
    }
    briefs.push(brief);
  }
  const overflow = cards.length - BRIEF_CARD_LIMIT;
  if (overflow > 0) {
    const titles = cards.slice(BRIEF_CARD_LIMIT).map((card) => truncate(card.title, OVERFLOW_TITLE_MAX)).join(", ");
    briefs.push(truncate(overflowLabel(overflow, titles), BRIEF_MAX_CHARS));
  }
  return briefs;
}
