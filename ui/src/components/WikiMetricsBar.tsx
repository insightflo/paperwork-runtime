// ui/src/components/WikiMetricsBar.tsx
//
// [파일 목적] Mistology 기록·지표 요약 스트립 (읽기 전용 — 뮤테이션·승인 없음).
//   knowledge-patterns 카드 + agent-wiki entries DTO만으로 파생한 순수 집계를
//   회사/전역 설정 언어(en/ko)에 맞춰 렌더한다.
// [연결] mount: ui/src/pages/AgentWiki.tsx. DTO: api/knowledgePatterns, api/agentWiki.
import { Activity } from "lucide-react";
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { cn } from "../lib/utils";

export interface WikiMetricsBarProps {
  patterns: KnowledgePatternCardDto[];
  entries: AgentWikiEntryDto[];
  language?: CompanyDefaultLanguage;
}

const isLive = (p: KnowledgePatternCardDto): boolean => p.status === "active" && !p.supersededById;
const isRetired = (p: KnowledgePatternCardDto): boolean =>
  !!p.supersededById || p.status === "retired" || p.status === "superseded";
const hasEntity = (p: KnowledgePatternCardDto): boolean =>
  (p.files?.length ?? 0) > 0 || (p.symbols?.length ?? 0) > 0;

const PANEL =
  "tactile-card relative overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const MUTED = "text-slate-500 dark:text-[#8b97ad]";

interface Metric {
  label: string;
  value: string;
  hint?: string;
  dot: string;
}

export function WikiMetricsBar({ patterns, entries, language }: WikiMetricsBarProps) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;

  const metrics: Metric[] = [
    {
      label: L(lang, { en: "Active Mistakes (failure_mode)", ko: "활성 오답 (failure_mode)" }),
      value: String(patterns.filter((p) => p.kind === "failure_mode" && isLive(p)).length),
      hint: "30d TTL",
      dot: "bg-rose-500 shadow-[0_0_7px_rgba(244,63,94,0.35)] dark:bg-[#f43f5e]",
    },
    {
      label: L(lang, { en: "Durable Rules & Recipes", ko: "내구 규약·레시피" }),
      value: String(
        patterns.filter((p) => (p.kind === "constraint" || p.kind === "success_recipe") && isLive(p)).length,
      ),
      hint: L(lang, { en: "durable", ko: "영속" }),
      dot: "bg-lime-500 shadow-[0_0_7px_rgba(163,230,53,0.35)] dark:bg-[#a3e635]",
    },
    {
      label: L(lang, { en: "Retired / Superseded", ko: "폐기·대체됨" }),
      value: String(patterns.filter(isRetired).length),
      dot: "bg-slate-400 dark:bg-[#627089]",
    },
    {
      label: L(lang, { en: "Active Wiki Lessons", ko: "활성 Wiki 교훈" }),
      value: String(entries.filter((e) => e.status === "active").length),
      dot: "bg-blue-500 shadow-[0_0_7px_rgba(96,165,250,0.32)] dark:bg-[#60a5fa]",
    },
    {
      label: L(lang, { en: "Entity Coupling Coverage", ko: "엔터티 결합 커버리지" }),
      value: `${patterns.filter(hasEntity).length}/${patterns.length}`,
      dot: "bg-amber-500 shadow-[0_0_7px_rgba(245,158,11,0.32)] dark:bg-[#f59e0b]",
    },
  ];

  const empty = patterns.length === 0 && entries.length === 0;

  return (
    <section aria-label="Wiki records and metrics" className={cn(PANEL, "px-4 py-3 tabular-nums")}>
      <div aria-hidden className="pointer-events-none absolute bottom-4 left-0 top-4 w-px bg-gradient-to-b from-blue-500/60 via-blue-500/15 to-transparent dark:from-[#60a5fa]/80 dark:via-[#60a5fa]/15" />
      <div className="relative flex items-center justify-between gap-2 border-b border-slate-200/80 pb-2.5 dark:border-white/[0.07]">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-200/80 bg-slate-50 text-blue-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#60a5fa]">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">{L(lang, { en: "Records & Metrics", ko: "기록 · 지표" })}</span>
        </h2>
        <span className="shrink-0 rounded-full border border-lime-600/20 bg-lime-500/10 px-2 py-0.5 text-[10px] font-medium text-lime-800 dark:border-[#a3e635]/25 dark:bg-[#a3e635]/10 dark:text-[#a3e635]">
          {L(lang, { en: "read-only · auto-collected", ko: "read-only · 자동 수집" })}
        </span>
      </div>

      {empty ? (
        <p className={cn(INSET, "relative mt-3 px-3 py-2.5 text-xs leading-relaxed", MUTED)}>
          {L(lang, {
            en: "No records yet — metrics will populate automatically as mistakes and rules are collected.",
            ko: "아직 수집된 기록이 없습니다 — 오답·규약이 자동 수집되면 지표가 채워집니다.",
          })}
        </p>
      ) : (
        <div className="relative mt-3 grid gap-2">
          {metrics.map((m) => (
            <div key={m.label} className={cn(INSET, "flex min-w-0 items-start gap-2.5 px-3 py-2")}>
              <span aria-hidden className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", m.dot)} />
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[10px] font-semibold uppercase tracking-[0.12em]", MUTED)} title={m.label}>{m.label}</p>
                <p className="mt-0.5 font-mono text-lg font-semibold leading-none tracking-tight text-slate-950 tabular-nums dark:text-[#eef2f8]">
                  {m.value}
                  {m.hint ? (
                    <span className="ml-1.5 rounded-full border border-slate-200/80 bg-white px-1.5 py-0.5 align-middle font-sans text-[10px] font-medium text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]">
                      {m.hint}
                    </span>
                  ) : null}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
