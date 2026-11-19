import { api } from "./client";

/**
 * Typed adapter bridging Board UI surfaces with backend endpoints in `routes/worktree.ts`:
 *  - `/companies/:companyId/hermit-gate/state|claims|verify|merges|audit|decisions`
 *  - `/companies/:companyId/ops-console/overview|thresholds|processes/:pid/stop|queue`
 */

export interface HermitPathClaim {
  id: string;
  taskId: string;
  worktreeName: string;
  paths: string[];
  createdAt?: string;
}

export interface HermitAuditProgress {
  completed: number;
  total: number;
  auditActive?: boolean;
  pendingScopes?: string[];
  lastAuditMergeSha?: string | null;
}

export interface HermitValidationResult {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

export interface CoreDecision {
  id: string;
  taskId?: string;
  decision: string;
  rationale: string;
  impact: string;
  amendTarget: string;
  createdAt?: string;
}

export interface SystemResourceUsage {
  cpuPercent: number;
  ramPercent: number;
  diskPercent: number | null;
}

export interface ResourceAlertThresholds {
  cpuPercent: number;
  ramPercent: number;
  diskPercent: number;
}

export interface BackgroundProcess {
  pid: number;
  etime: string;
  command: string;
  ownedChild?: boolean;
}

interface BackendGateState {
  claims: Array<{ claimId: string; taskId: string; worktreeName: string; paths: string[]; createdAt?: string }>;
  auditState: {
    threshold: number;
    lastAuditMergeSha: string | null;
    auditActive: boolean;
    blockedScopes: string[];
    mergedPrsSinceAudit: Array<{ prNumber: number; mergeSha: string }>;
  };
  decisions: Array<{
    id: string;
    taskId: string;
    decision: string;
    rationaleAndAssumption: string;
    impact: string;
    whereToChange: string;
    createdAt?: string;
  }>;
}

interface BackendOpsOverview {
  resources: {
    cpuPct: number;
    memUsedPct: number;
    diskUsedPct: number | null;
    thresholds: { cpuPct: number; memPct: number; diskPct: number };
  };
  backgroundProcesses: Array<{ pid: number; elapsed: string; command: string; stoppable?: boolean }>;
}

const hg = (companyId: string, suffix: string) => `/companies/${companyId}/hermit-gate${suffix}`;
const oc = (companyId: string, suffix: string) => `/companies/${companyId}/ops-console${suffix}`;

const fetchGateState = (companyId: string) => api.get<BackendGateState>(hg(companyId, "/state"));
const fetchOverview = (companyId: string) => api.get<BackendOpsOverview>(oc(companyId, "/overview"));

const mapClaims = (claims: BackendGateState["claims"]): HermitPathClaim[] =>
  claims.map((c) => ({
    id: c.claimId,
    taskId: c.taskId,
    worktreeName: c.worktreeName,
    paths: c.paths,
    createdAt: c.createdAt,
  }));

const mapAudit = (a: BackendGateState["auditState"]): HermitAuditProgress => ({
  completed: a.mergedPrsSinceAudit.length,
  total: a.threshold,
  auditActive: a.auditActive,
  pendingScopes: a.blockedScopes,
  lastAuditMergeSha: a.lastAuditMergeSha,
});

const mapDecision = (d: BackendGateState["decisions"][number]): CoreDecision => ({
  id: d.id,
  taskId: d.taskId,
  decision: d.decision,
  rationale: d.rationaleAndAssumption,
  impact: d.impact,
  amendTarget: d.whereToChange,
  createdAt: d.createdAt,
});

const mapOverview = (ov: BackendOpsOverview) => ({
  resources: {
    cpuPercent: ov.resources.cpuPct,
    ramPercent: ov.resources.memUsedPct,
    diskPercent: ov.resources.diskUsedPct ?? null,
  },
  thresholds: {
    cpuPercent: ov.resources.thresholds.cpuPct,
    ramPercent: ov.resources.thresholds.memPct,
    diskPercent: ov.resources.thresholds.diskPct,
  },
  processes: ov.backgroundProcesses.map((p) => ({
    pid: p.pid,
    etime: p.elapsed,
    command: p.command,
    ownedChild: p.stoppable,
  })),
});

export const hermitGateApi = {
  state: async (companyId: string) => {
    const state = await fetchGateState(companyId);
    return {
      claims: mapClaims(state.claims),
      audit: mapAudit(state.auditState),
      decisions: state.decisions.map(mapDecision),
    };
  },
  claims: async (companyId: string): Promise<HermitPathClaim[]> => mapClaims((await fetchGateState(companyId)).claims),
  claim: async (companyId: string, data: { taskId: string; worktreeName: string; paths: string[] }) => {
    const res = await api.post<{ ok: boolean; claim: BackendGateState["claims"][number] }>(hg(companyId, "/claims"), data);
    return { id: res.claim.claimId, ...res.claim };
  },
  releaseClaim: (companyId: string, taskId: string) =>
    api.delete(hg(companyId, `/claims/${encodeURIComponent(taskId)}`)),

  auditProgress: async (companyId: string): Promise<HermitAuditProgress> =>
    mapAudit((await fetchGateState(companyId)).auditState),
  completeAudit: async (companyId: string, data: { pendingScopes?: string[] }): Promise<HermitAuditProgress> => {
    if (data.pendingScopes && data.pendingScopes.length > 0) {
      const next = await api.post<BackendGateState["auditState"]>(hg(companyId, "/audit/scope"), {
        blockedScopes: data.pendingScopes,
      });
      return mapAudit(next);
    }
    const state = await fetchGateState(companyId);
    const tailSha =
      state.auditState.mergedPrsSinceAudit.at(-1)?.mergeSha ?? state.auditState.lastAuditMergeSha;
    if (!tailSha) {
      throw new Error("감사 완료 기준 병합 커밋이 없습니다");
    }
    const next = await api.post<BackendGateState["auditState"]>(hg(companyId, "/audit/complete"), {
      auditedThroughSha: tailSha,
    });
    return mapAudit(next);
  },

  validate: async (
    companyId: string,
    data: { stage: "pre-commit" | "pr"; taskId?: string; paths?: string[] },
  ): Promise<HermitValidationResult> => {
    const changes = (data.paths ?? []).filter(Boolean).map((p) => ({ path: p }));
    const verdict = await api.post<{
      decision: "proceed" | "hold_action" | "needs_user_decision";
      reason: string;
      violations: Array<{ path: string; detail: string }>;
    }>(hg(companyId, "/verify"), {
      taskId: data.taskId?.trim() || "operator-check",
      mode: data.stage === "pre-commit" ? "commit" : "pr",
      changes,
    });
    return {
      ok: verdict.decision === "proceed",
      errors: verdict.violations.map((v) => `${v.path}: ${v.detail}`),
    };
  },

  decisions: async (companyId: string): Promise<CoreDecision[]> =>
    (await fetchGateState(companyId)).decisions.map(mapDecision),
  createDecision: async (companyId: string, data: Omit<CoreDecision, "id" | "createdAt">): Promise<CoreDecision> => {
    const d = await api.post<BackendGateState["decisions"][number]>(hg(companyId, "/decisions"), {
      taskId: data.taskId?.trim() || "operator",
      decision: data.decision,
      rationaleAndAssumption: data.rationale.trim() || "-",
      impact: data.impact.trim() || "-",
      whereToChange: data.amendTarget.trim() || "-",
    });
    return mapDecision(d);
  },
};

export const opsConsoleApi = {
  overview: async (companyId: string) => mapOverview(await fetchOverview(companyId)),
  resources: async (companyId: string): Promise<SystemResourceUsage> => mapOverview(await fetchOverview(companyId)).resources,
  thresholds: async (companyId: string): Promise<ResourceAlertThresholds> => mapOverview(await fetchOverview(companyId)).thresholds,
  updateThresholds: async (companyId: string, data: ResourceAlertThresholds): Promise<ResourceAlertThresholds> => {
    const saved = await api.put<{ cpuPct: number; memPct: number; diskPct: number }>(oc(companyId, "/thresholds"), {
      cpuPct: data.cpuPercent,
      memPct: data.ramPercent,
      diskPct: data.diskPercent,
    });
    return { cpuPercent: saved.cpuPct, ramPercent: saved.memPct, diskPercent: saved.diskPct };
  },
  processes: async (companyId: string): Promise<BackgroundProcess[]> => mapOverview(await fetchOverview(companyId)).processes,
  stopProcess: (companyId: string, pid: number) =>
    api.post<{ ok: boolean }>(oc(companyId, `/processes/${pid}/stop`), {}),
  queue: (companyId: string) => api.get<unknown>(oc(companyId, "/queue")),
};
