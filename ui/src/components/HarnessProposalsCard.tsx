// ui/src/components/HarnessProposalsCard.tsx
//
// [파일 목적] RRSI 승인 게이트 제안 검토 카드 (읽기 전용 — 뮤테이션·auto-apply 없음).
//   Round/Budget·Stalled·Approval Required 배지와 함께 제안 목록(severity 배지,
//   component pill, Critic Gate, 가설·권장 조치·크리틱 이의)을 렌더한다.
//   "Hide critic-flagged"는 클라이언트 표시 토글일 뿐 서버 상태를 바꾸지 않는다.
//   data/isLoading/error 주입 시 쿼리 없이 순수 렌더(테스트용); 미주입 시 useQuery로 로드.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardList } from "lucide-react";
import {
  harnessRsiApi,
  type HarnessProposal,
  type HarnessProposalsResponse,
} from "../api/harnessRsi";
import { cn } from "../lib/utils";

export interface HarnessProposalsCardProps {
  companyId: string;
  windowHours?: number;
  data?: HarnessProposalsResponse;
  isLoading?: boolean;
  error?: Error | null;
  /** Initial state of the client-side "Hide critic-flagged" toggle (default false). */
  defaultHideFlagged?: boolean;
}

const SEVERITY_STYLE: Record<HarnessProposal["severity"], string> = {
  high: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-border bg-muted/40 text-muted-foreground",
};

const CRITIC_GATE_STYLE = {
  pass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  flagged: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

const PILL = "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]";

function ProposalRow({ item }: { item: HarnessProposal }) {
  const flagged = !item.critic.pass;
  return (
    <li className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn(PILL, "font-medium", SEVERITY_STYLE[item.severity])}>
          {item.severity}
        </span>
        <span className={cn(PILL, "border-border bg-background font-mono text-muted-foreground")}>
          {item.component.replace(/_/g, " ")}
        </span>
        <span className={cn(PILL, "font-medium", flagged ? CRITIC_GATE_STYLE.flagged : CRITIC_GATE_STYLE.pass)}>
          {flagged ? "Critic Flagged" : "Critic Pass"}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground">{item.targetMetric}</span>
      </div>
      <p className="text-xs text-foreground">{item.hypothesis}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Action: </span>
        {item.recommendedAction}
      </p>
      {flagged && (
        <ul className="space-y-0.5 text-[11px] text-rose-700 dark:text-rose-300">
          {item.critic.objections.map((o, i) => (
            <li key={`${o.code}:${i}`}>
              <span className="font-mono font-medium">{o.code}</span> — {o.detail}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface ViewProps {
  data?: HarnessProposalsResponse;
  isLoading: boolean;
  error: Error | null;
  defaultHideFlagged?: boolean;
}

function HarnessProposalsView({ data, isLoading, error, defaultHideFlagged = false }: ViewProps) {
  const [hideFlagged, setHideFlagged] = useState(defaultHideFlagged);
  const result = data?.result;
  const proposals = result?.proposals ?? [];
  const visible = hideFlagged ? proposals.filter((p) => p.critic.pass) : proposals;

  return (
    <section aria-label="Harness proposals" className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Harness Proposals
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {result && (
            <span className={cn(PILL, "border-border bg-background font-mono text-muted-foreground")}>
              {`Round ${result.round}/${result.totalRounds} · Budget ${result.budget}`}
            </span>
          )}
          {result?.stallFlag && (
            <span className={cn(PILL, "font-medium border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300")}>
              Stalled
            </span>
          )}
          <span className={cn(PILL, "font-medium border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}>
            Approval Required (No Auto-Apply)
          </span>
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading proposals…</p>
      ) : error ? (
        <p className="text-xs text-muted-foreground">
          Proposals unavailable{error.message ? `: ${error.message}` : "."}
        </p>
      ) : !result ? (
        <p className="text-xs text-muted-foreground">No proposal data for this window.</p>
      ) : (
        <>
          <label className="flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={hideFlagged}
              onChange={(e) => setHideFlagged(e.target.checked)}
            />
            Hide critic-flagged
          </label>
          {visible.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              {proposals.length === 0
                ? "No proposals generated for this round."
                : "All proposals hidden by the critic filter."}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((item) => (
                <ProposalRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function HarnessProposalsCardLive({ companyId, windowHours }: { companyId: string; windowHours: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["harness-rsi-proposals", companyId, windowHours],
    queryFn: () => harnessRsiApi.proposals(companyId, { windowHours }),
    enabled: !!companyId,
    retry: false,
    staleTime: 60_000,
  });
  return <HarnessProposalsView data={data} isLoading={isLoading} error={error} />;
}

export function HarnessProposalsCard({
  companyId,
  windowHours = 24,
  data,
  isLoading,
  error,
  defaultHideFlagged,
}: HarnessProposalsCardProps) {
  if (data !== undefined || isLoading !== undefined || error !== undefined) {
    return (
      <HarnessProposalsView
        data={data}
        isLoading={isLoading ?? false}
        error={error ?? null}
        defaultHideFlagged={defaultHideFlagged}
      />
    );
  }
  return <HarnessProposalsCardLive companyId={companyId} windowHours={windowHours} />;
}
