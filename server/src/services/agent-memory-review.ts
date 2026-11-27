// server/src/services/agent-memory-review.ts
// [파일 목적] 에이전트 메모리 파일 변경 제안(review)과 승인/거절/보류(hold) 장부.
//   메모리 덮어쓰기 전 사람 검증을 강제하고, hold 동안 isTargetHeld로 해당 대상
//   파일의 추가 변경을 막는다. 실행 판정은 이 구조화 장부의 상태만 읽으며,
//   자연어 주석·설명은 권한 근거가 아니다.

import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "../errors.js";

export type MemoryReviewStatus = "pending" | "approved" | "rejected" | "held";

export interface MemoryReviewProposal {
  id: string;
  companyId: string;
  agentId: string;
  targetPath: string;
  beforeContent: string;
  afterContent: string;
  diffLines: string[];
  summary: string;
  status: MemoryReviewStatus;
  heldUntilMs: number | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MemoryReviewDecision = "approve" | "reject" | "hold";

export interface ProposeMemoryReviewInput {
  companyId: string;
  agentId: string;
  targetPath: string;
  beforeContent: string;
  afterContent: string;
  summary: string;
}

export interface DecideMemoryReviewInput {
  decision: MemoryReviewDecision;
  userId: string;
  note?: string;
  holdMs?: number;
}

const DEFAULT_HOLD_MS = 24 * 60 * 60_000;

// LCS(최장 공통 부분 수열) 기반 줄 단위 통합 diff. 결정론적 출력("- 제거,
// + 추가, 2칸 공백 문맥")이 계약이므로 환경에 따라 달라지는 외부 diff 대신
// 자체 계산을 쓴다. 메모리 파일은 수백 줄 수준이라 O(n*m)로 충분하다.
export function computeLineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push(`- ${a[i]}`);
    i += 1;
  }
  while (j < b.length) {
    lines.push(`+ ${b[j]}`);
    j += 1;
  }
  return lines;
}

// 메모리 대상 경로는 안전한 상대 경로만 허용한다. `..`는 경로 탈출, NUL은
// 바이너리 주입 시도이므로 fail-closed로 거절한다. 이 검사는 hold 차단이
// 실제 파일을 지키기 위한 전제다.
function assertSafeTargetPath(targetPath: string): void {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw badRequest("targetPath is required");
  }
  if (targetPath.includes("..") || targetPath.includes("\0")) {
    throw badRequest("targetPath must not contain path traversal or NUL bytes");
  }
}

export interface MemoryReviewStore {
  propose(input: ProposeMemoryReviewInput): MemoryReviewProposal;
  list(
    companyId: string,
    opts?: { status?: MemoryReviewStatus; agentId?: string },
  ): MemoryReviewProposal[];
  decide(
    companyId: string,
    proposalId: string,
    input: DecideMemoryReviewInput,
  ): MemoryReviewProposal;
  isTargetHeld(companyId: string, agentId: string, targetPath: string, nowMs?: number): boolean;
}

export function createMemoryReviewStore(): MemoryReviewStore {
  const proposals = new Map<string, MemoryReviewProposal>();

  return {
    propose(input) {
      assertSafeTargetPath(input.targetPath);
      const now = Date.now();
      const proposal: MemoryReviewProposal = {
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        targetPath: input.targetPath,
        beforeContent: input.beforeContent,
        afterContent: input.afterContent,
        diffLines: computeLineDiff(input.beforeContent, input.afterContent),
        summary: input.summary,
        status: "pending",
        heldUntilMs: null,
        reviewedByUserId: null,
        reviewNote: null,
        createdAt: now,
        updatedAt: now,
      };
      proposals.set(proposal.id, proposal);
      return proposal;
    },

    list(companyId, opts = {}) {
      return [...proposals.values()]
        .filter(
          (p) =>
            p.companyId === companyId &&
            (opts.status === undefined || p.status === opts.status) &&
            (opts.agentId === undefined || p.agentId === opts.agentId),
        )
        .sort((x, y) => y.createdAt - x.createdAt);
    },

    decide(companyId, proposalId, input) {
      const proposal = proposals.get(proposalId);
      // 회사 격리: 다른 회사의 제안은 존재 여부조차 노출하지 않는다(notFound).
      if (!proposal || proposal.companyId !== companyId) {
        throw notFound("Memory review proposal not found");
      }
      if (proposal.status !== "pending") {
        throw conflict(`Memory review proposal is already ${proposal.status}`);
      }
      if (input.decision === "hold" && input.holdMs !== undefined && input.holdMs <= 0) {
        throw badRequest("holdMs must be a positive number");
      }
      const now = Date.now();
      proposal.status =
        input.decision === "approve"
          ? "approved"
          : input.decision === "reject"
            ? "rejected"
            : "held";
      proposal.heldUntilMs =
        input.decision === "hold" ? now + (input.holdMs ?? DEFAULT_HOLD_MS) : null;
      proposal.reviewedByUserId = input.userId;
      proposal.reviewNote = input.note ?? null;
      proposal.updatedAt = now;
      return proposal;
    },

    isTargetHeld(companyId, agentId, targetPath, nowMs = Date.now()) {
      return [...proposals.values()].some(
        (p) =>
          p.companyId === companyId &&
          p.agentId === agentId &&
          p.targetPath === targetPath &&
          p.status === "held" &&
          p.heldUntilMs !== null &&
          p.heldUntilMs > nowMs,
      );
    },
  };
}

export const globalMemoryReviewStore = createMemoryReviewStore();
