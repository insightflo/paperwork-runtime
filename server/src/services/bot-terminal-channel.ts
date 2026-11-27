import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, botCapabilities, bots, channelMembers, channels, clientTerminals, teams } from "@paperclipai/db";
import { badRequest, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import {
  evaluateCapabilityDataScope,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotKind,
  type CallableBy,
  type CallerRole,
  type ChannelExecutionTarget,
  type DataScope,
  type TerminalAction,
  type TerminalKind,
} from "./bot-governance.js";

/**
 * Enterprise bot B3 + Stage 19 OpenBot server service:
 * - terminal lifecycle (register / heartbeat / command)
 * - channel @mention relay
 * - OpenBot CRUD, outbound webhook ping, inbound token-authenticated webhook, snapshot, and approval decisions.
 * Pure service over an injected `EnterpriseBotStore` (`createDrizzleEnterpriseBotStore` binds the schema).
 */

export type TerminalTransport = "outbound_wss" | "tailscale_direct";
export type TerminalStatus = "offline" | "online" | "revoked";
export type BotStatus = "active" | "paused" | "revoked";
export type BotPingStatus = "ok" | "error";

export interface BotActor { userId: string; companyId: string; teamId: string | null; role: CallerRole }

export interface TerminalTelemetry {
  os?: string;
  arch?: string;
  daemonVersion?: string;
  protocolVersion?: number;
  uptimeSecs?: number;
  cpuPct?: number;
  memRssMb?: number;
  activeChildren?: number;
  lastRttMs?: number;
}

export interface HealthSample {
  ts: string;
  ok: boolean;
  rttMs?: number | null;
  statusCode?: number | null;
  errorRef?: string | null;
}

export interface BotAuditEventRecord {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ChannelInvokePreviewResult {
  dryRun: true;
  outcome: "allowed" | "requires_approval" | "denied";
  reason: string;
  forcedFilter: Record<string, string> | null;
  requiresApproval: boolean;
}

export const HEALTH_HISTORY_MAX = 20;

export const ENTERPRISE_BOTS_COMPATIBILITY = {
  protocol: { minimum: 1, maximum: 2 },
  capabilities: [
    "terminal.telemetry.v1",
    "bot.capabilities_matrix.v1",
    "channel.invoke_preview.v1",
    "bot.audit.v1",
  ],
} as const;

export function appendHealthSample(
  existing: HealthSample[] | null | undefined,
  sample: HealthSample,
): HealthSample[] {
  const list = Array.isArray(existing) ? existing : [];
  const next = [...list, sample];
  return next.length > HEALTH_HISTORY_MAX ? next.slice(next.length - HEALTH_HISTORY_MAX) : next;
}

/** Connectivity state (`status`) is display-only; governance lifecycle = revoked ⇔ `revokedAt !== null`, else active.
 *  Snapshot reads derive online/offline from `lastSeenAt` (45s window) so stale daemons display offline without a sweep. */
export interface BotTerminalRecord {
  id: string; companyId: string; kind: TerminalKind; name: string;
  ownerUserId: string | null; teamId: string | null; botId: string | null;
  tokenHash: string; transport: TerminalTransport; status: TerminalStatus; lastSeenAt: Date | null; revokedAt: Date | null;
  telemetry?: TerminalTelemetry | null;
  healthHistory?: HealthSample[] | null;
}

export interface EnterpriseBotRecord {
  id: string; companyId: string; kind: BotKind; name?: string;
  ownerUserId: string | null; teamId: string | null; agentId?: string | null;
  callableBy: CallableBy; status: string;
  webhookUrl?: string | null; tokenSecretId?: string | null; inboundTokenHash?: string | null;
  lastPingAt?: Date | null; lastPingStatus?: BotPingStatus | null;
  healthHistory?: HealthSample[] | null;
  createdAt?: Date; updatedAt?: Date;
}

export interface BotCapabilityRecord {
  botId: string; capabilityKey: string; callableBy: CallableBy; dataScope: DataScope; requiresApproval: boolean;
}

export interface BotCapabilityInput {
  capabilityKey: string; callableBy: CallableBy; dataScope?: DataScope; requiresApproval?: boolean;
}

export interface EnterpriseChannelRecord {
  id: string; companyId: string; kind: "team" | "shared" | "dm"; name?: string;
  teamId: string | null; createdByUserId?: string;
}

/** Read-only team directory row (`worker_node` registration selector source). */
export interface EnterpriseBotTeamSummary { id: string; name: string }

/** Freshness window for read-time online/offline derivation: daemon heartbeat interval (15s) × 3. */
export const HEARTBEAT_ONLINE_WINDOW_MS = 45_000;

export interface BotPendingApprovalRecord {
  id: string; companyId: string; type: string; status: string;
  payload: Record<string, unknown>;
  requestedByUserId: string | null; requestedByAgentId: string | null;
  decidedByUserId: string | null; decisionNote: string | null;
  decidedAt: Date | null; createdAt: Date;
}

export interface NewBotTerminal {
  companyId: string; kind: TerminalKind; name: string; ownerUserId: string | null; teamId: string | null;
  botId: string | null; transport: TerminalTransport; tokenHash: string;
}

export interface NewEnterpriseBot {
  companyId: string; kind: BotKind; name: string;
  ownerUserId: string | null; teamId: string | null; agentId: string | null;
  callableBy: CallableBy; status: BotStatus;
  webhookUrl: string | null; tokenSecretId: string | null; inboundTokenHash: string | null;
}

export interface UpdateEnterpriseBot {
  name?: string;
  status?: BotStatus;
  webhookUrl?: string | null;
  tokenSecretId?: string | null;
  agentId?: string | null;
  callableBy?: CallableBy;
  inboundTokenHash?: string | null;
  updatedAt: Date;
}

export interface CreateBotInput {
  kind: BotKind;
  name: string;
  ownerUserId?: string | null;
  teamId?: string | null;
  agentId?: string | null;
  callableBy?: CallableBy;
  webhookUrl?: string | null;
  tokenSecretId?: string | null;
  mintInboundToken?: boolean;
  capabilities?: BotCapabilityInput[];
}

export interface UpdateBotInput {
  name?: string;
  status?: BotStatus;
  webhookUrl?: string | null;
  tokenSecretId?: string | null;
  agentId?: string | null;
  callableBy?: CallableBy;
  rotateInboundToken?: boolean;
  capabilities?: BotCapabilityInput[];
}

export interface BotInboundPayload {
  event?: string;
  title?: string;
  description?: string;
  message?: string;
  priority?: "critical" | "high" | "medium" | "low";
  metadata?: Record<string, unknown>;
}

export interface BotPingResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error?: string;
}

export interface EnterpriseBotStore {
  createTerminal(input: NewBotTerminal): Promise<BotTerminalRecord>;
  /** Company-scoped lookup; must return null when the terminal belongs to another company. */
  getTerminal(companyId: string, terminalId: string): Promise<BotTerminalRecord | null>;
  /** Unscoped lookup for token-authenticated heartbeats only. Callers must verify the token hash. */
  getTerminalById(terminalId: string): Promise<BotTerminalRecord | null>;
  markTerminalSeen(
    terminalId: string,
    seenAt: Date,
    update?: { telemetry?: TerminalTelemetry | null; healthHistory?: HealthSample[] },
  ): Promise<void>;
  revokeTerminal(terminalId: string, revokedAt: Date): Promise<void>;
  getBot(companyId: string, botId: string): Promise<EnterpriseBotRecord | null>;
  /** Unscoped lookup for token-authenticated inbound webhooks only. Callers must verify the token hash. */
  getBotById(botId: string): Promise<EnterpriseBotRecord | null>;
  listBots(companyId: string): Promise<EnterpriseBotRecord[]>;
  listBotCapabilities(botIds: string[]): Promise<BotCapabilityRecord[]>;
  listTerminals(companyId: string): Promise<BotTerminalRecord[]>;
  listChannels(companyId: string): Promise<EnterpriseChannelRecord[]>;
  /** Company-scoped team directory (id+name only), ordered by name. */
  listTeams(companyId: string): Promise<EnterpriseBotTeamSummary[]>;
  listPendingApprovals(companyId: string): Promise<BotPendingApprovalRecord[]>;
  listAuditEvents?(companyId: string, limit: number): Promise<BotAuditEventRecord[]>;
  createBot(
    input: NewEnterpriseBot,
    capabilities: BotCapabilityInput[],
  ): Promise<{ bot: EnterpriseBotRecord; capabilities: BotCapabilityRecord[] }>;
  updateBot(
    companyId: string,
    botId: string,
    patch: UpdateEnterpriseBot,
    capabilities?: BotCapabilityInput[],
  ): Promise<{ bot: EnterpriseBotRecord; capabilities: BotCapabilityRecord[] } | null>;
  deleteBot(companyId: string, botId: string): Promise<boolean>;
  recordBotPing(
    companyId: string,
    botId: string,
    pingAt: Date,
    status: BotPingStatus,
    healthHistory?: HealthSample[],
  ): Promise<void>;
  decideApproval(
    companyId: string,
    approvalId: string,
    decidedByUserId: string,
    status: "approved" | "rejected",
    note: string | null,
    decidedAt: Date,
  ): Promise<BotPendingApprovalRecord | null>;
  getBotCapability(botId: string, capabilityKey: string): Promise<BotCapabilityRecord | null>;
  getChannel(companyId: string, channelId: string): Promise<EnterpriseChannelRecord | null>;
  listChannelMemberIds(channelId: string): Promise<string[]>;
  /** Owner approval for a personal bot to run on a personal terminal from the given channel. */
  hasChannelOwnerApproval(companyId: string, botId: string, botOwnerUserId: string, channelId: string): Promise<boolean>;
}

export interface RegisterTerminalInput {
  companyId: string; kind: TerminalKind; name: string;
  ownerUserId?: string | null; teamId?: string | null; botId?: string | null; transport?: TerminalTransport;
}

export interface TerminalBotContext {
  botId: string;
  /** Trusted relay paths only: the bot acts with its owner's explicit context. */
  explicitOwnerContext?: boolean;
  /** Trusted relay paths only: approval already verified through a structured record. */
  botApproved?: boolean;
}

export interface ChannelTargetRecord { ownerUserId: string | null; teamId: string | null; companyId?: string | null }

export interface BotTerminalChannelServiceOptions {
  now?: () => Date;
  fetchFn?: typeof fetch;
  pingTimeoutMs?: number;
  resolveSecret?: (companyId: string, secretId: string) => Promise<string>;
  onInboundActivity?: (input: {
    companyId: string;
    botId: string;
    agentId: string | null;
    event: string;
    title: string | null;
    issueId: string | null;
  }) => Promise<void>;
  wakeAgent?: (agentId: string, payload: Record<string, unknown>) => Promise<{ id?: string } | null>;
  createInboundIssue?: (companyId: string, input: {
    title: string;
    description: string | null;
    priority: "critical" | "high" | "medium" | "low";
    assigneeAgentId: string | null;
  }) => Promise<{ id: string; identifier?: string | null }>;
}

export const TERMINAL_TOKEN_PREFIX = "pcp_term_";
export const BOT_INBOUND_TOKEN_PREFIX = "pcp_bot_";
const TERMINAL_TOKEN_MAX_LENGTH = 256;
const SHA256_HEX_LENGTH = 64;
const DEFAULT_PING_TIMEOUT_MS = 5000;

export function hashTerminalToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function createTerminalToken(): string { return `${TERMINAL_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`; }
export function hashBotInboundToken(token: string): string { return hashTerminalToken(token); }
export function createBotInboundToken(): string { return `${BOT_INBOUND_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`; }

// Compared for unknown terminals/bots too, so a missing id and a wrong token take the same path.
const UNKNOWN_TERMINAL_HASH = hashTerminalToken("");

function tokenMatches(storedHash: string, rawToken: string): boolean {
  const presented = Buffer.from(hashTerminalToken(rawToken), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (presented.length !== stored.length || stored.length !== SHA256_HEX_LENGTH) return false;
  return timingSafeEqual(presented, stored);
}

function governanceError(reason: string): HttpError { return reason === "invalid_input" ? badRequest(reason) : forbidden(reason); }

function lifecycleStatus(terminal: BotTerminalRecord): "active" | "revoked" {
  return terminal.revokedAt !== null || terminal.status === "revoked" ? "revoked" : "active";
}

/** Read-time status derivation: fresh heartbeat → online, stale/missing → offline, revoked wins. */
function deriveDisplayStatus(terminal: BotTerminalRecord, at: Date): TerminalStatus {
  if (terminal.revokedAt !== null || terminal.status === "revoked") return "revoked";
  const seenAt = terminal.lastSeenAt;
  if (seenAt !== null && at.getTime() - seenAt.getTime() <= HEARTBEAT_ONLINE_WINDOW_MS) return "online";
  return "offline";
}

function requestsCrossTeamSecrets(bot: EnterpriseBotRecord, capability: BotCapabilityRecord, actor: BotActor): boolean {
  return bot.kind === "team" && bot.teamId !== null && actor.teamId !== null && bot.teamId !== actor.teamId && capability.dataScope === "team";
}

function assertCompanyScope(actor: BotActor, companyId: string) {
  if (actor.companyId !== companyId) throw forbidden("company_scope_denied");
}

function assertAdminRole(actor: BotActor) {
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("admin_role_required");
}

function validateWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest("invalid_webhook_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("invalid_webhook_url");
  }
  return parsed;
}

function sanitizePingError(err: unknown, secretValue: string | null): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (secretValue && secretValue.length > 0 && raw.includes(secretValue)) {
    return raw.split(secretValue).join("***REDACTED***");
  }
  return raw;
}

