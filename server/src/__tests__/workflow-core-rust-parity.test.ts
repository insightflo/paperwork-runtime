import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  appendRetryAttempt,
  calculateWorkflowRetryDelaySeconds,
  classifyWorkflowStepRetry,
  hasMalformedWorkflowRetry,
  isStepRunAwaitingRetry,
  isWorkflowRetryDue,
  normalizeWorkflowRetryPolicy,
  readWorkflowRetryMetadata,
  sanitizeErrorSummary,
} from "../services/workflow/retry-policy.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

function runRust<T>(subcommand: string, payload: unknown): T {
  const stdout = execFileSync(rustBin, [subcommand], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return JSON.parse(stdout) as T;
}

beforeAll(() => {
  const cargoBin = process.env.CARGO || "cargo";
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 120_000);

describe("paperclip-workflow-core Rust parity (retry-policy & retry-metadata)", () => {
  it("matches normalizeWorkflowRetryPolicy across edge cases", () => {
    const cases = [
      { onFailure: "retry" },
      { onFailure: "retry", maxRetries: 0 },
      { onFailure: "retry", maxRetries: "3" as unknown as number },
      { onFailure: "abort_workflow", maxRetries: 3 },
      { onFailure: "retry", graphRetryBackoff: "Exponential", graphRetryDelaySeconds: 3.9, graphRetryJitter: true },
      { onFailure: "retry", graphRetryBackoff: "aggressive", graphRetryDelaySeconds: -5 },
    ];
    for (const c of cases) {
      expect(runRust("normalize-policy", c)).toEqual(normalizeWorkflowRetryPolicy(c));
    }
  });

  it("matches calculateWorkflowRetryDelaySeconds and classifyWorkflowStepRetry", () => {
    const delayCases = [
      { delaySeconds: 10, backoff: "fixed" as const, jitter: false, retryNumber: 3, randomSample: 0.5 },
      { delaySeconds: 10, backoff: "linear" as const, jitter: false, retryNumber: 3, randomSample: 0.5 },
      { delaySeconds: 10, backoff: "exponential" as const, jitter: false, retryNumber: 4, randomSample: 0.5 },
      { delaySeconds: 0, backoff: "exponential" as const, jitter: true, retryNumber: 5, randomSample: 0.9 },
      { delaySeconds: 100, backoff: "fixed" as const, jitter: true, retryNumber: 1, randomSample: 0.0 },
      { delaySeconds: 100, backoff: "fixed" as const, jitter: true, retryNumber: 1, randomSample: 1.0 },
      { delaySeconds: 200_000, backoff: "linear" as const, jitter: false, retryNumber: 1, randomSample: 0.5 },
      { delaySeconds: 1e18, backoff: "exponential" as const, jitter: false, retryNumber: 2000, randomSample: 0.5 },
    ];
    for (const c of delayCases) {
      const ts = calculateWorkflowRetryDelaySeconds(c, c.retryNumber, () => c.randomSample);
      expect(runRust<{ delaySeconds: number }>("calculate-delay", c).delaySeconds).toBe(ts);
    }

    const basePolicy = { enabled: true, maxRetries: 2, delaySeconds: 30, backoff: "linear" as const, jitter: false };
    const classCases = [
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 2, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: true, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "failed", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: true, qaRequestChanges: true, recoveryActive: false },
      { policy: basePolicy, stepRunStatus: "pending", retryCount: 0, isControlNode: false, stepTypeSupported: true, isQaStep: false, qaRequestChanges: false, recoveryActive: false },
    ];
    for (const c of classCases) {
      expect(runRust("classify-retry", { ...c, randomSample: 0.5 })).toEqual(
        classifyWorkflowStepRetry(c, () => 0.5),
      );
    }
  });

  it("matches sanitizeErrorSummary, appendRetryAttempt, and retry metadata predicates", () => {
    const errors = [
      '{"apiKey":"secret"}',
      "Authorization: Bearer abc123token failed",
      "éBearer secret123",
      "error with sk-1234567890abcdefghij1234",
      "password=hunter2\nline2",
      {},
      [],
      [1, 2],
      "   ",
    ];
    for (const value of errors) {
      expect(runRust<{ summary: string | null }>("sanitize-error", { value }).summary).toBe(
        sanitizeErrorSummary(value),
      );
    }

    const history = [{ retryNumber: 0, failedAt: "2026-11-20T00:00:00.000Z", errorSummary: "err 1" }, { bad: true }];
    const attempt = { retryNumber: 1, failedAt: "2026-11-20T00:01:00.000Z", errorSummary: "Bearer secretToken" };
    expect(runRust("append-attempt", { history, attempt })).toEqual(appendRetryAttempt(history, attempt));

    const validRetry = {
      state: "waiting",
      retryNumber: 1,
      maxRetries: 2,
      nextEligibleAt: "2026-11-20T01:00:00.000Z",
      sourceRequestId: "req-1",
    };
    const nowIso = "2026-11-20T01:00:00.000Z";
    expect(runRust("read-metadata", { metadata: validRetry })).toEqual(readWorkflowRetryMetadata(validRetry));
    expect(runRust("is-due", { metadata: validRetry, nowIso })).toEqual({
      due: isWorkflowRetryDue(validRetry, new Date(nowIso)),
      awaiting: isStepRunAwaitingRetry(validRetry),
      malformed: hasMalformedWorkflowRetry(validRetry),
    });
    const wrapped = { workflowRetry: validRetry };
    expect(runRust("is-due", { metadata: wrapped, nowIso })).toEqual({
      due: isWorkflowRetryDue(wrapped, new Date(nowIso)),
      awaiting: isStepRunAwaitingRetry(wrapped),
      malformed: hasMalformedWorkflowRetry(wrapped),
    });

    for (const badTs of ["292471209-01-01T00:00:00Z", "10000-01-01T00:00:00Z", "2026-1-1T0:0:0Z"]) {
      const m = { workflowRetry: { ...validRetry, nextEligibleAt: badTs } };
      expect(runRust("is-due", { metadata: m, nowIso })).toEqual({
        due: isWorkflowRetryDue(m, new Date(nowIso)),
        awaiting: isStepRunAwaitingRetry(m),
        malformed: hasMalformedWorkflowRetry(m),
      });
    }
    for (const okTs of ["2026-11-20T09:00:00+09:00", "2026-11-20"]) {
      const m = { workflowRetry: { ...validRetry, nextEligibleAt: okTs } };
      expect(runRust("is-due", { metadata: m, nowIso })).toEqual({
        due: isWorkflowRetryDue(m, new Date(nowIso)),
        awaiting: isStepRunAwaitingRetry(m),
        malformed: hasMalformedWorkflowRetry(m),
      });
    }
  });
});
