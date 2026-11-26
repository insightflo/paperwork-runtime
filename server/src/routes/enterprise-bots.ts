import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, type Db } from "@paperclipai/db";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import type {
  BotActor,
  BotCapabilityRecord,
  BotTerminalChannelService,
  BotTerminalRecord,
  EnterpriseBotRecord,
  TerminalTransport,
} from "../services/bot-terminal-channel.js";

/**
 * Enterprise bot terminal, channel relay, and OpenBot attachment routes.
 * Existing 4 routes:
 * - `POST /terminals/register`            → 201 { terminal, token } (token returned exactly once)
 * - `POST /terminals/:terminalId/heartbeat` → 200 { terminal }   (Bearer terminal token)
 * - `POST /terminals/:terminalId/commands`  → 200 { terminal, action, decision }
 * - `POST /channels/:channelId/invoke`      → 200 | 202 relay decision
 * Stage 19 OpenBot routes:
 * - `GET  /companies/:companyId/snapshot`
 * - `POST /companies/:companyId/bots`
 * - `PATCH /companies/:companyId/bots/:botId`
 * - `DELETE /companies/:companyId/bots/:botId`
 * - `POST /companies/:companyId/bots/:botId/ping`
 * - `POST /bots/:botId/inbound`            (Bearer pcp_bot_... token)
 * - `POST /companies/:companyId/approvals/:approvalId/decision`
 * Every denial maps to 401/403/400/404 with a reason code; raw tokens are never logged or echoed.
 */

export type ResolveBotActor = (req: Request, companyId: string) => Promise<BotActor | null> | BotActor | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_PATTERN);
const userText = z.string().trim().min(1).max(128);

const registerSchema = z.object({
  companyId: uuidSchema,
  kind: z.enum(["personal_terminal", "worker_node"]),
  name: z.string().trim().min(1).max(120),
  ownerUserId: userText.optional(),
  teamId: uuidSchema.optional(),
  botId: uuidSchema.optional(),
  transport: z.enum(["outbound_wss", "tailscale_direct"]).optional(),
}).strict();

const commandSchema = z.object({
  companyId: uuidSchema,
  action: z.enum(["exec", "stop", "revoke"]),
}).strict();

const invokeSchema = z.object({
  companyId: uuidSchema,
  targetBotId: uuidSchema,
  executionTarget: z.enum(["personal_terminal", "worker_node", "none"]),
  capabilityKey: z.string().trim().min(1).max(128),
  targetRecord: z.object({
    ownerUserId: userText.nullable(),
    teamId: uuidSchema.nullable(),
    companyId: uuidSchema.nullable().optional(),
  }).strict().optional(),
}).strict();

const botCapabilitySchema = z.object({
  capabilityKey: z.string().trim().min(1).max(128),
  callableBy: z.enum(["self_only", "team", "company"]),
  dataScope: z.enum(["self", "team", "company"]).optional(),
  requiresApproval: z.boolean().optional(),
}).strict();

const createBotSchema = z.object({
  kind: z.enum(["personal", "team", "company"]),
  name: z.string().trim().min(1).max(120),
  ownerUserId: userText.nullable().optional(),
  teamId: uuidSchema.nullable().optional(),
  agentId: uuidSchema.nullable().optional(),
  callableBy: z.enum(["self_only", "team", "company"]).optional(),
  webhookUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  tokenSecretId: uuidSchema.nullable().optional(),
  mintInboundToken: z.boolean().optional(),
  capabilities: z.array(botCapabilitySchema).max(50).optional(),
}).strict();

const updateBotSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "paused", "revoked"]).optional(),
  webhookUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  tokenSecretId: uuidSchema.nullable().optional(),
  agentId: uuidSchema.nullable().optional(),
  callableBy: z.enum(["self_only", "team", "company"]).optional(),
  rotateInboundToken: z.boolean().optional(),
  capabilities: z.array(botCapabilitySchema).max(50).optional(),
}).strict();

const inboundSchema = z.object({
  event: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(16_000).optional(),
  message: z.string().max(16_000).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().max(2000).nullable().optional(),
}).strict();

