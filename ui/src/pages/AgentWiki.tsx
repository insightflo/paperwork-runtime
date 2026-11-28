// ui/src/pages/AgentWiki.tsx
//
// [목적] Mistology 위키 — 회사/전역 설정 언어(en/ko)에 맞춰 자동 수집·중복 제거·30일 TTL로
//   관리되는 오답·규약 기록을 3개 탭의 사람 읽기 카드로 보여준다. 읽기 전용(수동 토글 없음).
//   Stage 11 cockpit: 1-row strip(규약·오답·은퇴·TTL·접근) + 40px toolbar(제목 · 탭 · 검색) + hairline 카드.
// [외부 연결] knowledgePatternsApi.list + agentWikiApi.get — GET 조회만.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Search } from "lucide-react";
import { agentWikiApi } from "../api/agentWiki";
import { knowledgePatternsApi } from "../api/knowledgePatterns";
import { useCompany } from "../context/CompanyContext";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { WikiMetricsBar } from "../components/WikiMetricsBar";
import { MistologyCardList } from "../components/MistologyCardList";
import { KbTreePanel } from "../components/KbTreePanel";
import { classifyMistologyTab, groupAgentWikiEntries, type MistologyTab } from "../components/wikiHumanize";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type WikiPageTab = MistologyTab | "kb";

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const TACTILE_PANEL =
  "rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const TACTILE_INSET =
  "border-slate-200/90 bg-slate-100/80 text-slate-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]";
const SEGMENT_ACTIVE = "bg-white text-slate-950 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]";
const SEGMENT_IDLE = "text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]";
/** Hairline card: #151b28 body inside a 1px #242d3f border. */
const TACTILE_CARD = cn("min-w-0", TACTILE_PANEL);
/** Descendant override so WikiMetricsBar / MistologyCardList / KbTreePanel blocks inherit the tactile card look. */
const TACTILE_DESCENDANTS =
  "[&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-slate-500 dark:[&_h2]:text-[#8b97ad] " +
  "[&_article]:rounded-xl [&_article]:border-slate-200/90 [&_article]:bg-white [&_article]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:[&_article]:border-white/[0.08] dark:[&_article]:bg-[#0e131d] dark:[&_article]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] " +
  "[&_article_h3]:min-w-0 [&_article_h3]:truncate [&_dd]:min-w-0 [&_dd]:whitespace-pre-wrap [&_code]:whitespace-pre-wrap [&_code]:font-mono " +
  "[&_article_dl>div]:border [&_article_dl>div]:border-slate-200/70 [&_article_dl>div]:bg-slate-50/80 dark:[&_article_dl>div]:border-white/[0.06] dark:[&_article_dl>div]:bg-[#090c12]/80 " +
  "[&_.text-rose-300]:text-rose-700 dark:[&_.text-rose-300]:text-rose-300 [&_.text-amber-300]:text-amber-700 dark:[&_.text-amber-300]:text-amber-300 [&_.text-emerald-300]:text-emerald-700 dark:[&_.text-emerald-300]:text-emerald-300 " +
  "[&_section.rounded-lg.border]:rounded-xl [&_section.rounded-lg.border]:border-slate-200/90 [&_section.rounded-lg.border]:bg-white dark:[&_section.rounded-lg.border]:border-white/[0.08] dark:[&_section.rounded-lg.border]:bg-[#0e131d] " +
  "[&_div.rounded-md.border]:border-slate-200/80 [&_div.rounded-md.border]:bg-white dark:[&_div.rounded-md.border]:border-white/[0.08] dark:[&_div.rounded-md.border]:bg-[#090c12] " +
  "[&_p.rounded-lg.border]:rounded-xl [&_p.rounded-lg.border]:border-slate-200/90 [&_p.rounded-lg.border]:bg-white dark:[&_p.rounded-lg.border]:border-white/[0.08] dark:[&_p.rounded-lg.border]:bg-[#0e131d]";
const TOOLBAR_INPUT =
  "h-8 rounded-lg border-slate-200/90 bg-white text-xs text-slate-900 placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/25";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="flex h-10 min-w-0 items-center justify-center gap-1.5 px-2 text-xs text-slate-600 dark:text-[#8b97ad]">
      {dot && <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />}
      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.1em]">{label}</span>
      <b className="truncate font-mono text-xs font-semibold normal-case tracking-normal text-slate-950 dark:text-[#edf2fb]" title={value}>{value}</b>
    </span>
  );
}

