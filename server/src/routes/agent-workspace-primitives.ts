import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, conflict, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { globalSharedTableStore as tables } from "../services/agent-shared-tables.js";
import { globalAgentOpenWaitStore as waits } from "../services/agent-open-waits.js";
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

export function agentWorkspacePrimitivesRoutes() {
  const router = Router();
  // Param hooks run only for this router's matched routes, before body validation.
  router.param("companyId", (req, _res, next, companyId: string) => {
    try {
      if (req.actor?.type !== "board" && req.actor?.type !== "agent") throw unauthorized();
      assertCompanyAccess(req, companyId);
      next();
    } catch (err) { next(err); }
  });

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
