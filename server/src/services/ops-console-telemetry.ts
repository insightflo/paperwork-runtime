/**
 * Ops 콘솔 텔레메트리 — 리소스 스냅샷·백그라운드 프로세스·열린 대기 목록.
 *
 * 비밀 경계: 응답에 원시 환경변수·API 토큰·파일 내용을 절대 담지 않는다.
 *   프롬프트 미리보기는 operator-queue-view 의 300자 캡 헬퍼로만 노출한다.
 * 프로세스 경계: 종료 가능 대상은 이 서버 프로세스(process.pid)의 직계 자식만.
 *   PID 1·서버 자신·타 프로세스의 자식은 거부한다(검증은 ps 로 재확인).
 * 쓰기 경계: agent_wakeup_requests(읽기)·operator_decisions(읽기)만 조회하고
 *   run 상태(heartbeat_runs/workflow_runs)는 건드리지 않는다.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, operatorDecisions } from "@paperclipai/db";
import type { ResourceThresholds } from "./hermit-gate-types.js";
import type { HermitGateService } from "./hermit-gate.js";
import { QUEUED_WAKEUP_STATUSES, buildPromptPreview } from "./operator-queue-view.js";

const execFileAsync = promisify(execFile);

const DEFAULT_THRESHOLDS: ResourceThresholds = { cpuPct: 85, memPct: 85, diskPct: 90 };

const PROCESS_ROW_CAP = 25;

export interface ResourceSnapshot {
  cpuPct: number;
  memTotalBytes: number;
  memFreeBytes: number;
  memUsedPct: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPct: number | null;
  thresholds: ResourceThresholds;
}

export interface BackgroundProcessRow {
  pid: number;
  ppid: number;
  elapsed: string;
  command: string;
  stoppable: boolean;
}

export interface OpenWaitItem {
  kind: "wakeup" | "operator_decision";
  id: string;
  label: string;
  status: string;
  createdAt: Date;
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLDS.cpuPct;
  return Math.min(99, Math.max(10, Math.round(value)));
}

function thresholdsFilePath(stateDir: string, companyId: string): string {
  const safe = companyId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(stateDir, `resource-thresholds-${safe}.json`);
}

function loadThresholds(stateDir: string, companyId: string): ResourceThresholds {
  try {
    const parsed = JSON.parse(fs.readFileSync(thresholdsFilePath(stateDir, companyId), "utf8")) as Partial<ResourceThresholds>;
    return {
      cpuPct: typeof parsed.cpuPct === "number" ? parsed.cpuPct : DEFAULT_THRESHOLDS.cpuPct,
      memPct: typeof parsed.memPct === "number" ? parsed.memPct : DEFAULT_THRESHOLDS.memPct,
      diskPct: typeof parsed.diskPct === "number" ? parsed.diskPct : DEFAULT_THRESHOLDS.diskPct,
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function persistThresholds(stateDir: string, companyId: string, thresholds: ResourceThresholds): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = thresholdsFilePath(stateDir, companyId);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(thresholds, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

async function runPs(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("ps", args, {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return stdout;
}

const PS_LSTART_RE = /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/;

/** DB 기록 processStartedAt 과 ps UTC lstart 를 대조해 PID 재사용으로 인한 오종료를 차단한다. */
export function matchesProcessStartTime(
  psUtcLstart: string,
  recordedStartedAt: Date | string | null | undefined,
): boolean {
  if (!recordedStartedAt) return false;
  const recordedMs = new Date(recordedStartedAt).getTime();
  const normalized = psUtcLstart.trim().replace(/\s+/g, " ");
  if (!PS_LSTART_RE.test(normalized)) return false;
  const psMs = Date.parse(`${normalized} UTC`);
  return Number.isFinite(recordedMs) && Number.isFinite(psMs) && psMs <= recordedMs + 2_000 && recordedMs - psMs <= 10_000;
}

