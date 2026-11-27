import type { heartbeatRuns } from "@paperclipai/db";
import { asNumber, parseObject } from "../adapters/utils.js";
import { readNonEmptyString, resolveAdapterFallbackAttempt } from "./heartbeat-run-context.js";
import { heartbeatRunFailureText } from "./heartbeat-failure-classification.js";
import { stringifyRunResultJson } from "./heartbeat-run-result-text.js";

const DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS = 1;
const MAX_ADAPTER_FALLBACK_ORDER = 8;
// order 체인 폴백에만 기본으로 걸리는 트리거(명시 triggers 가 없을 때). legacy 단일 command 폴백은 기존처럼 process_lost 만 본다.
const DEFAULT_ORDER_FALLBACK_TRIGGERS = ["process_lost", "provider_quota_exhausted", "provider_overloaded", "rate_limit", "adapter_failed"];

export type AdapterFallbackEntry = {
  adapterType?: string;
  command?: string;
  provider?: string;
  model?: string;
  thinking?: string;
};

export type AdapterFallbackConfig = {
  /** [하위 호환] 레거시 단일 폴백 command. resolveAdapterFallbackConfig 가 채우며 레거시 경로가 없으면 "" (빈 문자열 = 없음 취급). */
  command?: string;
  provider?: string;
  model?: string;
  /** [thinking ladder] 폴백 실행에 적용할 추론 수준(단일 값). command/provider/model은 바꾸지 않는다. */
  thinking?: string;
  /** [thinking ladder] 시도 횟수별 추론 수준 사다리(명시 config만 — 자동 승격 금지). */
  thinkingLadder: string[];
  triggers: Set<string>;
  maxAttempts: number;
  /** 순차 폴백 체인(최대 MAX_ADAPTER_FALLBACK_ORDER). 각 항목은 model/provider/adapterType/command 중 하나 이상. */
  order: AdapterFallbackEntry[];
  /** false 면 자동 폴백 전환을 하지 않는다(기본 true). */
  automatic: boolean;
  /** 리셋 후 기본(1차) 설정으로 복귀(기본 true). */
  returnToPrimaryOnReset: boolean;
};

/**
 * resolveAdapterFallbackConfig 반환 타입. 기존 호출부(heartbeat.ts, heartbeat-orphan-reaper.ts)가
 * command 를 string 으로 기대하므로(로그: enqueueAdapterFallbackRun fallbackCommand: string 필수) 해석 결과에 항상 존재를 보장한다.
 */
export type ResolvedAdapterFallbackConfig = AdapterFallbackConfig & { command: string };

/**
 * [thinking ladder] 폴백 시도(1-based)에 적용할 thinking 값.
 *   - 사다리가 없으면 단일 thinking 값을 매 시도에 적용.
 *   - 사다리가 있으면 ladder[min(attempt-1, len-1)] — 시도가 사다리보다 길면 마지막 값 유지.
 * 어댑터별 정식 순서표가 없어(pi 문서 off~xhigh vs UI minimal~max 불일치) 값 자동 추론/승격은 금지이며,
 * 반드시 agent config(fallback.thinking / fallback.thinkingLadder)에 명시된 값만 사용한다.
 */
export function resolveAdapterFallbackThinking(
  config: Pick<AdapterFallbackConfig, "thinking" | "thinkingLadder">,
  attempt: number,
): string | undefined {
  if (config.thinkingLadder.length === 0) return config.thinking;
  const index = Math.min(Math.max(attempt - 1, 0), config.thinkingLadder.length - 1);
  return config.thinkingLadder[index];
}

function parseAdapterFallbackOrder(raw: unknown): AdapterFallbackEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: AdapterFallbackEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (entries.length >= MAX_ADAPTER_FALLBACK_ORDER) break;
    const entry = parseObject(item);
    const adapterType = readNonEmptyString(entry.adapterType) ?? undefined;
    const command = readNonEmptyString(entry.command) ?? undefined;
    const provider = readNonEmptyString(entry.provider) ?? undefined;
    const model = readNonEmptyString(entry.model) ?? undefined;
    const thinking = readNonEmptyString(entry.thinking) ?? undefined;
    // 유효 항목은 model/provider/adapterType/command 중 하나 이상. thinking 만 있는 항목은 폐기한다.
    if (!adapterType && !command && !provider && !model) continue;
    const identity = JSON.stringify([adapterType ?? null, command ?? null, provider ?? null, model ?? null]);
    // 동일 경로(adapterType+command+provider+model) 중복 항목은 첫 번째만 유지한다.
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push({
      ...(adapterType ? { adapterType } : {}),
      ...(command ? { command } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    });
  }
  return entries;
}