const AUDIT_SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|apikey|api_key|credential/i;
const RAW_TOKEN_VALUE_PATTERN = /\bpcp_(?:(?:term_|bot_)[0-9a-zA-Z_-]+|[0-9a-zA-Z_-]{16,})/g; // bare legacy pcp_<16+ chars> too; short ids like pcp_id pass

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(RAW_TOKEN_VALUE_PATTERN, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = AUDIT_SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : sanitizeAuditValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeAuditDetails(details: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!details || typeof details !== "object") return null;
  return sanitizeAuditValue(details) as Record<string, unknown>;
}

export function createBotTerminalChannelService(
  store: EnterpriseBotStore,
  options: BotTerminalChannelServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;

  /** Returns the plaintext token exactly once; only its SHA-256 hex digest is persisted. */
  async function registerTerminal(actor: BotActor, input: RegisterTerminalInput) {
    if (input.companyId !== actor.companyId) throw forbidden("company_scope_denied");
    if (actor.role === "viewer") throw forbidden("viewer_cannot_register_terminal");
    const mayDelegate = actor.role === "owner" || actor.role === "admin";
    let ownerUserId: string | null = null;
    let teamId: string | null = null;
    if (input.kind === "personal_terminal") {
      ownerUserId = input.ownerUserId?.trim() || actor.userId;
      if (ownerUserId !== actor.userId && !mayDelegate) throw forbidden("personal_terminal_owner_required");
      if (input.teamId) throw badRequest("personal_terminal_team_not_allowed");
    } else {
      teamId = input.teamId?.trim() || null;
      if (!teamId) throw badRequest("team_required");
      if (actor.role !== "owner" && actor.teamId !== teamId) throw forbidden("team_scope_denied");
    }
    let botId: string | null = null;
    if (input.botId) {
      const bot = await store.getBot(actor.companyId, input.botId);
      if (!bot) throw notFound("bot_not_found");
      const matches = input.kind === "personal_terminal"
        ? bot.kind === "personal" && bot.ownerUserId === ownerUserId
        : (bot.kind === "team" && bot.teamId === teamId) || bot.kind === "company";
      if (!matches) throw forbidden("terminal_bot_scope_mismatch");
      botId = bot.id;
    }
    const token = createTerminalToken();
    const terminal = await store.createTerminal({
      companyId: actor.companyId, kind: input.kind, name: input.name, ownerUserId, teamId, botId,
      transport: input.transport ?? "outbound_wss", tokenHash: hashTerminalToken(token),
    });
    return { terminal, token };
  }

  /** Token-authenticated. Unknown, revoked, or mismatched terminals fail closed. */
  async function heartbeatTerminal(
    terminalId: string,
    rawToken: unknown,
    telemetry?: TerminalTelemetry,
  ): Promise<BotTerminalRecord> {
    if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > TERMINAL_TOKEN_MAX_LENGTH) {
      throw unauthorized("terminal_token_rejected");
    }
    const terminal = await store.getTerminalById(terminalId);
    if (!tokenMatches(terminal?.tokenHash ?? UNKNOWN_TERMINAL_HASH, rawToken) || !terminal) {
      throw unauthorized("terminal_token_rejected");
    }
    if (lifecycleStatus(terminal) === "revoked") throw forbidden("terminal_revoked");
    const seenAt = now();
    const nextTelemetry = telemetry !== undefined ? telemetry : (terminal.telemetry ?? null);
    const sample: HealthSample = {
      ts: seenAt.toISOString(),
      ok: true,
      rttMs: telemetry?.lastRttMs ?? null,
    };
    const nextHealthHistory = appendHealthSample(terminal.healthHistory, sample);
    await store.markTerminalSeen(terminal.id, seenAt, {
      telemetry: nextTelemetry,
      healthHistory: nextHealthHistory,
    });
    return {
      ...terminal,
      status: "online",
      lastSeenAt: seenAt,
      telemetry: nextTelemetry,
      healthHistory: nextHealthHistory,
    };
  }

  async function commandTerminal(actor: BotActor, terminalId: string, action: TerminalAction, botContext?: TerminalBotContext) {
    const terminal = await store.getTerminal(actor.companyId, terminalId);
    if (!terminal) throw notFound("terminal_not_found");
    const noBotContext = { botKind: null as BotKind | null, botOwnerUserId: null as string | null, botTeamId: null as string | null, botCompanyId: null as string | null, botApproved: false, explicitOwnerContext: false };
    let botFields = noBotContext;
    if (botContext) {
      const bot = await store.getBot(actor.companyId, botContext.botId);
      if (!bot) throw notFound("bot_not_found");
      botFields = {
        botKind: bot.kind, botOwnerUserId: bot.ownerUserId, botTeamId: bot.teamId, botCompanyId: bot.companyId,
        botApproved: botContext.botApproved === true, explicitOwnerContext: botContext.explicitOwnerContext === true,
      };
    }
    const decision = evaluateTerminalCommand({
      callerUserId: actor.userId, callerTeamId: actor.teamId, callerRole: actor.role, callerCompanyId: actor.companyId,
      companyId: terminal.companyId, kind: terminal.kind, ownerUserId: terminal.ownerUserId, teamId: terminal.teamId,
      status: lifecycleStatus(terminal), action, ...botFields,
    });
    if (!decision.allowed) throw governanceError(decision.reason);
    if (action === "revoke") {
      const revokedAt = now();
      await store.revokeTerminal(terminal.id, revokedAt);
      return { terminal: { ...terminal, status: "revoked" as const, revokedAt }, action, decision };
    }
    return { terminal, action, decision };
  }

  /** @mention relay gate. Denies unless channel membership, owner approval, and data scope all pass. */
  async function invokeChannelMention(
    actor: BotActor, channelId: string, targetBotId: string, executionTarget: ChannelExecutionTarget,
    capabilityKey: string, targetRecord?: ChannelTargetRecord,
  ) {
    const [channel, bot] = await Promise.all([store.getChannel(actor.companyId, channelId), store.getBot(actor.companyId, targetBotId)]);
    if (!channel) throw notFound("channel_not_found");
    if (!bot) throw notFound("bot_not_found");
    const [channelMemberIds, capability] = await Promise.all([store.listChannelMemberIds(channel.id), store.getBotCapability(bot.id, capabilityKey)]);
    if (!capability) throw notFound("capability_not_found");
    const ownerApproved = await store.hasChannelOwnerApproval(channel.companyId, bot.id, bot.ownerUserId ?? "", channel.id);
    const decision = evaluateChannelInvoke({
      callerUserId: actor.userId, callerTeamId: actor.teamId, callerRole: actor.role, callerCompanyId: actor.companyId,
      channelCompanyId: channel.companyId, channelMemberIds, botId: bot.id, botCompanyId: bot.companyId, botKind: bot.kind,
      botOwnerUserId: bot.ownerUserId, botTeamId: bot.teamId, executionTarget, ownerApproved,
      requestsCrossTeamSecrets: requestsCrossTeamSecrets(bot, capability, actor),
    });
    if (!decision.allowed) throw governanceError(decision.reason);
    const scope = evaluateCapabilityDataScope({
      caller: { userId: actor.userId, teamId: actor.teamId, role: actor.role, companyId: actor.companyId },
      capability: { capabilityKey: capability.capabilityKey, callableBy: capability.callableBy, dataScope: capability.dataScope, requiresApproval: capability.requiresApproval },
      targetRecord: targetRecord
        ? { ownerUserId: targetRecord.ownerUserId, teamId: targetRecord.teamId, companyId: targetRecord.companyId ?? bot.companyId }
        : { ownerUserId: null, teamId: null, companyId: bot.companyId },
    });
    if (!scope.allowed) throw governanceError(scope.reason);
    return { channel, bot, capability, forcedFilter: scope.forcedFilter, requiresApproval: scope.requiresApproval };
  }

  /** Read-only dry-run evaluation of a channel @mention with ZERO side effects. */
  async function previewChannelInvoke(
    actor: BotActor,
    channelId: string,
    targetBotId: string,
    executionTarget: ChannelExecutionTarget,
    capabilityKey: string,
    targetRecord?: ChannelTargetRecord,
  ): Promise<ChannelInvokePreviewResult> {
    const [channel, bot] = await Promise.all([
      store.getChannel(actor.companyId, channelId),
      store.getBot(actor.companyId, targetBotId),
    ]);
    if (!channel) throw notFound("channel_not_found");
    if (!bot) throw notFound("bot_not_found");
    const [channelMemberIds, capability] = await Promise.all([
      store.listChannelMemberIds(channel.id),
      store.getBotCapability(bot.id, capabilityKey),
    ]);
    if (!capability) throw notFound("capability_not_found");
    const ownerApproved = await store.hasChannelOwnerApproval(
      channel.companyId,
      bot.id,
      bot.ownerUserId ?? "",
      channel.id,
    );
    const decision = evaluateChannelInvoke({
      callerUserId: actor.userId,
      callerTeamId: actor.teamId,
      callerRole: actor.role,
      callerCompanyId: actor.companyId,
      channelCompanyId: channel.companyId,
      channelMemberIds,
      botId: bot.id,
      botCompanyId: bot.companyId,
      botKind: bot.kind,
      botOwnerUserId: bot.ownerUserId,
      botTeamId: bot.teamId,
      executionTarget,
      ownerApproved,
      requestsCrossTeamSecrets: requestsCrossTeamSecrets(bot, capability, actor),
    });
    if (!decision.allowed) {
      return {
        dryRun: true,
        outcome: "denied",
        reason: decision.reason,
        forcedFilter: null,
        requiresApproval: decision.requiresOwnerApproval,
      };
    }
    const scope = evaluateCapabilityDataScope({
      caller: { userId: actor.userId, teamId: actor.teamId, role: actor.role, companyId: actor.companyId },
      capability: {
        capabilityKey: capability.capabilityKey,
        callableBy: capability.callableBy,
        dataScope: capability.dataScope,
        requiresApproval: capability.requiresApproval,
      },
      targetRecord: targetRecord
        ? { ownerUserId: targetRecord.ownerUserId, teamId: targetRecord.teamId, companyId: targetRecord.companyId ?? bot.companyId }
        : { ownerUserId: null, teamId: null, companyId: bot.companyId },
    });
    if (!scope.allowed) {
      return {
        dryRun: true,
        outcome: "denied",
        reason: scope.reason,
        forcedFilter: null,
        requiresApproval: scope.requiresApproval,
      };
    }
    return {
      dryRun: true,
      outcome: scope.requiresApproval ? "requires_approval" : "allowed",
      reason: scope.requiresApproval ? "requires_approval" : scope.reason,
      forcedFilter: scope.forcedFilter,
      requiresApproval: scope.requiresApproval,
    };
  }

  async function getCompanySnapshot(companyId: string) {
    const [botRows, terminals, channelRows, pendingApprovals] = await Promise.all([
      store.listBots(companyId),
      store.listTerminals(companyId),
      store.listChannels(companyId),
      store.listPendingApprovals(companyId),
    ]);
    const capRows = botRows.length > 0 ? await store.listBotCapabilities(botRows.map((b) => b.id)) : [];
    const capsByBot = new Map<string, BotCapabilityRecord[]>();
    for (const cap of capRows) {
      const list = capsByBot.get(cap.botId) ?? [];
      list.push(cap);
      capsByBot.set(cap.botId, list);
    }
    return {
      bots: botRows.map((bot) => ({ ...bot, capabilities: capsByBot.get(bot.id) ?? [] })),
      terminals: terminals.map((t) => ({ ...t, status: deriveDisplayStatus(t, now()) })),
      channels: channelRows,
      pendingApprovals,
    };
  }

  async function listTeams(companyId: string): Promise<EnterpriseBotTeamSummary[]> {
    return store.listTeams(companyId);
  }

  async function createBot(companyId: string, actor: BotActor, input: CreateBotInput) {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const name = input.name.trim();
    if (!name) throw badRequest("bot_name_required");
    let ownerUserId: string | null = null;
    let teamId: string | null = null;
    if (input.kind === "personal") {
      ownerUserId = input.ownerUserId?.trim() || actor.userId;
    } else if (input.kind === "team") {
      teamId = input.teamId?.trim() || null;
      if (!teamId) throw badRequest("team_required");
    } else {
      ownerUserId = input.ownerUserId?.trim() || null;
      teamId = input.teamId?.trim() || null;
    }
    const webhookUrl = input.webhookUrl ? validateWebhookUrl(input.webhookUrl.trim()).toString() : null;
    const shouldMint = input.mintInboundToken !== false;
    const inboundToken = shouldMint ? createBotInboundToken() : null;
    const inboundTokenHash = inboundToken ? hashBotInboundToken(inboundToken) : null;
    const created = await store.createBot(
      {
        companyId,
        kind: input.kind,
        name,
        ownerUserId,
        teamId,
        agentId: input.agentId ?? null,
        callableBy: input.callableBy ?? (input.kind === "company" ? "company" : "team"),
        status: "active",
        webhookUrl,
        tokenSecretId: input.tokenSecretId ?? null,
        inboundTokenHash,
      },
      input.capabilities ?? [],
    );
    return { bot: created.bot, capabilities: created.capabilities, inboundToken };
  }

  async function updateBot(companyId: string, botId: string, actor: BotActor, patch: UpdateBotInput) {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const existing = await store.getBot(companyId, botId);
    if (!existing) throw notFound("bot_not_found");
    const updatePatch: UpdateEnterpriseBot = { updatedAt: now() };
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw badRequest("bot_name_required");
      updatePatch.name = trimmed;
    }
    if (patch.status !== undefined) updatePatch.status = patch.status;
    if (patch.callableBy !== undefined) updatePatch.callableBy = patch.callableBy;
    if (patch.agentId !== undefined) updatePatch.agentId = patch.agentId;
    if (patch.tokenSecretId !== undefined) updatePatch.tokenSecretId = patch.tokenSecretId;
    if (patch.webhookUrl !== undefined) {
      updatePatch.webhookUrl = patch.webhookUrl === null ? null : validateWebhookUrl(patch.webhookUrl.trim()).toString();
    }
    let inboundToken: string | null = null;
    if (patch.rotateInboundToken) {
      inboundToken = createBotInboundToken();
      updatePatch.inboundTokenHash = hashBotInboundToken(inboundToken);
    }
    const updated = await store.updateBot(companyId, botId, updatePatch, patch.capabilities);
    if (!updated) throw notFound("bot_not_found");
    return { bot: updated.bot, capabilities: updated.capabilities, inboundToken };
  }

  async function updateBotCapabilities(
    companyId: string,
    botId: string,
    actor: BotActor,
    capabilities: BotCapabilityInput[],
  ) {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const seen = new Set<string>();
    for (const cap of capabilities) {
      if (seen.has(cap.capabilityKey)) throw badRequest("duplicate_capability_key");
      seen.add(cap.capabilityKey);
    }
    const updated = await store.updateBot(companyId, botId, { updatedAt: now() }, capabilities);
    if (!updated) throw notFound("bot_not_found");
    return { bot: updated.bot, capabilities: updated.capabilities };
  }

  async function listCompanyAudit(companyId: string, actor: BotActor, limit = 50): Promise<BotAuditEventRecord[]> {
    assertCompanyScope(actor, companyId);
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = store.listAuditEvents ? await store.listAuditEvents(companyId, safeLimit) : [];
    return rows.map((row) => ({ ...row, details: sanitizeAuditDetails(row.details) }));
  }

  async function deleteBot(companyId: string, botId: string, actor: BotActor) {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const deleted = await store.deleteBot(companyId, botId);
    if (!deleted) throw notFound("bot_not_found");
    return { deleted: true as const, botId };
  }

  async function pingBot(companyId: string, botId: string, actor: BotActor): Promise<BotPingResult> {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const bot = await store.getBot(companyId, botId);
    if (!bot) throw notFound("bot_not_found");
    if (!bot.webhookUrl) throw badRequest("bot_webhook_url_missing");
    const targetUrl = validateWebhookUrl(bot.webhookUrl);
    let secretValue: string | null = null;
    if (bot.tokenSecretId) {
      if (!options.resolveSecret) throw unprocessable("secret_resolver_unavailable");
      secretValue = await options.resolveSecret(companyId, bot.tokenSecretId);
    }
    const startedAt = Date.now();
    const pingAt = now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secretValue) headers.authorization = `Bearer ${secretValue}`;
    try {
      const response = await fetchFn(targetUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ event: "ping", botId: bot.id, companyId, timestamp: pingAt.toISOString() }),
        signal: AbortSignal.timeout(pingTimeoutMs),
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const ok = response.ok;
      const sample: HealthSample = {
        ts: pingAt.toISOString(),
        ok,
        rttMs: latencyMs,
        statusCode: response.status,
        ...(ok ? {} : { errorRef: `HTTP ${response.status}` }),
      };
      const nextHealthHistory = appendHealthSample(bot.healthHistory, sample);
      await store.recordBotPing(companyId, bot.id, pingAt, ok ? "ok" : "error", nextHealthHistory);
      return ok
        ? { ok: true, statusCode: response.status, latencyMs }
        : { ok: false, statusCode: response.status, latencyMs, error: `HTTP ${response.status}` };
    } catch (err) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const errorMsg = sanitizePingError(err, secretValue);
      const sample: HealthSample = {
        ts: pingAt.toISOString(),
        ok: false,
        rttMs: latencyMs,
        statusCode: null,
        errorRef: errorMsg.slice(0, 120),
      };
      const nextHealthHistory = appendHealthSample(bot.healthHistory, sample);
      await store.recordBotPing(companyId, bot.id, pingAt, "error", nextHealthHistory);
      return { ok: false, statusCode: null, latencyMs, error: errorMsg };
    }
  }

  async function handleBotInbound(botId: string, rawToken: unknown, payload: BotInboundPayload = {}) {
    if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > TERMINAL_TOKEN_MAX_LENGTH) {
      throw unauthorized("bot_token_rejected");
    }
    const bot = await store.getBotById(botId);
    if (!tokenMatches(bot?.inboundTokenHash ?? UNKNOWN_TERMINAL_HASH, rawToken) || !bot || !bot.inboundTokenHash) {
      throw unauthorized("bot_token_rejected");
    }
    if (bot.status !== "active") {
      throw forbidden(bot.status === "revoked" ? "bot_revoked" : "bot_inactive");
    }
    const title = typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : null;
    const description =
      typeof payload.description === "string" && payload.description.trim().length > 0
        ? payload.description.trim()
        : typeof payload.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : null;
    let issueId: string | null = null;
    if (title && options.createInboundIssue) {
      const issue = await options.createInboundIssue(bot.companyId, {
        title,
        description,
        priority: payload.priority ?? "medium",
        assigneeAgentId: bot.agentId ?? null,
      });
      issueId = issue.id;
    }
    let wokenAgentId: string | null = null;
    let runId: string | null = null;
    if (bot.agentId && options.wakeAgent) {
      const run = await options.wakeAgent(bot.agentId, {
        botId: bot.id,
        companyId: bot.companyId,
        event: payload.event ?? "inbound",
        title,
        message: payload.message ?? null,
        issueId,
        metadata: payload.metadata ?? null,
      });
      wokenAgentId = bot.agentId;
      runId = run?.id ?? null;
    }
    if (options.onInboundActivity) {
      await options.onInboundActivity({
        companyId: bot.companyId,
        botId: bot.id,
        agentId: bot.agentId ?? null,
        event: payload.event ?? "inbound",
        title,
        issueId,
      });
    }
    return {
      ok: true as const,
      botId: bot.id,
      companyId: bot.companyId,
      issueId,
      wokenAgentId,
      runId,
    };
  }

  async function decideBotApproval(
    companyId: string,
    approvalId: string,
    actor: BotActor,
    decision: "approve" | "deny",
    note?: string | null,
  ) {
    assertCompanyScope(actor, companyId);
    assertAdminRole(actor);
    const status = decision === "approve" ? "approved" : "rejected";
    const updated = await store.decideApproval(companyId, approvalId, actor.userId, status, note ?? null, now());
    if (!updated) throw notFound("approval_not_found");
    return updated;
  }

  return {
    registerTerminal,
    heartbeatTerminal,
    commandTerminal,
    invokeChannelMention,
    previewChannelInvoke,
    getCompanySnapshot,
    listTeams,
    createBot,
    updateBot,
    updateBotCapabilities,
    deleteBot,
    pingBot,
    handleBotInbound,
    decideBotApproval,
    listCompanyAudit,
  };
}

