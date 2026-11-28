import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { SharedTableRowPayload } from "@paperclipai/db/schema/workspace_primitives";
import { badRequest, conflict, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { globalSharedTableStore as tables } from "../services/agent-shared-tables.js";
import { globalAgentOpenWaitStore as waits } from "../services/agent-open-waits.js";
import {
  createOpenWaitDb,
  createSharedTableDb,
  ensureWorkspacePrimitivesTables,
  listOpenWaitsDb,
  listSharedTablesDb,
  resolveOpenWaitDb,
  upsertSharedTableRowDb,
  type OpenWaitDbRow,
  type SharedTableDbRow,
} from "../services/workspace-primitives-db-store.js";
import { assertCompanyAccess } from "./authz.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const nonEmpty = z.string().trim().min(1);
const createTableSchema = z.object({
  name: identifier,
  columns: z.array(z.object({
    name: identifier,
    type: z.enum(["string", "number", "boolean", "json"]),
    required: z.boolean().optional(),
  })).min(1).refine((columns) => new Set(columns.map((column) => column.name)).size === columns.length,
    "Column names must be unique"),
});
const rowSchema = z.object({
  key: z.string().min(1),
  values: z.record(z.unknown()),
  agentId: nonEmpty.nullable().optional(),
});
const waitSchema = z.object({
  agentId: nonEmpty,
  eventKey: nonEmpty,
  note: z.string(),
  requestContext: z.record(z.unknown()),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { fn(req, res); } catch (err) { next(err); }
  };
}

function handleAsync(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// [Stage36 W4] DB 행 → 기존 UI/테스트 계약 JSON 매핑.
// UI SharedTableRecord: { id, companyId, name, columns, createdAt, updatedAt } (ISO 문자열).
function toSharedTableJson(row: SharedTableDbRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    columns: row.columnsJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// 행 upsert 응답은 테이블 행이 아니라 rowsJson 안의 단일 행 페이로드다.
function toRowJson(key: string, payload: SharedTableRowPayload) {
  return { key, values: payload.values, updatedByAgentId: payload.updatedByAgentId, updatedAt: payload.updatedAt };
}

// UI OpenWaitRecord: { id, companyId, agentId, eventKey, note, requestContext, status,
// expiresAtMs, matchedPayload, createdAtMs, updatedAtMs }.
// DB 열 대응: kind→eventKey, summary→note, target_label→JSON 직렬화된 requestContext.
// DB 스키마에 TTL·매칭 페이로드 열이 없어 expiresAtMs·matchedPayload는 항상 null이다.
function toOpenWaitJson(row: OpenWaitDbRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    eventKey: row.kind,
    note: row.summary,
    requestContext: parseStoredRequestContext(row.targetLabel),
    status: row.status === "waiting" ? "waiting" : "cancelled",
    expiresAtMs: null,
    matchedPayload: null,
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: (row.resolvedAt ?? row.createdAt).getTime(),
  };
}

function parseStoredRequestContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* 직렬화되지 않은 라벨 값 → 빈 컨텍스트(표시 fail-closed) */ }
  return {};
}

