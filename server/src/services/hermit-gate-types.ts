/**
 * Hermit Gate 계약 타입·스키마 (r60-hermit-gate-design 기반)
 *
 * 목적: 웨이브2 백엔드(은둔 작업 게이트)의 입력 검증 zod 스키마와 상태 타입을
 * 서비스/라우트/테스트가 공유한다. 이 파일은 자료 구조만 정의하고 부수효과가 없다.
 * ops-console 라우트 입력 스키마(큐 재정렬/편집, 리소스 임계치)도 같은 이유로 여기 둔다.
 */

import { z } from "zod";
import { badRequest } from "../errors.js";

export const DEFAULT_AUDIT_THRESHOLD = 25;

/** 내부 패키지 src 내부 경로 직접 import 금지 패턴. */
export const DEEP_IMPORT_PATTERNS: RegExp[] = [
  /@paperclipai\/[^/]+\/src\//,
  /\.\.\/\.\.\/packages\/[^/]+\/src\//,
];

/** 저장소 경로 정규화 — `//`·`.` 축소, 선행/후행 `/` 제거, `..` 트래버설 및 빈 결과 거부. */
export function normalizeRepoPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) throw badRequest("경로가 비어 있습니다");
  const segments = p.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw badRequest(`경로 트래버설은 허용되지 않습니다: ${p}`);
  }
  const norm = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (norm.length === 0) {
    throw badRequest(`유효한 저장소 상대 경로가 아닙니다: ${p}`);
  }
  return norm;
}

/** 조상-후손 포함 겹침 판정: a === b || a가 b 하위 || b가 a 하위. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeRepoPath(a);
  const nb = normalizeRepoPath(b);
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/**
 * 자식 경로가 조상 범위 안인지(같음 또는 하위) — 변경 검증용 단방향 판정.
 * 호출자는 반드시 `normalizeRepoPath` 로 정규화된 경로를 전달해야 한다.
 */
export function pathWithin(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + "/");
}

export function defaultAuditState(): MergeAuditState {
  return {
    threshold: DEFAULT_AUDIT_THRESHOLD,
    lastAuditMergeSha: null,
    auditActive: false,
    scopeDetermined: false,
    blockedScopes: [],
    mergedPrsSinceAudit: [],
  };
}

// ---------------------------------------------------------------------------
// Path claim — 작업 경로 선점
// ---------------------------------------------------------------------------

export const ClaimRequestSchema = z.object({
  taskId: z.string().min(1),
  worktreeName: z.string().min(1),
  agentId: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1),
  ttlMinutes: z.number().int().min(1).max(10_080).optional(),
});

export interface PathClaim {
  claimId: string;
  taskId: string;
  worktreeName: string;
  agentId?: string;
  paths: string[];
  createdAt: string;
  /** 클레임 만료 시각(ISO 8601) — 비정상 종료 태스크의 스테일 선점 자동 회수 기준. */
  expiresAt?: string;
}

export type ClaimResult =
  | { ok: true; claim: PathClaim }
  | {
      ok: false;
      verdict: "hold_action";
      conflicts: GateViolation[];
      resumeCondition: string;
    };

// ---------------------------------------------------------------------------
// 변경 검증 (pre-commit / pre-PR)
// ---------------------------------------------------------------------------

export const ChangeEntrySchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().optional(),
  addedImports: z.array(z.string()).optional(),
});

export const ChangeVerificationInputSchema = z.object({
  taskId: z.string().min(1),
  mode: z.enum(["commit", "pr"]),
  baseBranch: z.string().optional(),
  changes: z.array(ChangeEntrySchema),
});

export type GateViolationKind =
  | "out_of_scope"
  | "rename_out_of_scope"
  | "internal_deep_import"
  | "overlap"
  | "audit_hold";

export interface GateViolation {
  kind: GateViolationKind;
  path: string;
  detail: string;
}

export interface GateVerdict {
  decision: "proceed" | "hold_action" | "needs_user_decision";
  reason: string;
  resumeCondition?: string;
  violations: GateViolation[];
}

// ---------------------------------------------------------------------------
// 25-PR 누적 병합 감사
// ---------------------------------------------------------------------------

export const MergeRecordInputSchema = z.object({
  prNumber: z.number().int().positive(),
  mergeSha: z.string().min(1),
  changedPaths: z.array(z.string()),
  isAuditFix: z.boolean().optional(),
});

export const AuditScopeInputSchema = z.object({
  blockedScopes: z.array(z.string().min(1)),
});

export const AuditCompleteInputSchema = z.object({
  auditedThroughSha: z.string().min(1),
});

export interface MergedPrRecord {
  prNumber: number;
  mergeSha: string;
  changedPaths: string[];
  mergedAt: string;
}

export interface MergeAuditState {
  threshold: number;
  lastAuditMergeSha: string | null;
  auditActive: boolean;
  scopeDetermined: boolean;
  blockedScopes: string[];
  mergedPrsSinceAudit: MergedPrRecord[];
}

/** 회사별 게이트 저장 상태(파일 지속화 단위) — hermit-gate.ts 전용. */
export interface CompanyGateState {
  claims: PathClaim[];
  audit: MergeAuditState;
  decisions: ConsequentialDecision[];
}

// ---------------------------------------------------------------------------
// 중대 결정 원장 (consequential decision ledger)
// ---------------------------------------------------------------------------

export const DecisionRecordSchema = z.object({
  taskId: z.string().min(1),
  decision: z.string().min(1),
  rationaleAndAssumption: z.string().min(1),
  impact: z.string().min(1),
  whereToChange: z.string().min(1),
});

export const DecisionUpdateInputSchema = z.object({
  reason: z.string().min(1),
});

export interface ConsequentialDecision {
  id: string;
  taskId: string;
  decision: string;
  rationaleAndAssumption: string;
  impact: string;
  whereToChange: string;
  createdAt: string;
  updatedReason?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Ops-console 라우트 입력 (큐·리소스 임계치) — 검증 계층 일관성을 위해 여기서 정의
// ---------------------------------------------------------------------------

export const QueueReorderInputSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export const QueueEditInputSchema = z
  .object({
    prompt: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((v) => v.prompt !== undefined || v.note !== undefined, {
    message: "prompt 또는 note 중 하나는 필요합니다",
  });

export const ThresholdsInputSchema = z.object({
  cpuPct: z.number(),
  memPct: z.number(),
  diskPct: z.number(),
});

export interface ResourceThresholds {
  cpuPct: number;
  memPct: number;
  diskPct: number;
}

export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
export type ChangeVerificationInput = z.infer<typeof ChangeVerificationInputSchema>;
export type MergeRecordInput = z.infer<typeof MergeRecordInputSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
