// ui/src/pages/AgentWiki.tsx
//
// [목적] Mistology 위키 — 회사/전역 설정 언어(en/ko)에 맞춰 자동 수집·중복 제거·30일 TTL로
//   관리되는 오답·규약 기록을 3개 탭의 사람 읽기 카드로 보여준다. 읽기 전용(수동 토글 없음).
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
import { classifyMistologyTab, type MistologyTab } from "../components/wikiHumanize";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AgentWiki() {
  const { selectedCompanyId } = useCompany();
  const lang = useCompanyLanguage();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<MistologyTab>("recent");

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
      <p className="p-6 text-sm text-muted-foreground">
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

  const tabs: { id: MistologyTab; label: string }[] = [
    { id: "canon", label: L(lang, { en: `★ Standard Rules (${canonPatterns.length})`, ko: `★ 표준 규약 (${canonPatterns.length})` }) },
    {
      id: "recent",
      label: L(lang, {
        en: `Recent Mistakes · 30d (${recentPatterns.length + activeEntries.length})`,
        ko: `최근 오답 · 30일 (${recentPatterns.length + activeEntries.length})`,
      }),
    },
    {
      id: "retired",
      label: L(lang, {
        en: `Retired & Resolved (${retiredPatterns.length + closedEntries.length})`,
        ko: `은퇴 · 해결 이력 (${retiredPatterns.length + closedEntries.length})`,
      }),
    },
  ];
  const shown =
    tab === "canon"
      ? { patterns: canonPatterns, entries: [] }
      : tab === "retired"
        ? { patterns: retiredPatterns, entries: closedEntries }
        : { patterns: recentPatterns, entries: activeEntries };

  return (
    <div className="space-y-5 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Brain className="h-5 w-5" /> Mistology Wiki
        </h1>
        <p className="text-sm text-muted-foreground">
          {L(lang, {
            en: "Auto-collected, deduplicated mistakes and durable rules with 30-day TTL (read-only).",
            ko: "자동 수집·중복 제거·30일 TTL로 관리되는 오답·규약 기록입니다(읽기 전용).",
          })}
        </p>
      </header>

      <WikiMetricsBar patterns={patterns} entries={entries} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={L(lang, { en: "Search title, symptoms, tags", ko: "제목·증상·태그 검색" })}
            className="h-8 w-64 pl-7"
          />
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Mistology tabs">
          {tabs.map((t) => (
            <Button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              variant={tab === t.id ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{L(lang, { en: "Loading…", ko: "불러오는 중…" })}</p>
      ) : isError ? (
        <p className="text-sm text-red-400">
          {L(lang, { en: "Failed to load", ko: "조회 실패" })}: {(error as Error)?.message ?? "unknown"}
        </p>
      ) : (
        <MistologyCardList patterns={shown.patterns} entries={shown.entries} language={lang} />
      )}
    </div>
  );
}
