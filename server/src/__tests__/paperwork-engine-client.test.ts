import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPaperworkEngineClient, LineByteAccumulator, PAPERWORK_ENGINE_MAX_REQUEST_BYTES,
  resolvePaperworkEngineBin, type PaperworkEngineClientOptions,
} from "../services/paperwork-engine-client.js";

const STUB = `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const send = (r) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...r }) + "\\n");
  const m = req.method, p = req.params ?? {};
  if (m === "engine.health") return send({ result: { ok: true, engine: "paperwork-engine", protocol_version: 1, capabilities: ["engine.health", "redactor.redact_text"] } });
  if (m === "redactor.redact_text") return send({ result: { redacted: p.text.replace(/sk-[^ ]+/g, "[redacted]"), changed: p.text.includes("sk-") } });
  if (m === "wedge") return;
  if (m === "end_stdout" || m === "crash") return m === "crash" ? process.exit(2) : process.stdout.end();
  if (m === "raw") { process.stdout.write(p.raw.endsWith("\\n") ? p.raw : p.raw + "\\n"); return send({ result: "emitted" }); }
  if (m === "raw_b64") { process.stdout.write(Buffer.concat([Buffer.from(p.b64, "base64"), Buffer.from("\\n")])); return send({ result: "emitted" }); }
  if (m === "split") { const ps = p.parts.map((x) => Buffer.from(x, "base64")); const step = (i) => i >= ps.length ? send({ result: "emitted" }) : (process.stdout.write(ps[i]), setTimeout(() => step(i + 1), p.delayMs ?? 15)); return step(0); }
  return send({ error: { code: -32601, message: "method_not_found" } });
});
`;

let dir = "", stubPath = "";
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "pw-engine-client-")); stubPath = path.join(dir, "stub.mjs"); writeFileSync(stubPath, STUB); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mk = (o: PaperworkEngineClientOptions = {}) => createPaperworkEngineClient({ bin: process.execPath, args: [stubPath], ...o });
const line = (id: number, k: "result" | "error", v: unknown) => JSON.stringify({ jsonrpc: "2.0", id, [k]: v }) + "\n";
const emit = (c: any, s: string | Buffer) => c.stdout.emit("data", Buffer.isBuffer(s) ? s : Buffer.from(s));

function fakeChild(pid: number) {
  const c = new EventEmitter() as any;
  c.pid = pid;
  for (const tag of ["stdin", "stdout", "stderr"] as const) {
    const s = new EventEmitter() as any;
    s.writableLength = 0;
    s.write = (d: string, cb?: (e?: Error | null) => void) => { c.lastWrite = d; cb?.(c.writeErr ?? null); return true; };
    s.end = () => { c.stdinEnded = true; }; s.resume = () => {};
    s.destroy = () => { c[`${tag}Dead`] = true; return s; };
    c[tag] = s;
  }
  c.kill = () => { c.killed = true; return true; };
  return c;
}
function harness(o: PaperworkEngineClientOptions = {}, writeErr?: Error) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = (() => { const c = fakeChild(100 + children.length); c.writeErr = writeErr; children.push(c); return c; }) as any;
  return { children, client: createPaperworkEngineClient({ bin: "/bin/fake", spawnFn, ...o }) };
}

describe("resolvePaperworkEngineBin and option bounds", () => {
  it("gates the bin path, validates numeric bounds, maps spawn failure to process_exited", async () => {
    expect(resolvePaperworkEngineBin("")).toBeNull();
    expect(resolvePaperworkEngineBin("rel/bin")).toBeNull();
    expect(resolvePaperworkEngineBin("/x\0y")).toBeNull();
    expect(resolvePaperworkEngineBin("/abs/bin")).toBe("/abs/bin");
    const noBin = createPaperworkEngineClient({ bin: "" });
    await expect(noBin.call("m")).rejects.toMatchObject({ code: "bin_not_configured" });
    for (const bad of [0, -1, 1.5, NaN, Infinity, 600_001]) expect(() => mk({ timeoutMs: bad })).toThrow(RangeError);
    for (const good of [1, 600_000]) expect(() => mk({ timeoutMs: good })).not.toThrow();
    for (const [k, v] of [["maxPending", 0], ["maxQueuedWriteBytes", 65_535], ["maxRetiringChildren", 33],
      ["maxResponseBytes", 127], ["closeGraceMs", -1], ["closeKillTimeoutMs", 60_001]] as const) {
      expect(() => mk({ [k]: v })).toThrow(RangeError);
    }
    const c = mk();
    expect(() => c.call("m", {}, { timeoutMs: 0 })).toThrow(RangeError);
    const missing = createPaperworkEngineClient({ bin: path.join(dir, "no-such-engine") });
    await expect(missing.call("m")).rejects.toMatchObject({ code: "process_exited" });
    await Promise.all([c.close(), missing.close()]);
  });
});

