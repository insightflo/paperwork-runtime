// [파일 목적] Quality RSI & 실전 QA 현황판. 사람 개입을 최소화한 자동 자가개선 루프 모니터링.
// [외부 연결] ui/src/api/quality.ts, ui/src/components/QualityRsiPanel.tsx, server/src/routes/quality-rsi.ts.
import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ListChecks, RefreshCw, AlertTriangle } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { qualityApi, type QualityRsiSyncResult } from "../api/quality";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QualityRsiPanel } from "../components/QualityRsiPanel";

type Tab = "rsi" | "verdicts" | "open";
type Tone = "emerald" | "amber" | "crimson" | "cobalt" | "muted";

/* ── Cockpit vocabulary ──
 * Shared with the Work/Issues pages: 1-row strip, 40px toolbar, hairline rows and
 * semantic pills so verdict/outcome scanning needs no label reading. */
const TONE_DOT: Record<Tone, string> = {
  emerald: "bg-[#34d399]", amber: "bg-[#fbbf24]", crimson: "bg-[#f87171]", cobalt: "bg-[#5f8dff]", muted: "bg-[#8b97ad]",
};
const TONE_PILL: Record<Tone, string> = {
  emerald: "bg-[#34d399]/15 text-[#34d399]", amber: "bg-[#fbbf24]/15 text-[#fbbf24]", crimson: "bg-[#f87171]/15 text-[#f87171]",
  cobalt: "bg-[#5f8dff]/15 text-[#5f8dff]", muted: "bg-[#8b97ad]/15 text-[#8b97ad]",
};
const PILL_CLASS = "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide";
const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-[#151b28] aria-pressed:text-[#e6edf7] aria-pressed:shadow-[inset_0_0_0_1px_#242d3f] text-[#8b97ad] hover:text-[#e6edf7]";
const ROW_CLASS = "flex items-start gap-3 px-3 py-2 transition-colors hover:bg-[#151b28]";
const LIST_CLASS = "divide-y divide-[#242d3f] overflow-hidden rounded-md border border-[#242d3f] bg-[#111622]";
/** Child panels keep their own layout; only surfaces are re-skinned to cockpit hairlines. */
const cockpitRoundedCardOverrides =
  "[&_.border.rounded-lg]:rounded-md [&_.border.rounded-lg.border-border]:border-[#242d3f] [&_.border.rounded-lg.border-border]:bg-[#111622] [&_.border.rounded-lg.bg-card]:bg-[#111622] [&_.border.rounded-lg]:hover:bg-[#151b28]";

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function Pill({ tone, children, title }: { tone: Tone; children: string; title?: string }) {
  return <span title={title} className={cn(PILL_CLASS, TONE_PILL[tone])}>{children}</span>;
}

export function Quality() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const lang = useCompanyLanguage();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("rsi");
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [promotingSig, setPromotingSig] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: L(lang, { en: "Quality", ko: "품질 · QA RSI" }) }]);
  }, [setBreadcrumbs, lang]);

  const cid = selectedCompanyId ?? "";
  const queryKey = ["quality-rsi-overview", cid] as const;

  const { data: overview, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => qualityApi.rsiOverview(cid),
    enabled: !!cid,
  });

  const syncMut = useMutation({
    mutationFn: () => qualityApi.rsiSync(cid),
    onSuccess: (res: QualityRsiSyncResult) => {
      setErrorMsg(null);
      setNotice(
        L(lang, {
          en: `Synced: closed ${res.closedStaleItems} stale items, added ${res.createdPatterns} auto-RSI lessons.`,
          ko: `동기화 완료: 종료 미션 방치 ${res.closedStaleItems}건 정리, 신규 자동 RSI 교훈 ${res.createdPatterns}건 반영.`,
        }),
      );
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setErrorMsg(err instanceof Error ? err.message : String(err)),
  });

  const promoteMut = useMutation({
    mutationFn: (signature: string) => {
      setPromotingSig(signature);
      return qualityApi.rsiPromoteCanon(cid, signature);
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      setNotice(
        res.alreadyCanon
          ? L(lang, { en: "Already pinned as a ★ Standard Rule.", ko: "이미 ★ 표준 규약으로 등록되어 있습니다." })
          : L(lang, {
              en: "Pinned as a ★ Standard Rule (durable, 100% auto-injected to agents).",
              ko: "★ 표준 규약으로 고정되었습니다. 이제 만료 없이 100% 자동 주입됩니다.",
            }),
      );
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setErrorMsg(err instanceof Error ? err.message : String(err)),
    onSettled: () => setPromotingSig(null),
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={ListChecks}
        message={L(lang, { en: "Select a company to view Quality RSI.", ko: "회사를 선택하면 품질·QA 자가개선 현황을 볼 수 있습니다." })}
      />
    );
  }
  if (isLoading || !overview) return <PageSkeleton variant="list" />;

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: "rsi", label: L(lang, { en: "QA Self-Improvement", ko: "QA 자가개선 (RSI)" }), count: overview.clusters.length },
    { key: "verdicts", label: L(lang, { en: "Recent Plan QA", ko: "최근 Plan QA 판정" }), count: overview.recentVerdicts.length },
    { key: "open", label: L(lang, { en: "Open Items", ko: "열린 주의 항목" }), count: overview.openReviewItems.length },
  ];
  const stats = overview.stats;
  const stripCells: Array<{ label: string; value: string; tone: Tone; title: string }> = [
    { label: L(lang, { en: "Pass rate 30d", ko: "30일 통과율" }), value: formatPct(stats.passRate30d), tone: stats.passRate30d === null ? "muted" : "emerald",
      title: L(lang, { en: `All-time pass rate ${formatPct(stats.passRateAllTime)}`, ko: `전체 기간 통과율 ${formatPct(stats.passRateAllTime)}` }) },
    { label: L(lang, { en: "Pass 30d", ko: "30일 통과" }), value: String(stats.pass30d), tone: "emerald",
      title: L(lang, { en: `${stats.passAllTime} all-time`, ko: `전체 ${stats.passAllTime}건` }) },
    { label: L(lang, { en: "Rework 30d", ko: "30일 수정 요청" }), value: String(stats.requestChanges30d), tone: "amber",
      title: L(lang, { en: `${stats.requestChangesAllTime} all-time`, ko: `전체 ${stats.requestChangesAllTime}건` }) },
    { label: L(lang, { en: "Escaped defects", ko: "통과 후 결함" }), value: formatPct(stats.escapedDefectRate), tone: (stats.escapedDefectRate ?? 0) > 0 ? "crimson" : "muted",
      title: L(lang, { en: `${stats.escapedMissionsCount} / ${stats.passedMissionsTotal} passed missions`, ko: `통과 미션 ${stats.passedMissionsTotal}건 중 ${stats.escapedMissionsCount}건` }) },
    { label: L(lang, { en: "RSI lessons", ko: "RSI 교훈" }), value: String(stats.autoInjectedCount + stats.canonCount), tone: "cobalt",
      title: L(lang, { en: `${stats.autoInjectedCount} auto · ${stats.canonCount} ★ canon`, ko: `자동 주입 ${stats.autoInjectedCount} · ★ 표준 규약 ${stats.canonCount}` }) },
    { label: L(lang, { en: "Open items", ko: "주의 항목" }), value: String(stats.openReviewItemsCount), tone: stats.openReviewItemsCount > 0 ? "amber" : "muted",
      title: stats.staleReviewItemsCount > 0
        ? L(lang, { en: `${stats.staleReviewItemsCount} finished-mission items ready to close`, ko: `종료 미션 방치 ${stats.staleReviewItemsCount}건 자동 정리 대기` })
        : L(lang, { en: "Active missions only", ko: "진행 중인 미션 기준" }) },
  ];

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: QA pass/rework telemetry replaces the 4-card metrics grid */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label={L(lang, { en: "Quality RSI metrics", ko: "품질 RSI 지표" })}
        title={L(lang, { en: "Recurring Plan QA rejections and post-pass blind spots auto-graduate into Wiki lessons with minimal human intervention. Only pin rules that must be permanent as ★ Standard Rules.", ko: "반복되는 Plan QA 반려와 통과 후 미탐(구멍)은 사람 승인 없이 Wiki 교훈에 자동 반영됩니다. 꼭 영구 고정할 규칙만 ★ 표준 규약으로 지정하세요." })}>
        {stripCells.map((cell) => (
          <div key={cell.label} className="cockpit-cell min-w-0 flex-1 justify-center" title={cell.title}>
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[cell.tone]}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1">{cell.value}</b>
          </div>
        ))}
      </div>

      {/* Tight 40px toolbar: section tabs + the single mutating action */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div role="group" aria-label={L(lang, { en: "Quality sections", ko: "품질 섹션" })} className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
          {tabs.map((t) => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)} className={TAB_CLASS}>
              {t.label}
              <span className={cn("ml-1 font-mono text-[10px]", tab === t.key ? "text-[#5f8dff]" : "text-[#8b97ad]")}>{t.count}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={syncMut.isPending}
          onClick={() => syncMut.mutate()}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[#5f8dff]/50 bg-[#2563eb] px-2.5 text-xs font-semibold text-[#f8fafc] hover:bg-[#1d4ed8] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", syncMut.isPending && "animate-spin")} />
          {syncMut.isPending
            ? L(lang, { en: "Syncing...", ko: "동기화 중..." })
            : L(lang, { en: "Sync RSI Now", ko: "지금 RSI 동기화" })}
        </button>
      </div>

      {(error || errorMsg) && (
        <div className="flex items-center gap-2 rounded-md border border-[#f87171]/40 bg-[#f87171]/10 px-3 py-2 text-xs text-[#f87171]" role="alert">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{errorMsg ?? (error instanceof Error ? error.message : String(error))}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[#34d399]/30 bg-[#34d399]/10 px-3 py-2 text-xs text-[#34d399]" role="status">
          <span className="flex min-w-0 items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{notice}</span>
          </span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-[11px] underline">
            {L(lang, { en: "Dismiss", ko: "닫기" })}
          </button>
        </div>
      )}

      {tab === "rsi" && (
        <div className={cockpitRoundedCardOverrides}>
          <QualityRsiPanel
            overview={overview}
            promotingSig={promotingSig}
            onPromoteCanon={(sig) => promoteMut.mutate(sig)}
            language={lang}
          />
        </div>
      )}

      {tab === "verdicts" && (
        overview.recentVerdicts.length === 0 ? (
          <EmptyState icon={ListChecks} message={L(lang, { en: "No Plan QA verdicts recorded yet.", ko: "기록된 Plan QA 판정이 아직 없습니다." })} />
        ) : (
          <div className={LIST_CLASS}>
            {overview.recentVerdicts.map((v) => (
              <div key={v.id} className={ROW_CLASS}>
                <Pill tone={v.verdict === "pass" ? "emerald" : "amber"}>
                  {v.verdict === "pass" ? L(lang, { en: "PASS", ko: "통과" }) : L(lang, { en: "REWORK", ko: "수정 요청" })}
                </Pill>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <Link to={`/missions/${v.missionId}`} className="min-w-0 truncate text-xs font-medium text-[#e6edf7] hover:underline">
                      {v.missionTitle}
                    </Link>
                    <span className="shrink-0 font-mono text-[10px] text-[#8b97ad]">{v.diagnosticCount} dx</span>
                  </div>
                  {v.topDetail && <p className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#b6c2d6]">{v.topDetail}</p>}
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[#8b97ad]">{v.createdAt.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )
      )}

      {tab === "open" && (
        overview.openReviewItems.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            message={
              stats.staleReviewItemsCount > 0
                ? L(lang, {
                    en: `No active-mission issues. Click "Sync RSI Now" to auto-close ${stats.staleReviewItemsCount} stale items from finished missions.`,
                    ko: `진행 중인 미션에 열린 주의 항목이 없습니다. "지금 RSI 동기화"를 누르면 이미 끝난 미션의 방치 항목 ${stats.staleReviewItemsCount}건이 자동 정리됩니다.`,
                  })
                : L(lang, { en: "No open review items on active missions.", ko: "진행 중인 미션에 열린 주의 항목이 없습니다." })
            }
          />
        ) : (
          <div className={LIST_CLASS}>
            {overview.openReviewItems.map((item) => (
              <div key={item.id} className={ROW_CLASS}>
                <Pill tone="amber">{item.triggerSource}</Pill>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-[#e6edf7]">{item.title}</p>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#8b97ad]">
                    {item.missionId && (
                      <Link to={`/missions/${item.missionId}`} className="min-w-0 truncate underline">
                        {item.missionTitle ?? item.missionId.slice(0, 8)}
                      </Link>
                    )}
                    {item.failureType && <Pill tone="crimson">{item.failureType}</Pill>}
                    <span>{item.status}</span>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[#8b97ad]">{item.createdAt.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