export function resolveAdapterFallbackConfig(adapterConfigRaw: unknown): ResolvedAdapterFallbackConfig | null {
  const adapterConfig = parseObject(adapterConfigRaw);
  const fallback = parseObject(adapterConfig.fallback);
  const order = parseAdapterFallbackOrder(fallback.order);
  const legacyCommand = readNonEmptyString(adapterConfig.fallbackCommand) ?? readNonEmptyString(fallback.command);
  const provider = readNonEmptyString(fallback.provider) ?? undefined;
  const model = readNonEmptyString(fallback.model) ?? undefined;
  // 폴백 경로가 하나라도 있으면 설정을 반환한다: 레거시 command, order 체인, 동일 어댑터 provider/model 폴백.
  if (!legacyCommand && order.length === 0 && !provider && !model) return null;
  const thinking = readNonEmptyString(fallback.thinking) ?? undefined;
  const rawThinkingLadder = Array.isArray(fallback.thinkingLadder) ? fallback.thinkingLadder : [];
  const thinkingLadder = rawThinkingLadder
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value));

  const rawTriggers = Array.isArray(fallback.triggers) ? fallback.triggers : [];
  const triggers = rawTriggers
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value));
  const explicitMaxAttempts = fallback.maxAttempts ?? adapterConfig.fallbackMaxAttempts;
  // 명시 maxAttempts 가 없으면 order 체인 길이를 기본 시도 수로, 없으면 기존 기본값 1 을 유지한다.
  const maxAttempts =
    explicitMaxAttempts === undefined
      ? Math.max(1, order.length)
      : Math.max(1, Math.floor(asNumber(explicitMaxAttempts, DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS)));

  return {
    // [하위 호환] 기존 호출부는 command 를 string 으로 기대한다. 레거시 경로가 없으면 order[0].command,
    // 그것도 없으면 "" (빈 문자열은 모든 소비자에서 "없음"으로 취급된다).
    command: legacyCommand ?? (order.length > 0 ? order[0].command : undefined) ?? "",
    provider,
    model,
    thinking,
    thinkingLadder,
    triggers: triggers.length > 0 ? new Set(triggers) : new Set(order.length > 0 ? DEFAULT_ORDER_FALLBACK_TRIGGERS : ["process_lost"]),
    maxAttempts,
    order,
    automatic: fallback.automatic !== false,
    returnToPrimaryOnReset: fallback.returnToPrimaryOnReset !== false,
  };
}

/** 유효한 adapter_fallback 재시도 런인지(retryOfRunId + wakeReason + fallbackOfRunId 일치) 판정한다. */
function isValidAdapterFallbackRetryRun(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
}) {
  return (
    Boolean(input.run.retryOfRunId) &&
    readNonEmptyString(input.context.wakeReason) === "adapter_fallback" &&
    readNonEmptyString(input.context.fallbackOfRunId) === input.run.retryOfRunId
  );
}

function shouldApplyAdapterFallbackConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
}) {
  return (
    isValidAdapterFallbackRetryRun(input) &&
    Boolean(
      readNonEmptyString(input.context.fallbackCommand) ??
        readNonEmptyString(input.context.fallbackProvider) ??
        readNonEmptyString(input.context.fallbackModel) ??
        readNonEmptyString(input.context.fallbackThinking) ??
        readNonEmptyString(input.context.fallbackAdapterType),
    )
  );
}

export function applyAdapterFallbackRuntimeConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
  config: Record<string, unknown>;
}) {
  if (!shouldApplyAdapterFallbackConfig(input)) return input.config;
  const command = readNonEmptyString(input.context.fallbackCommand);
  const provider = readNonEmptyString(input.context.fallbackProvider);
  const model = readNonEmptyString(input.context.fallbackModel);
  // [thinking ladder] thinking만 덮어쓴다. command 는 폴백 컨텍스트에 있을 때만 덮어써서,
  //   command 없는 동일 어댑터 provider/model 폴백도 기본 command 를 유지하게 한다.
  const thinking = readNonEmptyString(input.context.fallbackThinking);
  const adapterType = readNonEmptyString(input.context.fallbackAdapterType);
  return {
    ...input.config,
    ...(command ? { command } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(adapterType ? { adapterType } : {}),
  };
}

/** 폴백 런이 실행될 어댑터 타입. 유효한 adapter_fallback 재시도 런이면 컨텍스트의 fallbackAdapterType, 아니면 기본값. */
export function resolveAdapterFallbackAdapterType(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
  defaultAdapterType: string;
}): string {
  if (!isValidAdapterFallbackRetryRun(input)) return input.defaultAdapterType;
  return readNonEmptyString(input.context.fallbackAdapterType) ?? input.defaultAdapterType;
}

