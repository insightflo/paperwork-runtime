// [파일 목적] Rust provider-auth-core(paperclip-provider-auth-core) JSON 브리지 — 인증 증거 메타데이터 전용, Node 폴백 없음(fail-closed).
// [외부 연결] crates/provider-auth-core (`probe-all`/`plan-login` 서브커맨드), server/src/routes/instance-settings.ts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_PROVIDER_AUTH_BIN = path.join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "crates/provider-auth-core/target/release/paperclip-provider-auth-core",
);

export const PROVIDER_AUTH_IDS = ["claude", "codex", "pi", "commandcode", "devin"] as const;
export type ProviderAuthId = (typeof PROVIDER_AUTH_IDS)[number];
export function isValidProviderAuthId(v: unknown): v is ProviderAuthId {
  return typeof v === "string" && (PROVIDER_AUTH_IDS as readonly string[]).includes(v);
}

const EVIDENCE_KINDS = ["api_key_env_present", "credential_file_present", "managed_env_present", "missing", "probe_error"] as const;
export type ProviderAuthEvidence = (typeof EVIDENCE_KINDS)[number];

export interface ProviderAuthCredentialMeta {
  exists: boolean; isSymlink: boolean; sizeBytes: number; mtimeEpochMs: number; inode: number;
}
export interface ProviderAuthStatus {
  provider: ProviderAuthId; evidence: ProviderAuthEvidence;
  envVar?: string; credentialPath?: string; credentialMeta?: ProviderAuthCredentialMeta;
  errorPath?: string; auxiliaryPresent: string[];
}
export interface ProviderAuthLoginPlan {
  provider: ProviderAuthId; command: string; args: string[]; interactive: boolean; notes: string[];
}

export const PROVIDER_AUTH_CLIENT_REASONS = [
  "binary_missing", "spawn_error", "timeout", "stdout_overflow", "stderr_overflow", "non_zero_exit", "invalid_json",
  "invalid_provider",
] as const;
export type ProviderAuthClientReason = (typeof PROVIDER_AUTH_CLIENT_REASONS)[number];
export class ProviderAuthClientError extends Error {
  readonly reason: ProviderAuthClientReason;
  constructor(reason: ProviderAuthClientReason) {
    super(`provider_auth_${reason}`);
    this.name = "ProviderAuthClientError";
    this.reason = reason;
  }
}
const invalid = () => new ProviderAuthClientError("invalid_json");

export function resolveProviderAuthBin(
  configured = process.env.PAPERCLIP_PROVIDER_AUTH_BIN,
  defaultBin = DEFAULT_PROVIDER_AUTH_BIN,
): string | null {
  if (configured !== undefined) {
    // configured 가 설정되면(blank 포함) 그 값만 신뢰 — defaultBin 폴백은 절대 참조하지 않는다(fail-closed).
    const trimmed = configured.trim();
    if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
    return existsSync(trimmed) ? trimmed : null;
  }
  return existsSync(defaultBin) ? defaultBin : null;
}

interface RunOpts {
  binPath?: string | null;
  timeoutMs?: number;
}

function runProviderAuthBin(argv: readonly string[], opts?: RunOpts): Promise<unknown> {
  const bin = opts?.binPath !== undefined ? opts.binPath : resolveProviderAuthBin();
  if (!bin) return Promise.reject(new ProviderAuthClientError("binary_missing"));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...argv], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (reason: ProviderAuthClientReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdout?.destroy(); // close 를 기다리지 않고 파이프를 즉시 끊는다
      child.stderr?.destroy();
      reject(new ProviderAuthClientError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), opts?.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return fail("stdout_overflow");
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return fail("stderr_overflow");
    });
    child.on("error", () => fail("spawn_error"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new ProviderAuthClientError("non_zero_exit"));
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
      } catch {
        reject(invalid());
      }
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function reqStr(v: unknown): string { if (typeof v !== "string") throw invalid(); return v; }
function optStr(v: unknown): string | undefined { return v === undefined ? undefined : reqStr(v); }
function reqBool(v: unknown): boolean { if (typeof v !== "boolean") throw invalid(); return v; }
function reqNum(v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(); return v; }
function strArr(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw invalid();
  return [...v];
}

function projectMeta(v: unknown): ProviderAuthCredentialMeta | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw invalid();
  return {
    exists: reqBool(v.exists), isSymlink: reqBool(v.isSymlink),
    sizeBytes: reqNum(v.sizeBytes), mtimeEpochMs: reqNum(v.mtimeEpochMs), inode: reqNum(v.inode),
  };
}

function projectStatus(v: unknown): ProviderAuthStatus {
  if (!isRecord(v) || !isValidProviderAuthId(v.provider)) throw invalid();
  if (typeof v.evidence !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(v.evidence)) {
    throw invalid();
  }
  return {
    provider: v.provider,
    evidence: v.evidence as ProviderAuthEvidence,
    envVar: optStr(v.envVar),
    credentialPath: optStr(v.credentialPath),
    credentialMeta: projectMeta(v.credentialMeta),
    errorPath: optStr(v.errorPath),
    auxiliaryPresent: v.auxiliaryPresent === undefined ? [] : strArr(v.auxiliaryPresent),
  };
}

export async function probeAllProviders(opts?: RunOpts): Promise<ProviderAuthStatus[]> {
  const raw = await runProviderAuthBin(["probe-all"], opts);
  if (!Array.isArray(raw)) throw invalid();
  return raw.map(projectStatus);
}

export async function planProviderLogin(
  provider: ProviderAuthId,
  opts?: RunOpts,
): Promise<ProviderAuthLoginPlan> {
  // 런타임 방어: allowlist 밖 provider 는 spawn 이전에 fail-closed(타입 우회 호출자 차단).
  if (!isValidProviderAuthId(provider)) throw new ProviderAuthClientError("invalid_provider");
  const raw = await runProviderAuthBin(["plan-login", provider], opts);
  if (!isRecord(raw) || !isValidProviderAuthId(raw.provider)) throw invalid();
  const plan: ProviderAuthLoginPlan = {
    provider: raw.provider,
    command: reqStr(raw.command),
    args: strArr(raw.args),
    interactive: reqBool(raw.interactive),
    notes: strArr(raw.notes),
  };
  if (plan.provider !== provider) throw invalid(); // echo-bind: 요청 provider 와 정확히 일치해야 한다
  return plan;
}
