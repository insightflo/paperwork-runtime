import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Scale } from "lucide-react";
import {
  missionsApi,
  type MissionDecisionEvidenceRef,
  type MissionDecisionRecord,
  type MissionDecisionReportPayload,
  type MissionDecisionStatus,
} from "../api/missions";
import { queryKeys } from "../lib/queryKeys";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import type { CompanyDefaultLanguage } from "@paperclipai/shared";

interface MissionDecisionLogPanelProps {
  missionId: string;
}

function formatDecisionDate(value: string | null | undefined, lang: CompanyDefaultLanguage) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
// Display-only context; decision logs are not execution-control authority.
const fieldClass = "mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20";
function statusClass(status: MissionDecisionRecord["status"]) {
  switch (status) {
    case "confirmed":
      return "text-emerald-600 dark:text-[#a3e635]";
    case "under_review":
      return "text-amber-600 dark:text-[#f59e0b]";
    case "retired":
      return "text-muted-foreground line-through dark:text-[#8f9db3]";
    default:
      return "text-muted-foreground";
  }
}

function provenanceLabel(record: MissionDecisionRecord, lang: CompanyDefaultLanguage) {
  return record.handoffId ? L(lang, { en: `via handoff ${record.handoffId}`, ko: `핸드오프 ${record.handoffId}로부터` }) : L(lang, { en: "via decision report", ko: "결정 보고서로부터" });
}

/** 근거 참조 표시용: shortId(8) 로 잘라 `type shortId` 를 쉼표로 연결한다(마크다운 렌더와 동일 규칙). */
function evidenceRefsLabel(refs: MissionDecisionEvidenceRef[]) {
  return refs.map((ref) => `${ref.type} ${ref.id.slice(0, 8)}`).join(", ");
}

/** title 속성용 전체 원문: `type:id` 를 쉼표로 연결한다. */
function evidenceRefsFullTitle(refs: MissionDecisionEvidenceRef[]) {
  return refs.map((ref) => `${ref.type}:${ref.id}`).join(", ");
}

