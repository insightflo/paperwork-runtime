// Pure, fail-closed bridge for agent local-tool invocations: validates calls
// into safe endpoint task payloads for the Rust paperwork-bot. No I/O here.

export type LocalToolKind = "local_read_file" | "local_write_file" | "local_list_dir" | "local_shell_exec";

export type LocalToolCall =
  | { kind: "local_read_file"; path: string }
  | { kind: "local_write_file"; path: string; content: string }
  // cwd is required so the matched folder (and its ro/rw mode) is always well-defined.
  | { kind: "local_shell_exec"; command: string; cwd: string }
  | { kind: "local_list_dir"; path: string };

export type AllowedFolderGrant = { path: string; mode: "ro" | "rw" };

export type ValidatedEndpointTask = {
  kind: LocalToolKind;
  folderPath: string;
  folderMode: "ro" | "rw";
  path: string | null; relativePath: string | null;
  command: string | null; cwd: string | null;
  contentBytes: number | null;
  maxWriteBytes: number; maxOutputBytes: number;
};

export type EndpointTaskErrorCode =
  | "INVALID_INPUT" | "INVALID_PATH" | "NO_ALLOWED_FOLDER" | "WRITE_REQUIRES_RW"
  | "SHELL_REQUIRES_RW" | "WRITE_TOO_LARGE" | "DESTRUCTIVE_COMMAND";

export type EndpointTaskValidation =
  | { ok: true; task: ValidatedEndpointTask }
  | { ok: false; code: EndpointTaskErrorCode; message: string };

export type FormattedEndpointTaskResult = { taskId: string; ok: boolean; output?: string; error?: string };

const DEFAULT_MAX_WRITE_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHARS = 4_000;

const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Conservative denylist for clearly destructive shell commands (lowercased,
// whitespace-collapsed copy of the command).
const DESTRUCTIVE_SHELL_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fork bomb", re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { label: "download piped into a shell", re: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi|k)?sh\b/ },
  { label: "filesystem formatter", re: /\bmkfs(?:\.[a-z0-9]+)?\b/ },
  { label: "raw device write via dd", re: /\bdd\b[^;&|]*\bif\s*=/ },
  { label: "power state change", re: /\b(?:shutdown|reboot|halt|poweroff)\b/ },
  { label: "system halt via init", re: /\binit\s+[06]\b/ },
];

function reject(code: EndpointTaskErrorCode, message: string): EndpointTaskValidation {
  return { ok: false, code, message };
}
type NormalizedPath = { ok: true; path: string } | { ok: false; message: string };

// Rejects null bytes, relative paths, and literal ".." segments — never resolve "..".
function normalizePosixPath(raw: unknown): NormalizedPath {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, message: "path must be a non-empty absolute string" };
  if (raw.includes("\0")) return { ok: false, message: "path contains a null byte" };
  if (!raw.startsWith("/")) return { ok: false, message: "path must be absolute" };
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, message: "path contains a '..' traversal segment" };
    segments.push(segment);
  }
  return { ok: true, path: segments.length === 0 ? "/" : `/${segments.join("/")}` };
}

// Longest-prefix, boundary-safe match ("/a/b" never matches "/a/bc"); a more
// specific nested grant wins, and grants failing normalization are skipped.
function matchAllowedFolder(grants: readonly AllowedFolderGrant[], target: string): AllowedFolderGrant | null {
  let best: AllowedFolderGrant | null = null;
  for (const grant of grants) {
    const normalized = normalizePosixPath(grant?.path);
    const mode = grant?.mode;
    if (!normalized.ok || (mode !== "ro" && mode !== "rw")) continue;
    const contains = target === normalized.path || target.startsWith(`${normalized.path}/`);
    if (!contains) continue;
    if (best === null || normalized.path.length > best.path.length) best = { path: normalized.path, mode };
  }
  return best;
}

function relativeTo(folder: string, target: string): string {
  return target === folder ? "." : target.slice(folder.length + 1);
}

