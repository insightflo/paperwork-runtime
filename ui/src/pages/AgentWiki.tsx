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
const SEGMENT_ACTIVE = "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_0_0_1px_#242d3f]";
const SEGMENT_IDLE = "text-[#8b97ad] hover:text-[#e6edf7]";
/** Hairline card: #151b28 body inside a 1px #242d3f border. */
const HAIRLINE_CARD = "min-w-0 rounded-md border border-[#242d3f] bg-[#151b28]";
/** Descendant override so WikiMetricsBar / MistologyCardList / KbTreePanel blocks inherit the hairline card look. */
const HAIRLINE_DESCENDANTS =
  "[&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-[#8b97ad] " +
  "[&_article]:rounded-md [&_article]:border-[#242d3f] [&_article]:bg-[#151b28] [&_article]:shadow-none [&_article_h3]:min-w-0 [&_article_h3]:truncate " +
  "[&_dd]:min-w-0 [&_dd]:whitespace-pre-wrap [&_code]:whitespace-pre-wrap [&_code]:font-mono " +
  "[&_section.rounded-lg.border]:rounded-md [&_section.rounded-lg.border]:border-[#242d3f] [&_section.rounded-lg.border]:bg-[#151b28] [&_section.rounded-lg.border]:shadow-none " +
  "[&_div.rounded-md.border]:border-[#242d3f] [&_div.rounded-md.border]:bg-[#151b28] " +
  "[&_p.rounded-lg.border]:rounded-md [&_p.rounded-lg.border]:border-[#242d3f] [&_p.rounded-lg.border]:bg-[#151b28]";
const TOOLBAR_INPUT =
  "h-7 border-[#242d3f] bg-[#0b0e14] text-xs text-[#e6edf7] focus-visible:border-[#5f8dff] focus-visible:ring-0";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="cockpit-cell min-w-0 flex-1">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate normal-case tracking-normal">{value}</b>
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
      <p className="text-sm text-[#8b97ad] tabular-nums">
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
    <div className={cn("space-y-2 tabular-nums", HAIRLINE_DESCENDANTS)}>
      {/* 1-row 5-cell cockpit strip: record counts by tab + TTL + access */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Wiki summary">
        <StripFact label={L(lang, { en: "Standards", ko: "표준 규약" })} value={String(canonPatterns.length)} dot="bg-[#5f8dff]" />
        <StripFact label={L(lang, { en: "Mistakes · 30d", ko: "오답 · 30일" })} value={String(recentPatterns.length + activeEntryGroups)} dot="bg-[#fbbf24]" />
        <StripFact label={L(lang, { en: "Retired", ko: "은퇴·해결" })} value={String(retiredPatterns.length + closedEntryGroups)} dot="bg-[#8b97ad]" />
        <StripFact label="TTL" value="30d" />
        <StripFact label={L(lang, { en: "Access", ko: "접근" })} value={L(lang, { en: "Read-only", ko: "읽기 전용" })} dot="bg-[#34d399]" />
      </div>

      {/* Tight single-row 40px toolbar: title · description · tabs · search (wraps on narrow viewports). */}
      <div className="cockpit-toolbar min-h-10 w-full flex-wrap rounded-md border border-[#242d3f] bg-[#111622] pl-2 pr-1.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-[#5f8dff]" aria-hidden />
        <h1 className="shrink-0 text-sm font-semibold text-[#e6edf7]">Mistology Wiki</h1>
        <p className="min-w-0 truncate text-xs text-[#8b97ad]" title={description}>{description}</p>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {tab !== "kb" && (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8b97ad]" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={L(lang, { en: "Search title, symptoms, tags", ko: "제목·증상·태그 검색" })}
                className={cn(TOOLBAR_INPUT, "w-56 pl-7")}
              />
            </div>
          )}
          <div role="tablist" aria-label="Mistology tabs" className="flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn("h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors", tab === t.id ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(() => {
        if (tab === "kb") return <KbTreePanel key={selectedCompanyId} companyId={selectedCompanyId} />;
        if (isLoading) return <p className={cn(HAIRLINE_CARD, "px-4 py-3 font-mono text-xs text-[#8b97ad]")}>{L(lang, { en: "Loading…", ko: "불러오는 중…" })}</p>;
        if (isError) {
          return (
            <p className={cn(HAIRLINE_CARD, "whitespace-pre-wrap px-4 py-3 font-mono text-xs text-[#f87171]")}>
              {L(lang, { en: "Failed to load", ko: "조회 실패" })}: {(error as Error)?.message ?? "unknown"}
            </p>
          );
        }
        return <MistologyCardList patterns={shown.patterns} entries={shown.entries} language={lang} />;
      })()}
    </div>
  );
}
