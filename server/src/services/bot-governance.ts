export type CallerRole = "owner" | "admin" | "member" | "viewer";
export type BotKind = "personal" | "team";
export type CallableBy = "self_only" | "team" | "company";
export type DataScope = "self" | "team" | "company";
export type TerminalKind = "personal_terminal" | "worker_node";
export type TerminalAction = "exec" | "stop" | "revoke";
export type ChannelExecutionTarget = "personal_terminal" | "worker_node" | "none";
export type ForcedFilter = Record<string, string>;

export interface GovernanceDecision { allowed: boolean; reason: string }
export interface CapabilityDecision extends GovernanceDecision { forcedFilter: ForcedFilter | null; requiresApproval: boolean }
export interface ChannelDecision extends GovernanceDecision { requiresOwnerApproval: boolean; crossTeamSecretsAllowed: false }

export interface BotDispatchInput {
  callerUserId: string; callerTeamId: string | null; callerRole: CallerRole; callerCompanyId: string;
  companyId: string; kind: BotKind; ownerUserId: string | null; teamId: string | null;
  callableBy: CallableBy; status: string;
}

export interface CapabilityDataScopeInput {
  caller: { userId: string; teamId: string | null; role: CallerRole; companyId?: string | null };
  capability: { capabilityKey: string; callableBy: CallableBy; dataScope: DataScope; requiresApproval: boolean };
  targetRecord: { ownerUserId: string | null; teamId: string | null; companyId?: string | null };
}

export interface TerminalCommandInput {
  callerUserId: string; callerTeamId: string | null; callerRole: CallerRole; callerCompanyId: string;
  companyId: string; kind: TerminalKind; ownerUserId: string | null; teamId: string | null;
  status: string; action: TerminalAction; botKind?: BotKind | null; botOwnerUserId?: string | null;
  botTeamId?: string | null; botApproved?: boolean; botCompanyId?: string | null; explicitOwnerContext?: boolean;
}

export interface ChannelInvokeInput {
  callerUserId: string; callerTeamId: string | null; callerRole: CallerRole; callerCompanyId: string;
  channelCompanyId: string; channelMemberIds: string[]; botId: string; botCompanyId: string;
  botKind: BotKind; botOwnerUserId: string | null; botTeamId: string | null;
  executionTarget: ChannelExecutionTarget; ownerApproved?: boolean; requestsCrossTeamSecrets?: boolean;
}

const callerRoles: readonly CallerRole[] = ["owner", "admin", "member", "viewer"];
const botKinds: readonly BotKind[] = ["personal", "team"];
const callableByValues: readonly CallableBy[] = ["self_only", "team", "company"];
const dataScopes: readonly DataScope[] = ["self", "team", "company"];
const terminalKinds: readonly TerminalKind[] = ["personal_terminal", "worker_node"];
const terminalActions: readonly TerminalAction[] = ["exec", "stop", "revoke"];
const executionTargets: readonly ChannelExecutionTarget[] = ["personal_terminal", "worker_node", "none"];

const botDispatchKeys = ["callerUserId", "callerTeamId", "callerRole", "callerCompanyId", "companyId", "kind", "ownerUserId", "teamId", "callableBy", "status"];
const capabilityCallerKeys = ["userId", "teamId", "role"];
const capabilityKeys = ["capabilityKey", "callableBy", "dataScope", "requiresApproval"];
const targetRecordKeys = ["ownerUserId", "teamId"];
const terminalKeys = ["callerUserId", "callerTeamId", "callerRole", "callerCompanyId", "companyId", "kind", "ownerUserId", "teamId", "status", "action"];
const terminalOptionalKeys = ["botKind", "botOwnerUserId", "botTeamId", "botApproved", "botCompanyId", "explicitOwnerContext"];
const channelKeys = ["callerUserId", "callerTeamId", "callerRole", "callerCompanyId", "channelCompanyId", "channelMemberIds", "botId", "botCompanyId", "botKind", "botOwnerUserId", "botTeamId", "executionTarget"];
const channelOptionalKeys = ["ownerApproved", "requestsCrossTeamSecrets"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function keysMatch(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}
function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return requiredString(value) ?? undefined;
}
function optionalNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  return Object.hasOwn(record, key) ? nullableString(record[key]) : null;
}
function optionalBoolean(record: Record<string, unknown>, key: string): boolean | null {
  if (!Object.hasOwn(record, key)) return false;
  return typeof record[key] === "boolean" ? record[key] as boolean : null;
}
function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function hasRequiredBotScope(kind: BotKind, ownerUserId: string | null, teamId: string | null): boolean {
  return kind === "personal" ? ownerUserId !== null : teamId !== null;
}
function hasRequiredTerminalScope(kind: TerminalKind, ownerUserId: string | null, teamId: string | null): boolean {
  return kind === "personal_terminal" ? ownerUserId !== null : teamId !== null;
}
function decision(allowed: boolean, reason: string): GovernanceDecision { return { allowed, reason }; }
function deny(reason: string): GovernanceDecision { return decision(false, reason); }
function capabilityDecision(allowed: boolean, reason: string, forcedFilter: ForcedFilter | null, requiresApproval: boolean): CapabilityDecision {
  return { allowed, reason, forcedFilter, requiresApproval };
}
function channelDecision(allowed: boolean, reason: string, requiresOwnerApproval: boolean): ChannelDecision {
  return { allowed, reason, requiresOwnerApproval, crossTeamSecretsAllowed: false };
}

