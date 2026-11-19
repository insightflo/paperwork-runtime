/**
 * Hermit Gate 서비스 — 은둔(park) 작업의 경로 선점·변경 검증·누적 병합 감사·중대 결정 원장.
 *
 * 저장: 회사별 상태를 단일 JSON 으로 원자 기록(tmp + renameSync).
 *   기본 위치 = PAPERCLIP_HERMIT_STATE_DIR ?? os.tmpdir()/paperclip-hermit-gate.
 *   손상/부재 파일은 기본 상태로 복구한다(첫 실행 초기화).
 * 동시성: 회사별 in-process Promise 큐 뮤텍스(withLock)로 모든 변이를 직렬화한다.
 * 경계: run-status(heartbeat_runs/workflow_runs)와 무관하며 DB 런 상태를 쓰지 않는다.
 * 순수 계약(스키마·타입·경로 판정)은 hermit-gate-types.ts 를 참고한다.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { badRequest, unprocessable } from "../errors.js";
import type {
  ChangeVerificationInput, ClaimRequest, ClaimResult, CompanyGateState,
  ConsequentialDecision, DecisionRecord, GateVerdict, GateViolation, MergeRecordInput, PathClaim,
} from "./hermit-gate-types.js";
import { DEEP_IMPORT_PATTERNS, defaultAuditState, normalizeRepoPath, pathWithin, pathsOverlap } from "./hermit-gate-types.js";

export { normalizeRepoPath, pathsOverlap } from "./hermit-gate-types.js";

const DEFAULT_CLAIM_TTL_MINUTES = 240;
let warnedTmpFallback = false;

function pruneExpiredClaims(state: CompanyGateState, nowMs = Date.now()): void {
  state.claims = state.claims.filter((claim) => {
    if (!claim.expiresAt) return true;
    const expiryMs = Date.parse(claim.expiresAt);
    return Number.isFinite(expiryMs) && expiryMs > nowMs;
  });
}

function stateFilePath(stateDir: string, companyId: string): string {
  return path.join(stateDir, `hermit-gate-${companyId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function loadCompanyState(stateDir: string, companyId: string): CompanyGateState {
  const file = stateFilePath(stateDir, companyId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CompanyGateState> | null;
    if (!parsed || typeof parsed !== "object") return { claims: [], audit: defaultAuditState(), decisions: [] };
    const auditInput = (parsed.audit ?? {}) as Partial<CompanyGateState["audit"]>;
    return {
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      audit: {
        ...defaultAuditState(),
        ...auditInput,
        blockedScopes: Array.isArray(auditInput.blockedScopes) ? auditInput.blockedScopes : [],
        mergedPrsSinceAudit: Array.isArray(auditInput.mergedPrsSinceAudit) ? auditInput.mergedPrsSinceAudit : [],
      },
    };
  } catch {
    if (fs.existsSync(file)) {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* noop */ }
    }
    return { claims: [], audit: defaultAuditState(), decisions: [] };
  }
}

