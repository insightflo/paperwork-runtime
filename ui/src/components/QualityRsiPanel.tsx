// [파일 목적] Quality RSI 요약 지표 바 + 양방향 자가개선(QA 자체 미탐 보강 + 작업자 반복 반려) 패널.
// [외부 연결] ui/src/pages/Quality.tsx, ui/src/lib/companyLanguage.ts.
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import type { QualityRsiCluster, QualityRsiOverview } from "../api/quality";

interface QualityRsiPanelProps {
  overview: QualityRsiOverview;
  promotingSig?: string | null;
  onPromoteCanon?: (signature: string) => void;
  language?: CompanyDefaultLanguage;
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function StatusBadge({ status, lang }: { status: QualityRsiCluster["rsiStatus"]; lang: CompanyDefaultLanguage }) {
  if (status === "canon") {
    return (
      <span className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        {L(lang, { en: "★ Standard Rule (100% injected)", ko: "★ 표준 규약 (100% 주입)" })}
      </span>
    );
  }
  if (status === "auto_injected") {
    return (
      <span className="inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        {L(lang, { en: "Auto-injected to Wiki", ko: "Wiki 자동 주입 중" })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {L(lang, { en: "Observing (auto at 2+)", ko: "관측 중 (2회부터 자동 반영)" })}
    </span>
  );
}

export function QualityRsiMetrics({
  stats,
  language,
}: {
  stats: QualityRsiOverview["stats"];
  language?: CompanyDefaultLanguage;
}) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;
  const cards = [
    {
      label: L(lang, { en: "Plan QA Pass Rate (30d)", ko: "Plan QA 통과율 (30일)" }),
      value: formatPct(stats.passRate30d),
      sub: L(lang, {
        en: `${stats.pass30d} pass · ${stats.requestChanges30d} rework (all: ${formatPct(stats.passRateAllTime)})`,
        ko: `통과 ${stats.pass30d} · 반려 ${stats.requestChanges30d} (전체 ${formatPct(stats.passRateAllTime)})`,
      }),
    },
    {
      label: L(lang, { en: "QA Escaped Defect Rate", ko: "QA 미탐률 (통과 후 실패)" }),
      value: formatPct(stats.escapedDefectRate),
      sub: L(lang, {
        en: `${stats.escapedMissionsCount} / ${stats.passedMissionsTotal} passed missions`,
        ko: `통과 미션 ${stats.passedMissionsTotal}건 중 ${stats.escapedMissionsCount}건`,
      }),
    },
    {
      label: L(lang, { en: "Auto-Synced RSI Lessons", ko: "자동 반영된 RSI 교훈" }),
      value: String(stats.autoInjectedCount + stats.canonCount),
      sub: L(lang, {
        en: `${stats.autoInjectedCount} auto · ${stats.canonCount} ★ canon`,
        ko: `자동 주입 ${stats.autoInjectedCount} · ★ 표준 규약 ${stats.canonCount}`,
      }),
    },
    {
      label: L(lang, { en: "Open Review Items", ko: "진행 중 주의 항목" }),
      value: String(stats.openReviewItemsCount),
      sub:
        stats.staleReviewItemsCount > 0
          ? L(lang, {
              en: `${stats.staleReviewItemsCount} finished-mission items ready to close`,
              ko: `종료 미션 방치 ${stats.staleReviewItemsCount}건 자동 정리 대기`,
            })
          : L(lang, { en: "Active missions only", ko: "진행 중인 미션 기준" }),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" aria-label="Quality RSI metrics">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div className="text-[11px] text-muted-foreground">{c.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{c.value}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

export function QualityRsiPanel({ overview, promotingSig, onPromoteCanon, language }: QualityRsiPanelProps) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;
  const qaSelf = overview.clusters.filter((c) => c.axis === "qa_self");
  const worker = overview.clusters.filter((c) => c.axis === "worker");

  if (overview.clusters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {L(lang, {
          en: "No recurring Plan QA rejections or QA blind spots detected yet. New patterns will auto-graduate into Wiki lessons at 2+ occurrences.",
          ko: "아직 반복되는 Plan QA 반려나 QA 미탐 패턴이 없습니다. 같은 패턴이 2회 이상 쌓이면 사람 승인 없이 자동으로 Wiki 교훈에 반영됩니다.",
        })}
      </div>
    );
  }

  const renderSection = (title: string, subtitle: string, list: QualityRsiCluster[]) => {
    if (list.length === 0) return null;
    return (
      <section className="space-y-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
          <p className="text-[12px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="space-y-2">
          {list.map((c) => (
            <div key={c.signature} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
                    {L(lang, { en: `${c.count}x`, ko: `${c.count}회` })}
                  </span>
                  <StatusBadge status={c.rsiStatus} lang={lang} />
                </div>
                {c.rsiStatus !== "canon" && onPromoteCanon && (
                  <button
                    type="button"
                    disabled={promotingSig === c.signature}
                    onClick={() => onPromoteCanon(c.signature)}
                    className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
                  >
                    {promotingSig === c.signature
                      ? L(lang, { en: "Promoting...", ko: "등록 중..." })
                      : L(lang, { en: "Pin as ★ Standard Rule", ko: "★ 표준 규약으로 고정" })}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{c.summary}</p>
              {c.samples.length > 0 && (
                <div className="space-y-1 border-t border-border/60 pt-2">
                  {c.samples.map((s, idx) => (
                    <div key={`${c.signature}:${idx}`} className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{s.missionTitle}</span>
                      {" — "}
                      <span>{s.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-5">
      {renderSection(
        L(lang, { en: "QA Self-Improvement (Blind Spots)", ko: "QA 자체 개선 (미탐·구멍 보강)" }),
        L(lang, {
          en: "Missions that passed Plan QA but later failed or were cancelled. Auto-injected into Plan QA prompts at 2+ occurrences.",
          ko: "Plan QA를 통과했지만 이후 취소·후속 실패로 이어진 패턴입니다. 2회 이상 누적되면 Plan QA 체크리스트 교훈으로 자동 주입됩니다.",
        }),
        qaSelf,
      )}
      {renderSection(
        L(lang, { en: "Worker Self-Improvement (Recurring Rejections)", ko: "작업자 개선 (반복 반려 패턴)" }),
        L(lang, {
          en: "Diagnostics repeatedly caught by Plan QA. Auto-injected into worker heartbeats at 2+ occurrences to prevent rework.",
          ko: "Plan QA에서 반복적으로 반려되는 원인입니다. 2회 이상 누적되면 작업자 프롬프트에 자동 주입되어 재작업을 줄입니다.",
        }),
        worker,
      )}
    </div>
  );
}