const callerRoles = new Set<BotActor["role"]>(["owner", "admin", "member", "viewer"]);

function toCallerRole(value: unknown): BotActor["role"] | null {
  return typeof value === "string" && callerRoles.has(value as BotActor["role"]) ? value as BotActor["role"] : null;
}

export function resolveEnterpriseBotActor(db: Db): ResolveBotActor {
  return async (req, companyId) => {
    if (req.actor.type !== "board" || !req.actor.userId) return null;
    const userId = req.actor.userId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return { userId, companyId, teamId: null, role: "owner" };
    }
    if (!(req.actor.companyIds ?? []).includes(companyId)) throw forbidden("company_scope_denied");
    const membership = await db
      .select({ membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const role = toCallerRole(membership?.membershipRole);
    if (!role) throw forbidden("company_scope_denied");
    return { userId, companyId, teamId: null, role };
  };
}

export interface PublicBotTerminal extends Omit<BotTerminalRecord, "tokenHash"> {}

export function toPublicBotTerminal(terminal: BotTerminalRecord): PublicBotTerminal {
  const { tokenHash: _tokenHash, ...rest } = terminal;
  return rest;
}

export interface PublicEnterpriseBot extends Omit<EnterpriseBotRecord, "inboundTokenHash"> {
  hasInboundToken: boolean;
  capabilities?: BotCapabilityRecord[];
}

export function toPublicEnterpriseBot(
  bot: EnterpriseBotRecord & { capabilities?: BotCapabilityRecord[] },
): PublicEnterpriseBot {
  const { inboundTokenHash, ...rest } = bot;
  return { ...rest, hasInboundToken: Boolean(inboundTokenHash) };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== "bearer") return null;
  const token = header.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

export function requireEnterpriseBotsBoardActor(req: Request, _res: Response, next: NextFunction) {
  const isTokenAuthed =
    /^\/terminals\/[^/]+\/heartbeat\/?$/.test(req.path) ||
    /^\/bots\/[^/]+\/inbound\/?$/.test(req.path);
  if (!isTokenAuthed && (req.actor.type !== "board" || !req.actor.userId)) {
    next(unauthorized());
    return;
  }
  next();
}

export function createEnterpriseBotsRouter(service: BotTerminalChannelService, resolveActor: ResolveBotActor) {
  const router = Router();

  async function requireActor(req: Request, companyId: string): Promise<BotActor> {
    const actor = await resolveActor(req, companyId);
    if (!actor) throw unauthorized();
    if (actor.companyId !== companyId) throw forbidden("company_scope_denied");
    return actor;
  }

  async function requireAdminActor(req: Request, companyId: string): Promise<BotActor> {
    const actor = await requireActor(req, companyId);
    if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("admin_role_required");
    return actor;
  }

  function idParam(req: Request, name: string): string {
    const raw = req.params[name];
    const value = Array.isArray(raw) ? "" : (raw ?? "");
    if (!UUID_PATTERN.test(value)) throw badRequest(`${name}_invalid`);
    return value;
  }

  const register: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof registerSchema>;
    const actor = await requireActor(req, body.companyId);
    const result = await service.registerTerminal(actor, { ...body, transport: body.transport as TerminalTransport | undefined });
    res.status(201).json({ terminal: toPublicBotTerminal(result.terminal), token: result.token });
  };

  const heartbeat: RequestHandler = async (req, res) => {
    const token = bearerToken(req);
    if (!token) throw unauthorized("terminal_token_rejected");
    const terminal = await service.heartbeatTerminal(idParam(req, "terminalId"), token);
    res.json({ terminal: toPublicBotTerminal(terminal) });
  };

  const command: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof commandSchema>;
    const actor = await requireActor(req, body.companyId);
    const terminalId = idParam(req, "terminalId");
    const result = await service.commandTerminal(actor, terminalId, body.action);
    res.json({ terminal: toPublicBotTerminal(result.terminal), action: result.action, decision: result.decision });
  };

  const invoke: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof invokeSchema>;
    const actor = await requireActor(req, body.companyId);
    const channelId = idParam(req, "channelId");
    const result = await service.invokeChannelMention(actor, channelId, body.targetBotId, body.executionTarget, body.capabilityKey, body.targetRecord);
    const payload = {
      channel: { id: result.channel.id, kind: result.channel.kind },
      bot: { id: result.bot.id, kind: result.bot.kind },
      capability: { capabilityKey: result.capability.capabilityKey, dataScope: result.capability.dataScope },
      forcedFilter: result.forcedFilter,
      requiresApproval: result.requiresApproval,
    };
    // Approval-gated capabilities are acknowledged, never executed, until a structured approval exists.
    if (result.requiresApproval) res.status(202).json({ outcome: "requires_approval", ...payload });
    else res.json({ outcome: "allowed", ...payload });
  };

  const snapshot: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    await requireActor(req, companyId);
    const data = await service.getCompanySnapshot(companyId);
    res.json({
      bots: data.bots.map((b) => toPublicEnterpriseBot(b)),
      terminals: data.terminals.map((t) => toPublicBotTerminal(t)),
      channels: data.channels,
      pendingApprovals: data.pendingApprovals,
    });
  };

  const createBot: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    const actor = await requireAdminActor(req, companyId);
    const body = req.body as z.infer<typeof createBotSchema>;
    const result = await service.createBot(companyId, actor, body);
    res.status(201).json({
      bot: toPublicEnterpriseBot({ ...result.bot, capabilities: result.capabilities }),
      capabilities: result.capabilities,
      inboundToken: result.inboundToken,
    });
  };

  const updateBot: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    const botId = idParam(req, "botId");
    const actor = await requireAdminActor(req, companyId);
    const body = req.body as z.infer<typeof updateBotSchema>;
    const result = await service.updateBot(companyId, botId, actor, body);
    res.json({
      bot: toPublicEnterpriseBot({ ...result.bot, capabilities: result.capabilities }),
      capabilities: result.capabilities,
      ...(result.inboundToken ? { inboundToken: result.inboundToken } : {}),
    });
  };

  const deleteBot: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    const botId = idParam(req, "botId");
    const actor = await requireAdminActor(req, companyId);
    const result = await service.deleteBot(companyId, botId, actor);
    res.json(result);
  };

  const pingBot: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    const botId = idParam(req, "botId");
    const actor = await requireAdminActor(req, companyId);
    const result = await service.pingBot(companyId, botId, actor);
    res.json(result);
  };

  const inbound: RequestHandler = async (req, res) => {
    const token = bearerToken(req);
    if (!token) throw unauthorized("bot_token_rejected");
    const botId = idParam(req, "botId");
    const body = (req.body ?? {}) as z.infer<typeof inboundSchema>;
    const result = await service.handleBotInbound(botId, token, body);
    res.json(result);
  };

  const decideApproval: RequestHandler = async (req, res) => {
    const companyId = idParam(req, "companyId");
    const approvalId = idParam(req, "approvalId");
    const actor = await requireAdminActor(req, companyId);
    const body = req.body as z.infer<typeof approvalDecisionSchema>;
    const approval = await service.decideBotApproval(companyId, approvalId, actor, body.decision, body.note ?? null);
    res.json({ approval });
  };

  router.post("/terminals/register", validate(registerSchema), register);
  router.post("/terminals/:terminalId/heartbeat", heartbeat);
  router.post("/terminals/:terminalId/commands", validate(commandSchema), command);
  router.post("/channels/:channelId/invoke", validate(invokeSchema), invoke);

  router.get("/companies/:companyId/snapshot", snapshot);
  router.post("/companies/:companyId/bots", validate(createBotSchema), createBot);
  router.patch("/companies/:companyId/bots/:botId", validate(updateBotSchema), updateBot);
  router.delete("/companies/:companyId/bots/:botId", deleteBot);
  router.post("/companies/:companyId/bots/:botId/ping", pingBot);
  router.post("/bots/:botId/inbound", validate(inboundSchema), inbound);
  router.post("/companies/:companyId/approvals/:approvalId/decision", validate(approvalDecisionSchema), decideApproval);

  return router;
}
