// server/src/services/harness-rsi/telemetry-diagnose.ts
//
// [파일 목적] RRSI + Harness2 Stage 2 — 회사 하네스 텔레메트리 진단 (dgate soft).
//   읽기 전용: heartbeat_runs / agents / workflow_definitions 스냅샷을 받아 실행
//   지표 요약 + HARNESS_COMPONENTS 태그 병목 리포트를 만든다. 라이브 런·미션·
//   에이전트에 대한 쓰기는 절대 없다 (관찰·진단 전용).

import { and, eq, gte, ne } from "drizzle-orm";
import { agents, heartbeatRuns, workflowDefinitions, type Db } from "@paperclipai/db";
import {
  collectAgentConfigHygieneWarnings,
  collectWorkflowAuthoringWarnings,
} from "../config-hygiene-warnings.js";
import { readRawUsageTotals } from "../heartbeat-usage-totals.js";
import { parseObject } from "../../adapters/utils.js";
import type { HarnessComponent } from "./rrsi-history.js";

export const DIAGNOSIS_DEFAULT_WINDOW_HOURS = 24;
export const DIAGNOSIS_MAX_WINDOW_HOURS = 168;

const SLOW_STEP_MS = 15 * 60_000, HIGH_OUTPUT_TOKENS = 30_000, LOW_SUCCESS_RATE = 0.8;
const MIN_SUCCESS_SAMPLE = 3, SPIKE_THRESHOLD = 3, RUN_SCAN_LIMIT = 500;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const LOCK_TIMEOUT_MARKERS = ["55p03", "lock_not_available", "lock timeout", "lock_timeout"];

export interface HarnessTelemetryRun {
  id: string; status: string; durationMs: number | null; outputTokens: number | null;
  errorCode: string | null; error: string | null; stepTitle: string | null; adapterType: string | null;
}
export interface HarnessTelemetryAgent {
  id: string; role: string | null; adapterType: string | null;
  adapterConfig: Record<string, unknown> | null;
}
export interface HarnessTelemetryWorkflow {
  id: string; name: string | null; steps: unknown[];
}
export interface HarnessTelemetryInput {
  runs: HarnessTelemetryRun[]; agents: HarnessTelemetryAgent[]; workflows: HarnessTelemetryWorkflow[];
}

export interface HarnessDiagnosisSummary {
  totalRuns: number; successRate: number; avgDurationMs: number; p90DurationMs: number;
  selfBlockCancels: number; lockTimeouts: number; highTokenRuns: number; slowRuns: number;
}
export interface HarnessBottleneck {
  component: HarnessComponent; severity: "high" | "medium" | "low";
  metric: string; hypothesis: string; recommendedAction: string;
}
export interface HarnessDiagnosisReport {
  summary: HarnessDiagnosisSummary; bottlenecks: HarnessBottleneck[];
}

const SEVERITY_RANK: Record<HarnessBottleneck["severity"], number> = { high: 0, medium: 1, low: 2 };

