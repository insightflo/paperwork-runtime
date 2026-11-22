// ui/src/components/MistologyCardList.tsx
//
// [목적] Mistology 위키의 사람 읽기용 카드 리스트 — 회사/전역 설정 언어(en/ko)에 맞춰
//   지식 패턴 카드와 agent-wiki 교훈을 3단 요약 + 배지·코드 칩으로 렌더한다.
//   표시 전용 — 주입 토글·초안 승인 등 어떤 뮤테이션 버튼도 두지 않는다.
// [연결] mount: ui/src/pages/AgentWiki.tsx. 변환 헬퍼: ./wikiHumanize.
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { cn } from "../lib/utils";
import {
  classifyMistologyTab,
  formatAgeAndTtl,
  groupAgentWikiEntries,
  humanizeKind,
  humanizeRetireReason,
  humanizeSource,
  humanizeText,
  type GroupedWikiEntry,
} from "./wikiHumanize";

export interface MistologyCardListProps {
  patterns: KnowledgePatternCardDto[];
  entries?: AgentWikiEntryDto[];
  language?: CompanyDefaultLanguage;
}

const KIND_STYLE: Record<string, string> = {
  constraint: "bg-indigo-500/15 text-indigo-300",
  success_recipe: "bg-amber-500/15 text-amber-300",
  failure_mode: "bg-rose-500/15 text-rose-300",
};
const FALLBACK_KIND_STYLE = "bg-slate-500/15 text-slate-300";
const MUTED_BADGE = "rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground";

function cardChips(card: KnowledgePatternCardDto): string[] {
  const all = [
    ...(card.files ?? []),
    ...(card.symbols ?? []),
    ...(card.coupled ?? []),
    ...(card.errorSignatures ?? []),
    ...card.scopeTags.map((t) => `#${t}`),
  ];
  return Array.from(new Set(all.filter(Boolean))).slice(0, 6);
}

function SummaryGrid({
  problem,
  cause,
  fix,
  lang,
}: {
  problem: string;
  cause: string;
  fix: string;
  lang: CompanyDefaultLanguage;
}) {
  return (
    <dl className="mt-3 grid gap-2 sm:grid-cols-3">
      <div className="rounded-md bg-muted/40 p-2.5">
        <dt className="text-[11px] font-semibold text-rose-300">
          {L(lang, { en: "What happened", ko: "무슨 문제였나" })}
        </dt>
        <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{problem || "-"}</dd>
      </div>
      {cause ? (
        <div className="rounded-md bg-muted/40 p-2.5">
          <dt className="text-[11px] font-semibold text-amber-300">
            {L(lang, { en: "Root cause", ko: "원인" })}
          </dt>
          <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{cause}</dd>
        </div>
      ) : null}
      {fix ? (
        <div className="rounded-md bg-muted/40 p-2.5">
          <dt className="text-[11px] font-semibold text-emerald-300">
            {L(lang, { en: "Fix / Rule", ko: "해결·규칙" })}
          </dt>
          <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{fix}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function PatternCard({ card, lang }: { card: KnowledgePatternCardDto; lang: CompanyDefaultLanguage }) {
  const retired = classifyMistologyTab(card) === "retired";
  const retireReason = retired ? humanizeRetireReason(card, lang) : null;
  const chips = cardChips(card);
  return (
    <article className={cn("rounded-lg border bg-card p-4 shadow-sm", retired && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", KIND_STYLE[card.kind] ?? FALLBACK_KIND_STYLE)}>
          {humanizeKind(card.kind, lang)}
        </span>
        <span className={MUTED_BADGE}>{formatAgeAndTtl(card.createdAt, card.kind, lang)}</span>
        <span className={MUTED_BADGE}>{humanizeSource(card.source, lang)}</span>
        {retireReason ? (
          <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] font-medium text-slate-300">
            {retireReason}
          </span>
        ) : null}
      </div>
      <h3 className="mt-2 text-sm font-semibold leading-snug">{humanizeText(card.title, lang)}</h3>
      <SummaryGrid
        problem={humanizeText(card.symptoms || card.summary, lang)}
        cause={humanizeText(card.rootCause, lang)}
        fix={humanizeText(card.whatWorked, lang)}
        lang={lang}
      />
      {chips.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-muted-foreground">
            {L(lang, { en: "Linked code & tags", ko: "연결된 코드·태그" })}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <code key={chip} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {chip}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function EntryCard({ entry, lang }: { entry: GroupedWikiEntry; lang: CompanyDefaultLanguage }) {
  return (
    <article className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
          {L(lang, { en: "Mistake · Agent", ko: "오답 기록 · 에이전트" })}
        </span>
        <span className={MUTED_BADGE}>
          {entry.agentCount > 1
            ? L(lang, {
                en: `Seen ${entry.totalFrequency}x · ${entry.agentCount} agents`,
                ko: `${entry.totalFrequency}회 관측 · 에이전트 ${entry.agentCount}명`,
              })
            : L(lang, { en: `Seen ${entry.totalFrequency}x`, ko: `${entry.totalFrequency}회 관측` })}
        </span>
      </div>
      <SummaryGrid
        problem={humanizeText(entry.pattern, lang)}
        cause={humanizeText(entry.cause, lang)}
        fix={humanizeText(entry.solution, lang)}
        lang={lang}
      />
    </article>
  );
}

export function MistologyCardList({ patterns, entries = [], language }: MistologyCardListProps) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;
  if (patterns.length === 0 && entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        {L(lang, {
          en: "No records in this tab yet — mistakes and rules will appear here automatically.",
          ko: "이 탭에 표시할 기록이 없습니다 — 오답·규약이 자동 수집되면 여기에 카드로 채워집니다.",
        })}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {patterns.map((card) => (
        <PatternCard key={card.id} card={card} lang={lang} />
      ))}
      {groupAgentWikiEntries(entries).map((entry) => (
        <EntryCard key={entry.id} entry={entry} lang={lang} />
      ))}
    </div>
  );
}