function evaluateCallableBy(input: {
  callableBy: CallableBy; callerUserId: string; callerTeamId: string | null; callerRole: CallerRole;
  ownerUserId: string | null; teamId: string | null;
}): GovernanceDecision {
  if (input.callableBy === "self_only") {
    const allowed = input.ownerUserId !== null && input.ownerUserId === input.callerUserId;
    return decision(allowed, allowed ? "allowed" : "self_only_denied");
  }
  if (input.callableBy === "team") {
    const allowed = (input.teamId !== null && input.teamId === input.callerTeamId) || input.callerRole === "owner";
    return decision(allowed, allowed ? "allowed" : "team_scope_denied");
  }
  return decision(true, "allowed");
}

export function evaluateBotDispatch(input: BotDispatchInput): GovernanceDecision {
  const source = asRecord(input);
  if (!source || !keysMatch(source, botDispatchKeys)) return deny("invalid_input");
  const callerUserId = requiredString(source.callerUserId);
  const callerCompanyId = requiredString(source.callerCompanyId);
  const companyId = requiredString(source.companyId);
  const callerTeamId = nullableString(source.callerTeamId);
  const ownerUserId = nullableString(source.ownerUserId);
  const teamId = nullableString(source.teamId);
  const status = requiredString(source.status);
  if (!callerUserId || !callerCompanyId || !companyId || !status || callerTeamId === undefined || ownerUserId === undefined || teamId === undefined) return deny("invalid_input");
  if (callerCompanyId !== companyId) return deny("cross_company_denied");
  if (status !== "active") return deny("bot_inactive");
  if (!isOneOf(source.callerRole, callerRoles)) return deny("invalid_caller_role");
  if (!isOneOf(source.kind, botKinds)) return deny("invalid_bot_kind");
  if (!hasRequiredBotScope(source.kind, ownerUserId, teamId)) return deny("invalid_bot_scope");
  if (!isOneOf(source.callableBy, callableByValues)) return deny("invalid_callable_by");
  return evaluateCallableBy({ callableBy: source.callableBy, callerUserId, callerTeamId, callerRole: source.callerRole, ownerUserId, teamId });
}

