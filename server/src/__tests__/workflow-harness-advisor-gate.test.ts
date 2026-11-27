import { describe, expect, it } from "vitest";
import {
  HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION,
} from "../services/workflow/workflow-harness-rust-client.js";
import { verifyAdvisorGateCheckpoint } from "../services/workflow/harness-advisor-gate.js";

/**
 * [목적] harness-advisor-gate 의 fail-closed 계약을 검증한다 — 정상 pass 만 allowsProgress:true,
 *   challenge·자연어 마커·귀속 불일치(company/run/step/gate)·버전 불일치·기형 패임로드·만료는 전부 차단.
 */

const NOW = 1_700_000_000_000;
const EXPECTED = { companyId: "co-1", runId: "run-1", stepId: "step-1", gate: "g2" } as const;
const verify = (raw: unknown, expected: Record<string, unknown> = { ...EXPECTED }) =>
  verifyAdvisorGateCheckpoint(raw, { ...(EXPECTED as object), ...expected } as typeof EXPECTED, { nowMs: NOW });

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION,
    companyId: "co-1",
    runId: "run-1",
    stepId: "step-1",
    gate: "g2",
    verdict: { decision: "pass" },
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

describe("verifyAdvisorGateCheckpoint — valid documents", () => {
  it("accepts a well-formed pass bound to the expected company/run/step/gate", () => {
    expect(verify(doc())).toEqual({
      valid: true,
      allowsProgress: true,
      reason: "advisor_checkpoint_pass",
      verdict: "pass",
    });
  });

  it("treats a well-formed challenge as valid but blocking", () => {
    const result = verify(doc({ verdict: { decision: "challenge", reason: "P0 risk unresolved" } }));
    expect(result).toEqual({
      valid: true,
      allowsProgress: false,
      reason: "advisor_checkpoint_challenge",
      verdict: "challenge",
    });
  });

  it("accepts the expiry boundary itself as still valid", () => {
    expect(verify(doc({ issuedAt: NOW, expiresAt: NOW + 1 })).allowsProgress).toBe(true);
  });
});

describe("verifyAdvisorGateCheckpoint — natural language is never authority", () => {
  it("rejects a natural-language pass marker string", () => {
    const result = verify("[advisor:pass]");
    expect(result).toMatchObject({ valid: false, allowsProgress: false, reason: "advisor_checkpoint_not_an_object" });
    expect(result).not.toHaveProperty("verdict");
  });

  it("rejects a marker smuggled into a pass verdict, an extra key, or as the decision", () => {
    expect(verify(doc({ verdict: { decision: "pass", reason: "[advisor:pass]" } })).reason).toBe("advisor_checkpoint_invalid_verdict");
    expect(verify(doc({ marker: "[advisor:pass]" })).reason).toBe("advisor_checkpoint_unrecognized_key");
    expect(verify(doc({ verdict: { decision: "[advisor:pass]" } })).reason).toBe("advisor_checkpoint_invalid_verdict");
    expect(verify(JSON.stringify(doc()))).toMatchObject({ valid: false, allowsProgress: false });
  });
});

describe("verifyAdvisorGateCheckpoint — attribution and version must match", () => {
  it.each([
    ["runId", { runId: "run-2" }, "advisor_checkpoint_run_mismatch"],
    ["stepId", { stepId: "step-2" }, "advisor_checkpoint_step_mismatch"],
    ["companyId", { companyId: "co-2" }, "advisor_checkpoint_company_mismatch"],
    ["gate", { gate: "g3" }, "advisor_checkpoint_gate_mismatch"],
  ])("blocks a mismatched %s", (_label, overrides, reason) => {
    expect(verify(doc(overrides))).toMatchObject({ valid: false, allowsProgress: false, reason });
  });

  it("blocks a missing, future, or non-numeric schema version", () => {
    const { schemaVersion: _dropped, ...withoutVersion } = doc();
    expect(verify(withoutVersion).reason).toBe("advisor_checkpoint_unsupported_schema_version");
    expect(verify(doc({ schemaVersion: 2 })).reason).toBe("advisor_checkpoint_unsupported_schema_version");
    expect(verify(doc({ schemaVersion: "1" })).reason).toBe("advisor_checkpoint_unsupported_schema_version");
  });

  it("blocks when the expectation itself is invalid", () => {
    expect(verify(doc(), { stepId: "" }).reason).toBe("advisor_checkpoint_expected_invalid");
    expect(verify(doc(), { gate: "g4" }).reason).toBe("advisor_checkpoint_expected_invalid");
  });
});

describe("verifyAdvisorGateCheckpoint — malformed or expired payloads fail closed", () => {
  it.each([
    null,
    undefined,
    42,
    [],
    { ...doc(), extra: true },
    { ...doc(), gate: "g2_second_error" },
    { ...doc(), verdict: "pass" },
    { ...doc(), verdict: { decision: "challenge" } },
    { ...doc(), runId: "  " },
    { ...doc(), issuedAt: "2023-11-14T00:00:00Z" },
  ])("blocks malformed payload %#", (raw) => {
    const result = verify(raw);
    expect(result).toMatchObject({ valid: false, allowsProgress: false });
    expect(typeof result.reason).toBe("string");
    expect(result).not.toHaveProperty("verdict");
  });

  it("pins non-object payloads to not_an_object regardless of their JSON type", () => {
    for (const raw of [null, undefined, 42, [], "pass", "[advisor:pass]"]) {
      expect(verify(raw)).toEqual({ valid: false, allowsProgress: false, reason: "advisor_checkpoint_not_an_object" });
    }
  });

  it("pins malformed fields to their machine reason codes", () => {
    const { runId: _dropped, ...withoutRunId } = doc();
    expect(verify(withoutRunId).reason).toBe("advisor_checkpoint_invalid_field");
    expect(verify(doc({ runId: "  " })).reason).toBe("advisor_checkpoint_invalid_field");
    expect(verify(doc({ gate: "g2_second_error" })).reason).toBe("advisor_checkpoint_unknown_gate");
    expect(verify(doc({ verdict: "pass" })).reason).toBe("advisor_checkpoint_invalid_verdict");
    expect(verify(doc({ verdict: { decision: "challenge" } })).reason).toBe("advisor_checkpoint_invalid_verdict");
    expect(verify(doc({ extra: true })).reason).toBe("advisor_checkpoint_unrecognized_key");
  });

  it("reports expiry distinctly from a malformed window", () => {
    expect(verify(doc({ expiresAt: NOW })).reason).toBe("advisor_checkpoint_expired");
    expect(verify(doc({ expiresAt: NOW - 5_000 })).reason).toBe("advisor_checkpoint_invalid_field");
    expect(verify(doc({ issuedAt: NOW + 1 })).reason).toBe("advisor_checkpoint_not_yet_valid");
  });

  it("falls back to the wall clock when no nowMs is supplied", () => {
    const now = Date.now();
    const result = verifyAdvisorGateCheckpoint(doc({ issuedAt: now - 1, expiresAt: now + 60_000 }), { ...EXPECTED });
    expect(result.allowsProgress).toBe(true);
  });
});