export function MissionDecisionLogPanel({ missionId }: MissionDecisionLogPanelProps) {
  const lang = useCompanyLanguage();
  const queryClient = useQueryClient();
  const { data: log, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.decisionLog(missionId),
    queryFn: () => missionsApi.getDecisionLog(missionId),
    enabled: !!missionId,
  });

  const [decisionId, setDecisionId] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<MissionDecisionStatus>("confirmed");
  const [supersedes, setSupersedes] = useState("");

  const reportMutation = useMutation({
    mutationFn: (payload: MissionDecisionReportPayload) => missionsApi.reportDecisions(missionId, payload),
    onSuccess: async () => {
      setDecisionId("");
      setSummary("");
      setStatus("confirmed");
      setSupersedes("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions.decisionLog(missionId) });
    },
  });

  const retireMutation = useMutation({
    mutationFn: (payload: MissionDecisionReportPayload) => missionsApi.reportDecisions(missionId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions.decisionLog(missionId) });
    },
  });

  if (isLoading) {
    return (
      <section className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]" aria-label="Mission Decision Log">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-[#60a5fa]" />
          <h3 className="text-sm font-medium">{L(lang, { en: "Mission Decision Log", ko: "미션 결정 기록" })}</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{L(lang, { en: "Loading mission decision log…", ko: "미션 결정 기록을 불러오는 중…" })}</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]" aria-label="Mission Decision Log">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="text-sm font-medium">{L(lang, { en: "Mission Decision Log", ko: "미션 결정 기록" })}</h3>
        </div>
        <p className="mt-3 text-sm text-destructive">
          {error instanceof Error ? error.message : L(lang, { en: "Failed to load mission decision log.", ko: "미션 결정 기록을 불러오지 못했습니다." })}
        </p>
      </section>
    );
  }

  const decisions = log?.decisions ?? [];
  const confirmedCount = decisions.filter((record) => record.status === "confirmed").length;
  const underReviewCount = decisions.filter((record) => record.status === "under_review").length;

  return (
    <section className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 text-slate-900 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)] space-y-4" aria-label="Mission Decision Log">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-[#60a5fa]" />
          <div>
            <h3 className="text-sm font-medium">{L(lang, { en: "Mission Decision Log", ko: "미션 결정 기록" })}</h3>
            <p className="text-xs text-muted-foreground">
              {L(lang, { en: "Context handoff state only — not an execution-control authority", ko: "맥락 전달 상태만 표시 — 실행을 제어하는 근거가 아닙니다" })}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">
          {L(lang, { en: "board-authorable record", ko: "운영자가 작성할 수 있는 기록" })}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
        <span>{L(lang, { en: `rev ${log?.revision ?? 0}`, ko: `개정 ${log?.revision ?? 0}` })}</span>
        <span>{L(lang, { en: `${decisions.length} decisions`, ko: `결정 ${decisions.length}개` })}</span>
        <span>{L(lang, { en: `${confirmedCount} confirmed`, ko: `확정 ${confirmedCount}개` })}</span>
        <span>{L(lang, { en: `${underReviewCount} under review`, ko: `검토 중 ${underReviewCount}개` })}</span>
        <span>{L(lang, { en: "updated", ko: "갱신" })} {formatDecisionDate(log?.updatedAt, lang)}</span>
      </div>

      {decisions.length === 0 ? (
        <p className="rounded-[10px] border border-slate-200/80 bg-slate-50/60 p-3 text-sm text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.07] dark:bg-[#07090d] dark:text-[#8f9db3] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          {L(lang, { en: `No decisions recorded yet. Agents and the board report decisions via POST /api/missions/${missionId}/decision-reports.`, ko: `아직 기록된 결정이 없습니다. 에이전트와 운영자는 POST /api/missions/${missionId}/decision-reports로 결정을 보고합니다.` })}
        </p>
      ) : (
        <ul className="space-y-2">
          {decisions.map((record) => (
            <li key={record.id} className="rounded-[10px] border border-slate-200/80 bg-slate-50/60 p-3 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-[13px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                    {record.id}
                    {record.supersedes ? (
                      <span className="ml-2 text-xs text-muted-foreground">{L(lang, { en: "supersedes", ko: "대체" })} {record.supersedes}</span>
                    ) : null}
                  </p>
                  <p className={`mt-1 ${record.status === "retired" ? "text-muted-foreground" : ""}`}>
                    {record.summary}
                  </p>
                </div>
                <span className={`text-xs font-medium ${statusClass(record.status)}`} title={record.status}>{humanLabel(lang, "missionDecisionStatus", record.status).label}</span>
                {record.demotedByEvidence ? (
                  <span
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]"
                    title={`Demoted by machine evidence check: ${record.demotedByEvidence.mismatches.map((m) => `${m.type} ${m.id} (${m.current})`).join(", ")}`}
                  >
                    {L(lang, { en: "evidence stale", ko: "근거가 오래됨" })}
                  </span>
                ) : null}
                {record.source === "board" ? <span className="rounded-full border border-slate-300/80 bg-slate-100/70 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3]">board</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
                <span>{formatDecisionDate(record.updatedAt, lang)}</span>
                <span>{provenanceLabel(record, lang)}</span>
                {record.lastConflictingProposal ? <span>{L(lang, { en: "proposal pending", ko: "제안 대기 중" })} ({record.lastConflictingProposal.from})</span> : null}
                {record.evidenceRefs?.length ? (
                  <span title={evidenceRefsFullTitle(record.evidenceRefs)}>
                    {L(lang, { en: "evidence:", ko: "근거:" })} {evidenceRefsLabel(record.evidenceRefs)}
                  </span>
                ) : null}
                {record.status === "confirmed" || record.status === "under_review" ? (
                  <button
                    type="button"
                    disabled={retireMutation.isPending}
                    onClick={() =>
                      retireMutation.mutate({ updates: [{ id: record.id, status: "retired" }] })
                    }
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-500/15 disabled:opacity-50 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b] dark:hover:bg-[#f59e0b]/15"
                  >
                    {L(lang, { en: "Retire", ko: "폐기" })}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {retireMutation.error ? (
        <p className="text-sm text-destructive">
          {retireMutation.error instanceof Error
            ? retireMutation.error.message
            : L(lang, { en: "Failed to retire the decision.", ko: "결정을 폐기하지 못했습니다." })}
        </p>
      ) : null}

      <section className="rounded-[10px] border border-slate-200/80 bg-slate-50/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" aria-label="Record a decision">
        <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">{L(lang, { en: "Record a decision", ko: "결정 기록 추가" })}</h4>
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!decisionId.trim() || !summary.trim()) return;
            reportMutation.mutate({
              updates: [
                {
                  id: decisionId.trim(),
                  summary: summary.trim(),
                  status,
                  ...(supersedes.trim() ? { supersedes: supersedes.trim() } : {}),
                },
              ],
            });
          }}
        >
          <div>
            <label htmlFor="decision-id-input" className="text-xs font-medium">{L(lang, { en: "Decision id", ko: "결정 ID" })}</label>
            <input
              id="decision-id-input"
              value={decisionId}
              onChange={(event) => setDecisionId(event.target.value)}
              placeholder="e.g. D-4"
              required
              maxLength={100}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="decision-summary-input" className="text-xs font-medium">{L(lang, { en: "Summary", ko: "요약" })}</label>
            <textarea
              id="decision-summary-input"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What was decided and why"
              required
              maxLength={2000}
              rows={3}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="decision-status-input" className="text-xs font-medium">{L(lang, { en: "Status", ko: "상태" })}</label>
            <select
              id="decision-status-input"
              value={status}
              onChange={(event) => setStatus(event.target.value as MissionDecisionStatus)}
              className={fieldClass}
            >
              {["under_review", "confirmed", "retired"].map((value) => <option key={value} value={value} title={value}>{humanLabel(lang, "missionDecisionStatus", value).label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="decision-supersedes-input" className="text-xs font-medium">{L(lang, { en: "Supersedes", ko: "대체" })}</label>
            <input
              id="decision-supersedes-input"
              value={supersedes}
              onChange={(event) => setSupersedes(event.target.value)}
              placeholder="Decision id this replaces (optional)"
              maxLength={100}
              className={fieldClass}
            />
          </div>
          <button
            type="submit"
            disabled={reportMutation.isPending}
            className="rounded-md bg-[#4d7c0f] px-3 py-1.5 text-sm font-semibold text-white tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] transition-colors hover:bg-[#3f6212] disabled:opacity-50 dark:bg-[#a3e635] dark:text-[#07090d] dark:hover:bg-[#bef264]"
          >
            {L(lang, { en: "Record decision", ko: "결정 기록" })}
          </button>
        </form>
        {reportMutation.error ? (
          <p className="mt-2 text-sm text-destructive">
            {reportMutation.error instanceof Error
              ? reportMutation.error.message
              : L(lang, { en: "Failed to record the decision.", ko: "결정을 기록하지 못했습니다." })}
          </p>
        ) : null}
      </section>

      {log?.stateMarkdown ? (
        <details className="rounded-[10px] border border-slate-200/80 bg-slate-50/60 p-3 dark:border-white/[0.07] dark:bg-[#07090d]">
          <summary className="cursor-pointer font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8f9db3]">Mission state (markdown)</summary>
          <pre className="mt-2 overflow-x-auto overscroll-contain rounded-md bg-white/70 p-2 font-mono text-xs tabular-nums text-slate-600 dark:bg-[#0e131d] dark:text-slate-300">{log.stateMarkdown}</pre>
        </details>
      ) : null}
    </section>
  );
}