export function AgentWiki() {
  const { selectedCompanyId } = useCompany();
  const lang = useCompanyLanguage();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<WikiPageTab>("recent");

  const { data: patternData, isLoading, isError, error } = useQuery({
    queryKey: ["knowledge-patterns", selectedCompanyId, q, "with-superseded"],
    queryFn: () => knowledgePatternsApi.list(selectedCompanyId!, { q, includeSuperseded: true }),
    enabled: !!selectedCompanyId,
  });
  const { data: wikiData } = useQuery({
    queryKey: ["agent-wiki", selectedCompanyId, 30],
    queryFn: () => agentWikiApi.get(selectedCompanyId!, 30),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return (
      <p aria-live="polite" className="text-sm text-slate-500 tabular-nums dark:text-[#8b97ad]">
        {L(lang, { en: "Select a company to view its wiki.", ko: "회사를 선택하세요." })}
      </p>
    );
  }

  const patterns = patternData?.patterns ?? [];
  const entries = wikiData?.entries ?? [];
  const canonPatterns = patterns.filter((c) => classifyMistologyTab(c) === "canon");
  const recentPatterns = patterns.filter((c) => classifyMistologyTab(c) === "recent");
  const retiredPatterns = patterns.filter((c) => classifyMistologyTab(c) === "retired");
  const activeEntries = entries.filter((e) => e.status === "active");
  const closedEntries = entries.filter((e) => e.status !== "active");
  // 탭 배지는 카드 리스트와 같은 패턴 그룹화 기준으로 세야 실제 카드 수와 일치한다.
  const activeEntryGroups = groupAgentWikiEntries(activeEntries).length;
  const closedEntryGroups = groupAgentWikiEntries(closedEntries).length;

  const tabs: { id: WikiPageTab; label: string }[] = [
    { id: "canon", label: L(lang, { en: `★ Standard Rules (${canonPatterns.length})`, ko: `★ 표준 규약 (${canonPatterns.length})` }) },
    {
      id: "recent",
      label: L(lang, {
        en: `Recent Mistakes · 30d (${recentPatterns.length + activeEntryGroups})`,
        ko: `최근 오답 · 30일 (${recentPatterns.length + activeEntryGroups})`,
      }),
    },
    {
      id: "retired",
      label: L(lang, {
        en: `Retired & Resolved (${retiredPatterns.length + closedEntryGroups})`,
        ko: `은퇴 · 해결 이력 (${retiredPatterns.length + closedEntryGroups})`,
      }),
    },
    { id: "kb", label: L(lang, { en: "KB Tree", ko: "KB 트리" }) },
  ];
  const shown =
    tab === "canon"
      ? { patterns: canonPatterns, entries: [] }
      : tab === "retired"
        ? { patterns: retiredPatterns, entries: closedEntries }
        : { patterns: recentPatterns, entries: activeEntries };
  const description = L(lang, {
    en: "Auto-collected, deduplicated mistakes and durable rules with 30-day TTL (read-only).",
    ko: "자동 수집·중복 제거·30일 TTL로 관리되는 오답·규약 기록입니다(읽기 전용).",
  });

  return (
    <div className={cn("space-y-3 tabular-nums", TACTILE_DESCENDANTS)}>
      {/* 1-row 5-cell cockpit strip: record counts by tab + TTL + access */}
      <div className={cn(TACTILE_PANEL, "grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden dark:divide-white/[0.06] sm:grid-cols-5")} role="group" aria-label="Wiki summary">
        <StripFact label={L(lang, { en: "Standards", ko: "표준 규약" })} value={String(canonPatterns.length)} dot="bg-blue-500 dark:bg-[#60a5fa]" />
        <StripFact label={L(lang, { en: "Mistakes · 30d", ko: "오답 · 30일" })} value={String(recentPatterns.length + activeEntryGroups)} dot="bg-amber-500 dark:bg-[#f59e0b]" />
        <StripFact label={L(lang, { en: "Retired", ko: "은퇴·해결" })} value={String(retiredPatterns.length + closedEntryGroups)} dot="bg-slate-400 dark:bg-[#8b97ad]" />
        <StripFact label="TTL" value="30d" />
        <StripFact label={L(lang, { en: "Access", ko: "접근" })} value={L(lang, { en: "Read-only", ko: "읽기 전용" })} dot="bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.45)] dark:bg-[#a3e635]" />
      </div>

      {/* Tight single-row 40px toolbar: title · description · tabs · search (wraps on narrow viewports). */}
      <div className={cn(TACTILE_PANEL, "flex min-h-10 w-full flex-wrap items-center gap-2 px-2.5 py-1.5")}>
        <Brain className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
        <h1 className="shrink-0 text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">Mistology Wiki</h1>
        <p className="min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]" title={description}>{description}</p>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {tab !== "kb" && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#8b97ad]" />
              <Input
                aria-label={L(lang, { en: "Search title, symptoms, tags", ko: "제목·증상·태그 검색" })} value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={L(lang, { en: "Search title, symptoms, tags", ko: "제목·증상·태그 검색" })}
                className={cn(TOOLBAR_INPUT, "w-56 pl-8")}
              />
            </div>
          )}
          <div role="tablist" aria-label="Mistology tabs" className={cn("flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5", TACTILE_INSET)}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn("h-7 cursor-pointer rounded-md px-2 text-xs whitespace-nowrap transition-colors", tab === t.id ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_21rem] xl:items-start">
        <div className="min-w-0">
          {(() => {
            if (tab === "kb") return <KbTreePanel key={selectedCompanyId} companyId={selectedCompanyId} />;
            if (isLoading) return <p aria-live="polite" className={cn(TACTILE_CARD, "px-4 py-3 font-mono text-xs text-slate-500 dark:text-[#8b97ad]")}>{L(lang, { en: "Loading…", ko: "불러오는 중…" })}</p>;
            if (isError) {
              return (
                <p role="alert" className={cn(TACTILE_CARD, "whitespace-pre-wrap px-4 py-3 font-mono text-xs text-rose-700 dark:text-[#f87171]")}>
                  {L(lang, { en: "Failed to load", ko: "조회 실패" })}: {(error as Error)?.message ?? "unknown"}
                </p>
              );
            }
            return <MistologyCardList patterns={shown.patterns} entries={shown.entries} language={lang} />;
          })()}
        </div>
        <aside className="min-w-0 xl:sticky xl:top-3">
          <WikiMetricsBar patterns={patterns} entries={entries} language={lang} />
        </aside>
      </div>
    </div>
  );
}
