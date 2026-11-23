import type {
  AcpFlavor,
  AcpFlavorBuildArgsInput,
  AdapterSessionCodec,
} from "@paperclipai/adapter-utils";

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
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
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

export interface PiFlavorBuildArgsInput extends AcpFlavorBuildArgsInput {
  provider: string | null;
  modelId: string | null;
  thinking: string;
  systemPromptExtension: string;
  skillsDir: string;
  sessionFile: string;
}

export function buildPiArgs(input: PiFlavorBuildArgsInput): string[] {
  const args: string[] = [];

  // Use RPC mode for proper lifecycle management (waits for agent completion)
  args.push("--mode", "rpc");

  // Use --append-system-prompt to extend Pi's default system prompt
  args.push("--append-system-prompt", input.systemPromptExtension);

  if (input.provider) args.push("--provider", input.provider);
  if (input.modelId) args.push("--model", input.modelId);
  if (input.thinking) args.push("--thinking", input.thinking);

  args.push("--tools", "read,bash,edit,write,grep,find,ls");
  args.push("--session", input.sessionFile);

  // Add Paperclip skills directory so Pi can load the paperclip skill
  args.push("--skill", input.skillsDir);

  if (input.extraArgs.length > 0) args.push(...input.extraArgs);

  return args;
}

export type PiFlavor = AcpFlavor & {
  sessionCodec: AdapterSessionCodec;
  buildArgs(input: PiFlavorBuildArgsInput): string[];
};

export const piFlavor: PiFlavor = {
  key: "pi_local",
  protocolTransport: "agent_text",
  defaultCommand: "pi",
  supportsSessionResume: true,
  reservedArgs: [
    "--mode",
    "--append-system-prompt",
    "--provider",
    "--model",
    "--thinking",
    "--tools",
    "--session",
    "--skill",
  ],
  sessionCodec,
  buildArgs: buildPiArgs,
};
