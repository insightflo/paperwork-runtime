// [파일 목적] Rust kb-core(paperclip-kb-core) stdin-JSON 브리지 + Node TS 안전 폴백.
// [외부 연결] crates/kb-core, server/src/services/knowledge/kb-auto-compile.ts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreKbNode, tokenizeQuery } from "./kb-nodes.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_BIN = path.join(
  fileURLToPath(new URL("../../../..", import.meta.url)),
  "crates/kb-core/target/release/paperclip-kb-core",
);

export interface RustScoreNodeInput {
  id: string; slug: string; title: string; summary?: string; content?: string;
  tags?: string[]; nodeType?: string; certified?: boolean;
}
export interface RustScoreNodesRequest {
  schemaVersion: 1; query: string; limit?: number; nodes: RustScoreNodeInput[];
}
export interface RustScoreNodeHit { id: string; score: number; snippet: string; }
export interface RustScoreNodesResponse { schemaVersion: number; hits: RustScoreNodeHit[]; }

export interface RustLintNodeInput {
  id: string; kbId: string; parentId: string | null; title: string; status: string;
  certified?: boolean; linkedNodeIds?: string[]; updatedAtEpochMs: number;
}
export interface RustLintNodesRequest {
  schemaVersion: 1; nowEpochMs: number; staleDays?: number; nodes: RustLintNodeInput[];
}
export interface RustLintFinding { nodeId: string; kbId: string; code: string; detail: string; }
export interface RustLintNodesResponse {
  schemaVersion: number; findings: RustLintFinding[]; staleRetireCandidateIds: string[];
}

export interface RustCompileMissionRequest {
  schemaVersion: 1; missionId: string; missionTitle: string; completedAt: string;
  url?: string | null; slugHint?: string | null; section?: string | null;
  highlights?: string[];
  existingNodes?: Array<{ id: string; title: string; tags?: string[] }>;
}
export interface RustCompiledSourceRef {
  type: "url" | "manual" | "issue" | "file" | "mission" | "pr";
  id: string; label: string; url?: string; updatedAt: string;
}
export interface RustCompileMissionResponse {
  schemaVersion: number; slug: string; title: string; summary: string; content: string;
  nodeType: string; tags: string[]; linkedNodeIds: string[]; sourceRefs: RustCompiledSourceRef[];
}

