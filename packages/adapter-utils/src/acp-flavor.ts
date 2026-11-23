import type { AdapterSessionCodec, UsageSummary } from "./types.js";

/**
 * Versioned driver-event protocol for managed provider drivers. Provenance is
 * transport-derived, never content-derived: `origin` comes from which OS pipe
 * the bytes arrived on and the declared `ProtocolTransport`. Only top-level
 * frames parsed on `provider_protocol` are trusted; string fields inside
 * frames (e.g. `kind: "output"` text) are display data, never re-parsed.
 */
export const DRIVER_EVENT_PROTOCOL_VERSION = 1;

export type DriverStreamOrigin = "stderr" | "provider_protocol" | "agent_output";
export type ProtocolTransport = "stdout_protocol" | "agent_text";

export interface ProviderDescriptor {
  key: string;
  protocolTransport: ProtocolTransport;
  defaultCommand?: string;
  supportsSessionResume?: boolean;
}

interface DriverEventBase {
  protocolVersion: typeof DRIVER_EVENT_PROTOCOL_VERSION;
  origin: DriverStreamOrigin;
}

export interface DriverOutputEvent extends DriverEventBase {
  kind: "output";
  text: string;
}
export interface DriverSessionEvent extends DriverEventBase {
  kind: "session";
  sessionId: string;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  cwd?: string | null;
}
export interface DriverUsageEvent extends DriverEventBase {
  kind: "usage";
  usage: UsageSummary;
}
export interface DriverErrorEvent extends DriverEventBase {
  kind: "error";
  code: string;
  message?: string | null;
}

export type ParsedDriverEvent =
  | DriverOutputEvent
  | DriverSessionEvent
  | DriverUsageEvent
  | DriverErrorEvent;
export type DriverEventFrame =
  | Omit<DriverOutputEvent, "origin">
  | Omit<DriverSessionEvent, "origin">
  | Omit<DriverUsageEvent, "origin">
  | Omit<DriverErrorEvent, "origin">;

const FRAME_KINDS = new Set(["output", "session", "usage", "error"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseUsage(value: unknown): UsageSummary | null {
  const record = asRecord(value);
  const input = record?.inputTokens;
  const output = record?.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const cached = record?.cachedInputTokens;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
  };
}

/** Parse one raw stdout line as a top-level v1 frame; null = opaque output. */
export function parseDriverFrame(line: string): DriverEventFrame | null {
  let record: Record<string, unknown> | null = null;
  try {
    record = asRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (!record || record.protocolVersion !== DRIVER_EVENT_PROTOCOL_VERSION) return null;
  const kind = record.kind;
  if (typeof kind !== "string" || !FRAME_KINDS.has(kind)) return null;
  const base = { protocolVersion: DRIVER_EVENT_PROTOCOL_VERSION } as const;

  if (kind === "output" && typeof record.text === "string") {
    return { ...base, kind, text: record.text };
  }
  if (kind === "session" && typeof record.sessionId === "string" && record.sessionId) {
    return {
      ...base,
      kind,
      sessionId: record.sessionId,
      sessionParams: asRecord(record.sessionParams),
      sessionDisplayId:
        typeof record.sessionDisplayId === "string" ? record.sessionDisplayId : null,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
    };
  }
  if (kind === "usage") {
    const usage = parseUsage(record.usage);
    if (usage) return { ...base, kind, usage };
  }
  if (kind === "error" && typeof record.code === "string" && record.code) {
    return {
      ...base,
      kind,
      code: record.code,
      message: typeof record.message === "string" ? record.message : null,
    };
  }
  return null;
}

/**
 * Trusted only on the provider_protocol transport at the current protocol
 * version; `stderr`/`agent_output` events — including agent-authored JSON —
 * are never trusted.
 */
export function isTrustedProtocolEvent(
  event: ParsedDriverEvent,
): event is DriverSessionEvent | DriverUsageEvent | DriverErrorEvent {
  return (
    event.origin === "provider_protocol" &&
    event.protocolVersion === DRIVER_EVENT_PROTOCOL_VERSION
  );
}

/** Default session codec persisting `{ sessionId, cwd }` for resume checks. */
export function createDefaultSessionCodec(): AdapterSessionCodec {
  const pick = (raw: unknown) => {
    const record = asRecord(raw);
    const sessionId = record?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const cwd = record?.cwd;
    return {
      sessionId,
      ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
    };
  };
  return {
    deserialize: pick,
    serialize: pick,
    getDisplayId: (params) => {
      const id = params?.sessionId;
      return typeof id === "string" && id.length > 0 ? id : null;
    },
  };
}

export interface AcpFlavorBuildArgsInput {
  command: string;
  prompt: string;
  resumeSessionId: string | null;
  model: string;
  effort: string;
  maxTurns: number;
  extraArgs: string[];
  config: Record<string, unknown>;
}

/** Per-provider flavor: transport, reserved flags, argv builder, codec. */
export interface AcpFlavor extends ProviderDescriptor {
  sessionCodec?: AdapterSessionCodec;
  /** Flags the driver controls; matching user-supplied args are stripped. */
  reservedArgs?: readonly string[];
  buildArgs(input: AcpFlavorBuildArgsInput): string[];
}

export function driverArgsList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.split(/\s+/) : [];
  }
  return asStringArray(value);
}

/** Strip driver-reserved flags; a bare flag also eats the next non-flag token. */
export function stripReservedDriverArgs(
  args: string[],
  reserved: readonly string[],
): string[] {
  if (reserved.length === 0) return [...args];
  const flags = new Set(reserved);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    if (!flags.has(eq > 0 ? arg.slice(0, eq) : arg)) {
      out.push(arg);
      continue;
    }
    if (eq < 0 && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i += 1;
  }
  return out;
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
}

export function resolveDriverCwd(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  const candidates = [
    asString(config.cwd, ""),
    asString(context.cwd, ""),
    asString(context.workspaceDir, ""),
    asString(parseObject(context.workspace).cwd as string, ""),
    asString(parseObject(context.executionWorkspace).cwd as string, ""),
  ];
  const found = candidates.find((value) => value.length > 0);
  if (!found) return process.cwd();
  return isAbsolutePath(found) ? found : `${process.cwd()}/${found}`;
}