export function opsConsoleTelemetryService(db: Db, hermitGate: HermitGateService) {
  /** 요청 회사가 현재 running 으로 소유한 외부 OS 프로세스(pid + processStartedAt)만 조회한다(서버 자신의 pid 제외, 읽기 전용 SELECT). */
  async function getCompanyOwnedRuns(companyId: string): Promise<Array<{ pid: number; processStartedAt: Date | null }>> {
    const rows = await db
      .select({ processPid: heartbeatRuns.processPid, processStartedAt: heartbeatRuns.processStartedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    const owned: Array<{ pid: number; processStartedAt: Date | null }> = [];
    for (const row of rows) {
      if (
        typeof row.processPid === "number" &&
        Number.isInteger(row.processPid) &&
        row.processPid > 1 &&
        row.processPid !== process.pid
      ) {
        owned.push({ pid: row.processPid, processStartedAt: row.processStartedAt ?? null });
      }
    }
    return owned;
  }

  async function getResourceSnapshot(companyId: string): Promise<ResourceSnapshot> {
    const cpuCount = Math.max(1, os.cpus().length);
    const cpuPct = Math.min(100, Math.round((os.loadavg()[0] / cpuCount) * 100));
    const memTotalBytes = os.totalmem();
    const memFreeBytes = os.freemem();
    const memUsedPct = Math.round(((memTotalBytes - memFreeBytes) / memTotalBytes) * 100);
    let diskTotalBytes: number | null = null;
    let diskFreeBytes: number | null = null;
    let diskUsedPct: number | null = null;
    try {
      const stats = fs.statfsSync(process.cwd());
      diskTotalBytes = stats.blocks * stats.bsize;
      diskFreeBytes = stats.bfree * stats.bsize;
      diskUsedPct = diskTotalBytes > 0 ? Math.round(((diskTotalBytes - diskFreeBytes) / diskTotalBytes) * 100) : null;
    } catch {
      // statfs 미지원 플랫폼 — null 유지
    }
    return {
      cpuPct,
      memTotalBytes,
      memFreeBytes,
      memUsedPct,
      diskTotalBytes,
      diskFreeBytes,
      diskUsedPct,
      thresholds: loadThresholds(hermitGate.stateDir, companyId),
    };
  }

  async function updateThresholds(companyId: string, thresholds: ResourceThresholds): Promise<ResourceThresholds> {
    const clamped: ResourceThresholds = {
      cpuPct: clampThreshold(thresholds.cpuPct),
      memPct: clampThreshold(thresholds.memPct),
      diskPct: clampThreshold(thresholds.diskPct),
    };
    persistThresholds(hermitGate.stateDir, companyId, clamped);
    return clamped;
  }

  async function listBackgroundProcesses(companyId: string): Promise<BackgroundProcessRow[]> {
    const ownedRuns = await getCompanyOwnedRuns(companyId);
    if (ownedRuns.length === 0) return [];
    let stdout: string;
    try {
      stdout = await runPs(["-eo", "pid=,ppid=,etime=,lstart=,comm="]);
    } catch {
      return [];
    }
    const parsed: Array<{ pid: number; ppid: number; elapsed: string; lstart: string; command: string }> = [];
    for (const line of stdout.split("\n")) {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      parsed.push({ pid, ppid, elapsed: match[3], lstart: match[4], command: match[5] });
    }
    const verifiedRootPids = new Set<number>();
    for (const entry of parsed) {
      if (
        entry.pid !== process.pid &&
        ownedRuns.some((run) => run.pid === entry.pid && matchesProcessStartTime(entry.lstart, run.processStartedAt))
      ) {
        verifiedRootPids.add(entry.pid);
      }
    }
    if (verifiedRootPids.size === 0) return [];
    const ownedTree = new Set(verifiedRootPids);
    let added = true;
    while (added) {
      added = false;
      for (const entry of parsed) {
        if (ownedTree.has(entry.ppid) && !ownedTree.has(entry.pid)) {
          ownedTree.add(entry.pid);
          added = true;
        }
      }
    }
    const rows: BackgroundProcessRow[] = [];
    for (const entry of parsed) {
      if (!ownedTree.has(entry.pid)) continue;
      rows.push({
        pid: entry.pid,
        ppid: entry.ppid,
        elapsed: entry.elapsed,
        command: entry.command,
        stoppable: entry.ppid === process.pid && verifiedRootPids.has(entry.pid),
      });
      if (rows.length >= PROCESS_ROW_CAP) break;
    }
    return rows;
  }

  async function stopBackgroundProcess(
    companyId: string,
    pid: number,
  ): Promise<{ ok: true; pid: number } | { ok: false; reason: string }> {
    if (!Number.isInteger(pid)) return { ok: false, reason: "pid 는 정수여야 합니다" };
    if (pid <= 1) return { ok: false, reason: "보호된 시스템 프로세스(pid <= 1)는 종료할 수 없습니다" };
    if (pid === process.pid) return { ok: false, reason: "API 서버 프로세스 자신은 종료할 수 없습니다" };
    const candidates = (await getCompanyOwnedRuns(companyId)).filter((run) => run.pid === pid);
    if (candidates.length === 0) {
      return { ok: false, reason: `프로세스 ${pid} 는 요청 회사의 활성 실행 소유 프로세스가 아닙니다` };
    }
    let ppid: number;
    let lstart: string;
    try {
      const out = (await runPs(["-o", "ppid=,lstart=", "-p", String(pid)])).trim();
      const match = out.match(/^(\d+)\s+(.+)$/);
      ppid = match ? Number(match[1]) : 0;
      lstart = match ? match[2].trim() : "";
      if (!match || !Number.isInteger(ppid) || ppid <= 0) {
        return { ok: false, reason: `프로세스 ${pid} 를 찾을 수 없습니다` };
      }
    } catch {
      return { ok: false, reason: `프로세스 ${pid} 를 찾을 수 없습니다` };
    }
    if (ppid !== process.pid) {
      return { ok: false, reason: `프로세스 ${pid} 는 이 서버의 자식 프로세스가 아닙니다` };
    }
    if (!candidates.some((run) => matchesProcessStartTime(lstart, run.processStartedAt))) {
      return { ok: false, reason: `프로세스 ${pid} 시작 시각이 기록된 실행과 일치하지 않습니다(PID 재사용 보호)` };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      return { ok: false, reason: `프로세스 ${pid} 종료 신호 실패: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, pid };
  }

  async function getOpenWaits(companyId: string): Promise<OpenWaitItem[]> {
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, [...QUEUED_WAKEUP_STATUSES])),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(30);
    const decisions = await db
      .select({
        id: operatorDecisions.id,
        title: operatorDecisions.title,
        status: operatorDecisions.status,
        createdAt: operatorDecisions.createdAt,
      })
      .from(operatorDecisions)
      .where(and(eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.status, "pending")))
      .orderBy(desc(operatorDecisions.createdAt))
      .limit(30);
    const wakeupItems: OpenWaitItem[] = wakeups.map((row) => ({
      kind: "wakeup",
      id: row.id,
      label: buildPromptPreview(row.payload, row.reason) || `${row.source} 깨움 대기`,
      status: row.status,
      createdAt: row.requestedAt,
    }));
    const decisionItems: OpenWaitItem[] = decisions.map((row) => ({
      kind: "operator_decision",
      id: row.id,
      label: row.title,
      status: row.status,
      createdAt: row.createdAt,
    }));
    return [...wakeupItems, ...decisionItems];
  }

  return { getResourceSnapshot, updateThresholds, listBackgroundProcesses, stopBackgroundProcess, getOpenWaits };
}