describe("resident stub server", () => {
  it("reuses PID across calls and keeps it through rpc_error; close() is shared", async () => {
    const c = mk();
    expect(await c.health()).toMatchObject({ ok: true, engine: "paperwork-engine", protocol_version: 1 });
    const pid = c.getPid();
    expect(await c.redactText("token sk-ant-abc123")).toEqual({ redacted: "token [redacted]", changed: true });
    await expect(c.call("nope")).rejects.toMatchObject({ code: "rpc_error", rpcCode: -32601 });
    expect(c.getPid()).toBe(pid);
    expect(c.close()).toBe(c.close());
    await c.close();
    await expect(c.call("engine.health")).rejects.toMatchObject({ code: "closed" });
  });

  it("fails closed on malformed envelopes, bad error shape, and invalid UTF-8", async () => {
    const c = mk();
    const p1 = c.call("wedge");
    await expect(c.call("raw", { raw: '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"x"}}' })).rejects.toMatchObject({ code: "protocol_error" });
    await expect(p1).rejects.toMatchObject({ code: "protocol_error" });
    expect(c.getPid()).toBeNull();
    const p2 = c.call("wedge");
    const badUtf8 = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":3,"result":1}'), Buffer.from([0xff])]).toString("base64");
    await expect(c.call("raw_b64", { b64: badUtf8 })).rejects.toMatchObject({ code: "protocol_error" });
    await expect(p2).rejects.toMatchObject({ code: "protocol_error" });
    const p3 = c.call("wedge");
    await expect(c.call("raw", { raw: '{"jsonrpc":"2.0","id":5,"error":{"code":-32602.5,"message":"x"}}' })).rejects.toMatchObject({ code: "protocol_error" });
    await expect(p3).rejects.toMatchObject({ code: "protocol_error" });
    await c.close();
  });
  it("reassembles coalesced lines and multi-byte UTF-8 split across chunks", async () => {
    const c = mk();
    const p1 = c.call("wedge"), p2 = c.call("wedge");
    await expect(c.call("raw", { raw: line(1, "result", "a") + line(2, "result", "b") })).resolves.toBe("emitted");
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
    const p3 = c.call("wedge");
    const full = Buffer.from('{"jsonrpc":"2.0","id":4,"result":"héllo ✓"}\n');
    const cut = full.indexOf(0xa9); // inside é (0xc3 0xa9)
    await expect(c.call("split", { parts: [full.subarray(0, cut).toString("base64"), full.subarray(cut).toString("base64")] })).resolves.toBe("emitted");
    await expect(p3).resolves.toBe("héllo ✓");
    await c.close();
  });
  it("rejects in-flight calls on EOF/crash/timeout/oversize, then respawns", async () => {
    const c = mk({ timeoutMs: 500, maxResponseBytes: 256 });
    let prev = (await c.health(), c.getPid());
    await expect(c.call("end_stdout")).rejects.toMatchObject({ code: "process_exited" });
    expect(c.getPid()).toBeNull();
    await c.health();
    expect(c.getPid()).not.toBe(prev); prev = c.getPid();
    await expect(c.call("crash")).rejects.toMatchObject({ code: "process_exited" });
    await c.health();
    expect(c.getPid()).not.toBe(prev); prev = c.getPid();
    await expect(c.call("wedge")).rejects.toMatchObject({ code: "timeout" });
    await c.health();
    expect(c.getPid()).not.toBe(prev);
    const p = c.call("wedge");
    await expect(c.call("raw", { raw: `{"jsonrpc":"2.0","id":9,"result":"${"x".repeat(400)}"}` })).rejects.toMatchObject({ code: "response_too_large" });
    await expect(p).rejects.toMatchObject({ code: "response_too_large" });
    await c.close();
  });
  it("rejects oversized requests and full queues without killing the child", async () => {
    const c = mk({ maxPending: 2 });
    const p = c.call("wedge"); p.catch(() => {});
    const pid = c.getPid();
    await expect(c.call("engine.health", { pad: "x".repeat(PAPERWORK_ENGINE_MAX_REQUEST_BYTES) })).rejects.toMatchObject({ code: "request_too_large" });
    expect(c.getPid()).toBe(pid);
    c.call("wedge").catch(() => {});
    await expect(c.call("engine.health")).rejects.toMatchObject({ code: "queue_full" });
    expect(c.getPid()).toBe(pid);
    await c.close();
    await expect(p).rejects.toMatchObject({ code: "closed" });
  });
});

