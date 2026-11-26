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

const CARD =
  "tactile-card relative overflow-hidden rounded-[12px] border border-slate-200/90 bg-white p-4 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const MUTED = "text-slate-500 dark:text-[#8b97ad]";
const BODY = "text-slate-600 dark:text-[#aab6ca]";

const KIND_STYLE: Record<string, string> = {
  constraint: "border-blue-600/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]",
  success_recipe: "border-lime-600/25 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  failure_mode: "border-rose-600/25 bg-rose-500/10 text-rose-700 dark:border-[#f43f5e]/30 dark:bg-[#f43f5e]/10 dark:text-[#fb7185]",
};
const FALLBACK_KIND_STYLE = "border-slate-300/80 bg-slate-500/10 text-slate-600 dark:border-white/[0.09] dark:bg-white/[0.05] dark:text-[#8b97ad]";
const KIND_RAIL: Record<string, string> = {
  constraint: "from-blue-500/70 via-blue-500/15 dark:from-[#60a5fa]/85 dark:via-[#60a5fa]/15",
  success_recipe: "from-lime-500/70 via-lime-500/15 dark:from-[#a3e635]/85 dark:via-[#a3e635]/15",
  failure_mode: "from-rose-500/70 via-rose-500/15 dark:from-[#f43f5e]/85 dark:via-[#f43f5e]/15",
};
const FALLBACK_RAIL = "from-slate-400/70 via-slate-400/15 dark:from-[#627089]/85 dark:via-[#627089]/15";
const MUTED_BADGE =
  "rounded-full border border-slate-200/80 bg-slate-50/90 px-2 py-0.5 text-[11px] text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]";

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
      <div className={cn(INSET, "p-2.5")}>
        <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-700 dark:text-[#fb7185]">
          {L(lang, { en: "What happened", ko: "무슨 문제였나" })}
        </dt>
        <dd className={cn("mt-1 text-xs leading-relaxed", BODY)}>{problem || "-"}</dd>
      </div>
      {cause ? (
        <div className={cn(INSET, "p-2.5")}>
          <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-[#f59e0b]">
            {L(lang, { en: "Root cause", ko: "원인" })}
          </dt>
          <dd className={cn("mt-1 text-xs leading-relaxed", BODY)}>{cause}</dd>
        </div>
      ) : null}
      {fix ? (
        <div className={cn(INSET, "p-2.5")}>
          <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lime-800 dark:text-[#a3e635]">
            {L(lang, { en: "Fix / Rule", ko: "해결·규칙" })}
          </dt>
          <dd className={cn("mt-1 text-xs leading-relaxed", BODY)}>{fix}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function AccentRail({ tone }: { tone: string }) {
  return <div aria-hidden className={cn("pointer-events-none absolute bottom-4 left-0 top-4 w-px bg-gradient-to-b to-transparent", tone)} />;
}

function PatternCard({ card, lang }: { card: KnowledgePatternCardDto; lang: CompanyDefaultLanguage }) {
  const retired = classifyMistologyTab(card) === "retired";
  const retireReason = retired ? humanizeRetireReason(card, lang) : null;
  const chips = cardChips(card);
  return (
    <article className={cn(CARD, "tabular-nums", retired && "opacity-70")}>
      <AccentRail tone={KIND_RAIL[card.kind] ?? FALLBACK_RAIL} />
      <div className="relative flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", KIND_STYLE[card.kind] ?? FALLBACK_KIND_STYLE)}>
          {humanizeKind(card.kind, lang)}
        </span>
        <span className={MUTED_BADGE}>{formatAgeAndTtl(card.createdAt, card.kind, lang)}</span>
        <span className={MUTED_BADGE}>{humanizeSource(card.source, lang)}</span>
        {retireReason ? (
          <span className="rounded-full border border-slate-300/80 bg-slate-500/10 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-white/[0.09] dark:bg-white/[0.05] dark:text-[#8b97ad]">
            {retireReason}
          </span>
        ) : null}
      </div>
      <h3 className="relative mt-2 text-sm font-semibold leading-snug text-slate-950 dark:text-[#eef2f8]">{humanizeText(card.title, lang)}</h3>
      <div className="relative">
        <SummaryGrid
          problem={humanizeText(card.symptoms || card.summary, lang)}
          cause={humanizeText(card.rootCause, lang)}
          fix={humanizeText(card.whatWorked, lang)}
          lang={lang}
        />
      </div>
      {chips.length > 0 ? (
        <div className="relative mt-3 border-t border-slate-200/70 pt-2.5 dark:border-white/[0.06]">
          <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", MUTED)}>
            {L(lang, { en: "Linked code & tags", ko: "연결된 코드·태그" })}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <code key={chip} className="rounded-md border border-slate-200/80 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#8b97ad]">
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
    <article className={cn(CARD, "tabular-nums")}>
      <AccentRail tone={KIND_RAIL.failure_mode} />
      <div className="relative flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", KIND_STYLE.failure_mode)}>
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
      <div className="relative">
        <SummaryGrid
          problem={humanizeText(entry.pattern, lang)}
          cause={humanizeText(entry.cause, lang)}
          fix={humanizeText(entry.solution, lang)}
          lang={lang}
        />
      </div>
    </article>
  );
}

export function MistologyCardList({ patterns, entries = [], language }: MistologyCardListProps) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;
  if (patterns.length === 0 && entries.length === 0) {
    return (
      <p className="tactile-card rounded-[12px] border border-dashed border-slate-300/90 bg-white px-4 py-10 text-center text-sm text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.12] dark:bg-none dark:bg-[#0e131d] dark:text-[#8b97ad] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        {L(lang, {
          en: "No records in this tab yet — mistakes and rules will appear here automatically.",
          ko: "이 탭에 표시할 기록이 없습니다 — 오답·규약이 자동 수집되면 여기에 카드로 채워집니다.",
        })}
      </p>
    );
  }
  return (
    <div className="space-y-3 tabular-nums">
      {patterns.map((card) => (
        <PatternCard key={card.id} card={card} lang={lang} />
      ))}
      {groupAgentWikiEntries(entries).map((entry) => (
        <EntryCard key={entry.id} entry={entry} lang={lang} />
      ))}
    </div>
  );
}