export function evaluateCapabilityDataScope(input: CapabilityDataScopeInput): CapabilityDecision {
  const invalid = capabilityDecision(false, "invalid_input", null, false);
  const root = asRecord(input);
  const caller = asRecord(root?.caller);
  const capability = asRecord(root?.capability);
  const targetRecord = asRecord(root?.targetRecord);
  if (!root || !caller || !capability || !targetRecord) return invalid;
  if (!keysMatch(root, ["caller", "capability", "targetRecord"]) || !keysMatch(caller, capabilityCallerKeys, ["companyId"]) || !keysMatch(capability, capabilityKeys) || !keysMatch(targetRecord, targetRecordKeys, ["companyId"])) return invalid;
  const userId = requiredString(caller.userId);
  const callerTeamId = nullableString(caller.teamId);
  const callerCompanyId = optionalNullableString(caller, "companyId");
  const ownerUserId = nullableString(targetRecord.ownerUserId);
  const teamId = nullableString(targetRecord.teamId);
  const targetCompanyId = optionalNullableString(targetRecord, "companyId");
  const capabilityKey = requiredString(capability.capabilityKey);
  if (!userId || !capabilityKey || callerTeamId === undefined || callerCompanyId === undefined || ownerUserId === undefined || teamId === undefined || targetCompanyId === undefined) return invalid;
  if (!isOneOf(caller.role, callerRoles)) return capabilityDecision(false, "invalid_caller_role", null, false);
  if (!isOneOf(capability.callableBy, callableByValues)) return capabilityDecision(false, "invalid_callable_by", null, false);
  if (!isOneOf(capability.dataScope, dataScopes)) return capabilityDecision(false, "invalid_data_scope", null, false);
  if (typeof capability.requiresApproval !== "boolean") return invalid;
  const requiresApproval = capability.requiresApproval;
  if (callerCompanyId !== targetCompanyId) return capabilityDecision(false, "cross_company_denied", null, requiresApproval);
  const callable = evaluateCallableBy({ callableBy: capability.callableBy, callerUserId: userId, callerTeamId, callerRole: caller.role, ownerUserId, teamId });
  if (!callable.allowed) return capabilityDecision(false, callable.reason, null, requiresApproval);
  if (capability.dataScope === "self") {
    if (ownerUserId === null || ownerUserId !== userId) return capabilityDecision(false, "data_scope_self_violation", null, requiresApproval);
    return capabilityDecision(true, "allowed", { ownerUserId: userId }, requiresApproval);
  }
  if (capability.dataScope === "team") {
    if (caller.role === "owner") return capabilityDecision(true, "allowed", teamId === null ? null : { teamId }, requiresApproval);
    if (teamId === null || teamId !== callerTeamId) return capabilityDecision(false, "data_scope_team_violation", null, requiresApproval);
    return capabilityDecision(true, "allowed", { teamId }, requiresApproval);
  }
  if (callerCompanyId === null) return capabilityDecision(false, "cross_company_denied", null, requiresApproval);
  return capabilityDecision(true, "allowed", { companyId: callerCompanyId }, requiresApproval);
}

export function evaluateTerminalCommand(input: TerminalCommandInput): GovernanceDecision {
  const source = asRecord(input);
  if (!source || !keysMatch(source, terminalKeys, terminalOptionalKeys)) return deny("invalid_input");
  const callerUserId = requiredString(source.callerUserId);
  const callerCompanyId = requiredString(source.callerCompanyId);
  const companyId = requiredString(source.companyId);
  const callerTeamId = nullableString(source.callerTeamId);
  const ownerUserId = nullableString(source.ownerUserId);
  const teamId = nullableString(source.teamId);
  const status = requiredString(source.status);
  const botKind = optionalNullableString(source, "botKind");
  const botOwnerUserId = optionalNullableString(source, "botOwnerUserId");
  const botTeamId = optionalNullableString(source, "botTeamId");
  const botCompanyId = optionalNullableString(source, "botCompanyId");
  const botApproved = optionalBoolean(source, "botApproved");
  const explicitOwnerContext = optionalBoolean(source, "explicitOwnerContext");
  if (!callerUserId || !callerCompanyId || !companyId || !status || callerTeamId === undefined || ownerUserId === undefined || teamId === undefined || botKind === undefined || botOwnerUserId === undefined || botTeamId === undefined || botCompanyId === undefined || botApproved === null || explicitOwnerContext === null) return deny("invalid_input");
  if (callerCompanyId !== companyId || (botCompanyId !== null && botCompanyId !== companyId)) return deny("cross_company_denied");
  if (status === "revoked") return deny("terminal_revoked");
  if (status !== "active") return deny("terminal_inactive");
  if (!isOneOf(source.callerRole, callerRoles)) return deny("invalid_caller_role");
  if (!isOneOf(source.kind, terminalKinds)) return deny("invalid_terminal_kind");
  if (!isOneOf(source.action, terminalActions)) return deny("invalid_action");
  if (!hasRequiredTerminalScope(source.kind, ownerUserId, teamId)) return deny("invalid_terminal_scope");
  const hasBotContext = botKind !== null || botOwnerUserId !== null || botTeamId !== null || botCompanyId !== null || botApproved || explicitOwnerContext;
  if (botKind === null && hasBotContext) return deny("invalid_input");
  if (botKind !== null) {
    if (!isOneOf(botKind, botKinds)) return deny("invalid_bot_kind");
    if (botCompanyId === null || !hasRequiredBotScope(botKind, botOwnerUserId, botTeamId)) return deny("invalid_bot_scope");
  }
  const botActor = botKind !== null;
  if (source.kind === "personal_terminal") {
    if (botActor) {
      return botKind === "personal" && explicitOwnerContext && botOwnerUserId === ownerUserId
        ? decision(true, "allowed")
        : deny("personal_terminal_access_denied");
    }
    if (ownerUserId === callerUserId) return decision(true, "allowed");
    if ((source.callerRole === "admin" || source.callerRole === "owner") && (source.action === "stop" || source.action === "revoke")) return decision(true, "allowed");
    if ((source.callerRole === "admin" || source.callerRole === "owner") && source.action === "exec") return deny("personal_terminal_exec_denied");
    return deny("personal_terminal_access_denied");
  }
  if (source.callerRole === "viewer") return deny("worker_node_viewer_denied");
  if (botActor) {
    return botKind === "team" && botApproved && botTeamId !== null && botTeamId === teamId
      ? decision(true, "allowed")
      : deny("worker_node_access_denied");
  }
  if (source.callerRole === "owner") return decision(true, "allowed");
  if ((source.callerRole === "admin" || source.callerRole === "member") && teamId !== null && callerTeamId === teamId) return decision(true, "allowed");
  return deny("worker_node_access_denied");
}

