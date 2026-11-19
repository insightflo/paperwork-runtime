import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "@paperclipai/adapter-utils";

export const HANDOFF_BUDGET_CHARS = 32_000;
export const HANDOFF_RECENT_CHARS = 24_000;
export const HANDOFF_OLDER_CHARS = 4_000;
export const HANDOFF_STEPS_CHARS = 2_000;
export const HANDOFF_HEADER_CHARS = 2_000;
export const ROUTINE_HANDOFF_BUDGET_CHARS = 8_000;

export const HANDOFF_START_MARKER = "--- CONVERSATION HANDOFF START ---";
export const HANDOFF_END_MARKER = "--- CONVERSATION HANDOFF END ---";

export interface HandoffMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt?: string;
  text: string;
  capturedSteps?: string;
}

export interface ConversationHandoffInput {
  agentName: string;
  fromAdapter?: string;
  toAdapter?: string;
  reason?: string;
  routineMode?: boolean;
  branchNote?: string;
  messages: readonly HandoffMessage[];
}

export interface HandoffEnvelope {
  version: 1;
  sessionKey: string;
  sha256: string;
  createdAt: string;
  packet: string;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function excerptPreservingEnds(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const marker = "\n[... omitted ...]\n";
  if (limit <= marker.length + 2) {
    const end = splitsSurrogatePair(text, limit) ? limit - 1 : limit;
    return text.slice(0, end);
  }
  const available = limit - marker.length;
  const headRaw = Math.ceil(available / 2);
  const headEnd = splitsSurrogatePair(text, headRaw) ? headRaw - 1 : headRaw;
  const tailRaw = text.length - Math.floor(available / 2);
  const tailStart = splitsSurrogatePair(text, tailRaw) ? tailRaw + 1 : tailRaw;
  return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`;
}

function safeRenderMessage(msg: HandoffMessage): string {
  const clean = redactSensitiveText(msg.text, { keepUnscanned: true }).replaceAll(HANDOFF_END_MARKER, "[handoff-end-escaped]");
  return `[${msg.role}:${msg.id}]\n${clean}`;
}

export function renderConversationHandoff(input: ConversationHandoffInput): string | null {
  if (input.messages.length === 0) return null;
  const totalBudget = input.routineMode ? ROUTINE_HANDOFF_BUDGET_CHARS : HANDOFF_BUDGET_CHARS;
  const recentBudget = input.routineMode ? Math.min(4_000, totalBudget - 1_500) : HANDOFF_RECENT_CHARS;
  const olderBudget = input.routineMode ? 1_000 : HANDOFF_OLDER_CHARS;
  const stepsBudget = input.routineMode ? 1_000 : HANDOFF_STEPS_CHARS;

  const headerLines = [
    HANDOFF_START_MARKER,
    `Agent: ${input.agentName}${input.fromAdapter || input.toAdapter ? ` (${input.fromAdapter ?? "?"} -> ${input.toAdapter ?? "?"})` : ""}`,
    ...(input.reason ? [`Reason: ${input.reason}`] : []),
    ...(input.branchNote ? [input.branchNote] : []),
    "Follow current workspace instructions first; do not repeat completed steps.",
  ];
  const header = excerptPreservingEnds(headerLines.join("\n"), HANDOFF_HEADER_CHARS);

  const stepLines: string[] = [];
  let stepsSize = 0;
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const msg = input.messages[i];
    if (!msg.capturedSteps) continue;
    const cleanStep = redactSensitiveText(`[step:${msg.id}] ${msg.capturedSteps}`, { keepUnscanned: true });
    const chunk = excerptPreservingEnds(cleanStep, Math.min(1_000, stepsBudget - stepsSize));
    if (!chunk || stepsSize + chunk.length + 2 > stepsBudget) break;
    stepLines.unshift(chunk);
    stepsSize += chunk.length + 2;
  }

  const kept = new Map<string, string>();
  const older: string[] = [];
  let recentSize = 0;
  let olderSize = 0;

  const latestUser = [...input.messages].reverse().find((m) => m.role === "user");
  const latestAssistant = [...input.messages].reverse().find((m) => m.role === "assistant");
  for (const anchor of [latestUser, latestAssistant]) {
    if (!anchor || kept.has(anchor.id)) continue;
    const rendered = excerptPreservingEnds(safeRenderMessage(anchor), Math.min(8_000, recentBudget));
    if (recentSize + rendered.length + 2 <= recentBudget) {
      kept.set(anchor.id, rendered);
      recentSize += rendered.length + 2;
    }
  }

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const msg = input.messages[i];
    if (kept.has(msg.id)) continue;
    const rendered = safeRenderMessage(msg);
    if (recentSize + rendered.length + 2 <= recentBudget) {
      kept.set(msg.id, rendered);
      recentSize += rendered.length + 2;
    } else if (olderSize + 600 + 2 <= olderBudget) {
      const snippet = excerptPreservingEnds(rendered, 600);
      older.unshift(snippet);
      olderSize += snippet.length + 2;
    }
  }

  const recentSection = input.messages.flatMap((m) => (kept.has(m.id) ? [kept.get(m.id)!] : [])).join("\n\n");
  const sections = [
    header,
    "--- recent messages ---",
    recentSection,
    ...(older.length > 0 ? ["--- older excerpts ---", older.join("\n\n")] : []),
    "--- captured work steps ---",
    ...(stepLines.length > 0 ? [stepLines.join("\n\n")] : ["No captured work steps."]),
    HANDOFF_END_MARKER,
  ];
  const packet = sections.join("\n\n");
  return packet.length <= totalBudget ? packet : excerptPreservingEnds(packet, totalBudget);
}

export function handoffFilePath(directory: string, sessionKey: string): string {
  const safeHash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
  return path.join(directory, `handoff-${safeHash}.json`);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function writeHandoffPacketBeforeBind<T>(params: {
  directory: string;
  sessionKey: string;
  input: ConversationHandoffInput;
  bindSession: (artifact: { filePath: string; sha256: string; charLength: number } | null) => Promise<T>;
}): Promise<{ result: T; filePath: string | null; sha256: string | null }> {
  const packet = renderConversationHandoff(params.input);
  if (packet === null) {
    const result = await params.bindSession(null);
    return { result, filePath: null, sha256: null };
  }
  await mkdir(params.directory, { recursive: true, mode: 0o700 });
  const targetPath = handoffFilePath(params.directory, params.sessionKey);
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  const digest = sha256Hex(packet);
  const envelope: HandoffEnvelope = {
    version: 1,
    sessionKey: params.sessionKey,
    sha256: digest,
    createdAt: new Date().toISOString(),
    packet,
  };
  await writeFile(tempPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, targetPath);
  const result = await params.bindSession({ filePath: targetPath, sha256: digest, charLength: packet.length });
  return { result, filePath: targetPath, sha256: digest };
}

export type HandoffReadResult =
  | { ok: true; packet: string; sha256: string; createdAt: string }
  | { ok: false; reason: "missing" | "corrupt" };

export async function readAndVerifyHandoffPacket(params: {
  directory: string;
  sessionKey: string;
}): Promise<HandoffReadResult> {
  const targetPath = handoffFilePath(params.directory, params.sessionKey);
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "corrupt" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HandoffEnvelope>;
    if (
      parsed.version !== 1 ||
      parsed.sessionKey !== params.sessionKey ||
      typeof parsed.packet !== "string" ||
      typeof parsed.sha256 !== "string"
    ) {
      return { ok: false, reason: "corrupt" };
    }
    if (sha256Hex(parsed.packet) !== parsed.sha256) return { ok: false, reason: "corrupt" };
    return { ok: true, packet: parsed.packet, sha256: parsed.sha256, createdAt: String(parsed.createdAt ?? "") };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

export async function acknowledgeHandoffDelivered(params: {
  directory: string;
  sessionKey: string;
}): Promise<void> {
  await rm(handoffFilePath(params.directory, params.sessionKey), { force: true });
}