function isLockTimeout(run: Pick<HarnessTelemetryRun, "errorCode" | "error">): boolean {
  const haystack = `${run.errorCode ?? ""} ${run.error ?? ""}`.toLowerCase();
  return LOCK_TIMEOUT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Pure deterministic diagnosis. Detects slow steps (avg >= 15m), high-output
 * runs (>= 30k tokens), guardrail spikes (issue_status_blocked / 55P03), low
 * success rate (< 80%), and replays config-hygiene warnings as bottlenecks.
 */
export function diagnoseHarnessTelemetry(input: HarnessTelemetryInput): HarnessDiagnosisReport {
  const runs = input.runs;
  const durations = runs
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);
  const terminalRuns = runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status));
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const successRate = terminalRuns.length > 0 ? succeeded / terminalRuns.length : 1;
  const avgDurationMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
  const p90DurationMs = durations.length > 0 ? durations[Math.ceil(durations.length * 0.9) - 1]! : 0;
  const selfBlockCancels = runs.filter((r) => r.errorCode === "issue_status_blocked").length;
  const lockTimeouts = runs.filter(isLockTimeout).length;
  const highTokenRuns = runs.filter((r) => (r.outputTokens ?? 0) >= HIGH_OUTPUT_TOKENS).length;
  const slowRuns = durations.filter((d) => d >= SLOW_STEP_MS).length;

  const stepDurations = new Map<string, { total: number; count: number }>();
  for (const run of runs) {
    if (!run.stepTitle || typeof run.durationMs !== "number") continue;
    const acc = stepDurations.get(run.stepTitle) ?? { total: 0, count: 0 };
    acc.total += run.durationMs;
    acc.count += 1;
    stepDurations.set(run.stepTitle, acc);
  }

  const bottlenecks: HarnessBottleneck[] = [];
  const push = (
    component: HarnessComponent, severity: HarnessBottleneck["severity"],
    metric: string, hypothesis: string, recommendedAction: string,
  ) => bottlenecks.push({ component, severity, metric, hypothesis, recommendedAction });

  for (const [stepTitle, agg] of stepDurations) {
    const avg = agg.total / agg.count;
    if (avg < SLOW_STEP_MS) continue;
    push("tool_guidance", avg >= 2 * SLOW_STEP_MS ? "high" : "medium", `step_avg_duration_ms:${stepTitle}`,
      `Step "${stepTitle}" averages ${Math.round(avg / 60_000)}min across ${agg.count} run(s); serial LLM work sets a high latency floor.`,
      "Split the step, parallelize it, or add tool guidance to shorten the LLM loop.");
  }
  if (highTokenRuns > 0) {
    const maxTokens = Math.max(0, ...runs.map((r) => r.outputTokens ?? 0));
    push("adapter_config", highTokenRuns >= SPIKE_THRESHOLD ? "high" : "medium", "high_token_runs",
      `${highTokenRuns} run(s) emitted >= ${HIGH_OUTPUT_TOKENS} output tokens (max ${maxTokens}); likely excessive thinking/effort or no output cap.`,
      "Lower thinking/effort for routine roles, cap output in adapterConfig, split oversized deliverables.");
  }
  if (selfBlockCancels + lockTimeouts > 0) {
    push("guardrails", selfBlockCancels + lockTimeouts >= SPIKE_THRESHOLD ? "high" : "medium", "guardrail_faults",
      `${selfBlockCancels} self-block cancel(s) and ${lockTimeouts} lock-timeout (55P03) failure(s); guardrail/concurrency edges are burning runs.`,
      "Keep the self-block guard excluding the reporting run; reduce lock contention; review blocked-status side effects.");
  }
  if (terminalRuns.length >= MIN_SUCCESS_SAMPLE && successRate < LOW_SUCCESS_RATE) {
    push("system_prompt", successRate < 0.5 ? "high" : "medium", "success_rate",
      `Success rate ${(successRate * 100).toFixed(1)}% over ${terminalRuns.length} terminal runs is below ${LOW_SUCCESS_RATE * 100}%; a recurring failure class dominates.`,
      "Inspect dominant error codes on failed runs and tighten system-prompt/tool guidance for that failure class.");
  }
  for (const agent of input.agents) {
    for (const warning of collectAgentConfigHygieneWarnings({
      role: agent.role, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig,
    })) {
      push("adapter_config", warning.code === "agent_excessive_thinking" ? "high" : "low",
        `config_hygiene:${warning.code}:${agent.id}`, warning.message,
        "Adjust the agent adapterConfig per the config-hygiene warning.");
    }
  }
  for (const workflow of input.workflows) {
    for (const warning of collectWorkflowAuthoringWarnings(workflow.steps)) {
      push("workflow_dag", "medium", `config_hygiene:${warning.code}:${workflow.id}`,
        warning.message, "Split or parallelize the serial LLM chain in the workflow definition.");
    }
  }
  bottlenecks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    summary: {
      totalRuns: runs.length, successRate, avgDurationMs, p90DurationMs,
      selfBlockCancels, lockTimeouts, highTokenRuns, slowRuns,
    },
    bottlenecks,
  };
}

/** Read-only loader: three SELECTs then pure diagnosis. No writes (dgate soft). */
export async function loadCompanyHarnessDiagnosis(
  db: Db,
  companyId: string,
  windowHours: number = DIAGNOSIS_DEFAULT_WINDOW_HOURS,
): Promise<HarnessDiagnosisReport> {
  const hours = Number.isFinite(windowHours)
    ? Math.min(Math.max(Math.floor(windowHours), 1), DIAGNOSIS_MAX_WINDOW_HOURS)
    : DIAGNOSIS_DEFAULT_WINDOW_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);

  const [runRows, agentRows, workflowRows] = await Promise.all([
    db
      .select({
        id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error,
        usageJson: heartbeatRuns.usageJson, contextSnapshot: heartbeatRuns.contextSnapshot,
        triggerDetail: heartbeatRuns.triggerDetail,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since)))
      .limit(RUN_SCAN_LIMIT),
    db.select().from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
    db.select().from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.status, "active"))),
  ]);

  const stepTitleByKey = new Map<string, string>();
  for (const workflow of workflowRows) {
    if (!Array.isArray(workflow.stepsJson)) continue;
    for (const step of workflow.stepsJson) {
      const record = parseObject(step);
      if (typeof record.id !== "string") continue;
      const title = typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : record.id;
      stepTitleByKey.set(`${workflow.id}:${record.id}`, title);
    }
  }
  const adapterTypeByAgent = new Map(agentRows.map((a) => [a.id, a.adapterType]));
  const stepTitleOf = (snapshot: Record<string, unknown>, triggerDetail: string | null) => {
    const stepId = typeof snapshot.workflowStepId === "string" ? snapshot.workflowStepId
      : typeof snapshot.stepId === "string" ? snapshot.stepId : null;
    if (!stepId) return triggerDetail;
    const defId = typeof snapshot.workflowDefinitionId === "string" ? snapshot.workflowDefinitionId : null;
    return stepTitleByKey.get(`${defId}:${stepId}`) ?? stepId;
  };

  return diagnoseHarnessTelemetry({
    runs: runRows.map((row) => ({
      id: row.id,
      status: row.status,
      durationMs:
        row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      outputTokens: readRawUsageTotals(row.usageJson)?.outputTokens ?? null,
      errorCode: row.errorCode ?? null,
      error: row.error ?? null,
      stepTitle: stepTitleOf(parseObject(row.contextSnapshot), row.triggerDetail),
      adapterType: adapterTypeByAgent.get(row.agentId) ?? null,
    })),
    agents: agentRows.map((row) => ({
      id: row.id, role: row.role, adapterType: row.adapterType, adapterConfig: row.adapterConfig ?? null,
    })),
    workflows: workflowRows.map((row) => ({
      id: row.id, name: row.name, steps: Array.isArray(row.stepsJson) ? row.stepsJson : [],
    })),
  });
}
