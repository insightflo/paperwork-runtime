type HeartbeatSchedulerHeartbeat = {
  tickTimers(now: Date): Promise<{ enqueued?: number }>;
  reapOrphanedRuns(opts?: {
    staleThresholdMs?: number;
    activeExecutionTimeoutMs?: number;
    queuedStaleThresholdMs?: number;
  }): Promise<unknown>;
  reapStaleBusyMissionRuntimes(opts?: {
    graceMs?: number;
    now?: Date;
  }): Promise<unknown>;
  reapStalledIssueExecutionLocks(opts?: {
    limit?: number;
  }): Promise<unknown>;
  resumeQueuedRuns(): Promise<unknown>;
};

type HeartbeatSchedulerLogger = {
  info(message: string): void;
  info(obj: unknown, message: string): void;
  warn(message: string): void;
  error(obj: unknown, message: string): void;
};

export type HeartbeatSchedulerOptions = {
  heartbeat: HeartbeatSchedulerHeartbeat;
  logger: HeartbeatSchedulerLogger;
  timerIntervalMs: number;
  recoveryIntervalMs?: number;
  recoveryStaleThresholdMs?: number;
  queuedStaleThresholdMs?: number;
  sweepTimedOutExceptionHuddles?: (now: Date) => Promise<{
    scanned?: number;
    timedOut?: number;
    wokeChair?: number;
  }>;
};

export type HeartbeatScheduler = {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
};

type Lane = "timer" | "recovery";

const RECOVERY_LANE_TIMEOUT_MS = 4 * 60 * 1000;

// [queued-stale threshold 구성화] 기본값은 기존 max(recovery*3, 15m) 을 그대로 유지해
// env 미설정 시 동작이 100% 보존된다. env 값은 파싱 실패·비양수일 때 기본값으로,
// 범위 밖 정수일 때 [1분, 24시간] 으로 클램프한다(위험한 소거·과대 지연 방지).
export const QUEUED_STALE_THRESHOLD_FLOOR_MS = 60 * 1000;
export const QUEUED_STALE_THRESHOLD_CEILING_MS = 24 * 60 * 60 * 1000;
export const PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV = "PAPERCLIP_QUEUED_STALE_THRESHOLD_MS";

export function defaultQueuedStaleThresholdMs(recoveryStaleThresholdMs: number): number {
  return Math.max(recoveryStaleThresholdMs * 3, 15 * 60 * 1000);
}

export function clampQueuedStaleThresholdMs(ms: number): number {
  return Math.min(Math.max(ms, QUEUED_STALE_THRESHOLD_FLOOR_MS), QUEUED_STALE_THRESHOLD_CEILING_MS);
}

/** env 원문을 양의 정수(ms)로 파싱한다. 미설정·빈 값·무한/NaN·비양수는 null. */
export function parseQueuedStaleThresholdMsEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return null;
  const truncated = Math.trunc(parsed);
  return truncated > 0 ? truncated : null;
}

