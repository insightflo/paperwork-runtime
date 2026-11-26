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

export type ControlPlaneGateKind =
  | "approval"
  | "operator_decision"
  | "worktree_proposal"
  | "budget_incident";

export type ControlPlaneSeverity = "critical" | "high" | "medium" | "low";

export interface ControlPlaneSummary {
  activeRuns?: number;
  queuedRuns?: number;
  runningWorkers?: number;
  queuedWorkers?: number;
  activeAgents: number;
  totalAgents?: number;
  pendingApprovals?: number;
  pendingDecisions?: number;
  openBudgetIncidents?: number;
  pendingWorktreeProposals?: number;
  pendingGates?: number;
  passRatePct?: number | null;
  successRate24h?: number | null;
  totalRuns24h?: number;
  succeededRuns24h?: number;
  failedRuns24h?: number;
}

export interface ControlPlaneWorker {
  id?: string;
  runId?: string;
  agentId?: string;
  name?: string;
  agentName?: string;
  role?: string | null;
  slot?: string;
  adapterType?: string | null;
  adapter?: string | null;
  cli?: string | null;
  model?: string | null;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  elapsedSec?: number | null;
  durationSec?: number | null;
  durationMs?: number | null;
  contextLabel?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  activity?: string | null;
  [key: string]: unknown;
}

export interface ControlPlaneGateItem {
  id?: string;
  key?: string;
  kind?: ControlPlaneGateKind | string;
  title?: string;
  label?: string;
  count?: number;
  pending?: number;
  status?: string;
  severity?: ControlPlaneSeverity | string;
  createdAt?: string;
  linkPath?: string;
  route?: string;
  [key: string]: unknown;
}

export interface ControlPlaneGates {
  approvals?: ControlPlaneGateItem[];
  operatorDecisions?: ControlPlaneGateItem[];
  worktreeProposals?: ControlPlaneGateItem[];
  budgetIncidents?: ControlPlaneGateItem[];
  pendingApprovals?: number;
  ownerDecisions?: number;
  worktreeProposalsCount?: number;
  budgetIncidentsCount?: number;
  totalPending?: number;
  items?: ControlPlaneGateItem[];
  [key: string]: unknown;
}

export interface ControlPlaneOutcomes {
  windowHours?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  timedOut?: number;
  running?: number;
  queued?: number;
  byAdapter?: Record<string, number>;
  byProvider?: Record<string, number>;
  pass?: number;
  rework?: number;
  fail?: number;
  waiting_human?: number;
  [key: string]: unknown;
}

export interface ControlPlaneProviderBreakdown {
  adapterType?: string;
  adapter?: string;
  provider?: string;
  model?: string | null;
  runs?: number;
  succeeded?: number;
  failed?: number;
  running?: number;
  queued?: number;
  count?: number;
  sharePct?: number;
  successRate?: number | null;
  [key: string]: unknown;
}

export interface ControlPlaneEvent {
  id?: string;
  timestamp?: string;
  ts?: string;
  createdAt?: string;
  at?: string;
  kind?: string;
  type?: string;
  event?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorType?: string;
  severity?: string;
  status?: string;
  actor?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  message?: string;
  summary?: string;
  detail?: string;
  route?: string | null;
  [key: string]: unknown;
}

export interface DgateSnapshot {
  timestamp: string;
  scope: string;
  db_live: boolean;
  total_forks: number;
  open_forks: number;
  outcomes: Record<string, number> & ControlPlaneOutcomes;
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
  source?: "paperwork_internal" | "poll" | "push" | "none" | string;
  summary?: ControlPlaneSummary;
  gates?: ControlPlaneGates | ControlPlaneGateItem[];
  recentEvents?: ControlPlaneEvent[];
  adapters?: ControlPlaneProviderBreakdown[];
}

export type ControlPlaneSnapshot = DgateSnapshot;

export interface DgateDashboardBridgeResponse {
  // Paperwork native flat internal control-plane fields (Wave 1 GET /dashboard/dgate)
  connected?: boolean;
  source?: "paperwork_internal" | "poll" | "push" | "none" | string;
  timestamp?: string;
  summary?: ControlPlaneSummary;
  workers?: ControlPlaneWorker[];
  gates?: ControlPlaneGates | ControlPlaneGateItem[];
  outcomes?: ControlPlaneOutcomes;
  recentEvents?: ControlPlaneEvent[];
  adapters?: ControlPlaneProviderBreakdown[];
  // Backward-compatible legacy bridge fields
  available?: boolean;
  sourceUrl?: string | null;
  stale?: boolean;
  fetchedAt?: string | null;
  error?: string | null;
  reason?: string | null;
  snapshot?: ControlPlaneSnapshot | null;
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
