import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  createEnterpriseBotsRouter,
  requireEnterpriseBotsBoardActor,
} from "../routes/enterprise-bots.js";
import {
  createBotTerminalChannelService,
  hashBotInboundToken,
  hashTerminalToken,
  type BotTerminalRecord,
  type EnterpriseBotRecord,
  type EnterpriseBotStore,
} from "../services/bot-terminal-channel.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const TERMINAL_ID = "00000000-0000-4000-8000-000000000101";
const BOT_ID = "00000000-0000-4000-8000-000000000201";
const AGENT_ID = "00000000-0000-4000-8000-000000000301";
const ISSUE_ID = "00000000-0000-4000-8000-000000000401";
const RUN_ID = "00000000-0000-4000-8000-000000000501";
const TERMINAL_TOKEN = `pcp_term_${"a".repeat(48)}`;
const BOT_TOKEN = `pcp_bot_${"b".repeat(48)}`;

function findBinary(): string | null {
  const candidates = [
    process.env.PAPERWORK_BOT_BIN ?? null,
    path.join(repoRoot, "target/debug/paperwork-bot"),
    path.join(repoRoot, "target/release/paperwork-bot"),
    path.join(repoRoot, "crates/bot-runtime/target/debug/paperwork-bot"),
    path.join(repoRoot, "crates/bot-runtime/target/release/paperwork-bot"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return candidates.find((v) => existsSync(v)) ?? null;
}

function findCargo(): string | null {
  if (process.env.CARGO && existsSync(process.env.CARGO)) return process.env.CARGO;
  const which = spawnSync("which", ["cargo"], { encoding: "utf8" });
  if (which.status === 0) {
    const found = which.stdout.trim().split("\n")[0];
    if (found && existsSync(found)) return found;
  }
  const cargoHome = path.join(process.env.HOME ?? "", ".cargo/bin/cargo");
  return existsSync(cargoHome) ? cargoHome : null;
}

const cargoBin = findCargo();
const hasRustE2EPrereqs = Boolean(cargoBin || findBinary());
let botBin = findBinary();

function memoryStore() {
  const terminals = new Map<string, BotTerminalRecord>([[TERMINAL_ID, {
    id: TERMINAL_ID, companyId: COMPANY_ID, kind: "personal_terminal", name: "e2e terminal",
    status: "offline", transport: "outbound_wss", ownerUserId: null, tokenHash: hashTerminalToken(TERMINAL_TOKEN),
    lastSeenAt: null, telemetry: null, healthHistory: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date(),
  }]]);
  const bots = new Map<string, EnterpriseBotRecord>([[BOT_ID, {
    id: BOT_ID, companyId: COMPANY_ID, kind: "company", name: "e2e bot", status: "active",
    callableBy: "company", agentId: AGENT_ID, ownerUserId: null, messageRoute: null,
    inboundTokenHash: hashBotInboundToken(BOT_TOKEN), sandboxProfile: null, transport: "outbound_wss",
    terminalId: TERMINAL_ID, lastPingAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date(),
  }]]);
  const copy = <T>(v: T): T => ({ ...(v as object) }) as T;
  const missing = (name: string) => async () => { throw new Error(`unused in e2e fixture: ${name}`); };
  const store: EnterpriseBotStore = {
    createTerminal: missing("createTerminal") as EnterpriseBotStore["createTerminal"],
    getTerminal: async (_companyId, id) => { const row = terminals.get(id); return row ? copy(row) : null; },
    getTerminalById: async (id) => { const row = terminals.get(id); return row ? copy(row) : null; },
    listTerminals: async (companyId) => [...terminals.values()].filter((r) => r.companyId === companyId).map(copy),
    updateTerminalTransport: async (id, transport) => {
      const row = terminals.get(id); if (!row) return null;
      const next = { ...row, transport, updatedAt: new Date() }; terminals.set(id, next); return copy(next);
    },
    markTerminalSeen: async (id, telemetry, healthEvent) => {
      const row = terminals.get(id); if (!row) return;
      const history = Array.isArray(row.healthHistory) ? row.healthHistory : [];
      terminals.set(id, { ...row, lastSeenAt: new Date(), status: "online", telemetry, healthHistory: [...history, healthEvent].slice(-50), updatedAt: new Date() });
    },
    createBot: missing("createBot") as EnterpriseBotStore["createBot"],
    getBot: async (_companyId, id) => { const row = bots.get(id); return row ? copy(row) : null; },
    getBotById: async (id) => { const row = bots.get(id); return row ? copy(row) : null; },
    listBots: async (companyId) => [...bots.values()].filter((r) => r.companyId === companyId).map(copy),
    updateBot: missing("updateBot") as EnterpriseBotStore["updateBot"],
    deleteBot: missing("deleteBot") as EnterpriseBotStore["deleteBot"],
    recordBotPing: async (id) => { const row = bots.get(id); if (row) bots.set(id, { ...row, lastPingAt: new Date(), updatedAt: new Date() }); },
    listBotCapabilities: async () => [],
    listPendingBotApprovals: async () => [],
    decideBotApproval: missing("decideBotApproval") as EnterpriseBotStore["decideBotApproval"],
    getBotCapability: async () => null,
    getChannel: async () => null,
    listChannels: async () => [],
    listChannelMemberIds: async () => [],
    hasBotApproval: async () => false,
  };
  return { store };
}

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

function runtimeEnv(extra: Record<string, string>) {
  return { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: socketRuntimeDir, ...extra };
}

async function runBot(args: string[], extraEnv: Record<string, string>, input = "") {
  if (!botBin) throw new Error("paperwork-bot binary was not resolved");
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(botBin!, args, { env: runtimeEnv(extraEnv), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`paperwork-bot timed out: ${args.join(" ")}`)); }, 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function expectNoTokenLeak(result: { stdout: string; stderr: string }, token: string) {
  expect(result.stdout).not.toContain(token);
  expect(result.stderr).not.toContain(token);
}

const socketRuntimeDir = hasRustE2EPrereqs ? mkdtempSync(path.join(tmpdir(), "paperwork-bot-e2e-")) : path.join(tmpdir(), "paperwork-bot-e2e-skipped");
let server: Server | null = null;
let baseUrl = "";
let captured: CapturedRequest[] = [];
let createdIssues: Array<Record<string, unknown>> = [];
let wakes: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
let activityEvents: Array<Record<string, unknown>> = [];

describe.skipIf(!hasRustE2EPrereqs)("paperwork-bot daemon E2E over real HTTP", () => {
  beforeAll(() => {
    if (cargoBin) {
      execFileSync(cargoBin, ["build", "-p", "paperwork-bot-runtime", "--manifest-path", path.join(repoRoot, "Cargo.toml")], { stdio: "inherit" });
    }
    const resolved = findBinary();
    if (!resolved) throw new Error("paperwork-bot binary not found after cargo build");
    botBin = resolved;
  }, 240_000);

  beforeAll(async () => {
    const memory = memoryStore();
    createdIssues = []; wakes = []; activityEvents = [];
    const service = createBotTerminalChannelService(memory.store, {
      createInboundIssue: async (_companyId, input) => {
        createdIssues.push(input as unknown as Record<string, unknown>);
        return { id: ISSUE_ID, identifier: "E2E-1" };
      },
      wakeAgent: async (agentId, payload) => {
        wakes.push({ agentId, payload });
        return { id: RUN_ID };
      },
      onInboundActivity: async (input) => { activityEvents.push(input as unknown as Record<string, unknown>); },
    });
    const app = express();
    app.use(express.json());
    captured = [];
    app.use((req, _res, next) => {
      captured.push({ method: req.method, path: req.path, authorization: req.header("authorization") ?? null, body: req.body });
      next();
    });
    app.use("/api/enterprise-bots", requireEnterpriseBotsBoardActor, createEnterpriseBotsRouter(service, async () => null));
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ephemeral server did not expose a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
    rmSync(socketRuntimeDir, { recursive: true, force: true });
  });

  it("doctor succeeds against compatibility without leaking the terminal token", async () => {
    const result = await runBot(["doctor", "--server", baseUrl], { PAPERWORK_TERMINAL_TOKEN: TERMINAL_TOKEN });
    expectNoTokenLeak(result, TERMINAL_TOKEN);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report).toMatchObject({ ok: true, daemonVersion: expect.any(String), protocolVersion: expect.any(String) });
    expect(report.checks.tokenEnv).toMatchObject({ ok: true, present: true, tokenKind: "terminal" });
    expect(report.checks.compatibility).toMatchObject({ ok: true, status: 200 });
    expect(report.checks.controlSocketDir.ok).toBe(true);
    expect(report.checks.processSupervisor.ok).toBe(true);
    const request = captured.find((r) => r.method === "GET" && r.path === "/api/enterprise-bots/compatibility");
    expect(request?.authorization).toBe(`Bearer ${TERMINAL_TOKEN}`);
  });

  it("heartbeat reaches the server with enriched telemetry and the terminal Bearer token", async () => {
    const result = await runBot(["heartbeat", "--server", baseUrl, "--terminal-id", TERMINAL_ID], { PAPERWORK_TERMINAL_TOKEN: TERMINAL_TOKEN });
    expectNoTokenLeak(result, TERMINAL_TOKEN);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { ok?: unknown; status?: unknown };
    expect(typeof output.ok).toBe("boolean");
    expect(typeof output.status).toBe("number");
    const request = captured.find((r) => r.method === "POST" && r.path === `/api/enterprise-bots/terminals/${TERMINAL_ID}/heartbeat`);
    expect(request).toBeDefined();
    expect(request?.authorization).toBe(`Bearer ${TERMINAL_TOKEN}`);
    expect(request?.body).toMatchObject({
      status: "online", os: expect.any(String), arch: expect.any(String), daemonVersion: expect.any(String),
      protocolVersion: expect.anything(), uptimeSecs: expect.any(Number), activeChildren: 0,
    });
    expect(JSON.stringify(request?.body)).not.toContain(TERMINAL_TOKEN);
  });

  it("inbound submits the E2E task with a bot Bearer token and no token leakage", async () => {
    const wirePayload = { event: "inbound", title: "E2E Task", message: "created by the daemon e2e", priority: "high", metadata: { source: "vitest" } };
    const result = await runBot(
      ["inbound", "--server", baseUrl, "--bot-id", BOT_ID, "--title", "E2E Task"],
      { PAPERWORK_BOT_TOKEN: BOT_TOKEN },
      JSON.stringify(wirePayload),
    );
    expectNoTokenLeak(result, BOT_TOKEN);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { ok?: boolean; status?: number; body?: string };
    expect(output).toMatchObject({ ok: true, status: 200 });
    const responseBody = JSON.parse(String(output.body)) as Record<string, unknown>;
    expect(responseBody).toMatchObject({ ok: true, botId: BOT_ID, issueId: ISSUE_ID, wokenAgentId: AGENT_ID, runId: RUN_ID });
    const request = captured.find((r) => r.method === "POST" && r.path === `/api/enterprise-bots/bots/${BOT_ID}/inbound`);
    expect(request?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(request?.body).toMatchObject({ event: "inbound", title: "E2E Task", message: wirePayload.message, priority: "high" });
    expect(createdIssues[0]).toMatchObject({ title: "E2E Task", priority: "high", assigneeAgentId: AGENT_ID });
    expect(wakes[0]).toMatchObject({ agentId: AGENT_ID, payload: expect.objectContaining({ event: "inbound", title: "E2E Task", issueId: ISSUE_ID }) });
    expect(activityEvents[0]).toMatchObject({ event: "inbound", botId: BOT_ID, issueId: ISSUE_ID });
    expect(JSON.stringify(request?.body)).not.toContain(BOT_TOKEN);
  });
});