// Recursive `rm` is only blocked when its target escapes any sane scope:
// filesystem root, home, a bare/root-level wildcard, or parent directories.
function destructiveRmReason(command: string): string | null {
  for (const match of command.matchAll(/(?:^|[;&|]\s*)(?:sudo\s+|doas\s+)?rm\s+([^;&|]*)/g)) {
    const args = match[1].trim().split(/\s+/);
    const recursive = args.some((arg) => /^-{1,2}[a-z]*r[a-z]*$/i.test(arg) || arg === "--recursive");
    if (!recursive) continue;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const stripped = arg.replace(/^["']+|["']+$/g, "").toLowerCase();
      const target = stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
      const rootish =
        target === "/" || target === "~" || target === "$home" || target === "*" || target === ".." ||
        target.startsWith("/*") || target.startsWith("~/") || target.startsWith("../");
      if (rootish) return "recursive rm targeting filesystem root, home, wildcard, or parent directories";
    }
  }
  return null;
}

function destructiveShellReason(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  for (const { label, re } of DESTRUCTIVE_SHELL_PATTERNS) {
    if (re.test(normalized)) return label;
  }
  return destructiveRmReason(normalized);
}

function sanitizeTerminalText(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}

function truncateWithMarker(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}[truncated ${text.length - maxChars} chars]`;
}

// Builds the ok-result payload so each tool branch stays a one-liner.
function task(
  kind: LocalToolKind,
  folder: AllowedFolderGrant,
  fields: Partial<Pick<ValidatedEndpointTask, "path" | "relativePath" | "command" | "cwd" | "contentBytes">>,
  maxWriteBytes: number,
  maxOutputBytes: number,
): EndpointTaskValidation {
  return {
    ok: true,
    task: {
      kind, folderPath: folder.path, folderMode: folder.mode,
      path: fields.path ?? null, relativePath: fields.relativePath ?? null,
      command: fields.command ?? null, cwd: fields.cwd ?? null,
      contentBytes: fields.contentBytes ?? null, maxWriteBytes, maxOutputBytes,
    },
  };
}

export function validateAndBuildEndpointTask(input: {
  call: LocalToolCall;
  allowedFolders: readonly AllowedFolderGrant[];
  maxWriteBytes?: number; maxOutputBytes?: number;
}): EndpointTaskValidation {
  const maxWriteBytes = input?.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  const maxOutputBytes = input?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const call = input?.call;  if (
    !call || typeof call.kind !== "string" || !Array.isArray(input?.allowedFolders) ||
    !Number.isFinite(maxWriteBytes) || maxWriteBytes <= 0 ||
    !Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0
  ) {
    return reject("INVALID_INPUT", "invalid validateAndBuildEndpointTask input");
  }

  if (call.kind === "local_read_file" || call.kind === "local_write_file" || call.kind === "local_list_dir") {
    const normalized = normalizePosixPath(call.path);
    if (!normalized.ok) return reject("INVALID_PATH", normalized.message);
    const folder = matchAllowedFolder(input.allowedFolders, normalized.path);
    if (!folder) return reject("NO_ALLOWED_FOLDER", `${normalized.path} is outside every allowed folder`);
    const rel = relativeTo(folder.path, normalized.path);
    if (call.kind === "local_write_file") {
      if (folder.mode !== "rw") return reject("WRITE_REQUIRES_RW", `folder ${folder.path} is read-only`);
      if (typeof call.content !== "string") return reject("INVALID_INPUT", "write content must be a string");
      const contentBytes = Buffer.byteLength(call.content, "utf8");
      if (contentBytes > maxWriteBytes) {
        return reject("WRITE_TOO_LARGE", `write is ${contentBytes} bytes; limit is ${maxWriteBytes}`);
      }
      return task(call.kind, folder, { path: normalized.path, relativePath: rel, contentBytes }, maxWriteBytes, maxOutputBytes);
    }
    return task(call.kind, folder, { path: normalized.path, relativePath: rel }, maxWriteBytes, maxOutputBytes);
  }

  if (call.kind === "local_shell_exec") {
    if (typeof call.command !== "string" || call.command.trim().length === 0) {
      return reject("INVALID_INPUT", "shell command must be a non-empty string");
    }
    const reason = destructiveShellReason(call.command);
    if (reason) return reject("DESTRUCTIVE_COMMAND", `shell command rejected: ${reason}`);
    const normalized = normalizePosixPath(call.cwd);
    if (!normalized.ok) return reject("INVALID_PATH", normalized.message);
    const folder = matchAllowedFolder(input.allowedFolders, normalized.path);
    if (!folder) return reject("NO_ALLOWED_FOLDER", `cwd ${normalized.path} is outside every allowed folder`);
    if (folder.mode !== "rw") return reject("SHELL_REQUIRES_RW", `folder ${folder.path} is read-only`);
    return task(call.kind, folder, { command: call.command, cwd: normalized.path }, maxWriteBytes, maxOutputBytes);
  }

  return reject("INVALID_INPUT", `unknown local tool kind: ${String((call as { kind?: unknown }).kind)}`);
}

export function formatEndpointTaskResult(input: {
  taskId: string; ok: boolean; output?: string; error?: string; maxChars?: number;
}): FormattedEndpointTaskResult {
  const maxChars = input?.maxChars ?? DEFAULT_MAX_CHARS;
  const result: FormattedEndpointTaskResult = { taskId: input?.taskId ?? "", ok: Boolean(input?.ok) };
  if (typeof input?.output === "string") {
    result.output = truncateWithMarker(sanitizeTerminalText(input.output), maxChars);
  }
  if (typeof input?.error === "string") {
    result.error = truncateWithMarker(sanitizeTerminalText(input.error), maxChars);
  }
  return result;
}