describe("LineByteAccumulator", () => {
  it("decodes 1-byte fragments with bounded block count and fails closed over the cap", () => {
    const acc = new LineByteAccumulator(1_048_576);
    const input = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"héllo"}\r\n');
    const lines: Buffer[] = [];
    for (const b of input) expect(acc.push(Buffer.from([b]), (l) => (lines.push(l), true))).toBe(true);
    expect(lines.map((l) => l.toString("utf8"))).toEqual(['{"jsonrpc":"2.0","id":1,"result":"héllo"}']);
    expect(acc.allocatedBlocks).toBeLessThanOrEqual(Math.ceil(input.length / 8192));
    expect(new LineByteAccumulator(8).push(Buffer.alloc(9), () => true)).toBe(false);
  });
});

describe("deterministic fake-child behavior", () => {
  it("rejects queue_full on stdin backpressure without writing", async () => {
    const { children, client } = harness();
    const p = client.call("m", {});
    children[0].stdin.writableLength = 1_048_576;
    await expect(client.call("m2", {})).rejects.toMatchObject({ code: "queue_full" });
    expect(children[0].lastWrite).toBe(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: {} }) + "\n");
    emit(children[0], line(1, "result", "ok"));
    await expect(p).resolves.toBe("ok");
    children[0].emit("exit");
    await client.close();
  });
  it("bounds retiring children, restores capacity on exit-only, destroys all pipes", async () => {
    const { children, client } = harness({ maxRetiringChildren: 1 });
    const p = client.call("m", {}); p.catch(() => {});
    emit(children[0], "garbage\n"); // protocol_error retires c0 while still alive
    await expect(p).rejects.toMatchObject({ code: "protocol_error" });
    await expect(client.call("m", {})).rejects.toMatchObject({ code: "queue_full" });
    expect(children).toHaveLength(1);
    children[0].emit("exit"); // exit without a following close event
    expect(children[0].stdinDead && children[0].stdoutDead && children[0].stderrDead).toBe(true);
    const p2 = client.call("m", {});
    emit(children[1], line(3, "result", "ok"));
    await expect(p2).resolves.toBe("ok");
    children[1].emit("exit");
    await client.close();
  });
  it("ignores stale child exit/close after replacement is active", async () => {
    const { children, client } = harness();
    const p = client.call("m", {}); p.catch(() => {});
    emit(children[0], "bad\n");
    await expect(p).rejects.toMatchObject({ code: "protocol_error" });
    const p2 = client.call("m2", {});
    children[0].emit("exit");
    children[0].emit("close");
    emit(children[1], line(2, "result", "new"));
    await expect(p2).resolves.toBe("new");
    children[1].emit("exit"); // exit without close on a live child destroys all three pipes
    expect(children[1].stdinDead && children[1].stdoutDead && children[1].stderrDead).toBe(true);
    await expect(harness({}, new Error("EPIPE")).client.call("m", {})).rejects.toMatchObject({ code: "process_exited" }); // write cb error
    await client.close();
  });
  it("close() awaits a non-exited retiring child: resolves on late exit, times out otherwise", async () => {
    const ok = harness({ closeKillTimeoutMs: 500 });
    const p1 = ok.client.call("m", {}); p1.catch(() => {});
    emit(ok.children[0], "bad\n");
    await expect(p1).rejects.toMatchObject({ code: "protocol_error" });
    const cp = ok.client.close();
    ok.children[0].emit("close");
    await expect(cp).resolves.toBeUndefined();
    const stuck = harness({ closeGraceMs: 5, closeKillTimeoutMs: 40 });
    const p2 = stuck.client.call("m", {}); p2.catch(() => {});
    emit(stuck.children[0], "bad\n");
    await expect(p2).rejects.toMatchObject({ code: "protocol_error" });
    await expect(stuck.client.close()).rejects.toMatchObject({ code: "timeout" });
  });
  it("rejects re-entrant toJSON() that closes the client without spawning", async () => {
    const { children, client } = harness();
    const closeParams = { toJSON() { void client.close().catch(() => {}); return {}; } };
    await expect(client.call("m", closeParams)).rejects.toMatchObject({ code: "closed" });
    expect(children).toHaveLength(0);
    await expect(client.call("m", { toJSON: () => 42 })).rejects.toThrow(RangeError);
  });
  it("resolves a completed reply before an oversized frame, coalesced or split", async () => {
    for (const coalesced of [true, false]) {
      const { children, client } = harness({ maxResponseBytes: 128 });
      const p1 = client.call("m", {});
      const p2 = client.call("m", {});
      const good = line(1, "result", "ok"), big = line(2, "result", "x".repeat(200));
      if (coalesced) emit(children[0], good + big);
      else { emit(children[0], good); emit(children[0], big); }
      await expect(p1).resolves.toBe("ok");
      await expect(p2).rejects.toMatchObject({ code: "response_too_large" });
      expect(children[0].killed).toBe(true);
      children[0].emit("exit");
      await client.close();
    }
  });
  it("keeps distinct ids for a nested toJSON() call and resolves reversed replies", async () => {
    const { children, client } = harness({ maxPending: 2 });
    let nested!: Promise<unknown>;
    const p = client.call("outer", { toJSON() { nested = client.call("inner", { x: 1 }); return {}; } });
    emit(children[0], line(2, "result", "B") + line(1, "result", "A"));
    await expect(p).resolves.toBe("A");
    await expect(nested).resolves.toBe("B");
    children[0].emit("exit");
    await client.close();
  });
});

