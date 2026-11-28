import { useEffect, useState } from "react";
import { Link } from "../lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RefreshCw, UserRoundCheck } from "lucide-react";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
import { missionsApi, type MissionHumanOperatorRequest } from "../api/missions";
import { operatorDecisionsApi, type ResolveOperatorDecisionInput } from "../api/operator-decisions";
import { ExternalAutomationApprovals } from "../components/ExternalAutomationApprovals";
import { EmptyState } from "../components/EmptyState";
import { OperatorDecisionCard } from "../components/OperatorDecisionCard";
import { CardHumanSummary } from "../components/CardHumanSummary";
import { hasCompactOperatorSummary, hasCompactSymptom } from "../components/HumanReviewPacket";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import {
  selectHumanOperatorSurface,
  type HumanOperatorLifecycle,
  type HumanOperatorRequestStateProblem,
  type HumanOperatorScope,
  type HumanOperatorSurfaceSection,
} from "../lib/human-operator-surface";

/* ── Cockpit vocabulary (shared with Work/Issues/Approvals): 1-row strip, 40px toolbar, hairline rows, semantic pills.
 * Every data-* hook and label string below is a test/audit contract. */
const HAIRLINE_ROW = "rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50 dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] dark:hover:bg-[#141b29]";
const PILL_CLASS = "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide";
const BADGE_PILL = cn(PILL_CLASS, "border border-slate-200/80 bg-slate-100/80 text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]");
const ATTENTION_TONE = { needed: "bg-amber-500/10 text-amber-700 dark:bg-[#f59e0b]/15 dark:text-[#f59e0b]", none: "bg-lime-500/10 text-lime-700 dark:bg-[#a3e635]/15 dark:text-[#a3e635]", unknown: "bg-slate-500/10 text-slate-500 dark:bg-[#8b97ad]/15 dark:text-[#8b97ad]" } as const;
const EVIDENCE_TEXT = "whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-600 dark:text-[#b6c2d6]";
const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors text-slate-500 hover:text-slate-950 aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.1)] dark:text-[#8b97ad] dark:hover:text-[#edf2fb] dark:aria-pressed:bg-[#151d2b] dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]";

function formatRequestTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function missionLink(request: MissionHumanOperatorRequest): string {
  const query = request.issueId ? `?issue=${encodeURIComponent(request.issueId)}` : "";
  return `/missions/${request.missionId}${query}`;
}

const REQUEST_STATE_LABELS = {
  legacy: { en: "Decision state not provided by this server", ko: "이 서버 응답에 결정 상태가 없습니다" }, malformed: { en: "Decision state format is unknown", ko: "결정 상태 형식을 확인할 수 없습니다" },
  "scope-conflict": { en: "Request scope needs review", ko: "요청 범위를 확인해야 합니다" }, "card-conflict": { en: "Decision/card details conflict", ko: "결정과 카드 정보가 일치하지 않습니다" },
  "duplicate-decision": { en: "Decision identity is ambiguous", ko: "결정 연결이 모호합니다" }, unknown: { en: "Decision state is unknown", ko: "결정 상태를 알 수 없습니다" },
  missing: { en: "No exact decision found", ko: "정확히 연결된 결정을 찾지 못했습니다" }, ambiguous: { en: "Decision link is ambiguous", ko: "결정 연결이 모호합니다" },
  unsupported: { en: "Unsupported decision record", ko: "지원하지 않는 결정 기록입니다" }, pending: { en: "Direction pending", ko: "방향 선택 대기" },
  "pending-nocard": { en: "Direction pending · card not loaded", ko: "방향 결정 대기 · 카드 미조회" }, resolved: { en: "Direction decided", ko: "방향 결정됨" },
  cancelled: { en: "Direction cancelled", ko: "방향 결정 취소됨" },
} as const;

function requestStateLabel(lang: ReturnType<typeof useCompanyLanguage>, state: HumanOperatorRequestStateV1 | null,
  problem: HumanOperatorRequestStateProblem | null, hasCard: boolean): string {
  if (problem) return L(lang, REQUEST_STATE_LABELS[problem]);
  if (!state) return L(lang, REQUEST_STATE_LABELS.unknown);
  if (state.identity !== "exact") return L(lang, REQUEST_STATE_LABELS[state.identity]);
  if (state.decision?.status === "pending") return L(lang, hasCard ? REQUEST_STATE_LABELS.pending : REQUEST_STATE_LABELS["pending-nocard"]);
  if (state.decision?.status === "resolved") return L(lang, REQUEST_STATE_LABELS.resolved);
  return L(lang, REQUEST_STATE_LABELS.cancelled);
}

const CONTINUATION_LABELS: Record<string, { en: string; ko: string }> = {
  pending: { en: "Follow-up pending", ko: "후속 실행 대기" }, dispatching: { en: "Follow-up dispatching", ko: "후속 실행 전달 중" }, blocked: { en: "Follow-up blocked", ko: "후속 실행 차단" },
  exhausted: { en: "Follow-up attempts exhausted", ko: "후속 실행 시도 한도 도달" }, queued: { en: "Follow-up queued", ko: "후속 실행 대기열" }, deferred: { en: "Follow-up deferred", ko: "후속 실행 대기" },
  running: { en: "Follow-up running", ko: "후속 실행 중" }, coalesced: { en: "Follow-up joined an existing run", ko: "기존 실행에 연결됨" }, completed: { en: "Follow-up completed", ko: "후속 실행 완료" },
  skipped: { en: "Follow-up skipped", ko: "후속 실행 건너뜀" }, failed: { en: "Follow-up failed", ko: "후속 실행 실패" }, cancelled: { en: "Follow-up cancelled", ko: "후속 실행 취소" },
  timed_out: { en: "Follow-up timed out", ko: "후속 실행 시간 초과" }, agent_unrunnable: { en: "Target agent cannot run", ko: "대상 에이전트를 실행할 수 없음" },
  assignee_changed: { en: "Issue assignee changed", ko: "이슈 담당자가 변경됨" }, issue_terminal: { en: "Issue is terminal", ko: "이슈가 종료 상태임" },
};

function continuationStatusLabel(lang: ReturnType<typeof useCompanyLanguage>, status: string): string {
  const label = CONTINUATION_LABELS[status];
  return label ? L(lang, label) : L(lang, { en: "Follow-up state unknown", ko: "후속 실행 상태를 알 수 없음" });
}

function AttentionPill({ value }: { value: "needed" | "none" | "unknown" }) {
  const lang = useCompanyLanguage();
  const text = { needed: { en: "Follow-up attention needed", ko: "후속 실행 확인 필요" }, none: { en: "No follow-up attention reported", ko: "후속 실행 주의 신호 없음" }, unknown: { en: "Attention unknown", ko: "주의 여부 미확인" } }[value];
  return <span data-human-operator-attention={value} className={cn(PILL_CLASS, ATTENTION_TONE[value])}>{L(lang, text)}</span>;
}

function RequestDecisionState({ state }: { state: HumanOperatorRequestStateV1 }) {
  const lang = useCompanyLanguage();
  if (state.identity !== "exact" || !state.decision) return null;
  const decision = state.decision;
  const result = decision.result;
  const continuation = state.continuation;
  return (
    <section aria-live="polite" data-human-operator-request-state={decision.status} className="mt-2 space-y-1.5 border-t border-slate-200/80 dark:border-white/[0.08] pt-2 text-xs">
      <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Owner action issue", ko: "조치 소유 이슈" })}</dt>
        <dd data-owner-action-issue-id className={EVIDENCE_TEXT}>{state.ownerActionIssueId}</dd>
        <dt className="text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Source/navigation issue", ko: "원천·탐색 이슈" })}</dt>
        <dd data-source-issue-id className={EVIDENCE_TEXT}>{state.sourceIssueId ?? L(lang, { en: "None recorded", ko: "기록된 원천 이슈 없음" })}</dd>
      </dl>
      {decision.status === "resolved" && result && (
        <div data-human-operator-decision-result className={EVIDENCE_TEXT}>
          <p><span className="font-semibold text-slate-950 dark:text-[#edf2fb]">{L(lang, { en: "Selected result", ko: "선택 결과" })}:</span> {result.actionId} · {result.outcome}</p>
          {result.selectedOptionIds.length > 0 && <p>{L(lang, { en: "Selected options", ko: "선택 항목" })}: {result.selectedOptionIds.join(", ")}</p>}
          {result.comment && <p>{L(lang, { en: "Recorded comment", ko: "기록된 메모" })}: {result.comment}</p>}
        </div>
      )}
      {decision.status === "cancelled" && <p className="text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "This decision was cancelled.", ko: "이 결정은 취소되었습니다." })}</p>}
      {decision.status !== "pending" && (
        <div data-human-operator-continuation className="space-y-0.5">
          <p className="font-semibold text-slate-950 dark:text-[#edf2fb]">{L(lang, { en: "Native follow-up state", ko: "후속 실행 상태" })}</p>
          {!continuation
            ? <p className={EVIDENCE_TEXT}>{decision.continuationMode === "none" ? L(lang, { en: "No automatic follow-up is expected.", ko: "자동 후속 실행 대상이 아닙니다." }) : L(lang, { en: "Follow-up evidence needs review.", ko: "후속 실행 증거 확인 필요" })}</p>
            : <div className={EVIDENCE_TEXT}>
              <p>{continuationStatusLabel(lang, continuation.effectiveStatus)} · {continuation.state}</p>
              <p>{L(lang, { en: "Attempts", ko: "시도" })}: {continuation.attemptCount}/{continuation.maxAttempts} · {L(lang, { en: "Manual retries", ko: "수동 재시도" })}: {continuation.manualRetryCount}/{continuation.maxManualRetries}</p>
              {continuation.errorCode && <p className="text-rose-700 dark:text-[#f87171]">{L(lang, { en: "Error code", ko: "오류 코드" })}: {continuation.errorCode}</p>}
              {continuation.retryHint && <p>{L(lang, { en: "Read-only diagnostic hint", ko: "읽기 전용 진단 참고" })}: {continuation.retryHint}</p>}
              {continuation.state === "accepted" && <p className="text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Accepted delivery does not mean the mission or owner work is complete.", ko: "실행 접수는 미션 완료나 오너 작업 소비를 뜻하지 않습니다." })}</p>}
            </div>}
        </div>
      )}
    </section>
  );
}

