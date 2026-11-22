// ui/src/api/harnessRsi.ts
//
// [파일 목적] /api/companies/:companyId/harness-rsi/* 클라이언트 — Stage 2/3 읽기 전용
//   (diagnose·proposals) + Stage 4B 장부(ledger 조회·결정 기록·평가 트리거).
//   server/src/services/harness-rsi/{telemetry-diagnose,proposal-loop,ledger-store}.ts의
//   결과와 routes/harness-rsi.ts의 응답 봉투({ companyId, ... })를 미러한다.
import { api } from "./client";

/** Harness component taxonomy mirrored from server HARNESS_COMPONENTS (rrsi-history.ts). */
export type HarnessComponent =
  | "system_prompt"
  | "guardrails"
  | "memory"
  | "tool_guidance"
  | "subagents"
  | "skills"
  | "scripts"
  | "plugins"
  | "workflow_dag"
  | "adapter_config";

export interface HarnessDiagnosisSummary {
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  p90DurationMs: number;
  selfBlockCancels: number;
  lockTimeouts: number;
  highTokenRuns: number;
  slowRuns: number;
}

export interface HarnessBottleneck {
  component: HarnessComponent;
  severity: "high" | "medium" | "low";
  metric: string;
  hypothesis: string;
  recommendedAction: string;
}

export interface HarnessDiagnosisReport {
  summary: HarnessDiagnosisSummary;
  bottlenecks: HarnessBottleneck[];
}

export interface HarnessDiagnosisResponse {
  companyId: string;
  windowHours: number;
  report: HarnessDiagnosisReport;
}

/** Stateless critic verdict mirrored from server CriticResult (rrsi-critic.ts). */
export interface HarnessCriticObjection {
  code: string;
  detail: string;
}

export interface HarnessCriticResult {
  pass: boolean;
  objections: HarnessCriticObjection[];
}

/** Approval-gated proposal; literal types pin the no-auto-apply invariant. */
export interface HarnessProposal {
  id: string;
  component: HarnessComponent;
  severity: HarnessBottleneck["severity"];
  targetMetric: string;
  hypothesis: string;
  recommendedAction: string;
  critic: HarnessCriticResult;
  requiresApproval: true;
  autoApply: false;
}

export interface HarnessProposalLoopResult {
  round: number;
  totalRounds: number;
  budget: number;
  stallFlag: boolean;
  prunedComponents: string[];
  proposals: HarnessProposal[];
}

export interface HarnessProposalsResponse {
  companyId: string;
  windowHours: number;
  result: HarnessProposalLoopResult;
}

/** Ledger decision values mirrored from server LEDGER_DECISIONS (ledger-store.ts). */
export type HarnessLedgerDecision = "approved" | "rejected" | "deferred";

/** Serialized harness_rsi_ledger row — timestamps arrive as ISO strings;
 *  evaluation columns stay null until POST /ledger/:entryId/evaluate fills them. */
export interface HarnessLedgerEntry {
  id: string;
  companyId: string;
  round: number;
  variant: string;
  component: string;
  hypothesis: string;
  diffRef: string;
  decision: HarnessLedgerDecision;
  decidedBy: string;
  overrideReason: string | null;
  baselineJson: Record<string, unknown> | null;
  deltaScore: number | null;
  deltaCost: number | null;
  accepted: boolean | null;
  verdict: string | null;
  createdAt: string;
  evaluatedAt: string | null;
}

export interface HarnessLedgerResponse {
  companyId: string;
  entries: HarnessLedgerEntry[];
}

/** POST /proposals/decision body — mirror of server RecordProposalDecisionInput. */
export interface RecordProposalDecisionInput {
  round?: number;
  variant: string;
  component: string;
  hypothesis?: string;
  diffRef?: string;
  decision: HarnessLedgerDecision;
  decidedBy: string;
  criticPassed?: boolean;
  overrideReason?: string;
}

export interface RecordProposalDecisionResponse {
  companyId: string;
  entry: HarnessLedgerEntry;
}

export interface EvaluateLedgerEntryResponse {
  companyId: string;
  entry: HarnessLedgerEntry;
  selection: unknown;
}

export const harnessRsiApi = {
  diagnose: (companyId: string, windowHours = 24) => {
    const searchParams = new URLSearchParams();
    searchParams.set("windowHours", String(windowHours));
    return api.get<HarnessDiagnosisResponse>(
      `/companies/${companyId}/harness-rsi/diagnose?${searchParams.toString()}`,
    );
  },
  proposals: (
    companyId: string,
    opts?: { windowHours?: number; round?: number; totalRounds?: number },
  ) => {
    const searchParams = new URLSearchParams();
    if (opts?.windowHours !== undefined) searchParams.set("windowHours", String(opts.windowHours));
    if (opts?.round !== undefined) searchParams.set("round", String(opts.round));
    if (opts?.totalRounds !== undefined) searchParams.set("totalRounds", String(opts.totalRounds));
    const qs = searchParams.toString();
    return api.get<HarnessProposalsResponse>(
      `/companies/${companyId}/harness-rsi/proposals${qs ? `?${qs}` : ""}`,
    );
  },
  ledger: (companyId: string, limit = 50) => {
    const searchParams = new URLSearchParams();
    searchParams.set("limit", String(limit));
    return api.get<HarnessLedgerResponse>(
      `/companies/${companyId}/harness-rsi/ledger?${searchParams.toString()}`,
    );
  },
  recordDecision: (companyId: string, input: RecordProposalDecisionInput) =>
    api.post<RecordProposalDecisionResponse>(
      `/companies/${companyId}/harness-rsi/proposals/decision`,
      input,
    ),
  evaluateEntry: (companyId: string, entryId: string) =>
    api.post<EvaluateLedgerEntryResponse>(
      `/companies/${companyId}/harness-rsi/ledger/${entryId}/evaluate`,
      {},
    ),
};