export type BotTerminalChannelService = ReturnType<typeof createBotTerminalChannelService>;

/** Approval ledger row type for a personal-bot owner approving channel-driven terminal execution. */
export const BOT_CHANNEL_OWNER_APPROVAL_TYPE = "bot_channel_owner_approval";

const t = clientTerminals;
// `lastSeenAt` is exposed by the service and persisted in the B1 `last_heartbeat_at` column.
const terminalColumns = {
  id: t.id, companyId: t.companyId, kind: t.kind, name: t.name, ownerUserId: t.ownerUserId, teamId: t.teamId, botId: t.botId,
  tokenHash: t.tokenHash, transport: t.transport, status: t.status, lastSeenAt: t.lastHeartbeatAt, revokedAt: t.revokedAt,
  telemetry: t.telemetry, healthHistory: t.healthHistory,
};

const botColumns = {
  id: bots.id,
  companyId: bots.companyId,
  kind: bots.kind,
  name: bots.name,
  ownerUserId: bots.ownerUserId,
  teamId: bots.teamId,
  agentId: bots.agentId,
  callableBy: bots.callableBy,
  status: bots.status,
  webhookUrl: bots.webhookUrl,
  tokenSecretId: bots.tokenSecretId,
  inboundTokenHash: bots.inboundTokenHash,
  lastPingAt: bots.lastPingAt,
  lastPingStatus: bots.lastPingStatus,
  healthHistory: bots.healthHistory,
  createdAt: bots.createdAt,
  updatedAt: bots.updatedAt,
};

