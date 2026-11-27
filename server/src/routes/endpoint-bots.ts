import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import {
  createEndpointBotPairingService, globalEndpointBotPairingStore,
  type EndpointBotPairingService, type EndpointBotPairingStore,
} from "../services/endpoint-bot-pairing.js";

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

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest("Validation error");
  return result.data;
}

function run(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { fn(req, res); } catch (error) {
      if (error instanceof HttpError && error.status < 500) { next(error); return; }
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

function serviceCall<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
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

function requireDevice(req: Request, service: EndpointBotPairingService, deviceId: string): string {
  const headerCompany = req.get("x-company-id");
  const payloadCompany = bodyCompanyId(req);
  const companyId = headerCompany || payloadCompany;
  const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") ?? "");
  if (!companyId?.trim() || (headerCompany && payloadCompany && headerCompany !== payloadCompany) || !match) {
    throw unauthorized("Invalid device credentials");
  }
  if (!serviceCall(() => service.verifyDeviceToken({ companyId, deviceId, token: match[1] }))) {
    throw unauthorized("Invalid device credentials");
  }
  return companyId;
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

export function endpointBotRoutes(store?: EndpointBotPairingStore) {
  const service = store ? createEndpointBotPairingService(store) : globalEndpointBotPairingStore;
  const router = Router();

  router.get("/companies/:companyId/endpoints", run((req, res) => {
    const companyId = param(req, "companyId");
    requireCompanyActor(req, companyId);
    res.json(serviceCall(() => service.listEndpoints(companyId)).map(publicEndpoint));
  }));

  router.post("/companies/:companyId/endpoints/pairing-codes", run((req, res) => {
    const companyId = param(req, "companyId");
    requireCompanyActor(req, companyId);
    const body = parse(pairingInput, req.body);
    res.status(201).json(serviceCall(() => service.issuePairingCode({
      companyId, botName: body.botName, requestedFolders: body.requestedFolders,
    })));
  }));

  router.post("/companies/:companyId/endpoints/:deviceId/tasks", run((req, res) => {
    const companyId = param(req, "companyId"), deviceId = param(req, "deviceId");
    requireCompanyActor(req, companyId);
    const body = parse(taskInput, req.body);
    res.status(201).json(serviceCall(() => service.enqueueLocalTask({
      companyId, deviceId, kind: body.kind, targetPath: body.targetPath, command: body.command, args: body.args,
    })));
  }));

  router.post("/endpoints/pair", run((req, res) => {
    const body = parse(pairInput, req.body);
    res.status(201).json(serviceCall(() => service.completePairing({
      code: body.code, os: body.os, arch: body.arch, detectedClis: body.detectedClis,
    })));
  }));

  router.post("/endpoints/:deviceId/heartbeat", run((req, res) => {
    const deviceId = param(req, "deviceId"), companyId = requireDevice(req, service, deviceId);
    const body = parse(heartbeatInput, req.body);
    res.json(publicEndpoint(serviceCall(() => service.recordHeartbeat({
      companyId, deviceId, detectedClis: body.detectedClis, pendingOutboxCount: body.pendingOutboxCount,
    }))));
  }));

  router.post("/endpoints/:deviceId/tasks/poll", run((req, res) => {
    const deviceId = param(req, "deviceId"), companyId = requireDevice(req, service, deviceId);
    const body = parse(pollInput, req.body === undefined ? {} : req.body);
    res.json(serviceCall(() => service.pollPendingTasks({ companyId, deviceId, limit: body.limit })));
  }));

  router.post("/endpoints/:deviceId/tasks/:taskId/ack", run((req, res) => {
    const deviceId = param(req, "deviceId"), taskId = param(req, "taskId");
    const companyId = requireDevice(req, service, deviceId), body = parse(ackInput, req.body);
    res.json(serviceCall(() => service.ackTaskResult({
      companyId, deviceId, taskId, ok: body.ok, output: body.output, error: body.error,
    })));
  }));

  return router;
}
