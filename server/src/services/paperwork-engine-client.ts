import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export const PAPERWORK_ENGINE_MAX_REQUEST_BYTES = 65_536;
export const PAPERWORK_ENGINE_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const PAPERWORK_ENGINE_DEFAULT_TIMEOUT_MS = 5_000;
export const PAPERWORK_ENGINE_DEFAULT_MAX_PENDING = 64;

const BLOCK = 8 * 1024, LF = 0x0a, CR = 0x0d;

export type PaperworkEngineErrorCode = "bin_not_configured" | "request_too_large" | "queue_full"
  | "timeout" | "rpc_error" | "protocol_error" | "response_too_large" | "process_exited" | "closed";

export class PaperworkEngineError extends Error {
  constructor(readonly code: PaperworkEngineErrorCode, message?: string, readonly rpcCode?: number) {
    super(message ?? code);
    this.name = "PaperworkEngineError";
  }
}

/** Absolute-path gate only — never searches PATH. */
export function resolvePaperworkEngineBin(explicitBin?: string): string | null {
  const candidate = explicitBin ?? process.env.PAPERWORK_ENGINE_BIN ?? "";
  if (candidate === "" || candidate.includes("\0") || !path.isAbsolute(candidate)) return null;
  return candidate;
}

/** Bounded newline framer — copies inbound bytes into owned fixed 8 KiB blocks
 *  (allocates only when the open block fills; never per-chunk concat). */
export class LineByteAccumulator {
  allocatedBlocks = 0;
  private parts: Buffer[] = [];
  private used = 0;
  private lineBytes = 0;
  constructor(private readonly maxLineBytes: number) {}

  /** @returns completed payload lines (CR stripped), or null once the open line exceeds maxLineBytes. */
  push(chunk: Buffer): Buffer[] | null {
    const lines: Buffer[] = [];
    for (let off = 0; off < chunk.length;) {
      const nl = chunk.indexOf(LF, off);
      const partLen = (nl < 0 ? chunk.length : nl) - off;
      if (this.lineBytes + partLen > this.maxLineBytes) return null;
      for (let done = 0; done < partLen;) {
        let block = this.parts[this.parts.length - 1];
        if (!block || this.used === BLOCK) {
          block = Buffer.allocUnsafe(BLOCK);
          this.parts.push(block);
          this.used = 0;
          this.allocatedBlocks += 1;
        }
        const n = Math.min(partLen - done, BLOCK - this.used);
        chunk.copy(block, this.used, off + done, off + done + n);
        this.used += n; done += n;
      }
      this.lineBytes += partLen;
      if (nl < 0) break;
      let line = Buffer.concat(this.parts.map((p, i) => (i === this.parts.length - 1 ? p.subarray(0, this.used) : p)), this.lineBytes);
      if (line.length && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1);
      lines.push(line);
      this.parts = []; this.used = 0; this.lineBytes = 0;
      off = nl + 1;
    }
    return lines;
  }
}

export interface PaperworkEngineClientOptions {
  bin?: string; args?: string[]; timeoutMs?: number; maxPending?: number;
  maxQueuedWriteBytes?: number; maxRetiringChildren?: number; maxResponseBytes?: number;
  closeGraceMs?: number; closeKillTimeoutMs?: number; spawnFn?: typeof spawn;
}

export interface PaperworkEngineHealth { ok: true; engine: "paperwork-engine"; protocol_version: number; capabilities: string[] }

export interface PaperworkEngineClient {
  call<T = unknown>(method: string, params?: unknown, callOpts?: { timeoutMs?: number }): Promise<T>;
  getPid(): number | null;
  close(): Promise<void>;
  health(): Promise<PaperworkEngineHealth>;
  redactText(text: string): Promise<{ redacted: string; changed: boolean }>;
}

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> };

