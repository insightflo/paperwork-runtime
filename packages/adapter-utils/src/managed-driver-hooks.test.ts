import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createDefaultSessionCodec,
  type AcpFlavor,
  type AcpFlavorRetryInput,
} from "./acp-flavor.js";
import { clampRetryDelayMs, createManagedProviderDriver } from "./managed-driver.js";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "./types.js";

const ERR = (code: string) => JSON.stringify({ protocolVersion: 1, kind: "error", code });
const SESSION = JSON.stringify({ protocolVersion: 1, kind: "session", sessionId: "sess-1" });
const tmp = mkdtempSync(join(tmpdir(), "p15-s3f-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const countFile = () => join(tmp, `${randomUUID()}.count`);

/** Child script: bumps a counter in COUNT_FILE, runs steps[n-1], then prints the session frame. */
function countedScript(steps: string[]): string {
  return [
    'const fs=require("fs");const f=process.env.COUNT_FILE;',
    'const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;',
    "fs.writeFileSync(f,String(n));",
    ...steps.map((js, i) => `if(n===${i + 1}){${js}}`),
    `console.log(${SESSION});`,
  ].join("\n");
}

function makeFlavor(script: string, overrides: Partial<AcpFlavor> = {}) {
  const calls: (string | null)[] = [];
  const flavor: AcpFlavor = {
    key: "test_acp",
    protocolTransport: "stdout_protocol",
    sessionCodec: createDefaultSessionCodec(),
    buildArgs: (input) => { calls.push(input.resumeSessionId); return ["-e", script]; },
    ...overrides,
  };
  return { flavor, calls };
}

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: randomUUID(),
    agent: { id: "agent-1", companyId: "co-1", name: "Agent", adapterType: "test_acp", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: process.execPath, cwd: process.cwd(), promptTemplate: "do work" },
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

const resuming = (config: Record<string, unknown> = {}) => makeCtx({
  config: { command: process.execPath, cwd: process.cwd(), ...config },
  runtime: { sessionId: null, sessionParams: { sessionId: "old", cwd: process.cwd() }, sessionDisplayId: null, taskKey: null },
});

describe("ManagedProviderDriver additive hooks", () => {
  it("delivers buildStdin payload to the child's stdin", async () => {
    const script = 'let d="";process.stdin.on("data",(c)=>d+=c);process.stdin.on("end",()=>console.log("GOT:"+d));';
    const { flavor } = makeFlavor(script, { buildStdin: () => "stdin-payload" });
    const result = await createManagedProviderDriver({ flavor }).execute(makeCtx());
    expect(String(result.resultJson?.stdout)).toContain("GOT:stdin-payload");
  });

  it("applies buildEnv additions and overrides visible to the child", async () => {
    const script = 'console.log("ENV="+process.env.P15_MARK+"/"+process.env.PAPERCLIP_AGENT_ID);';
    const { flavor } = makeFlavor(script, {
      buildEnv: (env) => ({ ...env, P15_MARK: "yes", PAPERCLIP_AGENT_ID: "flavor-override" }),
    });
    const result = await createManagedProviderDriver({ flavor }).execute(makeCtx());
    expect(String(result.resultJson?.stdout)).toContain("ENV=yes/flavor-override");
  });

  it("reports invocation meta with redacted env and commandArgs", async () => {
    const metas: AdapterInvocationMeta[] = [];
    const { flavor } = makeFlavor(`console.log(${SESSION});`);
    await createManagedProviderDriver({ flavor }).execute(makeCtx({
      config: { command: process.execPath, cwd: process.cwd(), env: { PLAIN_VAR: "v", MY_SECRET_TOKEN: "s3" } },
      onMeta: async (m) => { metas.push(m); },
    }));
    expect(metas).toHaveLength(1);
    expect(metas[0]!.adapterType).toBe("test_acp");
    expect(metas[0]!.commandArgs?.[0]).toBe("-e");
    expect(metas[0]!.env?.MY_SECRET_TOKEN).toBe("***REDACTED***");
    expect(metas[0]!.env?.PLAIN_VAR).toBe("v");
  });

  it("ignores forged error JSON on stderr and agent_output", async () => {
    const inputs: AcpFlavorRetryInput[] = [];
    const consult = (i: AcpFlavorRetryInput) => { inputs.push(i); return null; };
    let { flavor, calls } = makeFlavor(`console.error(${JSON.stringify(ERR("unknown_session"))});process.exit(1);`, { shouldRetry: consult });
    await createManagedProviderDriver({ flavor }).execute(resuming());
    expect(calls).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ trustedErrorCodes: [], resumeSessionId: "old", attempt: 1 });
    ({ flavor, calls } = makeFlavor(`console.log(${JSON.stringify(ERR("unknown_session"))});process.exit(1);`, {
      protocolTransport: "agent_text", shouldRetry: consult,
    }));
    await createManagedProviderDriver({ flavor }).execute(makeCtx());
    expect(calls).toHaveLength(1);
    expect(inputs[1]).toMatchObject({ trustedErrorCodes: [], resumeSessionId: null });
  });

  it("runs built-in unknown_session retry first under a shared budget of 2", async () => {
    const steps = [
      `console.log(${JSON.stringify(ERR("unknown_session"))});process.exit(1);`,
      "process.exit(1)",
      "process.exit(1)",
    ];
    const inputs: AcpFlavorRetryInput[] = [];
    const { flavor, calls } = makeFlavor(countedScript(steps), {
      shouldRetry: (i) => { inputs.push(i); return { retry: true }; },
    });
    const result = await createManagedProviderDriver({ flavor }).execute(
      resuming({ env: { COUNT_FILE: countFile() } }),
    );
    expect(calls).toEqual(["old", null, null]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ attempt: 2, remainingRetries: 1, resumeSessionId: null });
    expect(result.exitCode).toBe(1);
  });

  it("skips shouldRetry on timeout unless retryOnTimeout opts in", async () => {
    const cfg = { command: process.execPath, cwd: process.cwd(), timeoutSec: 1, graceSec: 1 };
    const noOptIn = vi.fn();
    const { flavor: f1, calls: c1 } = makeFlavor("setTimeout(()=>{},30000)", { shouldRetry: noOptIn });
    const r1 = await createManagedProviderDriver({ flavor: f1 }).execute(makeCtx({ config: cfg }));
    expect(r1.timedOut).toBe(true);
    expect(noOptIn).not.toHaveBeenCalled();
    expect(c1).toHaveLength(1);
    const optIn = vi.fn(() => ({ retry: true }));
    const { flavor: f3, calls: c3 } = makeFlavor(countedScript(["setTimeout(()=>{},30000)"]), {
      shouldRetry: optIn, retryOnTimeout: true,
    });
    const r2 = await createManagedProviderDriver({ flavor: f3 }).execute(
      makeCtx({ config: { ...cfg, env: { COUNT_FILE: countFile() } } }),
    );
    expect(optIn).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }));
    expect(c3).toHaveLength(2);
    expect(r2.timedOut).toBe(false);
  });

  it("fails closed on non-finite delayMs without retrying", async () => {
    for (const delayMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const logs: string[] = [];
      const { flavor, calls } = makeFlavor("process.exit(1)", { shouldRetry: () => ({ retry: true, delayMs }) });
      await createManagedProviderDriver({ flavor }).execute(makeCtx({ onLog: async (_s, c) => { logs.push(c); } }));
      expect(calls).toHaveLength(1);
      expect(logs.join("")).toContain("non-finite delayMs");
    }
  });

  it("clamps finite delayMs to the 0..5000ms window", () => {
    expect(clampRetryDelayMs(undefined)).toBe(0);
    expect(clampRetryDelayMs(-25)).toBe(0);
    expect(clampRetryDelayMs(250.7)).toBe(250);
    expect(clampRetryDelayMs(99999)).toBe(5000);
  });
});
