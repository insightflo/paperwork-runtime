// [파일 목적] reapOrphanedRuns 의 active-running 런 발견(discovery) 실트래픽 컷오버 —
//   PAPERWORK_ENGINE_HEARTBEAT_CUTOVER=1 이면 Rust heartbeat.list_stale_runs 로
//   company 별 stale 후보 run id 를 읽고 in-memory handle 집합과 합집합한 뒤 Drizzle 로
//   전체 행(run + agents.adapterType)을 수화한다. 읽기 전용 RPC 라 쓰기 부작용이 없고,
//   엔진 미설정·오류·타임아웃·per-company limit 절단이면 즉시 기존 TS 전체 스캔으로
//   폴백한다(실행 권한은 TS 측 단일 소스의 재확인 쿼리가 보유).
// [외부 연결] crates/engine-heartbeat/src/lib.rs 의 SQL_LIST_STALE_RUNS 는
//   `FOR UPDATE SKIP LOCKED` — 잠긴 행은 이번 스윕에서 건너뛰고 다음 스윕이 회수한다.
//   listStaleRunsWithCutover(읽기 폴백 계약·10s timeout),
//   getSharedPaperworkEngineClient(공유 엔진), middleware logger,
//   heartbeat-orphan-reaper.ts 호출부.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  isHeartbeatEngineCutoverEnabled,
  listStaleRunsWithCutover,
} from "./paperwork-engine-heartbeat-cutover.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export const STALE_RUNS_CUTOVER_LIMIT = 200;

export interface ActiveRunWithAdapter {
  run: typeof heartbeatRuns.$inferSelect;
  adapterType: typeof agents.$inferSelect.adapterType;
}

type CutoverEnv = { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER?: string };

export interface DiscoverActiveRunsInput {
  db: Db;
  now: Date;
  staleThresholdMs: number;
  activeExecutionTimeoutMs: number;
  inMemoryRunIds: ReadonlySet<string> | readonly string[];
  engineClient?: PaperworkEngineClient | null;
  env?: CutoverEnv;
}

// 기존 reaper 의 인라인 스캔과 동일한 Drizzle 쿼리 — 폴백 계약은 바이트 동일해야 한다.
function queryActiveRunsTs(db: Db): Promise<ActiveRunWithAdapter[]> {
  return db
    .select({ run: heartbeatRuns, adapterType: agents.adapterType })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(eq(heartbeatRuns.status, "running"));
}

export async function discoverActiveRunsForReaper(
  input: DiscoverActiveRunsInput,
): Promise<ActiveRunWithAdapter[]> {
  const { db, now, staleThresholdMs, activeExecutionTimeoutMs, env } = input;
  // 회사 쿼리 전에 스냅샷 — sweep 도중 Map/Set 이 변해도 이번 판정에는 섞이지 않게.
  const inMemorySnapshot = [...input.inMemoryRunIds];
  const tsQuery = () => queryActiveRunsTs(db);
  if (!isHeartbeatEngineCutoverEnabled(env)) return tsQuery();
  let client = input.engineClient;
  if (client === undefined) {
    try {
      client = getSharedPaperworkEngineClient();
    } catch (err) {
      logger.warn({ err }, "paperwork-engine shared client resolution failed; using TS reader");
      client = null;
    }
  }
  if (client === null) return tsQuery();

  const minThresholdMs = staleThresholdMs > 0 && activeExecutionTimeoutMs > 0
    ? Math.min(staleThresholdMs, activeExecutionTimeoutMs)
    : staleThresholdMs > 0 ? staleThresholdMs : 0;
  // TS 스캔은 양수 stale 임계가 없으면 updated_at 필터를 적용하지 않는다 — 전체 TS 스캔으로 폴백.
  if (minThresholdMs <= 0) return tsQuery();
  // Rust 는 엄격 부등호(updated_at < stale_before), TS 는 경계 포함(>= threshold)이라 +1ms 보수 보정.
  const staleBefore = new Date(now.getTime() - minThresholdMs + 1);

  const companyRows = await db
    .selectDistinct({ companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.status, "running"));
  if (companyRows.length === 0 && inMemorySnapshot.length === 0) return [];

  const candidateIds = new Set<string>(inMemorySnapshot);
  for (const { companyId } of companyRows) {
    const result = await listStaleRunsWithCutover(
      client,
      { company_id: companyId, stale_before: staleBefore, limit: STALE_RUNS_CUTOVER_LIMIT },
      async () => [],
      { env },
    );
    // Rust 실패/타임아웃: hang·미설정 엔진이 회사 수만큼 10s 를 태우지 않도록 첫 실패에서
    // 전체 TS 스캔으로 즉시 단락한다.
    if (result.source === "ts") return tsQuery();
    // per-company limit 에 닿으면 절단으로 running 런 유실 가능 — 무제한 TS 스캔으로 폴백.
    if (result.value.length >= STALE_RUNS_CUTOVER_LIMIT) return tsQuery();
    for (const row of result.value) candidateIds.add(row.id);
  }
  if (candidateIds.size === 0) return [];
  return db
    .select({ run: heartbeatRuns, adapterType: agents.adapterType })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(and(eq(heartbeatRuns.status, "running"), inArray(heartbeatRuns.id, [...candidateIds])));
}
