export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}

export type DashboardTelemetryWindow = "10m" | "1h" | "6h" | "24h";

export interface DashboardTelemetryBucket {
  ts: string; // ISO bucket start
  label: string; // HH:mm
  totalTokens: number;
  costCents: number;
  runs: number;
  byModel: Record<string, number>; // model/provider -> tokens
}

export interface DashboardUsageShare {
  id: string;
  name: string;
  kind: "project" | "agent";
  tokens: number;
  costCents: number;
  sharePct: number; // 0..100 rounded to 1 decimal
}

export interface DashboardLiveSession {
  runId: string;
  status: string; // "running" | "queued" | "succeeded" | "failed" | ...
  isActive: boolean;
  agentId: string;
  agentName: string;
  adapterType: string;
  model: string | null;
  provider: string | null;
  projectId: string | null;
  projectName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  recentTokens: number; // tokens in window
  totalTokens: number; // total tokens for run
  outputTokens: number;
  costCents: number;
  burnRateTokPerHour: number; // estimated tokens/hour
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
}

export interface DashboardTelemetryResponse {
  window: DashboardTelemetryWindow;
  generatedAt: string;
  velocity: {
    tokensPerHour: number;
    peakTokensPerHour: number;
    totalTokens: number;
    avgTokensPerBucket: number;
    totalCostCents: number;
    activeSessions: number;
    idleSessions: number;
  };
  host: {
    cpuPct: number; // 0..100 from os.loadavg()[0] / os.cpus().length
    ramPct: number; // 0..100 from (totalmem - freemem) / totalmem
    ramUsedGb: number;
    ramTotalGb: number;
    activeRuns: number;
  };
  models: string[]; // ordered top 5 models (+ "other" if present)
  buckets: DashboardTelemetryBucket[];
  projectShares: DashboardUsageShare[];
  agentShares: DashboardUsageShare[];
  sessions: DashboardLiveSession[];
}

export interface DgateSnapshot {
  [key: string]: unknown;
}

export type DgateBridgeSource = "poll" | "push" | "none";

export interface DgateDashboardBridgeResponse {
  available: boolean;
  source: DgateBridgeSource;
  stale: boolean;
  fetchedAt: string | null;
  snapshot: DgateSnapshot | null;
  reason?: string;
}

export interface DgateSnapshotPushResponse {
  ok: true;
  fetchedAt: string;
}

export type ControlPlaneGateKind =
  | "approval"
  | "operator_decision"
  | "worktree_proposal"
  | "budget_incident";

export type ControlPlaneSeverity = "critical" | "high" | "medium" | "low";

export interface ControlPlaneSummary {
  activeRuns: number;
  queuedRuns: number;
  activeAgents: number;
  totalAgents: number;
  pendingApprovals: number;
  pendingDecisions: number;
  openBudgetIncidents: number;
  pendingWorktreeProposals: number;
  passRatePct: number;
}

export interface ControlPlaneWorker {
  agentId: string;
  agentName: string;
  role: string;
  adapterType: string;
  model: string | null;
  status: string;
  runId: string;
  startedAt: string | null;
  durationMs: number;
  contextLabel: string;
}

export interface ControlPlaneGateItem {
  id: string;
  kind: ControlPlaneGateKind;
  title: string;
  status: string;
  severity: ControlPlaneSeverity;
  createdAt: string;
  linkPath: string;
}

export interface ControlPlaneGates {
  approvals: ControlPlaneGateItem[];
  operatorDecisions: ControlPlaneGateItem[];
  worktreeProposals: ControlPlaneGateItem[];
  budgetIncidents: ControlPlaneGateItem[];
}

export interface ControlPlaneOutcomes {
  windowHours: number;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  running: number;
  queued: number;
  byAdapter: Record<string, number>;
  byProvider: Record<string, number>;
}

export interface ControlPlaneEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  createdAt: string;
  summary: string;
}

export interface ControlPlaneSnapshotResponse {
  connected: true;
  source: "paperwork_internal";
  timestamp: string;
  summary: ControlPlaneSummary;
  workers: ControlPlaneWorker[];
  gates: ControlPlaneGates;
  outcomes: ControlPlaneOutcomes;
  recentEvents: ControlPlaneEvent[];
}
