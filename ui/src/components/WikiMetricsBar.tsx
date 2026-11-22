// ui/src/components/WikiMetricsBar.tsx
//
// [파일 목적] Mistology 기록·지표 요약 스트립 (읽기 전용 — 뮤테이션·승인 없음).
//   knowledge-patterns 카드 + agent-wiki entries DTO만으로 파생한 순수 집계를 렌더한다.
//   기록 모델: 자동 수집·중복 제거, failure_mode는 30d TTL, constraint/success_recipe는 durable.
// [연결] mount: ui/src/pages/AgentWiki.tsx. DTO: api/knowledgePatterns, api/agentWiki.
import { Activity } from "lucide-react";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";

export interface WikiMetricsBarProps {
  patterns: KnowledgePatternCardDto[];
  entries: AgentWikiEntryDto[];
}

// live = status 'active'이며 대체되지 않은 카드 (draft는 미승인 잔재로 live/retired 어디에도 안 친다).
const isLive = (p: KnowledgePatternCardDto): boolean => p.status === "active" && !p.supersededById;
// retired/superseded = status가 retired·superseded이거나 supersededById가 박힌 카드.
const isRetired = (p: KnowledgePatternCardDto): boolean =>
  !!p.supersededById || p.status === "retired" || p.status === "superseded";
// files/symbols 구조화 결합이 하나라도 붙은 카드 (DTO optional 필드 — 없으면 0으로 집계).
const hasEntity = (p: KnowledgePatternCardDto): boolean =>
  (p.files?.length ?? 0) > 0 || (p.symbols?.length ?? 0) > 0;

interface Metric {
  label: string;
  value: string;
  hint?: string;
}

export function WikiMetricsBar({ patterns, entries }: WikiMetricsBarProps) {
  const metrics: Metric[] = [
    {
      label: "활성 오답 (failure_mode)",
      value: String(patterns.filter((p) => p.kind === "failure_mode" && isLive(p)).length),
      hint: "30d TTL",
    },
    {
      label: "내구 규약·레시피",
      value: String(
        patterns.filter((p) => (p.kind === "constraint" || p.kind === "success_recipe") && isLive(p)).length,
      ),
      hint: "durable",
    },
    {
      label: "폐기·대체됨",
      value: String(patterns.filter(isRetired).length),
    },
    {
      label: "활성 Wiki 교훈",
      value: String(entries.filter((e) => e.status === "active").length),
    },
    {
      label: "엔터티 결합 커버리지",
      value: `${patterns.filter(hasEntity).length}/${patterns.length}`,
    },
  ];

  const empty = patterns.length === 0 && entries.length === 0;

  return (
    <section aria-label="Wiki records and metrics" className="rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" /> Records &amp; Metrics
        </h2>
        <span className="text-[11px] text-muted-foreground">read-only · 자동 수집</span>
      </div>

      {empty ? (
        <p className="mt-2 text-xs text-muted-foreground">
          아직 수집된 기록이 없습니다 — 오답·규약이 자동 수집되면 지표가 채워집니다.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {metrics.map((m) => (
            <div key={m.label} className="min-w-0">
              <p className="text-sm font-semibold tabular-nums">
                {m.value}
                {m.hint ? (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[10px] font-medium text-muted-foreground">
                    {m.hint}
                  </span>
                ) : null}
              </p>
              <p className="text-[11px] text-muted-foreground">{m.label}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