function HumanOperatorRow({ request, card, requestState, requestStateProblem, scope, onResolve }: {
  request: MissionHumanOperatorRequest; card: OperatorDecisionView | null; requestState: HumanOperatorRequestStateV1 | null;
  requestStateProblem: HumanOperatorRequestStateProblem | null; scope: HumanOperatorScope;
  onResolve: (decisionId: string, input: ResolveOperatorDecisionInput) => Promise<unknown>;
}) {
  const lang = useCompanyLanguage();
  const cardStatusBadge = requestStateLabel(lang, requestState, requestStateProblem, !!card);
  // [사람 카드 목록 소음 정리 08:15] 신형 축소 요약(Stage 2) 또는 신형 카드(symptom)가 붙은 행은
  // 본문에 이미 축소 정보가 있으므로 '쉬운 해석 (AI)' 패널을 이중으로 노출하지 않는다(데이터·감사 기록은 무삭제).
  const compactRow = hasCompactSymptom(card?.definition.humanReview) || hasCompactOperatorSummary(request.summary);
  const evidenceHeading = L(lang, { en: "Historical request evidence · not a current instruction", ko: "과거 요청 증거 · 현재 지시가 아닙니다" });
  // 초보자 해석(표시 전용 — 원문 유지, 실패·부재 시 자동 숨김). 재해석은 board 전용 라우트.
  const summaryPanel = !compactRow ? (
    <CardHumanSummary
      approvalId={request.id}
      companyId={request.companyId}
      summary={request.humanSummary ?? null}
      retranslate={(id, body) => missionsApi.retranslateHumanOperatorRequestSummary(request.companyId, id, body)}
      fetchCurrent={async (id) => {
        const rows = await missionsApi.listHumanOperatorRequests(request.companyId);
        return rows.find((row) => row.id === id)?.humanSummary ?? null;
      }}
    />
  ) : null;
  const requestReasons = (<>
    {requestState && requestState.identity !== "exact" && requestState.reasonCode && (
      <p data-human-operator-request-reason className={cn(EVIDENCE_TEXT, "text-slate-500 dark:text-[#8b97ad]")}>{L(lang, { en: "Reason", ko: "사유 코드" })}: {requestState.reasonCode}</p>
    )}
    {requestStateProblem && <p data-human-operator-request-reason className={cn(EVIDENCE_TEXT, "text-slate-500 dark:text-[#8b97ad]")}>{L(lang, { en: "Request state is shown as unknown.", ko: "요청 상태를 미확인으로 표시했습니다." })}</p>}
  </>);
  const evidenceBody = (<>
    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">{evidenceHeading}</p>
    <p className="whitespace-pre-line font-mono text-xs leading-relaxed text-slate-600 dark:text-[#b6c2d6]">{request.summary}</p>
    {summaryPanel}
    {requestReasons}
  </>);

  // 상태 A — 대기 중 요청 + 선택 카드 연결: 선택 카드(OperatorDecisionCard) 1장만 펼쳐 노출하고
  // '과거 요청 증거' 블록(원문 요약·메타데이터·미션 링크)은 같은 카드 안 기본 접힘 details 로 보존한다.
  if (card) {
    return (
      <li data-human-operator-lifecycle={scope.lifecycle} className={cn(HAIRLINE_ROW, "p-2 [&>article]:rounded-md [&>article]:border-0 [&>article]:bg-transparent [&>article]:p-0")}>
        <details data-human-operator-evidence-fold className="mb-1.5 border-b border-slate-200/80 dark:border-white/[0.08] pb-1.5 text-xs">
          <summary className="flex min-w-0 cursor-pointer flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-[#8b97ad]">
            <span data-human-input-card-badge className={BADGE_PILL}>{cardStatusBadge}</span>
            <span>{L(lang, { en: "Show request evidence", ko: "과거 요청 증거 보기" })}</span>
            <span className="font-mono tabular-nums">{formatRequestTime(request.timestamp)}</span>
          </summary>
          <div className="mt-2 space-y-1.5">
            {/* details 안 첫 번째 a[href] 가 missionLink(request)여야 기존 링크 계약이 유지된다. */}
            <Link to={missionLink(request)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-[#60a5fa] underline">
              {L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="h-3 w-3" />
            </Link>
            <h2 className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{request.title}</h2>
            {evidenceBody}
            {requestState?.identity === "exact" && requestStateProblem === null && <RequestDecisionState state={requestState} />}
          </div>
        </details>
        <OperatorDecisionCard decision={card} onResolve={onResolve} />
      </li>
    );
  }

  // 상태 B — 해소(resolved/cancelled)된 요청: 본문 카드를 펼쳐지지 않고 1줄 이력(summary)로 접고
  // 상세 증거·후속 실행 상태는 기본 접힘 details 안에 그대로 보존한다(감사 필드·버튼 계약 무변경).
  const decisionState = requestState?.identity === "exact" ? requestState.decision : null;
  if (requestState && decisionState && (decisionState.status === "resolved" || decisionState.status === "cancelled")) {
    const result = decisionState.result;
    const resultSummary = decisionState.status === "cancelled"
      ? `· ${L(lang, { en: "cancelled", ko: "취소됨" })}`
      : result
        ? `· ${result.actionId} · ${result.outcome}${result.selectedOptionIds.length > 0 && !(result.selectedOptionIds.length === 1 && result.selectedOptionIds[0] === result.actionId) ? ` (${result.selectedOptionIds.join(", ")})` : ""}`
        : "";
    return (
      <li data-human-operator-lifecycle={scope.lifecycle} className={cn(HAIRLINE_ROW, "px-3 py-1.5")}>
        <details data-human-operator-history-fold>
          <summary className="flex min-w-0 cursor-pointer items-center gap-2 text-xs">
            <StatusBadge status={scope.missionStatus ?? "unknown"} />
            <span data-human-input-card-badge className={BADGE_PILL}>{cardStatusBadge}</span>
            <span className="min-w-0 truncate font-medium text-slate-950 dark:text-[#edf2fb]">{request.title}</span>
            {resultSummary && <span className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{resultSummary}</span>}
            {requestState.attention === true && <AttentionPill value="needed" />}
            {requestState.attention === false && <AttentionPill value="none" />}
            {requestState.attention === null && <AttentionPill value="unknown" />}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{formatRequestTime(decisionState.resolvedAt ?? decisionState.cancelledAt ?? request.timestamp)}</span>
          </summary>
          <div className="mt-2 space-y-1.5 border-t border-slate-200/80 dark:border-white/[0.08] pt-2">
            <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
              <Link to={missionLink(request)}>{L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
            </Button>
            {evidenceBody}
            <RequestDecisionState state={requestState} />
          </div>
        </details>
      </li>
    );
  }

  // 상태 C — 카드 미연결·상태 미확인(legacy/malformed/missing/ambiguous/unsupported) 행은 기존 렌더링 유지.
  return (
    <li data-human-operator-lifecycle={scope.lifecycle} className={cn(HAIRLINE_ROW, "p-3 [&>article]:border-0 [&>article]:bg-transparent")}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={request.severity ?? "attention"} />
            <StatusBadge status={scope.missionStatus ?? "unknown"} />
            <span data-human-input-card-badge className={BADGE_PILL}>{cardStatusBadge}</span>
            {(!requestState || requestState.attention === null) ? <AttentionPill value="unknown" /> : <AttentionPill value={requestState.attention ? "needed" : "none"} />}
            <span className="font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{formatRequestTime(request.timestamp)}</span>
          </div>
          <div>
            <h2 className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">{request.title}</h2>
            <div className="mt-1 space-y-1">{evidenceBody}</div>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
          <Link to={missionLink(request)}>{L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
        </Button>
      </div>
      {requestState?.identity === "exact" && requestStateProblem === null && <RequestDecisionState state={requestState} />}
    </li>
  );
}

export function focusOperatorDecisionSuccessTarget(root: ParentNode = document) {
  const target = root.querySelector<HTMLElement>(
    "[data-operator-decision-heading], [data-operator-decision-attention-heading], [data-human-operator-empty-heading]",
  );
  target?.focus();
}

export function HumanOperator() {
  const lang = useCompanyLanguage();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [focusAfterSuccess, setFocusAfterSuccess] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: "Human Operator" }]), [setBreadcrumbs]);

  const requestsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.missions.humanOperatorRequests(selectedCompanyId) : ["missions", "human-operator-requests"],
    queryFn: () => missionsApi.listHumanOperatorRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const missionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.missions.list(selectedCompanyId) : ["missions"],
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId, staleTime: 30_000, refetchInterval: 30_000,
  });
  const pendingQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.operatorDecisions.list(selectedCompanyId, "pending") : ["operator-decisions", "pending"],
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  // [2026-10-20 운영자 승인] resolved/cancelled 이력(attention·history 뷰)은 가져오지 않는다.
  // 두 뷰가 회사 전체 카드를 N+1로 로드해 페이지를 2.5s+ 지연시켰고 표시 대상도 아니었다.
  // 활성(pending) 카드와 요청 행만 조회한다.

  useEffect(() => {
    if (!focusAfterSuccess) return;
    const frame = requestAnimationFrame(() => {
      focusOperatorDecisionSuccessTarget();
      setFocusAfterSuccess(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAfterSuccess, pendingQuery.data, requestsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserRoundCheck} message="Select a company to view human operator requests." />;
  }
  if (requestsQuery.isLoading || pendingQuery.isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const requests = requestsQuery.data ?? [];
  const pending = pendingQuery.data?.data ?? [];
  const surface = selectHumanOperatorSurface({
    companyId: selectedCompanyId,
    missions: missionsQuery.isError ? undefined : missionsQuery.data,
    requests,
    pendingDecisions: pending,
    pendingNextCursor: pendingQuery.data?.page.nextCursor,
  });
  const error = requestsQuery.error ?? pendingQuery.error ?? missionsQuery.error;
  const isFetching = requestsQuery.isFetching || pendingQuery.isFetching || missionsQuery.isFetching;

  async function refreshDecisionSurfaces() {
    await Promise.all([
      queryKeys.operatorDecisions.list(selectedCompanyId!, "pending"), queryKeys.missions.humanOperatorRequests(selectedCompanyId!),
      queryKeys.missions.list(selectedCompanyId!), queryKeys.sidebarBadges(selectedCompanyId!), queryKeys.activity(selectedCompanyId!),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    setFocusAfterSuccess(true);
  }

  async function resolveDecision(id: string, input: ResolveOperatorDecisionInput) {
    await operatorDecisionsApi.resolve(id, input);
    await refreshDecisionSurfaces();
  }

  async function refreshAll() {
    await Promise.all([requestsQuery.refetch(), pendingQuery.refetch(), missionsQuery.refetch()]);
  }

  const sections: { lifecycle: HumanOperatorLifecycle; title: string; note?: string; data: HumanOperatorSurfaceSection }[] = [
    { lifecycle: "active", title: L(lang, { en: "Active and planning", ko: "활성 및 계획 중" }), data: surface.active },
    { lifecycle: "paused", title: L(lang, { en: "Paused missions", ko: "일시 중지된 미션" }),
      note: L(lang, { en: "A pending decision remains available while paused. Choosing a direction does not resume the mission.", ko: "미션이 멈춰 있어도 대기 중인 결정은 유지됩니다. 방향을 선택해도 미션이 자동으로 재개되지는 않습니다." }), data: surface.paused },
    { lifecycle: "terminal", title: L(lang, { en: "Completed or cancelled missions", ko: "완료 또는 취소된 미션" }), data: surface.terminal },
    { lifecycle: "unknown", title: L(lang, { en: "Mission status unknown", ko: "미션 상태를 알 수 없음" }), data: surface.unknown },
    { lifecycle: "unscoped", title: L(lang, { en: "Unscoped work", ko: "미션 범위가 없는 작업" }), data: surface.unscoped },
  ];
  const sectionCount = (s: HumanOperatorSurfaceSection) => s.cards.length + s.requests.length;
  // Active is always shown (it owns the empty-state heading); other groups only when they hold rows.
  const visibleSections = sections.filter((s) => s.lifecycle === "active" || sectionCount(s.data) > 0);
  const pendingCardCount = sections.reduce((n, s) => n + s.data.cards.length, 0);
  const attentionCount = sections.reduce((n, s) => n + s.data.requests.filter((r) => r.requestState?.attention === true).length, 0);
  const missionStatusNotice = missionsQuery.isLoading
    ? L(lang, { en: "Loading the complete company mission list; scoped items remain visible as unknown until it loads.", ko: "회사 전체 미션 목록을 불러오는 중입니다. 완료될 때까지 범위가 있는 항목은 상태 미확인으로 표시됩니다." })
    : missionsQuery.isError
      ? L(lang, { en: "The mission list could not be loaded; scoped items remain visible as unknown.", ko: "미션 목록을 불러오지 못했습니다. 범위가 있는 항목은 상태 미확인으로 표시됩니다." })
      : missionsQuery.isFetching || missionsQuery.isStale
        ? L(lang, { en: "Mission status may be stale; displayed groups use the last successful complete list.", ko: "미션 상태가 오래되었을 수 있습니다. 마지막으로 성공한 전체 목록으로 분류했습니다." })
        : null;
  const displayedLabel = surface.pendingPageIncomplete
    ? L(lang, { en: `At least ${surface.displayedCount} ${surface.displayedCount === 1 ? "item" : "items"} displayed; more pending cards exist.`, ko: `항목 ${surface.displayedCount}개 이상 표시 중이며, 대기 카드가 더 있습니다.` })
    : L(lang, { en: `${surface.displayedCount} ${surface.displayedCount === 1 ? "item" : "items"} displayed`, ko: `항목 ${surface.displayedCount}개 표시 중` });
  const recentWindowNotice = L(lang, { en: "Showing a bounded recent request window; this is not a total or a count of all pending work.", ko: "최근 요청 일부 표시이며 전체 요청 또는 전체 대기 수가 아닙니다." });
  const stripCells = [
    { label: L(lang, { en: "Pending cards", ko: "대기 카드" }), value: pendingCardCount, dot: cn("bg-amber-500 dark:bg-[#f59e0b]", pendingCardCount > 0 && "animate-pulse") },
    { label: L(lang, { en: "Requests", ko: "요청" }), value: requests.length, dot: "bg-blue-500 dark:bg-[#60a5fa]" },
    { label: L(lang, { en: "Attention", ko: "주의 필요" }), value: attentionCount, dot: attentionCount > 0 ? "bg-[#f87171]" : "bg-[#4a5670]" },
    { label: L(lang, { en: "Active/planning", ko: "활성/계획" }), value: surface.activeCount, dot: "bg-lime-500 dark:bg-[#a3e635]" },
  ];

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 5-cell cockpit strip: human queue telemetry */}
      <div className="cockpit-strip w-full gap-0 rounded-xl border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]" role="group" aria-label={L(lang, { en: "Human operator queue", ko: "사람 운영자 대기열" })}>
        {stripCells.map((cell) => (
          <div key={cell.label} className="cockpit-cell min-w-0 flex-1 justify-center">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1">{cell.value}</b>
          </div>
        ))}
        <div className="cockpit-cell min-w-0 shrink-0">
          <span className="truncate uppercase tracking-wide">{L(lang, { en: "Displayed", ko: "표시" })}</span>
          <b className="ml-1 text-blue-700 dark:text-[#60a5fa]">{surface.displayedCount}</b>
        </div>
      </div>

      {/* Tight 40px toolbar: lifecycle section tabs · bounded-window notices · refresh action */}
      <div className="cockpit-toolbar h-10 rounded-xl border border-slate-200/90 bg-white px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
        <div role="group" aria-label={L(lang, { en: "Jump to a mission group", ko: "미션 그룹으로 이동" })} className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200/80 bg-slate-100/80 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]">
          {visibleSections.map((s) => (
            <button key={s.lifecycle} type="button" className={TAB_CLASS}
              onClick={() => document.getElementById(`human-operator-${s.lifecycle}-heading`)?.scrollIntoView?.({ block: "start" })}>
              {s.title} <span className="ml-1 font-mono text-[10px] text-slate-500 dark:text-[#8b97ad]">{sectionCount(s.data)}</span>
            </button>
          ))}
        </div>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 text-[11px]">
          <p aria-live="polite" className="shrink-0 font-semibold text-slate-950 dark:text-[#edf2fb]">{displayedLabel}</p>
          <p data-human-operator-recent-window className="min-w-0 truncate text-slate-500 dark:text-[#8b97ad]" title={recentWindowNotice}>{recentWindowNotice}</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="ml-2 h-7 shrink-0 border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#0e131d] px-2.5 text-xs text-slate-950 dark:text-[#edf2fb] hover:bg-slate-100 dark:hover:bg-[#141b29]" onClick={() => void refreshAll()} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error && <div className="flex items-center gap-2 rounded-md border border-[#f87171]/40 bg-[#f87171]/10 p-3 text-sm text-rose-700 dark:text-[#f87171]" role="alert">
        <AlertTriangle className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{error instanceof Error ? error.message : "Failed to load Human Operator work."}</span>
      </div>}

      {missionStatusNotice && <p className="truncate text-xs text-slate-500 dark:text-[#8b97ad]" aria-live={missionsQuery.isError ? undefined : "polite"} role={missionsQuery.isError ? "alert" : "status"}>{missionStatusNotice}</p>}

      {visibleSections.map(({ lifecycle, title, note, data }) => {
        const count = sectionCount(data);
        const headingId = `human-operator-${lifecycle}-heading`;
        return (
          <section key={lifecycle} aria-labelledby={headingId} className="scroll-mt-2 space-y-1.5">
            <h2 id={headingId} className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
              {title} <b className="font-mono text-[10px] font-medium text-blue-700 dark:text-[#60a5fa]">{count}</b>
              <span className="sr-only">{L(lang, { en: `${count} displayed`, ko: `${count}개 표시` })}</span>
            </h2>
            {note && count > 0 && <p className="text-xs text-slate-500 dark:text-[#8b97ad]">{note}</p>}
            {data.cards.length > 0 && (
              <div aria-label={L(lang, { en: "Pending Interactive Cards", ko: "대기 중인 인터랙티브 카드" })} className="space-y-1.5 [&>article]:rounded-xl [&>article]:border-slate-200/90 [&>article]:bg-white [&>article]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:[&>article]:border-white/[0.08] dark:[&>article]:bg-[#0e131d] dark:[&>article]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Pending Interactive Cards", ko: "대기 중인 인터랙티브 카드" })}</h3>
                {data.cards.map(({ decision }) => <OperatorDecisionCard key={decision.id} decision={decision} onResolve={resolveDecision} />)}
              </div>
            )}
            {lifecycle === "active" && <ExternalAutomationApprovals />}
            {data.requests.length > 0 && <ul className="space-y-1.5">{data.requests.map(({ request, card, requestState, requestStateProblem, scope }) => (
              <HumanOperatorRow
                key={request.id}
                request={request}
                card={card}
                requestState={requestState}
                requestStateProblem={requestStateProblem}
                scope={scope}
                onResolve={resolveDecision}
              />
            ))}</ul>}
            {surface.displayedCount === 0 && lifecycle === "active" && (
              <h3 data-human-operator-empty-heading tabIndex={-1} className="text-sm font-medium text-slate-950 dark:text-[#edf2fb]">
                {L(lang, { en: "No requests in this recent window.", ko: "최근 요청 범위에 표시할 요청이 없습니다." })}
              </h3>
            )}
          </section>
        );
      })}
    </div>
  );
}