/**
 * 순차 폴백 체인에서 다음 후보를 고른다. currentAttempt 는 지금까지 수행한 폴백 시도 수(0-based)다.
 * order 체인이 있으면 currentAttempt 색인부터 차단되지 않은 첫 후보를, 없으면 레거시 단일 폴백을 반환한다.
 * resolvedCommand 의 빈 문자열/undefined 는 "없음"으로 취급해 defaultCommand 로 내려간다.
 */
export function selectNextAdapterFallbackEntry(input: {
  fallback: AdapterFallbackConfig;
  currentAttempt: number;
  defaultAdapterType: string;
  defaultCommand?: string;
  isCandidateBlocked?: (candidate: { adapterType: string; provider?: string; model?: string }) => boolean;
}): { entry: AdapterFallbackEntry; candidateIndex: number; resolvedCommand?: string; resolvedAdapterType: string } | null {
  if (!input.fallback.automatic) return null;
  if (input.fallback.order.length > 0) {
    const startIndex = Math.max(0, Math.floor(input.currentAttempt));
    for (let index = startIndex; index < input.fallback.order.length; index++) {
      const entry = input.fallback.order[index];
      const resolvedAdapterType = entry.adapterType ?? input.defaultAdapterType;
      if (input.isCandidateBlocked?.({ adapterType: resolvedAdapterType, provider: entry.provider, model: entry.model })) continue;
      const resolvedCommand = entry.command ?? (input.fallback.command || input.defaultCommand);
      return { entry, candidateIndex: index, ...(resolvedCommand ? { resolvedCommand } : {}), resolvedAdapterType };
    }
    return null;
  }
  if (Math.floor(input.currentAttempt) >= input.fallback.maxAttempts) return null;
  const candidate = { adapterType: input.defaultAdapterType, provider: input.fallback.provider, model: input.fallback.model };
  if (input.isCandidateBlocked?.(candidate)) return null;
  const entry: AdapterFallbackEntry = {
    ...(input.fallback.command ? { command: input.fallback.command } : {}),
    ...(input.fallback.provider ? { provider: input.fallback.provider } : {}),
    ...(input.fallback.model ? { model: input.fallback.model } : {}),
  };
  const resolvedCommand = input.fallback.command || input.defaultCommand;
  return { entry, candidateIndex: 0, ...(resolvedCommand ? { resolvedCommand } : {}), resolvedAdapterType: input.defaultAdapterType };
}

export function isTerminalAdapterFallbackConfigurationFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [
    heartbeatRunFailureText({
      errorCode: run.errorCode,
      errorMessage: run.error,
      stdoutExcerpt: run.stdoutExcerpt,
      stderrExcerpt: run.stderrExcerpt,
    }),
    stringifyRunResultJson(run.resultJson),
    stringifyRunResultJson(run.usageJson),
  ].join("\n").toLowerCase();

  return (
    /api error:\s*400\b[\s\S]*param incorrect/.test(text) ||
    /\bparam incorrect\b/.test(text) ||
    /\bnot supported model\b/.test(text) ||
    /\bunsupported model\b/.test(text) ||
    /\binvalid model\b/.test(text) ||
    /\bunknown model\b/.test(text) ||
    /\bmodel\b[\s\S]{0,80}\bnot (?:found|supported)\b/.test(text)
  );
}

export function shouldQueueRunFailureAdapterFallback(input: {
  run: typeof heartbeatRuns.$inferSelect;
  fallback: Pick<AdapterFallbackConfig, "command" | "provider" | "model" | "maxAttempts">;
}) {
  const context = parseObject(input.run.contextSnapshot);
  const fallbackAttempt = resolveAdapterFallbackAttempt(context);
  if (fallbackAttempt >= input.fallback.maxAttempts) return false;

  const activeFallbackCommand = readNonEmptyString(context.fallbackCommand);
  const activeFallbackProvider = readNonEmptyString(context.fallbackProvider);
  const activeFallbackModel = readNonEmptyString(context.fallbackModel);
  const fallbackProvider = input.fallback.provider ?? null;
  const fallbackModel = input.fallback.model ?? null;
  // command 가 없는(또는 "" 인) 폴백도 같은 경로로 비교하기 위해 양쪽을 정규화한다.
  const isSameFallbackCommand = activeFallbackCommand === readNonEmptyString(input.fallback.command);
  const isSameFallbackRoute =
    isSameFallbackCommand &&
    activeFallbackProvider === fallbackProvider &&
    activeFallbackModel === fallbackModel;
  const isFallbackRun = readNonEmptyString(context.wakeReason) === "adapter_fallback";
  if (isFallbackRun && isSameFallbackRoute && isTerminalAdapterFallbackConfigurationFailure(input.run)) {
    return false;
  }

  return true;
}
