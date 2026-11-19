// server/src/__tests__/drain-heartbeat-runs-contract.test.ts
//
// [W3 재발 방지 시험, 2026-11-13] drainHeartbeatRuns 종결 계약을 결정적으로 고정한다.
//   서명(run 43279531666 serial): afterAll 드레인이 행 표면(queued/running=0)만 보고 빈 순간에 반환한 뒤,
//   살아 있던 wake 원천이 늦게 run 으로 전환되어 0-윈도를 다시 깨며 45s 예산을 초과했다.
//   계약 — 드레인은 (a) run 행 0 이 settleMs 연속, (b) wake 서명(id:status:updatedAt)이 settleMs 연속
//   안정일 때만 종결한다. 세 조건:
//   1) 늦은 wake→run 전환: settle 창 안의 wake 전환은 창을 다시 돌리고 run 종결까지 대기한다(조기 종결 금지).
//   2) dormant wake: 전환이 없는 영구 대기 wake 는 종결을 막지 않는다(과대 대기·데드락 금지).
//   3) wake 순환: 전환이 반복되는 동안은 종결하지 않고 순환이 끝난 뒤 settleMs 만에 종결한다.
//   제품 코드는 목킹하지 않는다 — 실제 embedded PG 위의 표면 전환만으로 증명한다.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRuns } from "./helpers/drain-heartbeat-runs.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
let companyId: string, agentId: string;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("drain-contract-");
  db = createDb(temp.connectionString);
  const root = path.join(tmpdir(), `drain-contract-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  [companyId] = [randomUUID()];
  await db.insert(companies).values({ id: companyId, name: "Drain Contract Co", issuePrefix: randomUUID(), workProductRoot: root });
  [agentId] = await db.insert(agents).values({ companyId, name: "Worker", role: "worker", status: "active", adapterType: "process" })
    .returning({ id: agents.id }).then(rows => rows.map(row => row.id));
}, 60000);
afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await temp?.cleanup();
}, 60000);

const seedQueuedWake = () => db.insert(agentWakeupRequests)
  .values({ companyId, agentId, source: "assignment", triggerDetail: "w3-contract", status: "queued", idempotencyKey: `w3-contract:${randomUUID()}` })
  .returning({ id: agentWakeupRequests.id }).then(rows => rows[0]!.id);
const markTerminal = (wakeId: string, runId: string) => db.transaction(async tx => {
  await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  await tx.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentWakeupRequests.id, wakeId));
});

it("waits out a claimed wake whose run only appears after a rows-only settle window would have closed (run 43279531666 shape)", async () => {
  const wakeId = await seedQueuedWake();
  const runId = randomUUID();
  // 정황 재현: 200ms 에 wake claim(아직 run 행 없음) → 650ms 에 queued run 등장(claim→run 생성 지연,
  //   CI 부하에서 500ms settle 창보다 길어지는 간격) → 1400ms 에 종결. 행 표면만 보면 ~450ms 에
  //   조기 반환되지만, wake 서면이 200ms 에 전환됐으므로 창은 run 종결까지 다시 돌아간다.
  const conversion = new Promise<void>(resolve => {
    setTimeout(async () => {
      await db.update(agentWakeupRequests).set({ status: "claimed", runId, claimedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wakeId));
    }, 200);
    setTimeout(async () => {
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, wakeupRequestId: wakeId,
        invocationSource: "assignment", triggerDetail: "w3-contract", status: "queued", contextSnapshot: {} });
    }, 650);
    setTimeout(async () => { await markTerminal(wakeId, runId); resolve(); }, 1400);
  });
  const startedAt = Date.now();
  await drainHeartbeatRuns(db, 8000, 400);
  const durationMs = Date.now() - startedAt;
  await conversion;
  // 조기 종결 금지: run 등장(650ms) 전에는 종결되면 안 된다 — 행 표면만 보던 구현은 ~450ms 에 반환해 실패한다.
  expect(durationMs).toBeGreaterThan(1100);
}, 10000);

it("does not hang on a dormant wake that never transitions", async () => {
  await seedQueuedWake(); // 전환 없이 영구 queued 로 남는 wake — 발화 예정이 아니므로 종결을 막지 않는다.
  const startedAt = Date.now();
  await drainHeartbeatRuns(db, 3000, 400);
  expect(Date.now() - startedAt).toBeLessThan(2500);
}, 10000);

it("keeps waiting while a wake keeps transitioning, then settles after the cycling stops", async () => {
  const wakeId = await seedQueuedWake();
  let cycling = true;
  const cycle = (async () => {
    let claimed = false;
    while (cycling) {
      await new Promise(r => setTimeout(r, 150));
      if (!cycling) break;
      claimed = !claimed;
      await db.update(agentWakeupRequests)
        .set({ status: claimed ? "claimed" : "queued", claimedAt: claimed ? new Date() : null, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wakeId));
    }
  })();
  setTimeout(() => { cycling = false; }, 1100); // 1.1s 순환 후 정지(전환 없음 → 서명 고정)
  const startedAt = Date.now();
  await drainHeartbeatRuns(db, 8000, 400);
  expect(Date.now() - startedAt).toBeGreaterThan(1000); // 순환 중에는 종결하지 않는다
  await cycle;
}, 10000);
