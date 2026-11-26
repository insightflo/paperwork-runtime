import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

export type DashboardTelemetryWindow = "10m" | "1h" | "6h" | "24h";

export interface DashboardTelemetryBucket {
  bucketStart: string;
  bucketEnd: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: number;
  runs: number;
  byModel: Record<string, number>;
}

export interface DashboardUsageShare {
  id: string | null;
  name: string;
  tokens: number;
  costCents: number;
  runs: number;
  sharePct: number;
}

export interface DashboardLiveSession {
  runId: string;
  agentId: string;
  agentName: string;
  adapterType?: string | null;
  model?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  status: string;
  startedAt: string | null;
  elapsedSec?: number;
  tokens?: number;
  costCents?: number;
}

export interface DashboardTelemetryHost {
  cpuPct: number | null;
  memPct: number | null;
  memUsedGb?: number | null;
  memTotalGb?: number | null;
  loadAvg1m?: number | null;
  activeRuns: number;
  activeAgents?: number;
  hostname?: string | null;
}

export interface DashboardTelemetryVelocity {
  tokensPerHour: number;
  peakTokensPerHour: number;
  totalTokens: number;
  avgTokensPerBucket: number;
  totalCostCents: number;
  totalRuns: number;
}

export interface DashboardTelemetryResponse {
  window: DashboardTelemetryWindow;
  windowMinutes: number;
  bucketMinutes: number;
  generatedAt: string;
  velocity: DashboardTelemetryVelocity;
  models: string[];
  buckets: DashboardTelemetryBucket[];
  projectShares: DashboardUsageShare[];
  agentShares: DashboardUsageShare[];
  liveSessions: DashboardLiveSession[];
  host: DashboardTelemetryHost;
}

export interface DgateSystemMetrics {
  cpu_pct?: number | null;
  mem_pct?: number | null;
  mem_used_gb?: number | null;
  mem_total_gb?: number | null;
  load_1m?: number | null;
  active_processes?: number | null;
  [key: string]: unknown;
}

export interface DgateSnapshot {
  timestamp: string;
  scope: string;
  db_live: boolean;
  total_forks: number;
  open_forks: number;
  outcomes: Record<string, number>;
  effort_level: string | null;
  host_process_count: number;
  mapped_count: number;
  providers: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  active_gates: Array<Record<string, unknown>>;
  lead: Record<string, unknown> | null;
  verifiers: Array<Record<string, unknown>>;
  advisors: Array<Record<string, unknown>>;
  workers: Array<Record<string, unknown>>;
  local_repo: Record<string, unknown> | null;
  system: DgateSystemMetrics | null;
  recent_events: Array<Record<string, unknown>>;
}

export interface DgateDashboardBridgeResponse {
  available: boolean;
  sourceUrl?: string | null;
  fetchedAt: string;
  error?: string | null;
  snapshot: DgateSnapshot | null;
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  telemetry: (companyId: string, window: DashboardTelemetryWindow = "1h") =>
    api.get<DashboardTelemetryResponse>(
      `/companies/${companyId}/dashboard/telemetry?window=${encodeURIComponent(window)}`,
    ),
  dgate: (companyId: string) =>
    api.get<DgateDashboardBridgeResponse>(`/companies/${companyId}/dashboard/dgate`),
};