const auditEventColumns = {
  id: activityLog.id,
  companyId: activityLog.companyId,
  actorType: activityLog.actorType,
  actorId: activityLog.actorId,
  action: activityLog.action,
  entityType: activityLog.entityType,
  entityId: activityLog.entityId,
  agentId: activityLog.agentId,
  details: activityLog.details,
  createdAt: activityLog.createdAt,
};

const capabilityColumns = {
  botId: botCapabilities.botId,
  capabilityKey: botCapabilities.capabilityKey,
  callableBy: botCapabilities.callableBy,
  dataScope: botCapabilities.dataScope,
  requiresApproval: botCapabilities.requiresApproval,
};

const channelColumns = {
  id: channels.id,
  companyId: channels.companyId,
  kind: channels.kind,
  name: channels.name,
  teamId: channels.teamId,
  createdByUserId: channels.createdByUserId,
};

const approvalColumns = {
  id: approvals.id,
  companyId: approvals.companyId,
  type: approvals.type,
  status: approvals.status,
  payload: approvals.payload,
  requestedByUserId: approvals.requestedByUserId,
  requestedByAgentId: approvals.requestedByAgentId,
  decidedByUserId: approvals.decidedByUserId,
  decisionNote: approvals.decisionNote,
  decidedAt: approvals.decidedAt,
  createdAt: approvals.createdAt,
};