function registerPostgresRoutes(router: Router, db: Db): void {
  // [boot-safety] 첫 요청에서 0142 마이그레이션 없는 DB에도 테이블을 멱등 생성한다(캐시된 Promise).
  // 실패 시 캐시를 비워 다음 요청이 재시도한다.
  let ready: Promise<void> | null = null;
  const ensureTables = async (): Promise<void> => {
    ready ??= ensureWorkspacePrimitivesTables(db).catch((err: unknown) => {
      ready = null;
      throw err;
    });
    await ready;
  };

  router.get("/companies/:companyId/shared-tables", handleAsync(async (req, res) => {
    await ensureTables();
    const rows = await listSharedTablesDb(db, param(req, "companyId"));
    res.json(rows.map(toSharedTableJson));
  }));

  router.post("/companies/:companyId/shared-tables", validate(createTableSchema), handleAsync(async (req, res) => {
    await ensureTables();
    const companyId = param(req, "companyId");
    const existing = await listSharedTablesDb(db, companyId);
    if (existing.some((table) => table.name === req.body.name)) throw conflict("Shared table already exists");
    res.status(201).json(toSharedTableJson(await createSharedTableDb(db, companyId, req.body)));
  }));

  router.post("/companies/:companyId/shared-tables/:tableId/rows", validate(rowSchema), handleAsync(async (req, res) => {
    await ensureTables();
    const companyId = param(req, "companyId");
    const table = (await listSharedTablesDb(db, companyId)).find((entry) => entry.id === param(req, "tableId"));
    if (!table) throw notFound("Shared table not found");
    const key = req.body.key as string;
    let updated: SharedTableDbRow;
    try {
      updated = await upsertSharedTableRowDb(db, companyId, table.name, {
        ...req.body,
        agentId: req.actor.type === "agent" ? req.actor.agentId : req.body.agentId,
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Invalid row");
    }
    const payload = updated.rowsJson[key];
    if (!payload) throw new Error("row payload missing after upsert");
    res.json(toRowJson(key, payload));
  }));

  router.get("/companies/:companyId/open-waits", handleAsync(async (req, res) => {
    await ensureTables();
    const agentId = nonEmpty.optional().parse(req.query.agentId);
    // 활성(waiting) 대기만 노출한다 — 메모리 경로 listActiveWaits 계약과 동일하다.
    const rows = await listOpenWaitsDb(db, param(req, "companyId"), { agentId, status: "waiting" });
    res.json(rows.map(toOpenWaitJson));
  }));

  router.post("/companies/:companyId/open-waits", validate(waitSchema), handleAsync(async (req, res) => {
    await ensureTables();
    const created = await createOpenWaitDb(db, param(req, "companyId"), {
      agentId: req.body.agentId,
      kind: req.body.eventKey,
      summary: req.body.note,
      // 요청 컨텍스트는 target_label에 JSON 직렬화로 저장해 서버 재시작 후에도 왕복한다.
      targetLabel: JSON.stringify(req.body.requestContext ?? {}),
    });
    res.status(201).json(toOpenWaitJson(created));
  }));

  router.post("/companies/:companyId/open-waits/:waitId/resolve", handleAsync(async (req, res) => {
    await ensureTables();
    const companyId = param(req, "companyId");
    const id = param(req, "waitId");
    // Resolving one ID closes that wait; the store keeps company + waiting checks in one update.
    const active = (await listOpenWaitsDb(db, companyId, { status: "waiting" })).some((wait) => wait.id === id)
      ? await resolveOpenWaitDb(db, companyId, id)
      : null;
    if (!active) throw notFound("Active open wait not found");
    res.json({ id, companyId, status: "cancelled" });
  }));
}

export function agentWorkspacePrimitivesRoutes(db?: Db) {
  const router = Router();
  // Param hooks run only for this router's matched routes, before body validation.
  router.param("companyId", (req, _res, next, companyId: string) => {
    try {
      if (req.actor?.type !== "board" && req.actor?.type !== "agent") throw unauthorized();
      assertCompanyAccess(req, companyId);
      next();
    } catch (err) { next(err); }
  });

  // db가 주입되면 Postgres 영속 경로(Stage36 W4), 없으면 기존 인메모리 동작을 그대로 유지한다.
  if (db) {
    registerPostgresRoutes(router, db);
    return router;
  }

  router.get("/companies/:companyId/shared-tables", handle((req, res) => {
    res.json(tables.listTables(param(req, "companyId")));
  }));

  router.post("/companies/:companyId/shared-tables", validate(createTableSchema), handle((req, res) => {
    const companyId = param(req, "companyId");
    if (tables.listTables(companyId).some((table) => table.name === req.body.name)) {
      throw conflict("Shared table already exists");
    }
    res.status(201).json(tables.createTable(companyId, req.body));
  }));

  router.post("/companies/:companyId/shared-tables/:tableId/rows", validate(rowSchema), handle((req, res) => {
    const companyId = param(req, "companyId");
    const table = tables.listTables(companyId).find((entry) => entry.id === param(req, "tableId"));
    if (!table) throw notFound("Shared table not found");
    let row;
    try {
      row = tables.upsertRow(companyId, table.name, {
        ...req.body,
        agentId: req.actor.type === "agent" ? req.actor.agentId : req.body.agentId,
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Invalid row");
    }
    res.json(row);
  }));

  router.get("/companies/:companyId/open-waits", handle((req, res) => {
    const agentId = nonEmpty.optional().parse(req.query.agentId);
    res.json(waits.listActiveWaits(param(req, "companyId"), agentId));
  }));

  router.post("/companies/:companyId/open-waits", validate(waitSchema), handle((req, res) => {
    res.status(201).json(waits.registerWait({ ...req.body, companyId: param(req, "companyId") }));
  }));

  router.post("/companies/:companyId/open-waits/:waitId/resolve", handle((req, res) => {
    const companyId = param(req, "companyId");
    const id = param(req, "waitId");
    // Resolving one ID closes that wait; matchEvent would resume every matching eventKey.
    if (!waits.listActiveWaits(companyId).some((wait) => wait.id === id) || !waits.cancelWait(companyId, id)) {
      throw notFound("Active open wait not found");
    }
    res.json({ id, companyId, status: "cancelled" });
  }));

  return router;
}
