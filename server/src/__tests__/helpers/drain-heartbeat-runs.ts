// server/src/__tests__/helpers/drain-heartbeat-runs.ts
//
// [목적] heartbeat 실행 정착(drain) 공용 헬퍼 — 무거운 통합 스위트의 afterAll 정리 전에
//   in-flight 실행이 실제로 끝났음을 DB 표면으로 증명한다. cap-override-fixtures 에서
//   분리(300줄 한도, W3 2026-11-13)했고 기존 호출자는 cap-override-fixtures 재수출을 그대로 쓴다.
//
// [😎] wake claims fire async executeRun() (heartbeat.ts) — executeRun 은 heartbeat_run 이 terminal
//   된 뒤에도 후속 작업(stdout log append, final status write)을 잠시 더 한다. 따라서 queued/running
//   이 0 이 된 직후에 cleanup 하면 후속 작업이 죽은 DB 를 쳐 ECONNREFUSED/shutting-down stderr 가 남는다.
//   → queued/running=0 을 짧은 안정화 구간(settleMs) 동안 "연속"으로 확인한 뒤에 cleanup 한다.
//   전체 timeout 초과 시 silent return 없이 throw(실행이 실제로 종료되지 않음을 실패로 드러낸다).
//
// [drain-surface, W3 2026-11-13] 행 표면만 보면 정착 판정이 조기에 난다 — wake 원천(queued/claimed/
//   deferred_issue_execution)이 살아 있는 동안 빈 순간(row 0)이 settleMs 이상 지속되면 드레인이 반환되고,
//   그 뒤 늦게 전환된 wake 가 새 queued/running 행을 만들어 0-윈도를 다시 깬다(run 43279531666 serial:
//   QaRemediationAdmissionHold 재깨움 + 40P01 재시도가 45s 예산을 초과한 서명). 종결 조건에 wake 서명
//   (id:status:updatedAt) 안정을 포함해 원천이 조용해질 때까지 기다린다. 발화(claim/완료/신규 enqueue)는
//   반드시 wake 행 전환을 동반하므로 서명이 바뀌면 창을 다시 돌리고, 발화 없이 영구 대기하는(dormant)
//   wake 는 전환이 없어 서명이 고정되므로 데드락 없이 종결된다. 계약 시험: drain-heartbeat-runs-contract.test.ts.
import { inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";

export async function drainHeartbeatRuns(db: Db, timeoutMs = 30_000, settleMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let runZeroSince: number | null = null;
  let wakeSig: string | null = null;
  let wakeSigSince: number | null = null;
  let lastWakeCount = 0;
  while (Date.now() < deadline) {
    const [[runRow], wakeRows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"])),
      db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, updatedAt: agentWakeupRequests.updatedAt })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"])),
    ]);
    if ((runRow?.count ?? 0) === 0) {
      if (runZeroSince === null) runZeroSince = Date.now();
    } else {
      runZeroSince = null;                                  // new in-flight run appeared — restart the window
    }
    const signature = wakeRows.map(row => `${row.id}:${row.status}:${row.updatedAt?.toISOString() ?? ""}`).sort().join("|");
    if (signature === wakeSig) {
      if (wakeSigSince === null) wakeSigSince = Date.now();
    } else {
      wakeSig = signature;
      wakeSigSince = null;                                  // wake source transitioned (enqueue/claim/finish) — restart
    }
    lastWakeCount = wakeRows.length;
    if (runZeroSince !== null && wakeSigSince !== null
      && Date.now() - runZeroSince >= settleMs && Date.now() - wakeSigSince >= settleMs) {
      return;   // rows 0 AND wake surface stable, continuously over the stabilization window
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`drainHeartbeatRuns timed out after ${timeoutMs}ms — in-flight heartbeat execution did not settle (queued/running did not stay at 0; wake surface: ${lastWakeCount} non-terminal, stable=${wakeSigSince !== null})`);
}
