// ui/src/components/MissionResumeDialog.tsx
// [purpose] 운영자가 기존 실행(run)과 그 run의 실제 단계(step)를 골라 POST /workflow-resume-requests로
//   재개 요청을 보내는 실물 다이얼로그. 범위 변경·재오픈 시 이전 preview·요청·오류를 지워 stale POST를 막고,
//   idempotencyKey는 본문 확정 시점에 한 번만 생성하며, 불확실한 네트워크 오류 시 같은 본문·키로만 재시도한다.
//   구 엔드포인트(/workflow-runs/:id/resume) fallback 없음.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { workflowResumeApi } from "../api/workflow-resume";
import type { MissionWorkflowRun } from "../api/missions";
import type { ResumePreview, ResumeRequestView } from "@paperclipai/shared/types/workflow-resume";
import { resumeRequestSchema } from "@paperclipai/shared/validators/workflow-resume";
import type { ResumeRequestBody } from "@paperclipai/shared/validators/workflow-resume";
import { queryKeys } from "../lib/queryKeys";
import { MissionResumePreviewReport } from "./MissionResumePreviewReport";
import { MissionResumeRequestStatus } from "./MissionResumeRequestStatus";
import {
  describeApplyError,
  isSnapshotExpired,
  newIdempotencyKey,
} from "./mission-resume-dialog-utils";

const REASON_MAX_LENGTH = 2000;
const REQUEST_POLL_INTERVAL_MS = 2000;
const PRESERVATION_NOTE = "완료된 작업은 보존하며, 필요한 게시 승인은 별도로 진행합니다.";

interface MissionResumeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  missionId: string;
  missionTitle: string;
  workflowRuns: MissionWorkflowRun[];
}

