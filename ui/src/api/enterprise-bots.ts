import { api, request } from "./client";

/**
 * Typed client for `server/src/routes/enterprise-bots.ts` (enterprise bot terminals + channel relay).
 * Shapes mirror the server's zod schemas and public response payloads; the raw terminal token is
 * returned exactly once from `registerTerminal` and never re-read from the server.
 */

export type BotTerminalKind = "personal_terminal" | "worker_node";
export type BotTerminalTransport = "outbound_wss" | "tailscale_direct";
export type BotTerminalStatus = "offline" | "online" | "revoked";
export type BotTerminalAction = "exec" | "stop" | "revoke";
export type BotCapabilityDataScope = "self" | "team" | "company";
export type ChannelExecutionTarget = "personal_terminal" | "worker_node" | "none";

/** Server `PublicBotTerminal`: the stored record minus `tokenHash`. */
export interface BotTerminal {
  id: string;
  companyId: string;
  kind: BotTerminalKind;
  name: string;
  ownerUserId: string | null;
  teamId: string | null;
  botId: string | null;
  transport: BotTerminalTransport;
  status: BotTerminalStatus;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface GovernanceDecision {
  allowed: boolean;
  reason: string;
}

export interface RegisterTerminalInput {
  companyId: string;
  kind: BotTerminalKind;
  /** 1–120 chars. */
  name: string;
  ownerUserId?: string;
  teamId?: string;
  botId?: string;
  transport?: BotTerminalTransport;
}

export interface RegisterTerminalResponse {
  terminal: BotTerminal;
  /** One-time bearer token for heartbeats; not persisted or echoed by the server afterwards. */
  token: string;
}

export interface CommandTerminalInput {
  companyId: string;
  action: BotTerminalAction;
}

export interface CommandTerminalResponse {
  terminal: BotTerminal;
  action: BotTerminalAction;
  decision: GovernanceDecision;
}

export interface InvokeChannelTargetRecord {
  ownerUserId: string | null;
  teamId: string | null;
  companyId?: string | null;
}

export interface InvokeChannelInput {
  companyId: string;
  targetBotId: string;
  executionTarget: ChannelExecutionTarget;
  capabilityKey: string;
  targetRecord?: InvokeChannelTargetRecord;
}

export interface InvokeChannelPayload {
  outcome: "allowed" | "requires_approval";
  channel: { id: string; kind: "team" | "shared" | "dm" };
  bot: { id: string; kind: "personal" | "team" };
  capability: { capabilityKey: string; dataScope: BotCapabilityDataScope };
  forcedFilter: Record<string, string> | null;
  requiresApproval: boolean;
}

const BASE = "/enterprise-bots";

export const enterpriseBotsApi = {
  /** `POST /terminals/register` → 201 `{ terminal, token }`. */
  registerTerminal: (input: RegisterTerminalInput) =>
    api.post<RegisterTerminalResponse>(`${BASE}/terminals/register`, input),

  /** `POST /terminals/:terminalId/heartbeat` → 200 `{ terminal }` (Bearer terminal token). */
  heartbeatTerminal: (terminalId: string, token: string) =>
    request<{ terminal: BotTerminal }>(`${BASE}/terminals/${encodeURIComponent(terminalId)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { Authorization: `Bearer ${token}` },
    }),

  /** `POST /terminals/:terminalId/commands` → 200 `{ terminal, action, decision }`. */
  commandTerminal: (terminalId: string, input: CommandTerminalInput) =>
    api.post<CommandTerminalResponse>(`${BASE}/terminals/${encodeURIComponent(terminalId)}/commands`, input),

  /** `POST /channels/:channelId/invoke` → 200 (allowed) | 202 (requires_approval). */
  invokeChannelMention: (channelId: string, input: InvokeChannelInput) =>
    api.post<InvokeChannelPayload>(`${BASE}/channels/${encodeURIComponent(channelId)}/invoke`, input),
};
