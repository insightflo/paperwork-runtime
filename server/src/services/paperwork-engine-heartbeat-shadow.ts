// [파일 목적] Phase 2A Wave 4 — opt-in paperwork-engine heartbeat transition
//   shadow parity check. PAPERWORK_ENGINE_HEARTBEAT_SHADOW=1 일 때만
//   setHeartbeatRunStatus 의 set-level 전이를 엔진 heartbeat.validate_transition
//   RPC 로 fire-and-forget 재확인한다. 관측 전용: 절대 throw 하지 않고 실제
//   상태 전이 결과에는 개입하지 않는다(strictly fail-open).
// [외부 연결] heartbeat-queue-lifecycle setHeartbeatRunStatus(유일 호출부),
//   paperwork-engine-heartbeat validateHeartbeatTransition/classifyHeartbeatRpcError,
//   paperwork-engine-runtime getSharedPaperworkEngineClient, middleware/logger.
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  HEARTBEAT_RUN_STATUSES, classifyHeartbeatRpcError, validateHeartbeatTransition,
  type HeartbeatRunStatus,
} from "./paperwork-engine-heartbeat.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";
import { logger } from "../middleware/logger.js";

const CANONICAL: ReadonlySet<string> = new Set(HEARTBEAT_RUN_STATUSES);

/** Shadow parity flag — 정확히 "1" 일 때만 활성. 다른 값은 모두 비활성. */
export function isHeartbeatEngineShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_HEARTBEAT_SHADOW === "1";
}

export interface ShadowHeartbeatTransitionInput {
  runId: string;
  expectedStatuses: readonly string[];
  nextStatus: string;
  tsApplied: boolean;
}

type EngineCallOnly = Pick<PaperworkEngineClient, "call">;
type ShadowLog = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};
export interface ShadowHeartbeatTransitionDeps {
  env?: NodeJS.ProcessEnv;
  getClient?: () => EngineCallOnly | null;
  log?: ShadowLog;
}

/** 관측 전용 parity check — 어떤 경로로도 throw 하지 않는다(fail-open). */
export async function maybeShadowValidateHeartbeatTransition(
  input: ShadowHeartbeatTransitionInput,
  deps: ShadowHeartbeatTransitionDeps = {},
): Promise<void> {
  const log = deps.log ?? logger;
  if (!isHeartbeatEngineShadowEnabled(deps.env ?? process.env) || input.expectedStatuses.length === 0) return;
  if (![...input.expectedStatuses, input.nextStatus].every((s) => CANONICAL.has(s))) {
    log.debug(
      { runId: input.runId, expectedStatuses: input.expectedStatuses, nextStatus: input.nextStatus },
      "paperwork-engine heartbeat shadow skipped: non-canonical status",
    );
    return;
  }
  try {
    const client = (deps.getClient ?? getSharedPaperworkEngineClient)();
    if (client === null) return;
    const result = await validateHeartbeatTransition(client as PaperworkEngineClient, {
      expected_statuses: [...input.expectedStatuses] as HeartbeatRunStatus[],
      next_status: input.nextStatus as HeartbeatRunStatus,
    });
    if (!result.valid && input.tsApplied) {
      log.warn(
        {
          runId: input.runId, expectedStatuses: input.expectedStatuses,
          nextStatus: input.nextStatus, from: result.from, to: result.to, reason: result.reason,
        },
        "paperwork-engine heartbeat shadow set-level transition contract mismatch (pre-commit observation)",
      );
    }
  } catch (err) {
    log.debug(
      { runId: input.runId, nextStatus: input.nextStatus, classification: classifyHeartbeatRpcError(err) },
      "paperwork-engine heartbeat shadow validation failed",
    );
  }
}

/** setImmediate 지연 fire-and-forget 트리거 — flag OFF 이면 타이머·마이크로태스크
 *  없이 즉시 반환하고, ON 이면 엔진 접근(existsSync/spawn)이 호출자
 *  setHeartbeatRunStatus 의 동기 경로에서 0 회 실행되도록 다음 틱으로 미룬다. */
export function triggerShadowValidateHeartbeatTransition(
  input: ShadowHeartbeatTransitionInput,
  deps: ShadowHeartbeatTransitionDeps = {},
): void {
  if (!isHeartbeatEngineShadowEnabled(deps.env ?? process.env)) return;
  setImmediate(() => {
    void maybeShadowValidateHeartbeatTransition(input, deps).catch(() => {});
  });
}