/** DB check constraints guarantee the enum-shaped text columns; the cast narrows them to the record unions. */
function firstRow<T>(rows: unknown[]): T | null { return (rows[0] ?? null) as T | null; }

export function createDrizzleEnterpriseBotStore(db: Db): EnterpriseBotStore {
  return {
    createTerminal: (input) => db.insert(clientTerminals).values({
      companyId: input.companyId, kind: input.kind, name: input.name, ownerUserId: input.ownerUserId, teamId: input.teamId,
      botId: input.botId, transport: input.transport, tokenHash: input.tokenHash, status: "offline",
    }).returning(terminalColumns).then((rows) => firstRow<BotTerminalRecord>(rows)!),
    getTerminal: (companyId, terminalId) => db.select(terminalColumns).from(t)
      .where(and(eq(t.companyId, companyId), eq(t.id, terminalId))).then(firstRow<BotTerminalRecord>),
    getTerminalById: (terminalId) => db.select(terminalColumns).from(t).where(eq(t.id, terminalId)).then(firstRow<BotTerminalRecord>),
    markTerminalSeen: async (terminalId, seenAt, update) => {
      const patch: Record<string, unknown> = { status: "online", lastHeartbeatAt: seenAt, updatedAt: seenAt };
      if (update?.telemetry !== undefined) patch.telemetry = update.telemetry;
      if (update?.healthHistory !== undefined) patch.healthHistory = update.healthHistory;
      await db.update(t).set(patch).where(eq(t.id, terminalId));
    },
    revokeTerminal: async (terminalId, revokedAt) => {
      await db.update(t).set({ status: "revoked", revokedAt, updatedAt: revokedAt }).where(and(eq(t.id, terminalId), isNull(t.revokedAt)));
    },
    getBot: (companyId, botId) => db.select(botColumns).from(bots)
      .where(and(eq(bots.companyId, companyId), eq(bots.id, botId))).then(firstRow<EnterpriseBotRecord>),
    getBotById: (botId) => db.select(botColumns).from(bots)
      .where(eq(bots.id, botId)).then(firstRow<EnterpriseBotRecord>),
    listBots: (companyId) => db.select(botColumns).from(bots)
      .where(eq(bots.companyId, companyId)).orderBy(desc(bots.createdAt)) as Promise<EnterpriseBotRecord[]>,
    listBotCapabilities: (botIds) => botIds.length === 0
      ? Promise.resolve([])
      : db.select(capabilityColumns).from(botCapabilities)
          .where(inArray(botCapabilities.botId, botIds)) as Promise<BotCapabilityRecord[]>,
    listTerminals: (companyId) => db.select(terminalColumns).from(t)
      .where(eq(t.companyId, companyId)).orderBy(desc(t.createdAt)) as Promise<BotTerminalRecord[]>,
    listChannels: (companyId) => db.select(channelColumns).from(channels)
      .where(eq(channels.companyId, companyId)).orderBy(desc(channels.createdAt)) as Promise<EnterpriseChannelRecord[]>,
    listTeams: (companyId) => db.select({ id: teams.id, name: teams.name }).from(teams)
      .where(eq(teams.companyId, companyId)).orderBy(teams.name),
    listPendingApprovals: (companyId) => db.select(approvalColumns).from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, BOT_CHANNEL_OWNER_APPROVAL_TYPE),
        eq(approvals.status, "pending"),
      ))
      .orderBy(desc(approvals.createdAt)) as Promise<BotPendingApprovalRecord[]>,
    listAuditEvents: (companyId, limit) => db.select(auditEventColumns).from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        or(
          inArray(activityLog.entityType, ["bot", "client_terminal", "terminal", "channel", "bot_approval"]),
          ilike(activityLog.action, "enterprise_bot.%"),
          ilike(activityLog.action, "bot.%"),
          ilike(activityLog.action, "terminal.%"),
          ilike(activityLog.action, "channel.%"),
        ),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit) as Promise<BotAuditEventRecord[]>,
    createBot: async (input, capabilities) => db.transaction(async (tx) => {
      const [bot] = await tx.insert(bots).values({
        companyId: input.companyId,
        kind: input.kind,
        name: input.name,
        ownerUserId: input.ownerUserId,
        teamId: input.teamId,
        agentId: input.agentId,
        callableBy: input.callableBy,
        status: input.status,
        webhookUrl: input.webhookUrl,
        tokenSecretId: input.tokenSecretId,
        inboundTokenHash: input.inboundTokenHash,
      }).returning(botColumns);
      let insertedCaps: BotCapabilityRecord[] = [];
      if (capabilities.length > 0) {
        insertedCaps = (await tx.insert(botCapabilities).values(
          capabilities.map((cap) => ({
            botId: bot.id,
            capabilityKey: cap.capabilityKey,
            callableBy: cap.callableBy,
            dataScope: cap.dataScope ?? "self",
            requiresApproval: cap.requiresApproval ?? false,
          })),
        ).returning(capabilityColumns)) as BotCapabilityRecord[];
      }
      return { bot: bot as EnterpriseBotRecord, capabilities: insertedCaps };
    }),
    updateBot: async (companyId, botId, patch, capabilities) => db.transaction(async (tx) => {
      const updateSet: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) updateSet.name = patch.name;
      if (patch.status !== undefined) updateSet.status = patch.status;
      if (patch.webhookUrl !== undefined) updateSet.webhookUrl = patch.webhookUrl;
      if (patch.tokenSecretId !== undefined) updateSet.tokenSecretId = patch.tokenSecretId;
      if (patch.agentId !== undefined) updateSet.agentId = patch.agentId;
      if (patch.callableBy !== undefined) updateSet.callableBy = patch.callableBy;
      if (patch.inboundTokenHash !== undefined) updateSet.inboundTokenHash = patch.inboundTokenHash;

      const updatedRows = await tx.update(bots).set(updateSet)
        .where(and(eq(bots.companyId, companyId), eq(bots.id, botId)))
        .returning(botColumns);
      const bot = firstRow<EnterpriseBotRecord>(updatedRows);
      if (!bot) return null;

      let capRows: BotCapabilityRecord[];
      if (capabilities !== undefined) {
        await tx.delete(botCapabilities).where(eq(botCapabilities.botId, botId));
        if (capabilities.length > 0) {
          capRows = (await tx.insert(botCapabilities).values(
            capabilities.map((cap) => ({
              botId,
              capabilityKey: cap.capabilityKey,
              callableBy: cap.callableBy,
              dataScope: cap.dataScope ?? "self",
              requiresApproval: cap.requiresApproval ?? false,
            })),
          ).returning(capabilityColumns)) as BotCapabilityRecord[];
        } else {
          capRows = [];
        }
      } else {
        capRows = (await tx.select(capabilityColumns).from(botCapabilities)
          .where(eq(botCapabilities.botId, botId))) as BotCapabilityRecord[];
      }
      return { bot, capabilities: capRows };
    }),
    deleteBot: async (companyId, botId) => {
      const deleted = await db.delete(bots)
        .where(and(eq(bots.companyId, companyId), eq(bots.id, botId)))
        .returning({ id: bots.id });
      return deleted.length > 0;
    },
    recordBotPing: async (companyId, botId, pingAt, status, healthHistory) => {
      const patch: Record<string, unknown> = { lastPingAt: pingAt, lastPingStatus: status, updatedAt: pingAt };
      if (healthHistory !== undefined) patch.healthHistory = healthHistory;
      await db.update(bots)
        .set(patch)
        .where(and(eq(bots.companyId, companyId), eq(bots.id, botId)));
    },
    decideApproval: async (companyId, approvalId, decidedByUserId, status, note, decidedAt) => {
      const rows = await db.update(approvals)
        .set({
          status,
          decidedByUserId,
          decisionNote: note,
          decidedAt,
          updatedAt: decidedAt,
        })
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.id, approvalId),
          eq(approvals.type, BOT_CHANNEL_OWNER_APPROVAL_TYPE),
        ))
        .returning(approvalColumns);
      return firstRow<BotPendingApprovalRecord>(rows);
    },
    getBotCapability: (botId, capabilityKey) => db.select(capabilityColumns).from(botCapabilities)
      .where(and(eq(botCapabilities.botId, botId), eq(botCapabilities.capabilityKey, capabilityKey))).then(firstRow<BotCapabilityRecord>),
    getChannel: (companyId, channelId) => db.select(channelColumns).from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.id, channelId))).then(firstRow<EnterpriseChannelRecord>),
    listChannelMemberIds: async (channelId) => (await db.select({ principalId: channelMembers.principalId }).from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))).map((row) => row.principalId),
    // Structured approval ledger only (type/status/decidedBy/payload); no approval row ⇒ denied.
    hasChannelOwnerApproval: async (companyId, botId, botOwnerUserId, channelId) => {
      if (!botOwnerUserId) return false;
      const rows = await db.select({ id: approvals.id }).from(approvals).where(and(
        eq(approvals.companyId, companyId), eq(approvals.type, BOT_CHANNEL_OWNER_APPROVAL_TYPE), eq(approvals.status, "approved"),
        eq(approvals.decidedByUserId, botOwnerUserId), sql`${approvals.payload}->>'botId' = ${botId}`,
        sql`${approvals.payload}->>'channelId' = ${channelId}`,
      )).limit(1);
      return rows.length > 0;
    },
  };
}

