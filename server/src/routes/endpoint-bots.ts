import { createHash, randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import {
  createEndpointBotPairingService, globalEndpointBotPairingStore,
  type EndpointBotPairingService, type EndpointBotPairingStore,
} from "../services/endpoint-bot-pairing.js";
import {
  createEndpointAuditStore, type EndpointAuditOutcome, type EndpointAuditStore,
} from "../services/endpoint-task-audit.js";
import {
  ensurePersonalEndpointTables, listEndpointsDb, issuePairingCodeDb, completePairingByCodeDb,
  verifyDeviceTokenDb, recordHeartbeatDb, enqueueLocalTaskDb, pollPendingTasksDb, ackTaskResultDb,
} from "../services/endpoint-bot-db-store.js";

const endpointTablesReady = new WeakMap<Db, Promise<void>>();

function ensureEndpointTables(db: Db): Promise<void> {
  const existing = endpointTablesReady.get(db);
  if (existing) return existing;
  const initialized = ensurePersonalEndpointTables(db);
  endpointTablesReady.set(db, initialized);
  return initialized;
}

const folder = z.object({ path: z.string().min(1), mode: z.enum(["ro", "rw"]) }).strict();
const cli = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), binary: z.string().min(1), path: z.string().nullable(), available: z.boolean() }).strict(),
]);
const pairingInput = z.object({
  botName: z.string().min(1), requestedFolders: z.array(folder),
}).strict();
const pairInput = z.object({
  code: z.string().length(6), os: z.string().min(1), arch: z.string().min(1), detectedClis: z.array(cli),
}).strict();
const heartbeatInput = z.object({
  companyId: z.string().min(1).optional(), detectedClis: z.array(cli), pendingOutboxCount: z.number().int().nonnegative(),
}).strict();
const pollInput = z.object({ companyId: z.string().min(1).optional(), limit: z.number().int().positive().optional() }).strict();
const ackInput = z.object({
  companyId: z.string().min(1).optional(), ok: z.boolean(), output: z.string().optional(), error: z.string().optional(),
}).strict();
const taskInput = z.object({
  kind: z.enum(["read_file", "write_file", "list_dir", "shell_exec"]), targetPath: z.string().min(1),
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(),
}).strict();
const auditQuery = z.object({ deviceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional() }).strict();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest("Validation error");
  return result.data;
}

function run(fn: (req: Request, res: Response) => void | Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (error) {
      const mapped = error instanceof HttpError ? error : serviceError(error);
      if (mapped && mapped.status < 500) { next(mapped); return; }
      // Do not attach request bodies or service exception text to a 500 response/log context.
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

function serviceError(error: unknown): HttpError | undefined {
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid or expired pairing code") return notFound("Pairing code not found or expired");
  if (message === "endpoint not found" || message === "task not found") return notFound("Endpoint or task not found");
  if (message === "folder policy denied") return forbidden("Endpoint folder policy denied this task");
  if (["invalid TTL", "invalid folders", "invalid folder mode", "invalid path", "invalid timestamp",
    "invalid detectedClis", "invalid detectedCli", "invalid outbox count", "invalid task kind",
    "invalid task args", "invalid limit", "non-empty string required", "path traversal forbidden",
    "unsafe Windows path", "absolute local path required"].includes(message)) return badRequest("Invalid endpoint request");
  return undefined;
}

async function serviceCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    const mapped = serviceError(error);
    if (mapped) throw mapped;
    throw new Error("Endpoint service failure");
  }
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value ?? "";
}

function requireCompanyActor(req: Request, companyId: string) {
  if (!req.actor || req.actor.type === "none") throw unauthorized();
  if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden();
  assertCompanyAccess(req, companyId);
}

