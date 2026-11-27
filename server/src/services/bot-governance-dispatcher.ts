import {
  evaluateBotDispatch,
  evaluateCapabilityDataScope,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotDispatchInput,
  type CapabilityDataScopeInput,
  type ChannelDecision,
  type ChannelInvokeInput,
  type GovernanceDecision,
  type TerminalCommandInput,
} from "./bot-governance.js";
import {
  evaluateBotDispatchWithRust,
  evaluateChannelInvokeWithRust,
  evaluateTerminalCommandWithRust,
} from "./bot-governance-rust-client.js";

// BOT_GOVERNANCE_ENGINE 으로 bot governance 평가 엔진을 고른다. 기본값 "node" 는 기존
// bot-governance.ts 만 호출한다. "shadow" 는 Node 결과를 유지한 채 Rust 결과 차이만 기록하고,
// "rust" 는 Rust 브리지 결과를 쓰며 실패·타임아웃·계약 오류는 Node 평가로 되돌아간다(allow 로 해석 안 함).

export type BotGovernanceEngine = "node" | "shadow" | "rust";
export const BOT_GOVERNANCE_ENGINE_ENV = "BOT_GOVERNANCE_ENGINE";
// bot-governance-rust-client.ts 가 호출 시점에 읽는 모드 변수. 클라이언트는 모드 인자를 받지
// 않으므로 동기 호출 동안만 잠시 덮어쓰고 원복한다.
const RUST_CLIENT_MODE_ENV = "PAPERWORK_BOT_GOVERNANCE_MODE";

type BotAction = "bot_dispatch" | "terminal_command" | "channel_invoke";

const engines: readonly BotGovernanceEngine[] = ["node", "shadow", "rust"];
const warnedInvalidEngines = new Set<string>();

export function resolveBotGovernanceEngine(value: string | undefined = process.env[BOT_GOVERNANCE_ENGINE_ENV]): BotGovernanceEngine {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") return "node";
  if ((engines as readonly string[]).includes(normalized)) return normalized as BotGovernanceEngine;
  if (!warnedInvalidEngines.has(normalized)) {
    warnedInvalidEngines.add(normalized);
    console.warn(`[bot-governance] unknown ${BOT_GOVERNANCE_ENGINE_ENV}=${JSON.stringify(normalized)}; using "node"`);
  }
  return "node";
}

export function resetBotGovernanceDispatcherForTests(): void { warnedInvalidEngines.clear(); }

function withRustClientMode<T>(mode: "shadow" | "rust", run: () => T): T {
  const previous = process.env[RUST_CLIENT_MODE_ENV];
  process.env[RUST_CLIENT_MODE_ENV] = mode;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[RUST_CLIENT_MODE_ENV];
    else process.env[RUST_CLIENT_MODE_ENV] = previous;
  }
}

function evaluate<T>(
  action: BotAction,
  engine: BotGovernanceEngine,
  nodeEvaluate: () => T,
  rustEvaluate: () => T,
): T {
  if (engine === "node") return nodeEvaluate();
  try {
    return withRustClientMode(engine, rustEvaluate);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const detail = error instanceof Error ? `${error.name}${typeof code === "string" ? `:${code}` : ""}` : "unknown";
    console.warn(`[bot-governance] engine=${engine} threw for ${action} (${detail}); using Node decision`);
    return nodeEvaluate();
  }
}

export function evaluateBotDispatchGovernance(input: BotDispatchInput): GovernanceDecision {
  const engine = resolveBotGovernanceEngine();
  return evaluate("bot_dispatch", engine, () => evaluateBotDispatch(input), () => evaluateBotDispatchWithRust(input));
}

export function evaluateTerminalCommandGovernance(input: TerminalCommandInput): GovernanceDecision {
  const engine = resolveBotGovernanceEngine();
  return evaluate("terminal_command", engine, () => evaluateTerminalCommand(input), () => evaluateTerminalCommandWithRust(input));
}

export function evaluateChannelInvokeGovernance(input: ChannelInvokeInput): ChannelDecision {
  const engine = resolveBotGovernanceEngine();
  return evaluate("channel_invoke", engine, () => evaluateChannelInvoke(input), () => evaluateChannelInvokeWithRust(input));
}

// Rust 브리지가 capability_data_scope 계약을 제공하지 않으므로 엔진과 무관하게 Node 평가만 사용한다.
export function evaluateCapabilityDataScopeGovernance(input: CapabilityDataScopeInput) {
  return evaluateCapabilityDataScope(input);
}
