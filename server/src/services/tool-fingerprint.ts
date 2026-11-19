import { createHash } from "node:crypto";

export interface McpServerFingerprintEntry {
  name: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  disabledTools?: readonly string[];
}

export interface AgentToolFingerprintInput {
  adapterType: string;
  model?: string | null;
  thinkingEffort?: string | null;
  cwd?: string | null;
  instructionsFileName?: string | null;
  instructionsText?: string | null;
  mcpServers?: readonly McpServerFingerprintEntry[];
  allowedTools?: readonly string[];
  disabledTools?: readonly string[];
  envKeys?: Readonly<Record<string, string | undefined>>;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

function canonicalizeMcpServers(servers: readonly McpServerFingerprintEntry[] | undefined) {
  if (!servers || servers.length === 0) return [];
  return [...servers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      command: entry.command ?? null,
      args: entry.args ? [...entry.args] : [],
      url: entry.url ?? null,
      disabledTools: normalizeStringList(entry.disabledTools),
    }));
}

function hashInstructionsText(text: string | null | undefined): string | null {
  if (!text) return null;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashEnvShape(env: Readonly<Record<string, string | undefined>> | undefined): Array<[string, string]> {
  if (!env) return [];
  return Object.keys(env)
    .sort()
    .map((key) => {
      const value = env[key] ?? "";
      const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
      return [key, digest];
    });
}

export function computeAgentToolFingerprint(input: AgentToolFingerprintInput): string {
  const payload = {
    version: 1,
    adapterType: input.adapterType,
    model: input.model ?? null,
    thinkingEffort: input.thinkingEffort ?? null,
    cwd: input.cwd ?? null,
    instructionsFileName: input.instructionsFileName ?? "AGENTS.md",
    instructionsSha256: hashInstructionsText(input.instructionsText),
    mcpServers: canonicalizeMcpServers(input.mcpServers),
    allowedTools: normalizeStringList(input.allowedTools),
    disabledTools: normalizeStringList(input.disabledTools),
    envShape: hashEnvShape(input.envKeys),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function hasToolSurfaceChanged(
  previousFingerprint: string | null | undefined,
  currentInput: AgentToolFingerprintInput,
): { changed: boolean; currentFingerprint: string } {
  const currentFingerprint = computeAgentToolFingerprint(currentInput);
  if (!previousFingerprint) return { changed: false, currentFingerprint };
  return { changed: previousFingerprint !== currentFingerprint, currentFingerprint };
}
