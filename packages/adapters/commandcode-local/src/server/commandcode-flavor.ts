import type {
  AdapterSessionCodec,
  AcpFlavor,
  AcpFlavorBuildArgsInput,
} from "@paperclipai/adapter-utils";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { buildCommandCodePermissionArgs } from "./env.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir) ?? readNonEmptyString(record.folder);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ?? readNonEmptyString(params.workdir) ?? readNonEmptyString(params.folder);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

/**
 * Reserved Command Code flags matching the sanitizer sets in env.js (which
 * stay module-private there): enforced output, automation/permissions,
 * model/effort, max-turns, resume, and the prompt itself.
 */
const COMMANDCODE_RESERVED_ARGS: readonly string[] = [
  "--output-format", "--model", "-m", "--effort", "--max-turns",
  "--resume", "-r", "--session", "--permission-mode", "--config",
  "-p", "--print", "--", "--trust", "-t", "--skip-onboarding",
  "--no-auto-update", "--continue", "-c", "--no-session", "--yolo",
  "--auto-accept", "--dangerously-skip-permissions", "--plan", "--fork-session",
];

export function buildCommandCodeArgs(input: AcpFlavorBuildArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  args.push(
    "--skip-onboarding",
    ...buildCommandCodePermissionArgs(asBoolean(input.config.dangerouslySkipPermissions, false)),
    "--trust",
    "--output-format",
    "json",
    "--no-auto-update",
  );
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.maxTurns > 0) args.push("--max-turns", String(Math.floor(input.maxTurns)));
  if (input.extraArgs.length > 0) args.push(...input.extraArgs);
  args.push("-p", input.prompt);
  return args;
}

export const commandcodeFlavor: AcpFlavor & { sessionCodec: AdapterSessionCodec } = {
  key: "commandcode_local",
  protocolTransport: "agent_text",
  defaultCommand: "cmd",
  supportsSessionResume: true,
  reservedArgs: COMMANDCODE_RESERVED_ARGS,
  sessionCodec,
  buildArgs: buildCommandCodeArgs,
};