export function resolveKbCoreBin(configured = process.env.PAPERCLIP_KB_CORE_BIN): string | null {
  const trimmed = configured?.trim() ?? "";
  if (trimmed) {
    if (!path.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
    return existsSync(trimmed) ? trimmed : null;
  }
  return existsSync(DEFAULT_BIN) ? DEFAULT_BIN : null;
}

export function runKbCoreSubcommand<T>(
  subcommand: "score-nodes" | "lint-nodes" | "compile-mission",
  payload: unknown,
  opts?: { binPath?: string | null; timeoutMs?: number },
): Promise<T> {
  const bin = opts?.binPath !== undefined ? opts.binPath : resolveKbCoreBin();
  if (!bin) return Promise.reject(new Error("kb_core_unavailable"));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, [subcommand], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("kb_core_timeout")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return fail(new Error("kb_core_stdout_overflow"));
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (err) => fail(new Error(`kb_core_spawn_error: ${err.message}`)));
    child.stdin.on("error", () => fail(new Error("kb_core_stdin_error")));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8").trim();
      if (code !== 0) {
        return reject(new Error(`kb_core_exit_${code ?? "signal"}: ${stderrTail.trim() || raw}`));
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) {
          return reject(new Error("kb_core_bad_schema_version"));
        }
        resolve(parsed as T);
      } catch {
        reject(new Error("kb_core_bad_json"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function nfcLower(s: string): string { return s.normalize("NFC").toLowerCase(); }

function fallbackScoreNodes(req: RustScoreNodesRequest): RustScoreNodesResponse {
  const tokens = tokenizeQuery(req.query.normalize("NFC"));
  const limit = Math.min(Math.max(Math.floor(req.limit ?? 5), 1), 8);
  const hits = req.nodes
    .map((n) => {
      const { score, snippet } = scoreKbNode({
        slug: n.slug.normalize("NFC"), title: n.title.normalize("NFC"),
        summary: (n.summary ?? "").normalize("NFC"), content: (n.content ?? "").normalize("NFC"),
        tags: (n.tags ?? []).map((t) => t.normalize("NFC")),
        nodeType: n.nodeType ?? "concept", certified: n.certified ?? false,
      }, tokens);
      return { id: n.id, score, snippet };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, limit);
  return { schemaVersion: 1, hits };
}

function fallbackLintNodes(req: RustLintNodesRequest): RustLintNodesResponse {
  const clampedDays = Math.min(req.staleDays ?? 90, 36_500);
  const staleMs = clampedDays * 86_400_000;
  const statusById = new Map(req.nodes.map((n) => [n.id, n.status]));
  const findings: RustLintFinding[] = [];
  const staleRetireCandidateIds: string[] = [];
  const titleGroups = new Map<string, string[]>();
  for (const n of req.nodes) {
    if (n.status !== "active") continue;
    const key = `${n.kbId}\0${nfcLower(n.title.trim())}`;
    const list = titleGroups.get(key) ?? [];
    list.push(n.id);
    titleGroups.set(key, list);
    let activeOut = 0;
    for (const target of n.linkedNodeIds ?? []) {
      const st = statusById.get(target);
      if (!st) findings.push({ nodeId: n.id, kbId: n.kbId, code: "broken_link_missing", detail: target });
      else if (st !== "active") findings.push({ nodeId: n.id, kbId: n.kbId, code: "broken_link_retired", detail: target });
      else activeOut += 1;
    }
    let hasValidParent = false;
    if (n.parentId) {
      const pst = statusById.get(n.parentId);
      if (!pst) findings.push({ nodeId: n.id, kbId: n.kbId, code: "broken_link_missing", detail: `parent:${n.parentId}` });
      else if (pst !== "active") findings.push({ nodeId: n.id, kbId: n.kbId, code: "broken_link_retired", detail: `parent:${n.parentId}` });
      else hasValidParent = true;
    }
    if (!hasValidParent && activeOut === 0) {
      findings.push({ nodeId: n.id, kbId: n.kbId, code: "orphan", detail: "rootless node with no active outgoing links" });
    }
    if (!n.certified && Math.max(0, req.nowEpochMs - n.updatedAtEpochMs) > staleMs) {
      findings.push({ nodeId: n.id, kbId: n.kbId, code: "stale_uncertified", detail: `older than ${clampedDays}d` });
      staleRetireCandidateIds.push(n.id);
    }
  }
  for (const [key, ids] of titleGroups.entries()) {
    if (ids.length <= 1) continue;
    const kbId = key.split("\0")[0] ?? "";
    const sorted = [...ids].sort();
    for (const id of sorted.slice(1)) {
      findings.push({ nodeId: id, kbId, code: "duplicate_title", detail: `duplicates ${sorted[0]}` });
    }
  }
  return { schemaVersion: 1, findings, staleRetireCandidateIds: staleRetireCandidateIds.sort() };
}

function fallbackCompileMission(req: RustCompileMissionRequest): RustCompileMissionResponse {
  const title = req.missionTitle.normalize("NFC").trim() || `Mission ${req.missionId}`;
  const slugBase = nfcLower(req.slugHint || title).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const slug = slugBase || `mission-${req.missionId.slice(0, 8)}`;
  const highlights = (req.highlights ?? []).map((h) => h.normalize("NFC").trim()).filter(Boolean).slice(0, 8);
  const queryTokens = tokenizeQuery(`${title} ${highlights.join(" ")}`);
  const linked = (req.existingNodes ?? [])
    .map((e) => {
      const hay = nfcLower(`${e.title} ${(e.tags ?? []).join(" ")}`);
      const overlap = queryTokens.filter((t) => hay.includes(t)).length;
      return { id: e.id, title: e.title.normalize("NFC"), overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || a.id.localeCompare(b.id))
    .slice(0, 3);
  const lines = [`# ${title}`, "", ...highlights.map((h) => `- ${h}`)];
  if (linked.length > 0) {
    lines.push("", "## Related", ...linked.map((l) => `- [[${l.title}]]`));
  }
  return {
    schemaVersion: 1, slug, title,
    summary: (highlights[0] ?? title).slice(0, 180),
    content: lines.join("\n"),
    nodeType: "entity",
    tags: queryTokens.slice(0, 6),
    linkedNodeIds: linked.map((l) => l.id),
    sourceRefs: [{
      type: "mission", id: req.missionId, label: title,
      ...(req.url ? { url: req.url } : {}), updatedAt: req.completedAt,
    }],
  };
}

const fallbackWarned = new Set<string>();
function warnFallbackOnce(subcommand: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const key = `${subcommand}:${reason}`;
  if (fallbackWarned.has(key)) return;
  fallbackWarned.add(key);
  console.warn(`[kb-core] Rust helper fallback to Node (${subcommand}): ${reason}`);
}

export async function scoreNodesViaRust(req: RustScoreNodesRequest): Promise<RustScoreNodesResponse> {
  if (!resolveKbCoreBin()) return fallbackScoreNodes(req);
  try { return await runKbCoreSubcommand<RustScoreNodesResponse>("score-nodes", req); }
  catch (err) { warnFallbackOnce("score-nodes", err); return fallbackScoreNodes(req); }
}

export async function lintNodesViaRust(req: RustLintNodesRequest): Promise<RustLintNodesResponse> {
  if (!resolveKbCoreBin()) return fallbackLintNodes(req);
  try { return await runKbCoreSubcommand<RustLintNodesResponse>("lint-nodes", req); }
  catch (err) { warnFallbackOnce("lint-nodes", err); return fallbackLintNodes(req); }
}

export async function compileMissionViaRust(req: RustCompileMissionRequest): Promise<RustCompileMissionResponse> {
  if (!resolveKbCoreBin()) return fallbackCompileMission(req);
  try { return await runKbCoreSubcommand<RustCompileMissionResponse>("compile-mission", req); }
  catch (err) { warnFallbackOnce("compile-mission", err); return fallbackCompileMission(req); }
}
