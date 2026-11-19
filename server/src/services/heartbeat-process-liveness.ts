import { execFileSync } from "node:child_process";

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export interface ProcessTreeSnapshot {
  descendants: number[];
  isProcessGroupLeader: boolean;
}

/**
 * Snapshot recursive descendant PIDs (ordered leaf-first / bottom-up) and whether
 * `rootPid` is its own POSIX process-group leader (`pgid === rootPid`) in one `ps` call.
 * Capturing descendants before signaling `rootPid` prevents child processes (such as
 * `language_server` or MCP servers) from reparenting to PID 1 as un-reapable orphans.
 */
export function snapshotProcessTree(rootPid: number): ProcessTreeSnapshot {
  if (process.platform === "win32" || !Number.isInteger(rootPid) || rootPid <= 0) {
    return { descendants: [], isProcessGroupLeader: false };
  }
  try {
    const stdout = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childrenByParent = new Map<number, number[]>();
    let isProcessGroupLeader = false;
    for (const rawLine of stdout.split("\n")) {
      const parts = rawLine.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgid = Number(parts[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
      if (pid === rootPid && pgid === rootPid) {
        isProcessGroupLeader = true;
      }
      if (pid === process.pid || pid === rootPid) continue;
      const list = childrenByParent.get(ppid);
      if (list) list.push(pid);
      else childrenByParent.set(ppid, [pid]);
    }
    const ordered: number[] = [];
    const queue: number[] = [rootPid];
    const visited = new Set<number>([rootPid]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenByParent.get(current) ?? [];
      for (const childPid of children) {
        if (visited.has(childPid)) continue;
        visited.add(childPid);
        ordered.push(childPid);
        queue.push(childPid);
      }
    }
    ordered.reverse();
    return { descendants: ordered, isProcessGroupLeader };
  } catch {
    return { descendants: [], isProcessGroupLeader: false };
  }
}

export function listDescendantPids(rootPid: number): number[] {
  return snapshotProcessTree(rootPid).descendants;
}

export function terminateRecordedProcess(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!isProcessAlive(pid)) return false;
  const targetPid = pid as number;
  const { descendants, isProcessGroupLeader } = snapshotProcessTree(targetPid);
  for (const descendantPid of descendants) {
    try {
      process.kill(descendantPid, signal);
    } catch {
      // Descendant may have already exited between snapshot and kill.
    }
  }
  if (isProcessGroupLeader && targetPid !== process.pid) {
    try {
      process.kill(-targetPid, signal);
    } catch {
      // Fall through to direct PID kill below.
    }
  }
  try {
    process.kill(targetPid, signal);
    return true;
  } catch {
    return descendants.length > 0;
  }
}

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "commandcode_local",
  "antigravity_local",
]);

export function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

export const DETACHED_PROCESS_ERROR_CODE = "process_detached";
// orphaned-but-alive child 강제 회수 시한. handle 상실 후에도 child pid 가 살아 reaper 가 process_detached
// 로 매 tick defer 만 하던 무한 대기(CMPA-5519 ~72분 hang)를 상한으로 끊고 process_lost+retry 로 회수.
export const DETACHED_REAP_AFTER_MS = 30 * 60 * 1000;
export const DETACHED_GRACE_SEC = 5;
// [paperclip-stuck 2026-08-06, A2] detached 유예 창 동안 agents.status 가 `running`에 갇히는
// (phantom running) 것을 끊는다. reapOrphanedRuns 는 detached child 를 DETACHED_REAP_AFTER_MS 까지
// 유예하지만, 그 동안 finalizeAgentStatus 가 호출되지 않아 agent 가 최장 30분간 running 으로 보임.
// agent.updatedAt 기준으로 이 임계를 넘기면 agent 를 `error` 로 강등해 보드/QA 가 실상을 반영하게 한다.
// (run 자체는 longevity cap 에 따라 별도 회수 — 여기서는 agent 가시성만 교정.)
export const HEARTBEAT_AGENT_DETACHED_DEMOTE_MS = 10 * 60 * 1000;
