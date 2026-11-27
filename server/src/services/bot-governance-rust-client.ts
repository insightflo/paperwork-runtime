import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateBotDispatch,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotDispatchInput,
  type ChannelDecision,
  type ChannelInvokeInput,
  type GovernanceDecision,
  type TerminalCommandInput,
} from "./bot-governance.js";
import { hasLoneSurrogate } from "./tool-hygiene-core-client.js";

// paperwork-bot eval-policy 동기 브리지. 기본은 node, shadow 는 TS 결과를 유지하며
// 허용/승인 동작 차이만 기록하고, rust 는 계약 오류를 allow 로 해석하지 않고 TS 로 되돌아간다.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_RELEASE_BIN = path.join(repoRoot, "target/release/paperwork-bot");
const DEFAULT_DEBUG_BIN = path.join(repoRoot, "target/debug/paperwork-bot");
const EVAL_TIMEOUT_MS = 10_000;
const EVAL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function resolvePaperworkBotBin(configured: string | undefined = process.env.PAPERWORK_BOT_BIN): string | null {
  const trimmed = configured?.trim() ?? "";
  if (trimmed) return path.isAbsolute(trimmed) && !trimmed.includes("\0") ? trimmed : null;
  for (const candidate of [DEFAULT_RELEASE_BIN, DEFAULT_DEBUG_BIN]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type GovernanceMode = "node" | "shadow" | "rust";
function governanceMode(): GovernanceMode {
  const mode = (process.env.PAPERWORK_BOT_GOVERNANCE_MODE ?? "node").trim().toLowerCase();
  return mode === "shadow" || mode === "rust" ? mode : "node";
}

interface RustGovernanceDecision {
  allowed: boolean;
  requires_approval: boolean;
  effect: "allow" | "deny" | "require_approval";
  reason_code: string;
  message: string;
}

type RustRunResult = { ok: true; decision: RustGovernanceDecision } | { ok: false; reason: string };

const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

export function resetBotGovernanceRustWarningsForTests(): void { warnedKeys.clear(); }

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRustDecision(value: unknown): RustGovernanceDecision | null {
  if (!isObjectRecord(value)) return null;
  const effect = value.effect;
  const decision = {
    allowed: value.allowed,
    requires_approval: value.requires_approval,
    effect,
    reason_code: value.reason_code,
    message: value.message,
  };
  if (typeof decision.allowed !== "boolean" || typeof decision.requires_approval !== "boolean") return null;
  if (effect !== "allow" && effect !== "deny" && effect !== "require_approval") return null;
  if (typeof decision.reason_code !== "string" || typeof decision.message !== "string") return null;
  if ((effect === "allow") !== decision.allowed) return null;
  if ((effect === "require_approval") !== decision.requires_approval) return null;
  return decision as RustGovernanceDecision;
}

function serializePayload(payload: unknown): string | null {
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (typeof value === "string" && hasLoneSurrogate(value)) throw new Error("lone_surrogate_input");
      return value;
    });
  } catch { return null; }
}