export function evaluateChannelInvoke(input: ChannelInvokeInput): ChannelDecision {
  const invalid = channelDecision(false, "invalid_input", false);
  const source = asRecord(input);
  if (!source || !keysMatch(source, channelKeys, channelOptionalKeys)) return invalid;
  const callerUserId = requiredString(source.callerUserId);
  const callerCompanyId = requiredString(source.callerCompanyId);
  const channelCompanyId = requiredString(source.channelCompanyId);
  const botId = requiredString(source.botId);
  const botCompanyId = requiredString(source.botCompanyId);
  const callerTeamId = nullableString(source.callerTeamId);
  const botOwnerUserId = nullableString(source.botOwnerUserId);
  const botTeamId = nullableString(source.botTeamId);
  const ownerApproved = optionalBoolean(source, "ownerApproved");
  const requestsCrossTeamSecrets = optionalBoolean(source, "requestsCrossTeamSecrets");
  if (!callerUserId || !callerCompanyId || !channelCompanyId || !botId || !botCompanyId || callerTeamId === undefined || botOwnerUserId === undefined || botTeamId === undefined || ownerApproved === null || requestsCrossTeamSecrets === null) return invalid;
  if (callerCompanyId !== channelCompanyId || botCompanyId !== channelCompanyId) return channelDecision(false, "cross_company_denied", false);
  if (!isOneOf(source.callerRole, callerRoles)) return channelDecision(false, "invalid_caller_role", false);
  if (!isOneOf(source.botKind, botKinds)) return channelDecision(false, "invalid_bot_kind", false);
  if (!hasRequiredBotScope(source.botKind, botOwnerUserId, botTeamId)) return channelDecision(false, "invalid_bot_scope", false);
  if (!isOneOf(source.executionTarget, executionTargets)) return channelDecision(false, "invalid_execution_target", false);
  if (!Array.isArray(source.channelMemberIds) || source.channelMemberIds.some((member) => requiredString(member) === null)) return invalid;
  const channelMemberIds = source.channelMemberIds as string[];
  if (!channelMemberIds.includes(callerUserId)) return channelDecision(false, "caller_not_channel_member", false);
  if (!channelMemberIds.includes(botId)) return channelDecision(false, "bot_not_channel_member", false);
  if (requestsCrossTeamSecrets) return channelDecision(false, "cross_team_secrets_denied", false);
  if (source.botKind === "personal" && source.executionTarget === "personal_terminal" && callerUserId !== botOwnerUserId && !ownerApproved) {
    return channelDecision(false, "personal_terminal_requires_owner_approval", true);
  }
  return channelDecision(true, "allowed", false);
}
