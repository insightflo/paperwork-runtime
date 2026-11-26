import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests } from "@paperclipai/db";
import { and, count, eq, isNotNull, or } from "drizzle-orm";

// [P5 honesty guard] 응답이 durable side-effect(wakeup/comment/supervision)를 "했다/깨웠다/남겼다"고
//   주장하는지 휴리스틱 검출. prompt-only가 아니라 서버 사이드 사후 검증의 입력으로 쓴다.
//   거짓 "깨웠습니다" 재발 방지(peer 라이브 사례: claimed action + durable row 0).
const WAKE_ACTION_CLAIM_PATTERNS: RegExp[] = [
  /깨웠|깨워\s*드렸|깨워\s*놓|깨워\s*달|재개\s*시켰|재실행\s*시켰|다시\s*(돌렸|실행\s*시켰)/,
  /woken|woke\s+(it|them|the|up)|dispatched\s+(a\s+)?(wakeup|run)|notified\s+(the\s+)?(owner|executor|agent)/i,
];
const COMMENT_ACTION_CLAIM_PATTERNS: RegExp[] = [
  /댓글\s*(을\s*)?남겼|남겨\s*뒀/,
  /posted\s+(a\s+)?comment|left\s+a\s+(comment|message)/i,
];
const ACTION_CLAIM_PATTERNS: RegExp[] = [
  ...WAKE_ACTION_CLAIM_PATTERNS,
  ...COMMENT_ACTION_CLAIM_PATTERNS,
  /요청\s*(을\s*)?(보냈|전송)|알림\s*(을\s*)?보냈|조치\s*(를\s*)?했|처리\s*했|완료\s*했/,
  /sent\s+(a\s+)?(notification|request)|posted\s+(a\s+)?message|notified\s+the\s+operator/i,
];

export function detectClaimedAction(text: string | null | undefined): boolean {
  if (!text) return false;
  return ACTION_CLAIM_PATTERNS.some((re) => re.test(text));
}

function detectClaimedWakeAction(text: string): boolean {
  return WAKE_ACTION_CLAIM_PATTERNS.some((re) => re.test(text));
}

function detectClaimedCommentAction(text: string): boolean {
  return COMMENT_ACTION_CLAIM_PATTERNS.some((re) => re.test(text));
}

// [P5 honesty guard] claim이 있는데 proof가 0이면 caveat 부착. 순수 함수(단위 테스트용).
//   proofCount는 이 run이 만든 durable row 개수(wakeup + comment; 호출측에서 산출).
export function applyHonestyCaveat(input: {
  body: string;
  claimedAction: boolean;
  proofCount: number;
  claimedWakeAction?: boolean;
  wakeProofCount?: number;
  claimedCommentAction?: boolean;
  commentProofCount?: number;
}): string {
  if (!input.claimedAction) return input.body;
  const missingWakeProof = input.claimedWakeAction === true && (input.wakeProofCount ?? input.proofCount) === 0;
  const missingCommentProof = input.claimedCommentAction === true && (input.commentProofCount ?? input.proofCount) === 0;
  if (input.proofCount > 0 && !missingWakeProof && !missingCommentProof) return input.body;
  const caveat =
    "\n\n---\n[서버 검증] 위 '했다/깨웠다/남겼다' 조치가 이번 run의 durable 기록(mission/issue/workflow wakeup 또는 댓글)으로 확인되지 않았습니다. 진단·지시만 수행된 것으로 보세요. 실제 실행 여부는 해당 issue/mission의 activity나 wakeup ledger에서 직접 확인하세요.";
  return `${input.body}${caveat}`;
}

// [P5] 이 run이 만든 durable side-effect 개수를 세서 claim이 있는데 proof 0면 caveat 부착.
//   proof는 모두 exact run attribution(runId FK):
//   - wakeup: agent_wakeup_requests.runId = run.id + mission/issue/workflow target.
//   - comment/supervision: activity_log.runId = run.id + action IN (issue.comment_added, mission.supervision.run).
export async function applyRunHonestyCaveat(
  db: Db,
  run: { id: string },
  body: string,
): Promise<string> {
  const claimed = detectClaimedAction(body);
  if (!claimed) return body;

  const [wakeupRow] = await db
    .select({ n: count() })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.runId, run.id),
        or(
          isNotNull(agentWakeupRequests.missionId),
          isNotNull(agentWakeupRequests.issueId),
          isNotNull(agentWakeupRequests.workflowRunId),
        ),
      ),
    );

  const [commentActivityRow] = await db
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.runId, run.id),
        eq(activityLog.action, "issue.comment_added"),
      ),
    );

  const [supervisionActivityRow] = await db
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.runId, run.id),
        eq(activityLog.action, "mission.supervision.run"),
      ),
    );

  const wakeProofCount = Number(wakeupRow?.n ?? 0);
  const commentProofCount = Number(commentActivityRow?.n ?? 0);
  const proofCount = wakeProofCount + commentProofCount + Number(supervisionActivityRow?.n ?? 0);
  return applyHonestyCaveat({
    body,
    claimedAction: claimed,
    proofCount,
    claimedWakeAction: detectClaimedWakeAction(body),
    wakeProofCount,
    claimedCommentAction: detectClaimedCommentAction(body),
    commentProofCount,
  });
}