function runRustPolicy(payload: unknown): RustRunResult {
  const bin = resolvePaperworkBotBin();
  if (bin === null) return { ok: false, reason: "bin_unavailable" };
  const input = serializePayload(payload);
  if (input === null) return { ok: false, reason: "non_json_safe_input" };
  let stdout: string;
  try {
    stdout = execFileSync(bin, ["eval-policy"], {
      input,
      encoding: "utf8",
      timeout: EVAL_TIMEOUT_MS,
      maxBuffer: EVAL_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    const reason = typeof status === "number"
      ? `exit_${status}`
      : `spawn_error:${error instanceof Error ? error.name : "unknown"}`;
    return { ok: false, reason };
  }
  try {
    const parsed = parseRustDecision(JSON.parse(stdout));
    return parsed === null ? { ok: false, reason: "bad_shape" } : { ok: true, decision: parsed };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

function fallback<T>(action: string, reason: string, node: T): T {
  warnOnce(`fallback:${action}:${reason}`, `[bot-governance] Rust helper fallback to Node (${action}): ${reason}`);
  return node;
}

function behaviorMatches(node: GovernanceDecision, rust: RustGovernanceDecision): boolean {
  const nodeApproval = "requiresOwnerApproval" in node ? node.requiresOwnerApproval : false;
  return node.allowed === rust.allowed && nodeApproval === rust.requires_approval;
}

function evaluateWithMode<T extends GovernanceDecision>(
  action: string,
  buildPayload: () => unknown | null,
  nodeEvaluate: () => T,
  mapRust: (decision: RustGovernanceDecision) => T,
): T {
  const mode = governanceMode();
  const node = nodeEvaluate();
  if (mode === "node" || node.reason.startsWith("invalid_")) return node;
  const payload = buildPayload();
  if (payload === null) return fallback(action, "unsupported_input", node);
  const rust = runRustPolicy(payload);
  if (!rust.ok) return fallback(action, rust.reason, node);
  if (mode === "rust") return mapRust(rust.decision);

  if (!behaviorMatches(node, rust.decision)) {
    const summary = `node=${JSON.stringify(node)} rust=${JSON.stringify(rust.decision)}`;
    warnOnce(`diff:${action}:${summary}`, `[bot-governance] parity diff (${action}): ${summary}`);
  }
  return node;
}

function derivedBotScope(kind: string): { callableBy: string; dataScope: string } {
  if (kind === "personal") return { callableBy: "self_only", dataScope: "self" };
  if (kind === "team") return { callableBy: "team", dataScope: "team" };
  return { callableBy: "company", dataScope: "company" };
}

function botOwnerForRust(ownerUserId: string | null | undefined, kind: string): string | null {
  if (typeof ownerUserId === "string" && ownerUserId.trim().length > 0) return ownerUserId;
  return kind === "personal" ? "" : null;
}

function botDescriptor(input: {
  botId: string;
  companyId: string;
  ownerUserId: string | null | undefined;
  teamId: string | null | undefined;
  kind: string;
  callableBy?: string;
  dataScope?: string;
  status: string;
}): Record<string, unknown> | null {
  const owner = botOwnerForRust(input.ownerUserId, input.kind);
  if (owner === null) return null;
  const derived = derivedBotScope(input.kind);
  return {
    bot_id: input.botId,
    company_id: input.companyId,
    owner_user_id: owner,
    team_id: input.teamId ?? null,
    kind: input.kind,
    callable_by: input.callableBy ?? derived.callableBy,
    data_scope: input.dataScope ?? derived.dataScope,
    status: input.status,
    requires_approval: false,
  };
}

function botDispatchPayload(input: BotDispatchInput): Record<string, unknown> | null {
  const bot = botDescriptor({
    botId: "bot-dispatch-eval",
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    teamId: input.teamId,
    kind: input.kind,
    callableBy: input.callableBy,
    status: input.status,
  });
  return bot === null ? null : {
    action: "bot_dispatch",
    actor: {
      company_id: input.callerCompanyId,
      user_id: input.callerUserId,
      team_id: input.callerTeamId,
      role: input.callerRole,
    },
    bot,
  };
}

function terminalPayload(input: TerminalCommandInput): Record<string, unknown> | null {
  const hasBotContext = input.botKind != null
    || input.botOwnerUserId != null
    || input.botTeamId != null
    || input.botCompanyId != null
    || input.botApproved === true
    || input.explicitOwnerContext === true;
  if (input.botKind == null && hasBotContext) return null;
  const botActor = input.botKind == null ? null : {
    bot_kind: input.botKind,
    bot_company_id: input.botCompanyId ?? "",
    bot_owner_user_id: input.botOwnerUserId ?? null,
    bot_team_id: input.botTeamId ?? null,
    bot_approved: input.botApproved === true,
    explicit_owner_context: input.explicitOwnerContext === true,
  };
  return {
    action: "terminal_command",
    actor: {
      company_id: input.callerCompanyId,
      user_id: input.callerUserId,
      team_id: input.callerTeamId,
      role: input.callerRole,
    },
    terminal_company_id: input.companyId,
    terminal_owner_user_id: input.ownerUserId ?? (input.kind === "personal_terminal" ? "" : "worker-node"),
    terminal_team_id: input.teamId,
    terminal_active: input.status === "active",
    command: input.action === "exec" ? "exec" : "",
    requires_approval: false,
    dangerous: false,
    terminal_kind: input.kind,
    terminal_action: input.action,
    bot_actor: botActor,
  };
}

function channelPayload(input: ChannelInvokeInput): Record<string, unknown> | null {
  const bot = botDescriptor({
    botId: input.botId,
    companyId: input.botCompanyId,
    ownerUserId: input.botOwnerUserId,
    teamId: input.botTeamId,
    kind: input.botKind,
    status: "active",
  });
  return bot === null ? null : {
    action: "channel_invoke",
    actor: {
      company_id: input.callerCompanyId,
      user_id: input.callerUserId,
      team_id: input.callerTeamId,
      role: input.callerRole,
    },
    bot,
    channel_company_id: input.channelCompanyId,
    channel_team_id: input.botTeamId ?? input.callerTeamId,
    requires_approval: false,
    channel_member_ids: input.channelMemberIds,
    execution_target: input.executionTarget,
    owner_approved: input.ownerApproved === true,
    requests_cross_team_secrets: input.requestsCrossTeamSecrets === true,
  };
}

function governanceFromRust(decision: RustGovernanceDecision): GovernanceDecision {
  return { allowed: decision.allowed, reason: decision.reason_code };
}

export function evaluateBotDispatchWithRust(input: BotDispatchInput): GovernanceDecision {
  return evaluateWithMode("bot_dispatch", () => botDispatchPayload(input), () => evaluateBotDispatch(input), governanceFromRust);
}

export function evaluateTerminalCommandWithRust(input: TerminalCommandInput): GovernanceDecision {
  return evaluateWithMode("terminal_command", () => terminalPayload(input), () => evaluateTerminalCommand(input), governanceFromRust);
}

export function evaluateChannelInvokeWithRust(input: ChannelInvokeInput): ChannelDecision {
  return evaluateWithMode(
    "channel_invoke",
    () => channelPayload(input),
    () => evaluateChannelInvoke(input),
    (decision) => ({
      allowed: decision.allowed,
      reason: decision.reason_code,
      requiresOwnerApproval: decision.requires_approval,
      crossTeamSecretsAllowed: false,
    }),
  );
}