function bodyCompanyId(req: Request): string | undefined {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return undefined;
  const value = (req.body as { companyId?: unknown }).companyId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function requireDevice(req: Request, service: EndpointBotPairingService | ReturnType<typeof dbService>,
  deviceId: string): Promise<string> {
  const headerCompany = req.get("x-company-id");
  const payloadCompany = bodyCompanyId(req);
  const companyId = headerCompany || payloadCompany;
  const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") ?? "");
  if (!companyId?.trim() || (headerCompany && payloadCompany && headerCompany !== payloadCompany) || !match) {
    throw unauthorized("Invalid device credentials");
  }
  if (!await serviceCall(() => service.verifyDeviceToken({ companyId, deviceId, token: match[1] }))) {
    throw unauthorized("Invalid device credentials");
  }
  return companyId;
}

function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function auditActorId(req: Request): string | undefined {
  return req.actor.type === "agent" ? req.actor.agentId : req.actor.userId;
}

type EndpointView = ReturnType<EndpointBotPairingService["listEndpoints"]>[number];
function publicEndpoint(endpoint: EndpointView) {
  return {
    companyId: endpoint.companyId, deviceId: endpoint.deviceId, botName: endpoint.botName,
    os: endpoint.os, arch: endpoint.arch, online: endpoint.online,
    lastSeenAt: new Date(endpoint.lastSeenMs).toISOString(), detectedClis: endpoint.detectedClis,
    allowedFolders: endpoint.allowedFolders, pendingOutboxCount: endpoint.pendingOutboxCount,
  };
}

function dbService(db: Db) {
  const bind = <Args extends unknown[], Result>(fn: (db: Db, ...args: Args) => Promise<Result>) =>
    (...args: Args) => ensureEndpointTables(db).then(() => fn(db, ...args));
  const completePairing = bind(completePairingByCodeDb);
  return {
    listEndpoints: bind(listEndpointsDb), issuePairingCode: bind(issuePairingCodeDb),
    completePairing: async (input: Parameters<typeof completePairing>[0]) => {
      const paired = await completePairing(input);
      return { ...paired, tokenPreview: `sha256:${createHash("sha256").update(paired.deviceToken).digest("hex").slice(0, 8)}` };
    },
    verifyDeviceToken: bind(verifyDeviceTokenDb),
    recordHeartbeat: bind(recordHeartbeatDb), enqueueLocalTask: bind(enqueueLocalTaskDb),
    pollPendingTasks: bind(pollPendingTasksDb), ackTaskResult: bind(ackTaskResultDb),
  };
}

export function endpointBotRoutes(store?: EndpointBotPairingStore, auditStore?: EndpointAuditStore, db?: Db) {
  const service = store ? createEndpointBotPairingService(store) : db ? dbService(db) : globalEndpointBotPairingStore;
  const audit = auditStore ?? createEndpointAuditStore();

  // 감사 이벤트를 마스킹 스토어에 기록한다. botName은 페어링 레코드에서 표시용으로만 조회한다.
  async function auditTask(companyId: string, deviceId: string, outcome: EndpointAuditOutcome,
    task: { taskId?: string; kind?: string; targetPath?: string }, summary: string, actorId?: string) {
    const bot = (await serviceCall(() => service.listEndpoints(companyId))).find((e) => e.deviceId === deviceId)?.botName;
    audit.record({
      id: randomUUID(), companyId, deviceId, botName: bot ?? "unknown",
      taskId: task.taskId ?? "", kind: task.kind ?? "unknown", targetPath: task.targetPath ?? "",
      outcome, actorId, summary, createdAtMs: Date.now(),
    });
  }

  const router = Router();

  router.get("/companies/:companyId/endpoints", run(async (req, res) => {
    const companyId = param(req, "companyId");
    requireCompanyActor(req, companyId);
    res.json((await serviceCall(() => service.listEndpoints(companyId))).map(publicEndpoint));
  }));

  router.post("/companies/:companyId/endpoints/pairing-codes", run(async (req, res) => {
    const companyId = param(req, "companyId");
    requireCompanyActor(req, companyId);
    const body = parse(pairingInput, req.body);
    res.status(201).json(await serviceCall(() => service.issuePairingCode({
      companyId, botName: body.botName, requestedFolders: body.requestedFolders,
    })));
  }));

  router.post("/companies/:companyId/endpoints/:deviceId/tasks", run(async (req, res) => {
    const companyId = param(req, "companyId"), deviceId = param(req, "deviceId");
    requireCompanyActor(req, companyId);
    const body = parse(taskInput, req.body);
    try {
      const task = await serviceCall(() => service.enqueueLocalTask({
        companyId, deviceId, kind: body.kind, targetPath: body.targetPath, command: body.command, args: body.args,
      }));
      await auditTask(companyId, deviceId, "enqueued", task,
        `enqueued ${body.kind} ${body.targetPath}${body.command ? ` via ${body.command}` : ""}`, auditActorId(req));
      res.status(201).json(task);
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) {
        await auditTask(companyId, deviceId, "denied", body,
          `denied ${body.kind} ${body.targetPath} (folder policy)`, auditActorId(req));
      }
      throw error;
    }
  }));

  router.post("/endpoints/pair", run(async (req, res) => {
    const body = parse(pairInput, req.body);
    res.status(201).json(await serviceCall(() => service.completePairing({
      code: body.code, os: body.os, arch: body.arch, detectedClis: body.detectedClis,
    })));
  }));

  router.post("/endpoints/:deviceId/heartbeat", run(async (req, res) => {
    const deviceId = param(req, "deviceId"), companyId = await requireDevice(req, service, deviceId);
    const body = parse(heartbeatInput, req.body);
    res.json(publicEndpoint(await serviceCall(() => service.recordHeartbeat({
      companyId, deviceId, detectedClis: body.detectedClis, pendingOutboxCount: body.pendingOutboxCount,
    }))));
  }));

  router.post("/endpoints/:deviceId/tasks/poll", run(async (req, res) => {
    const deviceId = param(req, "deviceId"), companyId = await requireDevice(req, service, deviceId);
    const body = parse(pollInput, req.body === undefined ? {} : req.body);
    res.json(await serviceCall(() => service.pollPendingTasks({ companyId, deviceId, limit: body.limit })));
  }));

  router.post("/endpoints/:deviceId/tasks/:taskId/ack", run(async (req, res) => {
    const deviceId = param(req, "deviceId"), taskId = param(req, "taskId");
    const companyId = await requireDevice(req, service, deviceId), body = parse(ackInput, req.body);
    const result = await serviceCall(() => service.ackTaskResult({
      companyId, deviceId, taskId, ok: body.ok, output: body.output, error: body.error,
    }));
    await auditTask(companyId, deviceId, body.ok ? "completed" : "failed", result,
      `${body.ok ? "completed" : "failed"} ${result.kind} ${result.targetPath}`
        + (body.output ? ` output: ${body.output}` : "") + (body.error ? ` error: ${body.error}` : ""));
    res.json(result);
  }));

  router.get("/companies/:companyId/endpoints/audit", run(async (req, res) => {
    const companyId = param(req, "companyId");
    requireCompanyActor(req, companyId);
    const query = parse(auditQuery, {
      deviceId: queryParam(req, "deviceId"), limit: queryParam(req, "limit"),
    });
    res.json({ items: audit.list(companyId, { deviceId: query.deviceId, limit: query.limit }), stats: audit.stats(companyId) });
  }));

  return router;
}
