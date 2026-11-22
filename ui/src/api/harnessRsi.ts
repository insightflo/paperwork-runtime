// ui/src/api/harnessRsi.ts
//
// [파일 목적] GET /api/companies/:companyId/harness-rsi/diagnose 읽기 전용 클라이언트.
//   server/src/services/harness-rsi/telemetry-diagnose.ts의 HarnessDiagnosisReport와
//   routes/harness-rsi.ts의 응답 봉투({ companyId, windowHours, report })를 미러한다.
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

export const harnessRsiApi = {
  diagnose: (companyId: string, windowHours = 24) => {
    const searchParams = new URLSearchParams();
    searchParams.set("windowHours", String(windowHours));
    return api.get<HarnessDiagnosisResponse>(
      `/companies/${companyId}/harness-rsi/diagnose?${searchParams.toString()}`,
    );
  },
};
