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
export type EnterpriseBotKind = "personal" | "team" | "company";
export type EnterpriseBotCallableBy = "self_only" | "team" | "company";
export type EnterpriseBotStatus = "active" | "paused" | "revoked";
export type BotApprovalDecision = "approved" | "rejected";

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

export interface BotCapabilityMatrixEntry {
  capabilityKey: string;
  callableBy: EnterpriseBotCallableBy;
  dataScope: BotCapabilityDataScope;
  requiresApproval: boolean;
}

export interface EnterpriseBotsCompatibility {
  protocol: {
    minimum: number;
    maximum: number;
  };
  capabilities: string[];
}

export interface PreviewChannelInvokeResponse {
  dryRun: true;
  outcome: "allowed" | "requires_approval" | "denied";
  reason: string;
  forcedFilter: Record<string, string> | null;
  requiresApproval: boolean;
}

export interface EnterpriseBotAuditEvent {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface EnterpriseBotAuditResponse {
  events: EnterpriseBotAuditEvent[];
}

export interface EnterpriseBotRecord {
  id: string;
  companyId?: string;
  name: string;
  kind: EnterpriseBotKind;
  status: EnterpriseBotStatus;
  callableBy: EnterpriseBotCallableBy | "owner";
  dataScope?: BotCapabilityDataScope;
  capabilities?: string[];
  ownerUserId?: string | null;
  ownerName?: string | null;
  teamId?: string | null;
  webhookUrl?: string | null;
  apiSecretId?: string | null;
  lastPingAt?: string | null;
  lastPingStatus?: string | null;
  lastPingLatencyMs?: number | null;
  healthHistory?: HealthSample[] | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EnterpriseBotSnapshotTerminal extends BotTerminal {
  ownerName?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface EnterpriseBotSnapshotChannel {
  id: string;
  name: string;
  kind?: "team" | "shared" | "dm";
  members: string[];
}

export interface EnterpriseBotSnapshotApproval {
  id: string;
  channelId: string;
  botId: string;
  botName: string;
  fromUserName: string;
  toTerminalId: string;
  toTerminalName: string;
  toOwnerName: string;
  action: string;
  requestedAt: string;
}

export interface EnterpriseBotsSnapshot {
  bots: EnterpriseBotRecord[];
  terminals: EnterpriseBotSnapshotTerminal[];
  channels: EnterpriseBotSnapshotChannel[];
  pendingApprovals: EnterpriseBotSnapshotApproval[];
  now?: string;
}

export interface CreateBotInput {
  name: string;
  kind: EnterpriseBotKind;
  callableBy: EnterpriseBotCallableBy;
  dataScope: BotCapabilityDataScope;
  webhookUrl?: string | null;
  apiSecretId?: string | null;
  capabilities?: string[];
  teamId?: string | null;
  ownerUserId?: string | null;
}

export interface CreateBotResponse {
  bot: EnterpriseBotRecord;
  /** One-time inbound bearer token (`pcp_bot_...`), returned only on creation. */
  inboundToken?: string;
}

export interface UpdateBotInput {
  name?: string;
  kind?: EnterpriseBotKind;
  status?: EnterpriseBotStatus;
  callableBy?: EnterpriseBotCallableBy;
  dataScope?: BotCapabilityDataScope;
  webhookUrl?: string | null;
  apiSecretId?: string | null;
  capabilities?: string[];
}

export interface PingBotResponse {
  ok: boolean;
  status?: number | string;
  latencyMs?: number;
  error?: string | null;
  checkedAt?: string;
}

export interface DecideApprovalResponse {
  ok?: boolean;
  approvalId?: string;
  decision: BotApprovalDecision;
}

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
  telemetry?: TerminalTelemetry | null;
  healthHistory?: HealthSample[] | null;
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
  /** `GET /compatibility` → 200 protocol negotiation & capability flags. */
  getCompatibility: () =>
    api.get<EnterpriseBotsCompatibility>(`${BASE}/compatibility`),

  /** `POST /terminals/register` → 201 `{ terminal, token }`. */
  registerTerminal: (input: RegisterTerminalInput) =>
    api.post<RegisterTerminalResponse>(`${BASE}/terminals/register`, input),

  /** `POST /terminals/:terminalId/heartbeat` → 200 `{ terminal }` (Bearer terminal token). */
  heartbeatTerminal: (terminalId: string, token: string, telemetry?: TerminalTelemetry) =>
    request<{ terminal: BotTerminal }>(`${BASE}/terminals/${encodeURIComponent(terminalId)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify(telemetry ? { telemetry } : {}),
      headers: { Authorization: `Bearer ${token}` },
    }),

  /** `POST /terminals/:terminalId/commands` → 200 `{ terminal, action, decision }`. */
  commandTerminal: (terminalId: string, input: CommandTerminalInput) =>
    api.post<CommandTerminalResponse>(`${BASE}/terminals/${encodeURIComponent(terminalId)}/commands`, input),

  /** `POST /channels/:channelId/invoke` → 200 (allowed) | 202 (requires_approval). */
  invokeChannelMention: (channelId: string, input: InvokeChannelInput) =>
    api.post<InvokeChannelPayload>(`${BASE}/channels/${encodeURIComponent(channelId)}/invoke`, input),

  /** `POST /channels/:channelId/invoke?dryRun=true` → 200 side-effect-free governance preview. */
  previewChannelInvoke: (channelId: string, body: InvokeChannelInput) =>
    api.post<PreviewChannelInvokeResponse>(
      `${BASE}/channels/${encodeURIComponent(channelId)}/invoke?dryRun=true`,
      body,
    ),

  /** `GET /companies/:companyId/snapshot` → 200 `{ bots, terminals, channels, pendingApprovals, now }`. */
  getSnapshot: (companyId: string) =>
    api.get<EnterpriseBotsSnapshot>(`${BASE}/companies/${encodeURIComponent(companyId)}/snapshot`),

  /** `PATCH /companies/:companyId/bots/:botId/capabilities` → 200 `{ bot, capabilities }`. */
  updateBotCapabilities: (
    companyId: string,
    botId: string,
    capabilities: BotCapabilityMatrixEntry[],
  ) =>
    api.patch<{ bot: EnterpriseBotRecord; capabilities: BotCapabilityMatrixEntry[] }>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/bots/${encodeURIComponent(botId)}/capabilities`,
      { capabilities },
    ),

  /** `GET /companies/:companyId/audit?limit=50` → 200 `{ events }`. */
  getAudit: (companyId: string, limit?: number) => {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return api.get<EnterpriseBotAuditResponse>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/audit${query}`,
    );
  },

  /** `POST /companies/:companyId/bots` → 201 `{ bot, inboundToken? }`. */
  createBot: (companyId: string, body: CreateBotInput) =>
    api.post<CreateBotResponse>(`${BASE}/companies/${encodeURIComponent(companyId)}/bots`, body),

  /** `PATCH /companies/:companyId/bots/:botId` → 200 `{ bot }`. */
  updateBot: (companyId: string, botId: string, patch: UpdateBotInput) =>
    api.patch<{ bot: EnterpriseBotRecord }>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/bots/${encodeURIComponent(botId)}`,
      patch,
    ),

  /** `DELETE /companies/:companyId/bots/:botId` → 200 | 204. */
  deleteBot: (companyId: string, botId: string) =>
    api.delete<{ ok?: boolean; bot?: EnterpriseBotRecord }>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/bots/${encodeURIComponent(botId)}`,
    ),

  /** `POST /companies/:companyId/bots/:botId/ping` → 200 `{ ok, status?, latencyMs?, error? }`. */
  pingBot: (companyId: string, botId: string) =>
    api.post<PingBotResponse>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/bots/${encodeURIComponent(botId)}/ping`,
      {},
    ),

  /** `POST /companies/:companyId/approvals/:approvalId/decision` → 200 `{ decision, ... }`. */
  decideApproval: (companyId: string, approvalId: string, decision: BotApprovalDecision) =>
    api.post<DecideApprovalResponse>(
      `${BASE}/companies/${encodeURIComponent(companyId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      { decision },
    ),
};