export function createDrizzleEnterpriseBotRuntimeOptions(db: Db): BotTerminalChannelServiceOptions {
  const secrets = secretService(db);
  const heartbeat = heartbeatService(db);
  const issues = issueService(db);
  return {
    resolveSecret: async (companyId, secretId) => {
      const { env } = await secrets.resolveEnvBindings(companyId, {
        BOT_TOKEN: { type: "secret_ref", secretId, version: "latest" },
      });
      return env.BOT_TOKEN ?? "";
    },
    onInboundActivity: async (input) => {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: `bot:${input.botId}`,
        action: "enterprise_bot.inbound",
        entityType: "bot",
        entityId: input.botId,
        agentId: input.agentId,
        details: {
          event: input.event,
          title: input.title,
          issueId: input.issueId,
        },
      });
    },
    wakeAgent: async (agentId, payload) => {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "webhook",
        reason: "enterprise_bot_inbound",
        payload,
        requestedByActorType: "system",
        requestedByActorId: String(payload.botId ?? "enterprise_bot"),
      });
      return run ? { id: run.id } : null;
    },
    createInboundIssue: async (companyId, input) => {
      const issue = await issues.create(companyId, {
        title: input.title,
        description: input.description,
        status: "todo",
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
      });
      return { id: issue.id, identifier: issue.identifier };
    },
  };
}