function persistCompanyState(stateDir: string, companyId: string, state: CompanyGateState): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = stateFilePath(stateDir, companyId);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function createHermitGateService(options?: { stateDir?: string }) {
  if (!options?.stateDir && !process.env.PAPERCLIP_HERMIT_STATE_DIR && !process.env.PAPERCLIP_HOME && !warnedTmpFallback) {
    warnedTmpFallback = true;
    console.warn("[hermit-gate] PAPERCLIP_HOME unset; falling back to volatile tmpdir state directory");
  }
  const stateDir =
    options?.stateDir ??
    process.env.PAPERCLIP_HERMIT_STATE_DIR ??
    (process.env.PAPERCLIP_HOME ? path.join(process.env.PAPERCLIP_HOME, "hermit-gate") : path.join(os.tmpdir(), "paperclip-hermit-gate"));
  const locks = new Map<string, Promise<unknown>>();

  /** 회사별 직렬화 — 선행 작업 성공/실패와 무관하게 순차 실행하고 꼬리를 정리한다. */
  async function withLock<T>(companyId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = locks.get(companyId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(companyId, tail);
    await tail;
    if (locks.get(companyId) === tail) locks.delete(companyId);
    return run;
  }

  function mutate<T>(companyId: string, fn: (state: CompanyGateState) => T): Promise<T> {
    return withLock(companyId, () => {
      const state = loadCompanyState(stateDir, companyId);
      const result = fn(state);
      persistCompanyState(stateDir, companyId, state);
      return result;
    });
  }

  return {
    stateDir,

    getState(companyId: string) {
      return mutate(companyId, (state) => {
        pruneExpiredClaims(state);
        return { claims: state.claims, auditState: state.audit, decisions: state.decisions };
      });
    },

    claimPaths(companyId: string, input: ClaimRequest): Promise<ClaimResult> {
      return mutate(companyId, (state) => {
        pruneExpiredClaims(state);
        const requested = input.paths.map(normalizeRepoPath);
        const conflicts: GateViolation[] = [];
        for (const candidate of requested) {
          for (const active of state.claims) {
            if (active.taskId === input.taskId) continue;
            for (const claimed of active.paths) {
              if (pathsOverlap(candidate, claimed)) {
                conflicts.push({ kind: "overlap", path: candidate, detail: `${candidate} 경로가 task ${active.taskId}의 선점 경로 ${claimed}와 겹칩니다` });
              }
            }
          }
        }
        if (conflicts.length > 0) {
          return { ok: false, verdict: "hold_action", conflicts, resumeCondition: "선행 task 완료/해제 또는 공유 경로 조정 필요" };
        }
        const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? DEFAULT_CLAIM_TTL_MINUTES) * 60_000).toISOString();
        const existing = state.claims.find((c) => c.taskId === input.taskId);
        if (existing) {
          existing.paths = Array.from(new Set([...existing.paths, ...requested]));
          existing.worktreeName = input.worktreeName;
          existing.expiresAt = expiresAt;
          if (input.agentId !== undefined) existing.agentId = input.agentId;
          return { ok: true, claim: existing };
        }
        const claim: PathClaim = {
          claimId: randomUUID(),
          taskId: input.taskId,
          worktreeName: input.worktreeName,
          agentId: input.agentId,
          paths: requested,
          createdAt: new Date().toISOString(),
          expiresAt,
        };
        state.claims.push(claim);
        return { ok: true, claim };
      });
    },

    releaseTaskClaims(companyId: string, taskId: string) {
      return mutate(companyId, (state) => {
        const before = state.claims.length;
        state.claims = state.claims.filter((c) => c.taskId !== taskId);
        return before - state.claims.length;
      });
    },

    verifyChanges(companyId: string, input: ChangeVerificationInput): Promise<GateVerdict> {
      return mutate(companyId, (state) => {
        const claimed = (state.claims.find((c) => c.taskId === input.taskId)?.paths ?? []).map(normalizeRepoPath);
        const withinScope = (target: string): boolean => {
          try {
            const normalized = normalizeRepoPath(target);
            return claimed.some((root) => pathWithin(normalized, root));
          } catch {
            return false;
          }
        };
        const violations: GateViolation[] = [];
        for (const change of input.changes) {
          if (!withinScope(change.path)) {
            violations.push({ kind: "out_of_scope", path: change.path, detail: `${change.path} 변경이 task ${input.taskId}의 선점 범위 밖입니다` });
          }
          if (change.previousPath !== undefined && !withinScope(change.previousPath)) {
            violations.push({ kind: "rename_out_of_scope", path: change.previousPath, detail: `이동 원본 ${change.previousPath}가 task ${input.taskId}의 선점 범위 밖입니다` });
          }
          for (const imported of change.addedImports ?? []) {
            if (DEEP_IMPORT_PATTERNS.some((re) => re.test(imported))) {
              violations.push({ kind: "internal_deep_import", path: change.path, detail: `내부 패키지 src 직접 import 금지: ${imported}` });
            }
          }
        }
        if (violations.length > 0) {
          return {
            decision: "hold_action",
            reason: `변경 검증 실패(mode=${input.mode}) — 위반 ${violations.length}건`,
            resumeCondition: "범위 내 경로로 수정하거나 클레임 조정 후 재검증 필요",
            violations,
          };
        }
        return { decision: "proceed", reason: `모든 변경이 task ${input.taskId}의 선점 범위 안입니다(mode=${input.mode})`, violations: [] };
      });
    },

    recordMergedPr(companyId: string, input: MergeRecordInput) {
      return mutate(companyId, (state) => {
        const audit = state.audit;
        const duplicate =
          input.mergeSha === audit.lastAuditMergeSha ||
          audit.mergedPrsSinceAudit.some((e) => e.prNumber === input.prNumber || e.mergeSha === input.mergeSha);
        if (!duplicate) {
          audit.mergedPrsSinceAudit.push({
            prNumber: input.prNumber,
            mergeSha: input.mergeSha,
            changedPaths: input.changedPaths,
            mergedAt: new Date().toISOString(),
          });
          if (!audit.auditActive && audit.mergedPrsSinceAudit.length >= audit.threshold) {
            audit.auditActive = true;
            audit.scopeDetermined = false;
            audit.blockedScopes = [];
          }
        }
        return { duplicate, auditState: audit };
      });
    },

    checkMergeGate(companyId: string, input: { changedPaths: string[]; isAuditFix?: boolean }): Promise<GateVerdict> {
      return mutate(companyId, (state) => {
        const audit = state.audit;
        if (!audit.auditActive) return { decision: "proceed", reason: "누적 감사 비활성 — 병합 허용", violations: [] };
        if (input.isAuditFix) return { decision: "proceed", reason: "감사 수정 PR 진행 허용", violations: [] };
        if (!audit.scopeDetermined) {
          return {
            decision: "hold_action",
            reason: `${audit.threshold}개 PR 누적 감사 착수 — 영향 범위 판정 완료 전 일반 병합 일시 보류`,
            resumeCondition: "감사 영향 범위(blockedScopes) 판정 완료 후 재시도",
            violations: [],
          };
        }
        const blocked = input.changedPaths.filter((p) => {
          try {
            return audit.blockedScopes.some((scope) => pathsOverlap(p, scope));
          } catch {
            return true;
          }
        });
        if (blocked.length > 0) {
          return {
            decision: "hold_action",
            reason: `감사 중단 범위와 겹치는 경로: ${blocked.join(", ")}`,
            resumeCondition: "감사 완료 또는 해당 범위 감사 수정 PR로 전환 필요",
            violations: blocked.map((p) => ({ kind: "audit_hold" as const, path: p, detail: `${p} 가 감사 중단 범위에 속합니다` })),
          };
        }
        return { decision: "proceed", reason: "감사 중단 범위 밖 경로 — 병합 허용", violations: [] };
      });
    },

    setAuditScope(companyId: string, blockedScopes: string[]) {
      return mutate(companyId, (state) => {
        state.audit.scopeDetermined = true;
        state.audit.blockedScopes = blockedScopes.map(normalizeRepoPath);
        return state.audit;
      });
    },

    completeAudit(companyId: string, auditedThroughSha: string) {
      return mutate(companyId, (state) => {
        const trimmed = auditedThroughSha.trim();
        if (!trimmed || trimmed === "audit-head") {
          throw badRequest("유효한 감사 기준 커밋 SHA가 필요합니다");
        }
        const audit = state.audit;
        if (audit.mergedPrsSinceAudit.length === 0) {
          if (audit.lastAuditMergeSha !== null && trimmed === audit.lastAuditMergeSha) {
            audit.auditActive = false;
            audit.scopeDetermined = false;
            audit.blockedScopes = [];
            return audit;
          }
          throw unprocessable("감사 완료 처리할 누적 병합 항목이 없습니다");
        }
        const idx = audit.mergedPrsSinceAudit.findIndex((e) => e.mergeSha === trimmed);
        if (idx < 0) {
          throw unprocessable("감사 기준 커밋(auditedThroughSha)이 현재 감사 윈도우에 없습니다");
        }
        // 감사 중 도착한 병합은 버리지 않는다: auditedThroughSha 이후 항목만 유지.
        audit.mergedPrsSinceAudit = audit.mergedPrsSinceAudit.slice(idx + 1);
        audit.lastAuditMergeSha = trimmed;
        audit.auditActive = false;
        audit.scopeDetermined = false;
        audit.blockedScopes = [];
        return audit;
      });
    },

    recordDecision(companyId: string, input: DecisionRecord) {
      return mutate(companyId, (state) => {
        const decision: ConsequentialDecision = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
        state.decisions.push(decision);
        return decision;
      });
    },

    updateDecision(companyId: string, decisionId: string, reason: string) {
      return mutate(companyId, (state) => {
        const found = state.decisions.find((d) => d.id === decisionId);
        if (!found) return null;
        found.updatedReason = reason;
        found.updatedAt = new Date().toISOString();
        return found;
      });
    },

    listDecisions(companyId: string) {
      return mutate(companyId, (state) => state.decisions);
    },
  };
}

export type HermitGateService = ReturnType<typeof createHermitGateService>;

let singleton: HermitGateService | null = null;

/** 공유 싱글턴 접근자 — 라우트 등 소비자가 같은 상태 디렉터리를 바라보게 한다. */
export function getHermitGateService(_dbOrKey?: unknown): HermitGateService {
  if (!singleton) singleton = createHermitGateService();
  return singleton;
}