/** env 값 → 유효 임계값(ms). env 가 없거나 무효면 기존 기본값을 반환한다. */
export function resolveQueuedStaleThresholdMs(raw: string | undefined, recoveryStaleThresholdMs: number): number {
  const parsed = parseQueuedStaleThresholdMsEnv(raw);
  if (parsed === null) return defaultQueuedStaleThresholdMs(recoveryStaleThresholdMs);
  return clampQueuedStaleThresholdMs(parsed);
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const recoveryIntervalMs = opts.recoveryIntervalMs ?? Math.max(opts.timerIntervalMs * 10, 5 * 60 * 1000);
  const recoveryStaleThresholdMs = opts.recoveryStaleThresholdMs ?? 5 * 60 * 1000;
  const activeExecutionTimeoutMs = 15 * 60 * 1000;
  const queuedStaleEnvRaw = process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV];
  if (opts.queuedStaleThresholdMs === undefined && queuedStaleEnvRaw !== undefined
    && parseQueuedStaleThresholdMsEnv(queuedStaleEnvRaw) === null) {
    opts.logger.warn(
      `Ignoring invalid ${PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV}=${JSON.stringify(queuedStaleEnvRaw)}; using the default queued-stale threshold`,
    );
  }
  const queuedStaleThresholdMs = opts.queuedStaleThresholdMs
    ?? resolveQueuedStaleThresholdMs(queuedStaleEnvRaw, recoveryStaleThresholdMs);
  const laneTimeoutMs: Record<Lane, number> = {
    timer: Math.max(opts.timerIntervalMs * 2, 30_000),
    recovery: Math.min(RECOVERY_LANE_TIMEOUT_MS, Math.max(recoveryIntervalMs - 30_000, 30_000)),
  };

  let running = false;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let recoveryHandle: ReturnType<typeof setInterval> | null = null;
  let timerGeneration = 0;
  const activeTasks = new Set<Promise<unknown>>();

  const trackTask = <T>(task: Promise<T>): Promise<T> => {
    activeTasks.add(task);
    void task.then(
      () => activeTasks.delete(task),
      () => activeTasks.delete(task),
    );
    return task;
  };
  const laneFlights: Record<Lane, number> = {
    timer: 0,
    recovery: 0,
  };
  const inFlight: Record<Lane, boolean> = {
    timer: false,
    recovery: false,
  };

  const runLane = (lane: Lane, task: () => Promise<void>) => {
    if (inFlight[lane]) {
      const label = lane === "timer" ? "heartbeat timer tick" : "heartbeat recovery";
      opts.logger.warn(`Skipping ${label} because the previous tick is still running`);
      return;
    }

    inFlight[lane] = true;

    // timer/routine lane 은 기존 동작 유지: 이전 tick 이 끝날 때까지 skip(타임아웃 없음).
    if (lane !== "recovery") {
      trackTask(Promise.resolve()
        .then(task)
        .catch((err) => {
          const message = "heartbeat timer tick failed";
          opts.logger.error({ err }, message);
        })
        .finally(() => {
          inFlight[lane] = false;
        }));
      return;
    }

    // [recovery liveness hardening] recovery lane 은 한 tick 이 hang 되면 다음 tick 이 영원히
    // skip 된다(Skipping heartbeat recovery...). wall-clock 예산 후 inFlight 를 풀어 다음 tick 이
    // 진행되게 한다. 예산 초과 시에도 원래 task 는 취소하지 않는다(JS Promise 는 취소 불가).
    // timeout 과 늦은 finally 모두 flight 토큰(laneFlights)을 비교해, 자기 세대일 때만
    // inFlight 를 해제한다 — 그래야 timeout 으로 새 tick 이 시작된 뒤 이전 task 의 finally 가
    // 새 tick 을 풀어버리는 세대 간 간섭이 없다.
    // 주의: 예산 초과로 lane 이 풀려도 이전 task 의 DB 작업은 여전히 진행될 수 있고, 그 작업이
    // 반드시 멱등이라고 보장되지는 않는다(release+promote 경로는 lock_timeout/statement_timeout/
    // SKIP LOCKED 로 bounded 를 강화했으나, 그 외 경로의 멱등성은 별도 검증 필요).
    const flight = ++laneFlights.recovery;
    const laneTask = trackTask(Promise.resolve().then(task));
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutTask = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), laneTimeoutMs.recovery);
      timeoutHandle.unref?.();
    });

    const laneLifecycle = Promise.race([
      laneTask.then(() => "completed" as const),
      timeoutTask,
    ])
      .then((outcome) => {
        if (outcome === "timeout") {
          opts.logger.warn(`Heartbeat recovery lane exceeded ${laneTimeoutMs.recovery}ms; releasing lane for the next tick`);
        }
      })
      .catch((err) => {
        opts.logger.error({ err }, "periodic heartbeat recovery failed");
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (laneFlights.recovery === flight) inFlight.recovery = false;
      });
    trackTask(laneLifecycle);
  };

  const runAutomaticLane = (generation: number, lane: Lane, task: () => Promise<void>) => {
    if (!running || timerGeneration !== generation) return;
    runLane(lane, task);
  };

  const tickTimers = async () => {
    const now = new Date();
    const result = await opts.heartbeat.tickTimers(now);
    if ((result.enqueued ?? 0) > 0) {
      opts.logger.info({ ...result }, "heartbeat timer tick enqueued runs");
    }
    if (opts.sweepTimedOutExceptionHuddles) {
      try {
        const sweepResult = await opts.sweepTimedOutExceptionHuddles(now);
        if ((sweepResult?.timedOut ?? 0) > 0) {
          opts.logger.info({ ...sweepResult }, "swept timed-out exception huddles");
        }
      } catch (err) {
        opts.logger.error({ err }, "exception huddle timeout sweep failed; continuing timer tick");
      }
    }
  };

  // [startup recovery] 시작 즉시 틱은 staleThresholdMs 를 생략해(0) 죽은 PID 고아 런을
  // 5분 대기 없이 즉시 회수하면서(process-loss 재기동 계약 보존), queuedStaleThresholdMs 는
  // 함께 전달해 재시작 직후에도 큐 정체 회수가 동작하도록 한다.
  const recover = async (staleThresholdMs?: number) => {
    await opts.heartbeat.reapOrphanedRuns({
      ...(staleThresholdMs !== undefined ? { staleThresholdMs, activeExecutionTimeoutMs } : {}),
      queuedStaleThresholdMs,
    });
    // [mission-runtime busy 고착 회수기] 백킹 런 없이 busy로 남은 미션 런타임을 회수한다.
    // reapOrphanedRuns 직후에 실행: run 회수(실행_stale 등)로 백킹이 사라진 busy도 같은
    // 스윕에서 풀리게 한다. 실패해도 recovery lane 의 나머지(resumeQueuedRuns)는 계속된다.
    try {
      await opts.heartbeat.reapStaleBusyMissionRuntimes();
    } catch (err) {
      opts.logger.error({ err }, "mission runtime stale-busy reaper failed; continuing recovery lane");
    }
    // [issue 실행잠금 고착 회수기] terminal 실패 run 에 잠긴 채 남은 in_progress 이슈를
    // 표준 실패 경로로 회수한다. 실패해도 recovery lane 의 나머지(resumeQueuedRuns)는 계속된다.
    try {
      await opts.heartbeat.reapStalledIssueExecutionLocks();
    } catch (err) {
      opts.logger.error({ err }, "issue execution lock reaper failed; continuing recovery lane");
    }
    await opts.heartbeat.resumeQueuedRuns();
  };

  return {
    start() {
      if (running) return;
      running = true;
      const generation = ++timerGeneration;

      runAutomaticLane(generation, "recovery", () => recover());
      timerHandle = setInterval(() => runAutomaticLane(generation, "timer", tickTimers), opts.timerIntervalMs);
      recoveryHandle = setInterval(
        () => runAutomaticLane(generation, "recovery", () => recover(recoveryStaleThresholdMs)),
        recoveryIntervalMs,
      );
    },

    stop() {
      if (!running) return;
      running = false;
      timerGeneration += 1;
      if (timerHandle) clearInterval(timerHandle);
      if (recoveryHandle) clearInterval(recoveryHandle);
      timerHandle = null;
      recoveryHandle = null;
    },

    async drain() {
      while (activeTasks.size > 0) {
        await Promise.allSettled([...activeTasks]);
      }
    },
  };
}
