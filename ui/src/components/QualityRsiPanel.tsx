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
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f59e0b]/40 bg-[#f59e0b]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#92400e] dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#d97706] dark:bg-[#f59e0b]" />
        {L(lang, { en: "★ Standard Rule (100% injected)", ko: "★ 표준 규약 (100% 주입)" })}
      </span>
    );
  }
  if (status === "auto_injected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#a3e635]/45 bg-[#a3e635]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#3f6212] dark:bg-[#a3e635]/10 dark:text-[#a3e635]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#65a30d] dark:bg-[#a3e635]" />
        {L(lang, { en: "Auto-injected to Wiki", ko: "Wiki 자동 주입 중" })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300/80 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#8f9db3]">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-[#8f9db3]" />
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
      dot: "bg-[#65a30d] dark:bg-[#a3e635]",
      valueClass: "text-[#3f6212] dark:text-[#a3e635]",
    },
    {
      label: L(lang, { en: "QA Escaped Defect Rate", ko: "QA 미탐률 (통과 후 실패)" }),
      value: formatPct(stats.escapedDefectRate),
      sub: L(lang, {
        en: `${stats.escapedMissionsCount} / ${stats.passedMissionsTotal} passed missions`,
        ko: `통과 미션 ${stats.passedMissionsTotal}건 중 ${stats.escapedMissionsCount}건`,
      }),
      dot: "bg-[#e11d48] dark:bg-[#f43f5e]",
      valueClass: "text-[#be123c] dark:text-[#f43f5e]",
    },
    {
      label: L(lang, { en: "Auto-Synced RSI Lessons", ko: "자동 반영된 RSI 교훈" }),
      value: String(stats.autoInjectedCount + stats.canonCount),
      sub: L(lang, {
        en: `${stats.autoInjectedCount} auto · ${stats.canonCount} ★ canon`,
        ko: `자동 주입 ${stats.autoInjectedCount} · ★ 표준 규약 ${stats.canonCount}`,
      }),
      dot: "bg-[#2563eb] dark:bg-[#60a5fa]",
      valueClass: "text-[#1d4ed8] dark:text-[#60a5fa]",
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
      dot: "bg-[#d97706] dark:bg-[#f59e0b]",
      valueClass: "text-[#92400e] dark:text-[#f59e0b]",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" aria-label="Quality RSI metrics">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-[12px] border border-slate-200/90 bg-white/85 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-14px_rgba(0,0,0,0.7)]"
        >
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500 dark:text-[#8f9db3]">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
            <span className="truncate">{c.label}</span>
          </div>
          <div className={`mt-1.5 text-xl font-semibold leading-none tabular-nums ${c.valueClass}`}>{c.value}</div>
          <div className="mt-1.5 text-[11px] leading-4 text-slate-500 tabular-nums dark:text-[#8f9db3]">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

const AXIS_ACCENT: Record<QualityRsiCluster["axis"], string> = {
  qa_self: "border-l-[#60a5fa]",
  worker: "border-l-[#f59e0b]",
};

export function QualityRsiPanel({ overview, promotingSig, onPromoteCanon, language }: QualityRsiPanelProps) {
  const ctxLang = useCompanyLanguage();
  const lang = language ?? ctxLang;
  const qaSelf = overview.clusters.filter((c) => c.axis === "qa_self");
  const worker = overview.clusters.filter((c) => c.axis === "worker");

  if (overview.clusters.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-slate-300/90 bg-slate-50/80 px-4 py-8 text-center text-sm leading-6 text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12]/70 dark:text-[#8f9db3]">
        <span aria-hidden className="mx-auto mb-3 block h-2 w-2 rounded-full bg-[#60a5fa] shadow-[0_0_18px_rgba(96,165,250,0.6)]" />
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
      <section className="space-y-2.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600 dark:text-[#8f9db3]">{title}</h2>
            <p className="mt-1 text-[12px] leading-5 text-slate-500 dark:text-[#8f9db3]">{subtitle}</p>
          </div>
          <span className="rounded-full border border-slate-300/80 bg-white/75 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-500 tabular-nums dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3]">
            {list.length}
          </span>
        </div>
        <div className="space-y-2">
          {list.map((c) => (
            <div
              key={c.signature}
              className={`space-y-2.5 rounded-[12px] border border-l-[3px] border-slate-200/90 bg-white/88 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-14px_rgba(0,0,0,0.7)] ${AXIS_ACCENT[c.axis]}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold tracking-tight text-slate-800 dark:text-[#eef2f8]">{c.title}</span>
                  <span className="rounded-full border border-slate-300/80 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 tabular-nums dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#8f9db3]">
                    {L(lang, { en: `${c.count}x`, ko: `${c.count}회` })}
                  </span>
                  <StatusBadge status={c.rsiStatus} lang={lang} />
                </div>
                {c.rsiStatus !== "canon" && onPromoteCanon && (
                  <button
                    type="button"
                    disabled={promotingSig === c.signature}
                    onClick={() => onPromoteCanon(c.signature)}
                    className="rounded-md border border-[#f59e0b]/45 bg-[#f59e0b]/12 px-2.5 py-1 text-[11px] font-semibold text-[#92400e] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-colors duration-150 hover:bg-[#f59e0b]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f59e0b]/45 disabled:opacity-50 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b] dark:hover:bg-[#f59e0b]/15"
                  >
                    {promotingSig === c.signature
                      ? L(lang, { en: "Promoting...", ko: "등록 중..." })
                      : L(lang, { en: "Pin as ★ Standard Rule", ko: "★ 표준 규약으로 고정" })}
                  </button>
                )}
              </div>
              <p className="text-xs leading-5 text-slate-500 dark:text-[#8f9db3]">{c.summary}</p>
              {c.samples.length > 0 && (
                <div className="space-y-1.5 rounded-[10px] border border-slate-200/80 bg-slate-50/80 px-2.5 py-2 dark:border-white/[0.06] dark:bg-[#090c12]/75">
                  {c.samples.map((s, idx) => (
                    <div key={`${c.signature}:${idx}`} className="font-mono text-[11px] leading-4 text-slate-500 dark:text-[#8f9db3]">
                      <span className="font-semibold text-slate-700 dark:text-[#eef2f8]">{s.missionTitle}</span>
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
