import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import type {
  BotActor,
  BotTerminalChannelService,
  BotTerminalRecord,
  TerminalTransport,
} from "../services/bot-terminal-channel.js";

/**
 * Enterprise bot terminal + channel relay routes.
 * - `POST /terminals/register`            → 201 { terminal, token } (token returned exactly once)
 * - `POST /terminals/:terminalId/heartbeat` → 200 { terminal }   (Bearer terminal token)
 * - `POST /terminals/:terminalId/commands`  → 200 { terminal, action, decision }
 * - `POST /channels/:channelId/invoke`      → 200 | 202 relay decision
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

export interface PublicBotTerminal extends Omit<BotTerminalRecord, "tokenHash"> {}

export function toPublicBotTerminal(terminal: BotTerminalRecord): PublicBotTerminal {
  const { tokenHash: _tokenHash, ...rest } = terminal;
  return rest;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== "bearer") return null;
  const token = header.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

export function createEnterpriseBotsRouter(service: BotTerminalChannelService, resolveActor: ResolveBotActor) {
  const router = Router();

  async function requireActor(req: Request, companyId: string): Promise<BotActor> {
    const actor = await resolveActor(req, companyId);
    if (!actor) throw unauthorized();
    if (actor.companyId !== companyId) throw forbidden("company_scope_denied");
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

  router.post("/terminals/register", validate(registerSchema), register);
  router.post("/terminals/:terminalId/heartbeat", heartbeat);
  router.post("/terminals/:terminalId/commands", validate(commandSchema), command);
  router.post("/channels/:channelId/invoke", validate(invokeSchema), invoke);
  return router;
}
