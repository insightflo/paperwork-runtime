import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, botCapabilities, bots, channelMembers, channels, clientTerminals } from "@paperclipai/db";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
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
 * Enterprise bot B3: terminal lifecycle (register / heartbeat / command) and channel @mention relay.
 * Pure service over an injected `EnterpriseBotStore` (`createDrizzleEnterpriseBotStore` binds the B1 schema).
 * Every authorization question is delegated to `bot-governance.js`; this file only maps records into
 * evaluator inputs and evaluator reasons into fail-closed HTTP errors.
 */

export type TerminalTransport = "outbound_wss" | "tailscale_direct";
export type TerminalStatus = "offline" | "online" | "revoked";

export interface BotActor { userId: string; companyId: string; teamId: string | null; role: CallerRole }

/** Connectivity state (`status`) is display-only; governance lifecycle = revoked ⇔ `revokedAt !== null`, else active. */
export interface BotTerminalRecord {
  id: string; companyId: string; kind: TerminalKind; name: string;
  ownerUserId: string | null; teamId: string | null; botId: string | null;
  tokenHash: string; transport: TerminalTransport; status: TerminalStatus; lastSeenAt: Date | null; revokedAt: Date | null;
}

export interface EnterpriseBotRecord {
  id: string; companyId: string; kind: BotKind; ownerUserId: string | null; teamId: string | null; callableBy: CallableBy; status: string;
}

export interface BotCapabilityRecord {
  botId: string; capabilityKey: string; callableBy: CallableBy; dataScope: DataScope; requiresApproval: boolean;
}

export interface EnterpriseChannelRecord { id: string; companyId: string; kind: "team" | "shared" | "dm"; teamId: string | null }

export interface NewBotTerminal {
  companyId: string; kind: TerminalKind; name: string; ownerUserId: string | null; teamId: string | null;
  botId: string | null; transport: TerminalTransport; tokenHash: string;
}

export interface EnterpriseBotStore {
  createTerminal(input: NewBotTerminal): Promise<BotTerminalRecord>;
  /** Company-scoped lookup; must return null when the terminal belongs to another company. */
  getTerminal(companyId: string, terminalId: string): Promise<BotTerminalRecord | null>;
  /** Unscoped lookup for token-authenticated heartbeats only. Callers must verify the token hash. */
  getTerminalById(terminalId: string): Promise<BotTerminalRecord | null>;
  markTerminalSeen(terminalId: string, seenAt: Date): Promise<void>;
  revokeTerminal(terminalId: string, revokedAt: Date): Promise<void>;
  getBot(companyId: string, botId: string): Promise<EnterpriseBotRecord | null>;
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

export const TERMINAL_TOKEN_PREFIX = "pcp_term_";
const TERMINAL_TOKEN_MAX_LENGTH = 256;
const SHA256_HEX_LENGTH = 64;

export function hashTerminalToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function createTerminalToken(): string { return `${TERMINAL_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`; }

// Compared for unknown terminals too, so a missing id and a wrong token take the same path.
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

function requestsCrossTeamSecrets(bot: EnterpriseBotRecord, capability: BotCapabilityRecord, actor: BotActor): boolean {
  return bot.kind === "team" && bot.teamId !== null && actor.teamId !== null && bot.teamId !== actor.teamId && capability.dataScope === "team";
}

export function createBotTerminalChannelService(store: EnterpriseBotStore, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  /** Returns the plaintext token exactly once; only its SHA-256 hex digest is persisted. */
  async function registerTerminal(actor: BotActor, input: RegisterTerminalInput) {
    if (input.companyId !== actor.companyId) throw forbidden("company_scope_denied");
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
        : bot.kind === "team" && bot.teamId === teamId;
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
  async function heartbeatTerminal(terminalId: string, rawToken: unknown): Promise<BotTerminalRecord> {
    if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > TERMINAL_TOKEN_MAX_LENGTH) {
      throw unauthorized("terminal_token_rejected");
    }
    const terminal = await store.getTerminalById(terminalId);
    if (!tokenMatches(terminal?.tokenHash ?? UNKNOWN_TERMINAL_HASH, rawToken) || !terminal) {
      throw unauthorized("terminal_token_rejected");
    }
    if (lifecycleStatus(terminal) === "revoked") throw forbidden("terminal_revoked");
    const seenAt = now();
    await store.markTerminalSeen(terminal.id, seenAt);
    return { ...terminal, status: "online", lastSeenAt: seenAt };
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

  return { registerTerminal, heartbeatTerminal, commandTerminal, invokeChannelMention };
}

export type BotTerminalChannelService = ReturnType<typeof createBotTerminalChannelService>;

/** Approval ledger row type for a personal-bot owner approving channel-driven terminal execution. */
export const BOT_CHANNEL_OWNER_APPROVAL_TYPE = "bot_channel_owner_approval";

const t = clientTerminals;
// `lastSeenAt` is exposed by the service and persisted in the B1 `last_heartbeat_at` column.
const terminalColumns = {
  id: t.id, companyId: t.companyId, kind: t.kind, name: t.name, ownerUserId: t.ownerUserId, teamId: t.teamId, botId: t.botId,
  tokenHash: t.tokenHash, transport: t.transport, status: t.status, lastSeenAt: t.lastHeartbeatAt, revokedAt: t.revokedAt,
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
    markTerminalSeen: async (terminalId, seenAt) => {
      await db.update(t).set({ status: "online", lastHeartbeatAt: seenAt, updatedAt: seenAt }).where(eq(t.id, terminalId));
    },
    revokeTerminal: async (terminalId, revokedAt) => {
      await db.update(t).set({ status: "revoked", revokedAt, updatedAt: revokedAt }).where(and(eq(t.id, terminalId), isNull(t.revokedAt)));
    },
    getBot: (companyId, botId) => db.select({
      id: bots.id, companyId: bots.companyId, kind: bots.kind, ownerUserId: bots.ownerUserId, teamId: bots.teamId,
      callableBy: bots.callableBy, status: bots.status,
    }).from(bots).where(and(eq(bots.companyId, companyId), eq(bots.id, botId))).then(firstRow<EnterpriseBotRecord>),
    getBotCapability: (botId, capabilityKey) => db.select({
      botId: botCapabilities.botId, capabilityKey: botCapabilities.capabilityKey, callableBy: botCapabilities.callableBy,
      dataScope: botCapabilities.dataScope, requiresApproval: botCapabilities.requiresApproval,
    }).from(botCapabilities).where(and(eq(botCapabilities.botId, botId), eq(botCapabilities.capabilityKey, capabilityKey))).then(firstRow<BotCapabilityRecord>),
    getChannel: (companyId, channelId) => db.select({
      id: channels.id, companyId: channels.companyId, kind: channels.kind, teamId: channels.teamId,
    }).from(channels).where(and(eq(channels.companyId, companyId), eq(channels.id, channelId))).then(firstRow<EnterpriseChannelRecord>),
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
