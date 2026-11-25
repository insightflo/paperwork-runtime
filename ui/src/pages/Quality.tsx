// [파일 목적] Quality RSI & 실전 QA 현황판. 사람 개입을 최소화한 자동 자가개선 루프 모니터링.
// [외부 연결] ui/src/api/quality.ts, ui/src/components/QualityRsiPanel.tsx, server/src/routes/quality-rsi.ts.
import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ListChecks, RefreshCw, Sparkles, AlertTriangle } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { qualityApi, type QualityRsiSyncResult } from "../api/quality";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QualityRsiMetrics, QualityRsiPanel } from "../components/QualityRsiPanel";

type Tab = "rsi" | "verdicts" | "open";

const cockpitRoundedCardOverrides = "[&_.border.rounded-lg]:rounded-md [&_.border.rounded-lg.border-border]:border-border/80 [&_.border.rounded-lg.border-border]:bg-card/60";

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

  return (
    <div className="space-y-4 tabular-nums">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="h-4 w-4 text-amber-500" />
            {L(lang, { en: "Quality · Autonomous QA RSI", ko: "품질 · 자율 QA 자가개선 (RSI)" })}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {L(lang, {
              en: "Recurring Plan QA rejections and post-pass blind spots auto-graduate into Wiki lessons with minimal human intervention.",
              ko: "반복되는 Plan QA 반려와 통과 후 미탐(구멍)은 사람 승인 없이 Wiki 교훈에 자동 반영됩니다. 꼭 영구 고정할 규칙만 ★ 표준 규약으로 지정하세요.",
            })}
          </p>
        </div>
        <button
          type="button"
          disabled={syncMut.isPending}
          onClick={() => syncMut.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/70 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", syncMut.isPending && "animate-spin")} />
          {syncMut.isPending
            ? L(lang, { en: "Syncing...", ko: "동기화 중..." })
            : L(lang, { en: "Sync RSI Now", ko: "지금 RSI 동기화" })}
        </button>
      </div>

      {(error || errorMsg) && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{errorMsg ?? (error instanceof Error ? error.message : String(error))}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            {notice}
          </span>
          <button type="button" onClick={() => setNotice(null)} className="text-[11px] underline">
            {L(lang, { en: "Dismiss", ko: "닫기" })}
          </button>
        </div>
      )}

      <div className={cockpitRoundedCardOverrides}>
        <QualityRsiMetrics stats={overview.stats} language={lang} />
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              tab === t.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {t.label} <span className="ml-1 tabular-nums opacity-75">({t.count})</span>
          </button>
        ))}
      </div>

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
          <div className="space-y-2">
            {overview.recentVerdicts.map((v) => (
              <div key={v.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border/80 bg-card/60 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium",
                        v.verdict === "pass"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "bg-orange-500/15 text-orange-700 dark:text-orange-400",
                      )}
                    >
                      {v.verdict === "pass" ? L(lang, { en: "PASS", ko: "통과" }) : L(lang, { en: "REWORK", ko: "수정 요청" })}
                    </span>
                    <Link to={`/missions/${v.missionId}`} className="truncate text-sm font-medium hover:underline">
                      {v.missionTitle}
                    </Link>
                  </div>
                  {v.topDetail && <p className="text-xs text-muted-foreground">{v.topDetail}</p>}
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">{v.createdAt.slice(0, 10)}</span>
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
              overview.stats.staleReviewItemsCount > 0
                ? L(lang, {
                    en: `No active-mission issues. Click "Sync RSI Now" to auto-close ${overview.stats.staleReviewItemsCount} stale items from finished missions.`,
                    ko: `진행 중인 미션에 열린 주의 항목이 없습니다. "지금 RSI 동기화"를 누르면 이미 끝난 미션의 방치 항목 ${overview.stats.staleReviewItemsCount}건이 자동 정리됩니다.`,
                  })
                : L(lang, { en: "No open review items on active missions.", ko: "진행 중인 미션에 열린 주의 항목이 없습니다." })
            }
          />
        ) : (
          <div className="space-y-2">
            {overview.openReviewItems.map((item) => (
              <div key={item.id} className="rounded-md border border-border/80 bg-card/60 px-3 py-2.5 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                    {item.triggerSource}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  {item.missionId && (
                    <Link to={`/missions/${item.missionId}`} className="underline">
                      {item.missionTitle ?? item.missionId.slice(0, 8)}
                    </Link>
                  )}
                  {item.failureType && <span>{item.failureType}</span>}
                  <span className="tabular-nums">{item.createdAt.slice(0, 10)}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
