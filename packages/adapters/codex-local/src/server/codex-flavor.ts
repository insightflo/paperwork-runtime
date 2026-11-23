import type {
  AdapterSessionCodec,
  AcpFlavor,
  AcpFlavorBuildArgsInput,
} from "@paperclipai/adapter-utils";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

export function buildCodexArgs(input: AcpFlavorBuildArgsInput): string[] {
  const search = asBoolean(input.config.search, false);
  const bypass = asBoolean(
    input.config.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(input.config.dangerouslyBypassSandbox, false),
  );
  const args = ["exec", "--json"];
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (!input.extraArgs.includes("--skip-git-repo-check")) args.push("--skip-git-repo-check");
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  if (input.extraArgs.length > 0) args.push(...input.extraArgs);
  if (input.resumeSessionId) args.push("resume", input.resumeSessionId, "-");
  else args.push("-");
  return args;
}

export const codexFlavor: AcpFlavor & { sessionCodec: AdapterSessionCodec } = {
  key: "codex_local",
  defaultCommand: "codex",
  protocolTransport: "agent_text",
  supportsSessionResume: true,
  reservedArgs: [
    "--json",
    "--search",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--model",
    "-c",
  ],
  sessionCodec,
  buildArgs: buildCodexArgs,
};