function intOpt(name: string, value: number | undefined, fallback: number, lo: number, hi: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be an integer in [${lo}, ${hi}]`);
  return v;
}

export function createPaperworkEngineClient(opts: PaperworkEngineClientOptions = {}): PaperworkEngineClient {
  const bin = resolvePaperworkEngineBin(opts.bin);
  const args = opts.args ?? [];
  const timeoutMs = intOpt("timeoutMs", opts.timeoutMs, PAPERWORK_ENGINE_DEFAULT_TIMEOUT_MS, 1, 600_000);
  const maxPending = intOpt("maxPending", opts.maxPending, PAPERWORK_ENGINE_DEFAULT_MAX_PENDING, 1, 1_024);
  const maxQueuedWriteBytes = intOpt("maxQueuedWriteBytes", opts.maxQueuedWriteBytes, 1_048_576, 65_536, 16_777_216);
  const maxRetiring = intOpt("maxRetiringChildren", opts.maxRetiringChildren, 4, 1, 32);
  const maxResponseBytes = intOpt("maxResponseBytes", opts.maxResponseBytes, PAPERWORK_ENGINE_DEFAULT_MAX_RESPONSE_BYTES, 128, 16_777_216);
  const closeGraceMs = intOpt("closeGraceMs", opts.closeGraceMs, 200, 0, 60_000);
  const closeKillTimeoutMs = intOpt("closeKillTimeoutMs", opts.closeKillTimeoutMs, 500, 1, 60_000);
  const spawnFn = opts.spawnFn ?? spawn;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Map<number, Pending>();
  const retiringChildren = new Set<ChildProcess>();
  const terminated = new WeakSet<ChildProcess>(), closeWaiters = new Set<() => void>();
  let activeChild: ChildProcess | null = null;
  let closed = false, nextId = 1, closePromise: Promise<void> | null = null;

  const err = (code: PaperworkEngineErrorCode, msg?: string, rpcCode?: number) => new PaperworkEngineError(code, msg, rpcCode);
  const destroyPipes = (proc: ChildProcess) => { proc.stdin?.destroy(); proc.stdout?.destroy(); proc.stderr?.destroy(); };
  function failAll(error: PaperworkEngineError): void {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }

  /** Active-state teardown; stale-child events no-op through the activeChild guard. */
  function resetActive(proc: ChildProcess, error: PaperworkEngineError): void {
    if (activeChild !== proc) return;
    activeChild = null;
    if (!terminated.has(proc)) {
      retiringChildren.add(proc);
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      destroyPipes(proc);
    }
    failAll(error);
  }

  function spawnChild(): ChildProcess {
    const proc = spawnFn(bin!, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    proc.stderr?.resume();
    const acc = new LineByteAccumulator(maxResponseBytes);
    // Retirement bookkeeping precedes the activeChild guard so a late exit/close
    // clears retirement and wakes close() without touching the replacement child.
    const gone = () => {
      if (terminated.has(proc)) return;
      terminated.add(proc); destroyPipes(proc); retiringChildren.delete(proc);
      for (const w of [...closeWaiters]) w();
      resetActive(proc, err("process_exited", "engine exited"));
    };
    for (const ev of ["exit", "close"] as const) proc.once(ev, gone);
    proc.on("error", () => resetActive(proc, err("process_exited", "engine process error")));
    proc.stdin?.on("error", () => resetActive(proc, err("process_exited", "stdin error")));
    proc.stdout?.on("end", () => resetActive(proc, err("process_exited", "stdout EOF")));
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (activeChild !== proc) return;
      const lines = acc.push(chunk);
      if (lines === null) return resetActive(proc, err("response_too_large", "response exceeds maxResponseBytes"));
      for (const line of lines) handleLine(proc, line);
    });
    activeChild = proc;
    return proc;
  }

  function handleLine(proc: ChildProcess, line: Buffer): void {
    let msg: unknown;
    try { msg = JSON.parse(decoder.decode(line)); }
    catch { return resetActive(proc, err("protocol_error", "malformed response line")); }
    const o = msg as Record<string, unknown> | null;
    const isObj = typeof o === "object" && o !== null && !Array.isArray(o);
    const id = isObj ? o.id : undefined, e = isObj ? o.error : undefined;
    const hasResult = isObj && "result" in o, hasError = isObj && "error" in o;
    const errOk = typeof e === "object" && e !== null && !Array.isArray(e)
      && Number.isInteger((e as Record<string, unknown>).code) && typeof (e as Record<string, unknown>).message === "string";
    if (!isObj || o.jsonrpc !== "2.0" || typeof id !== "number" || !Number.isInteger(id)
      || hasResult === hasError || (hasError && !errOk) || !pending.has(id as number)) {
      return resetActive(proc, err("protocol_error", "invalid JSON-RPC response envelope"));
    }
    const entry = pending.get(id as number)!;
    pending.delete(id as number); clearTimeout(entry.timer);
    if (hasError) { const rpc = e as { code: number; message: string }; entry.reject(err("rpc_error", rpc.message, rpc.code)); }
    else entry.resolve((o as { result: unknown }).result);
  }

  function call<T>(method: string, params?: unknown, callOpts?: { timeoutMs?: number }): Promise<T> {
    const perTimeout = intOpt("callOpts.timeoutMs", callOpts?.timeoutMs, timeoutMs, 1, 600_000);
    const id = nextId++; // reserved pre-stringify: a re-entrant toJSON() can never collide on ids
    let paramsJson: string | undefined;
    if (params !== undefined) {
      paramsJson = JSON.stringify(params) as string | undefined;
      if (typeof paramsJson !== "string" || (paramsJson[0] !== "{" && paramsJson[0] !== "[")) {
        return Promise.reject(new RangeError("params must serialize to a JSON object or array"));
      }
    }
    const payload = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)}`
      + (paramsJson === undefined ? "" : `,"params":${paramsJson}`) + "}";
    // Post-stringify checks: a re-entrant toJSON() may have closed the client or filled pending.
    if (closed) return Promise.reject(err("closed", "client is closed"));
    if (bin === null) return Promise.reject(err("bin_not_configured", "PAPERWORK_ENGINE_BIN is not configured"));
    if (Buffer.byteLength(payload, "utf8") > PAPERWORK_ENGINE_MAX_REQUEST_BYTES) {
      return Promise.reject(err("request_too_large", "request exceeds 64KiB"));
    }
    if (pending.size >= maxPending || (activeChild === null && retiringChildren.size >= maxRetiring)) {
      return Promise.reject(err("queue_full", "queue is full"));
    }
    let proc = activeChild;
    if (proc === null) try { proc = spawnChild(); } catch { return Promise.reject(err("process_exited", "spawn failed")); }
    const child = proc;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(err("timeout", `call timed out after ${perTimeout}ms`));
        resetActive(child, err("process_exited", "call timed out; engine reset"));
      }, perTimeout);
      timer.unref?.();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const frame = `${payload}\n`, stdin = child.stdin!;
      if (stdin.writableLength + Buffer.byteLength(frame, "utf8") > maxQueuedWriteBytes) {
        if (pending.delete(id)) { clearTimeout(timer); reject(err("queue_full", "stdin backpressure")); }
        return;
      }
      stdin.write(frame, (e?: Error | null) => { if (e) resetActive(child, err("process_exited", "stdin write failed")); });
    });
  }

  /** Deadline timer stays ref'ed while shutdown is pending; cleared on exit or expiry. */
  function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
    if (cond()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { closeWaiters.delete(check); resolve(cond()); }, ms);
      const check = () => { if (!cond()) return; clearTimeout(timer); closeWaiters.delete(check); resolve(true); };
      closeWaiters.add(check);
    });
  }

  async function shutdown(): Promise<void> {
    closed = true;
    failAll(err("closed", "client is closed"));
    const proc = activeChild;
    activeChild = null;
    if (proc !== null && !terminated.has(proc)) {
      retiringChildren.add(proc);
      try { proc.stdin?.end(); } catch { /* ignore */ }
      await waitFor(() => terminated.has(proc), closeGraceMs);
    }
    for (const p of [...retiringChildren]) { try { p.kill("SIGKILL"); } catch { /* ignore */ } destroyPipes(p); }
    if (retiringChildren.size === 0) return;
    if (!(await waitFor(() => retiringChildren.size === 0, closeKillTimeoutMs))) throw err("timeout", "engine children did not exit before the close deadline");
  }

  async function health(): Promise<PaperworkEngineHealth> {
    const o = (await call<unknown>("engine.health")) as PaperworkEngineHealth;
    if (!o || o.ok !== true || o.engine !== "paperwork-engine" || o.protocol_version !== 1
      || !Array.isArray(o.capabilities) || !o.capabilities.every((c) => typeof c === "string")) throw err("protocol_error", "bad engine.health result shape");
    return o;
  }
  async function redactText(text: string): Promise<{ redacted: string; changed: boolean }> {
    const o = (await call<unknown>("redactor.redact_text", { text })) as { redacted: string; changed: boolean };
    if (!o || typeof o.redacted !== "string" || typeof o.changed !== "boolean") throw err("protocol_error", "bad redactor.redact_text result shape");
    return o;
  }

  return { call, getPid: () => activeChild?.pid ?? null, close: () => (closePromise ??= shutdown()), health, redactText };
}