export function MissionResumeDialog({
  open,
  onOpenChange,
  companyId,
  missionId,
  missionTitle,
  workflowRuns,
}: MissionResumeDialogProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [frozenBody, setFrozenBody] = useState<ResumeRequestBody | null>(null);
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const queryClient = useQueryClient();

  const previewMutation = useMutation({
    mutationFn: (scope: { workflowRunId: string; startStepId: string }) =>
      workflowResumeApi.preview(companyId, missionId, scope.workflowRunId, scope.startStepId),
  });

  const requestQuery = useQuery({
    queryKey: ["mission-workflow-resume-request", companyId, missionId, createdRequestId],
    queryFn: () => workflowResumeApi.getRequest(companyId, missionId, createdRequestId as string),
    enabled: createdRequestId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === "pending_delivery" ? REQUEST_POLL_INTERVAL_MS : false,
  });

  // readback이 도메인 뷰일 때만 사용(혼합 빌드/기타 데이터 방어). 요청 응답은 반환된 id가 있을 때만 조회한다.
  const requestView: ResumeRequestView | null =
    requestQuery.data && typeof requestQuery.data.state === "string" && typeof requestQuery.data.id === "string"
      ? requestQuery.data
      : null;

  useEffect(() => {
    if (requestView?.state === "accepted") {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.workflowRuns(missionId) });
    }
  }, [requestView, missionId, queryClient]);

  const runs = Array.isArray(workflowRuns) ? workflowRuns : [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  // 전달 완료(accepted)는 재개 요청의 실질 종점 — 실행기가 받았으므로 같은 범위로 다시
  // POST 할 이유가 없다. 이 시점부터 주 행동은 닫기다(범위/사유를 바꾸면 시도 상태가
  // 초기화되어 새 요청을 만들 수 있다).
  const requestDelivered = requestView?.state === "accepted";

  const applyMutation = useMutation({
    mutationFn: (body: ResumeRequestBody) => workflowResumeApi.createRequest(companyId, missionId, body),
    onSuccess: (view) => {
      setApplyError(null);
      setCreatedRequestId(view.id);
    },
    onError: (error) => setApplyError(describeApplyError(error)),
  });

  const preview = previewMutation.data ?? null;
  // 스냅샷은 정확히 선택된 범위에만 유효 — 선택이 바뀌면 이전 preview는 표시/확정할 수 없다.
  const visiblePreview = preview && preview.workflowRunId === selectedRunId && preview.startStepId === selectedStepId ? preview : null;
  const busy = previewMutation.isPending || applyMutation.isPending;
  const requestInFlight = requestView?.state === "pending_delivery";
  const snapshotExpired = visiblePreview ? isSnapshotExpired(visiblePreview) : false;
  const canConfirm =
    visiblePreview !== null &&
    visiblePreview.eligible &&
    !!visiblePreview.snapshotToken &&
    !snapshotExpired &&
    reason.trim().length > 0 &&
    !busy &&
    !requestInFlight;

  function clearStaleAttemptState() {
    setFrozenBody(null);
    setCreatedRequestId(null);
    setApplyError(null);
    previewMutation.reset();
  }

  // 닫힘(사용자 닫기/부모에 의한 제어 닫기 모두) 시 이전 preview·요청·오류·사유를 지워 stale POST를 막는다.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (!open && wasOpenRef.current) {
      setSelectedRunId(null);
      setSelectedStepId(null);
      setReason("");
      clearStaleAttemptState();
    }
    wasOpenRef.current = open;
  }, [open]);

  function handleRunChange(nextRunId: string) {
    setSelectedRunId(nextRunId);
    setSelectedStepId(null);
    clearStaleAttemptState();
  }

  function handleStepChange(nextStepId: string) {
    setSelectedStepId(nextStepId);
    clearStaleAttemptState();
  }

  function handlePreview() {
    if (!selectedRunId || !selectedStepId) return;
    clearStaleAttemptState();
    previewMutation.mutate({ workflowRunId: selectedRunId, startStepId: selectedStepId });
  }

  function handleConfirm() {
    if (!canConfirm || !visiblePreview?.snapshotToken || !selectedRunId || !selectedStepId) return;
    // 본문(idempotencyKey 포함)은 확정 시점에 정확히 한 번 만들어 고정한다.
    const body: ResumeRequestBody = frozenBody ?? {
      schemaVersion: 1,
      mode: "resume_from_step",
      companyId,
      missionId,
      workflowRunId: selectedRunId,
      startStepId: selectedStepId,
      snapshotToken: visiblePreview.snapshotToken,
      idempotencyKey: newIdempotencyKey(),
      reason: reason.trim(),
    };
    const parsed = resumeRequestSchema.safeParse(body);
    if (!parsed.success) {
      setApplyError({
        message: "재개 요청 본문이 공유 계약(resumeRequestSchema)을 만족하지 않습니다.",
        uncertain: false,
      });
      return;
    }
    if (!frozenBody) setFrozenBody(parsed.data);
    applyMutation.mutate(parsed.data);
  }

  /** 불확실한 네트워크 오류 이후에만 노출 — 자동 재시도 없음, 동일 본문/키 재사용. */
  function handleRetry() {
    if (!frozenBody) return;
    applyMutation.mutate(frozenBody);
  }

  function handleReasonChange(next: string) {
    setReason(next);
    if (frozenBody) {
      // 사유가 바뀌면 본문이 달라지므로 이전 시도(키 포함)는 재사용할 수 없다.
      setFrozenBody(null);
      setApplyError(null);
    }
  }

  // 닫힘 시 미렌더(node SSR·혼합 빌드 안전).
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true" className="tactile-card max-h-[85dvh] overflow-y-auto overscroll-contain rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_50px_rgba(15,23,42,0.16)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_18px_50px_rgba(0,0,0,0.48)] sm:max-w-xl">
        <DialogHeader className="border-b border-slate-200/80 pb-3 dark:border-white/[0.07]">
          <DialogTitle className="text-slate-950 dark:text-slate-50">이 실행 이어서 진행</DialogTitle>
          <DialogDescription className="text-slate-600 dark:text-slate-400">
            {missionTitle ? `${missionTitle} — ` : ""}
            기존 워크플로 실행의 단계부터 재개 요청을 만듭니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="mission-resume-run" className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
                재개할 실행
              </label>
              <select
                id="mission-resume-run"
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none transition-colors focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 disabled:opacity-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
                value={selectedRunId ?? ""}
                disabled={busy}
                onChange={(event) => handleRunChange(event.target.value)}
              >
                <option value="">실행 선택…</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.workflowName ?? run.id} ({run.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mission-resume-step" className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
                시작 단계
              </label>
              <select
                id="mission-resume-step"
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none transition-colors focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 disabled:opacity-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
                value={selectedStepId ?? ""}
                disabled={busy || !selectedRun}
                onChange={(event) => handleStepChange(event.target.value)}
              >
                <option value="">단계 선택…</option>
                {(selectedRun?.steps ?? []).map((step) => (
                  <option key={step.stepId} value={step.stepId}>
                    {step.name} ({step.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm" className="border-slate-200/90 bg-white text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:border-blue-500/35 hover:bg-blue-50 dark:border-[#60a5fa]/25 dark:bg-[#07090d] dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-[#101827]"
              onClick={handlePreview}
              disabled={busy || !selectedRunId || !selectedStepId}
            >
              재개 범위 확인
            </Button>
            {!visiblePreview && (
              <p className="text-xs text-slate-500 dark:text-[#8f9db3]">실행과 단계를 선택하고 재개 범위를 확인하세요.</p>
            )}
          </div>

          {visiblePreview && <div className="[&_[data-testid=mission-resume-preview]]:rounded-[12px] [&_[data-testid=mission-resume-preview]]:border-slate-200/80 [&_[data-testid=mission-resume-preview]]:bg-slate-50/70 [&_[data-testid=mission-resume-preview]]:shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:[&_[data-testid=mission-resume-preview]]:border-white/10 dark:[&_[data-testid=mission-resume-preview]]:bg-[#07090d] dark:[&_[data-testid=mission-resume-preview]]:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"><MissionResumePreviewReport preview={visiblePreview} expired={snapshotExpired} /></div>}

          <div className="space-y-1.5">
            <label htmlFor="mission-resume-reason" className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">
              재개 사유 (필수, 최대 2000자)
            </label>
            <Textarea
              id="mission-resume-reason"
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              disabled={busy}
              onChange={(event) => handleReasonChange(event.target.value)}
              placeholder="이 지점부터 다시 진행하는 이유를 적어주세요." className="border-slate-200 bg-white text-slate-800 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] placeholder:text-slate-400 focus-visible:border-[#2563eb] focus-visible:ring-[#2563eb]/15 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/20"
            />
          </div>

          <p className="rounded-[10px] border border-blue-500/20 bg-blue-500/5 px-2.5 py-2 text-xs text-blue-700 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">{PRESERVATION_NOTE}</p>

          <MissionResumeRequestStatus
            applyError={applyError}
            canRetry={!!applyError?.uncertain && frozenBody !== null}
            onRetry={handleRetry}
            requestLoading={createdRequestId !== null && requestQuery.isPending}
            requestError={
              createdRequestId !== null && requestQuery.error instanceof Error ? requestQuery.error.message : null
            }
            requestView={createdRequestId !== null ? requestView : null}
          />

          <div className="flex justify-end">
            {requestDelivered ? (
              <Button type="button" aria-label="닫기" variant="outline" className="border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-[#111827]" onClick={() => onOpenChange(false)}>
                닫기
              </Button>
            ) : (
              <Button type="button" className="bg-[#4d7c0f] text-white tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] hover:bg-[#3f6212] dark:bg-[#a3e635] dark:text-[#07090d] dark:hover:bg-[#bef264]" onClick={handleConfirm} disabled={!canConfirm}>
                {requestInFlight ? "전달 중… 창을 닫지 말아 주세요" : "이 지점부터 재개"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
