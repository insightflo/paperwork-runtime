// server/src/services/workflow/tool-step-args-workflow-core.ts
//
// [Stage 3C W3 — render-tool-args 브리지] 비동기 dispatch 경계의 tool 인자 해석+렌더.
//   핀/활동로그 코레오그래피는 기존 selected-input 트랜잭션 안에 두고, 최종 템플릿 렌더만
//   Rust workflow-core(render-tool-args) 우선·Node fallback 브리지로 옮긴다.
//   agent-artifact-tool 같이 열린 DB 트랜잭션 안의 호출부는 서브프로세스를 띄울 수
//   없으므로(F4) 기존 TS 경로를 그대로 탄다.
import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { withSelectedInputTransaction } from "./selected-input-transaction.js";
import { renderToolArgsWithNodeFallback } from "./workflow-core-client.js";
import {
  renderWorkflowToolStepArgsWithResolvedValues,
  resolveWorkflowToolStepArgValuesBody,
  resolveWorkflowToolStepArgs,
  type ResolvedToolStepArgValues,
  type ToolStepArgsResolutionInput,
} from "./tool-step-args.js";

/**
 * 해석 값({args, runDate, runId, pathsByStepId, runMetadata})만 커밋하고 렌더는 호출자가
 *   트랜잭션 밖에서 고른다. 같은 트랜잭션 안에서 TS fail-closed 렌더를 한 번 검증하므로
 *   unresolved 토큰은 핀 전체 롤백으로 닫힌다(all-or-none —
 *   workflow-selector-registration-race.test.ts 의 선-핀 롤백 계약 유지).
 */
export const resolveWorkflowToolStepArgValues = withSelectedInputTransaction(
  async (input: ToolStepArgsResolutionInput): Promise<ResolvedToolStepArgValues> => {
    const values = await resolveWorkflowToolStepArgValuesBody(input);
    renderWorkflowToolStepArgsWithResolvedValues(values);
    return values;
  },
);

/**
 * dispatch 경계용 해석+렌더. input.db 가 이미 열린 트랜잭션이면 서브프로세스를 띄울 수
 *   없으므로(F4) 기존 resolveWorkflowToolStepArgs(TS 렌더)를 그대로 쓴다. 아니면 해석이
 *   커밋된 뒤 브리지 렌더가 돌아 Rust 스폰은 항상 잠금 밖에서 일어난다.
 */
export async function resolveWorkflowToolStepArgsViaWorkflowCore(
  input: ToolStepArgsResolutionInput,
): Promise<unknown> {
  if (is(input.db, PgTransaction)) return resolveWorkflowToolStepArgs(input);
  return renderToolArgsWithNodeFallback(await resolveWorkflowToolStepArgValues(input));
}