describe("shutdown deadline keeps the event loop alive", () => {
  it("fires a ref'ed close deadline with no other live handles", () => {
    const svc = fileURLToPath(new URL("../services/paperwork-engine-client.ts", import.meta.url));
    const probe = path.join(dir, "probe.ts");
    writeFileSync(probe, `import { EventEmitter } from "node:events";
import { createPaperworkEngineClient } from ${JSON.stringify(svc)};
const fake = () => { const c = new EventEmitter() as any;
  for (const t of ["stdin", "stdout", "stderr"]) { const s = new EventEmitter() as any;
    s.write = (_d: string, cb?: (e?: Error | null) => void) => { cb?.(null); return true; };
    s.end = () => {}; s.resume = () => {}; s.destroy = () => {}; c[t] = s; }
  c.pid = 1; c.kill = () => true; return c; };
const client = createPaperworkEngineClient({ bin: "/bin/fake", spawnFn: fake as any, closeGraceMs: 5, closeKillTimeoutMs: 40 });
client.call("m", {}).catch(() => {});
client.close().then(() => console.log("CLOSED")).catch((e) => console.log("CLOSE_ERR:" + e.code));
`);
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const r = spawnSync(tsx, [probe], { encoding: "utf8", timeout: 15_000, cwd: dir });
    expect(r.stdout).toContain("CLOSE_ERR:timeout");
  });
});
