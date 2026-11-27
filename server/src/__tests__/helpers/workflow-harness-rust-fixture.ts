import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * [목적] workflow-harness-rust-client 테스트의 공용 fixture — paperclip-workflow-core release bin
 *   탐색·빌드(bot-governance-rust-parity 관례: env override → crates/target → workspace target → cargo build)
 *   와 canned bin 스크립트(스폰 카운터 파일 + WF_HARNESS_CANNED 으로 응답 선택).
 * [주의] bin·cargo 부재는 호출자가 skip 판정한다. 빌드는 --locked — Cargo.lock 을 절대 갱신하지 않는다.
 */

export const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

export const workflowCoreBinCandidates = [
  process.env.PAPERCLIP_WORKFLOW_CORE_BIN,
  path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core"),
  path.join(repoRoot, "target/release/paperclip-workflow-core"),
].filter((candidate): candidate is string => Boolean(candidate));

export function findWorkflowCoreBinary(): string | null {
  return workflowCoreBinCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function findCargoBin(): string | null {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const candidate = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  return existsSync(candidate) ? candidate : null;
}

/** 기존 bin 이 있으면 그것, 없으면 cargo build 후 재탐색 — 실패는 예외로 던진다(skip 대상 아님). */
export function resolveOrBuildWorkflowCoreBinary(cargo: string | null): string {
  const existing = findWorkflowCoreBinary();
  if (existing) return existing;
  if (!cargo) throw new Error("paperclip-workflow-core binary not found and cargo is absent");
  execFileSync(cargo,
    ["build", "--release", "--locked", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  const built = findWorkflowCoreBinary();
  if (!built) throw new Error(`cargo build finished but no binary at ${workflowCoreBinCandidates.join(", ")}`);
  return built;
}

export interface CannedBinDir {
  dir: string;
  countFile: string;
  /** stdin 을 버리고 $WF_HARNESS_CANNED 를 그대로 출력 — 스폰마다 $WF_HARNESS_SPAWN_COUNT 파일에 한 줄을 남긴다. */
  cannedBin: string;
  garbageBin: string;
  exitBin: string;
  spawnCount(): Promise<number>;
  cleanup(): Promise<void>;
}

async function writeBin(dir: string, name: string, body: string[]): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, ["#!/bin/bash", ...body, ""].join("\n"), "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

export async function createCannedBinDir(prefix: string): Promise<CannedBinDir> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const countFile = path.join(dir, "count");
  const cannedBin = await writeBin(dir, "canned", [
    "cat >/dev/null",
    '[ -n "$WF_HARNESS_SPAWN_COUNT" ] && echo spawn >> "$WF_HARNESS_SPAWN_COUNT"',
    `printf '%s' "$WF_HARNESS_CANNED"`,
  ]);
  const garbageBin = await writeBin(dir, "garbage", ['cat >/dev/null', 'echo "not-json"']);
  const exitBin = await writeBin(dir, "exit", ['cat >/dev/null', 'echo "boom" >&2', "exit 1"]);
  return {
    dir,
    countFile,
    cannedBin,
    garbageBin,
    exitBin,
    async spawnCount() {
      try {
        return (await readFile(countFile, "utf8")).split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
