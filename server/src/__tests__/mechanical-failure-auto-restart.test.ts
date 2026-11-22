import { describe, expect, it } from "vitest";
import {
  MECHANICAL_CLAIM_TTL_MS,
  evaluateMechanicalAutoRestartEligibility,
  extractMechanicalFailureCode,
  isMechanicalClaimActive,
  stripPerRunMetadataStamps,
} from "../services/workflow/mechanical-failure-auto-restart.js";

const STALE_PRODUCER_STEP = {
  status: "failed",
  metadata: { toolInvocation: { dispatchError: "workproduct_selector_stale_producer" } },
};

describe("mechanical-failure-auto-restart", () => {
  it("matches only exact structured dispatchError codes and rejects prose/substrings", () => {
    expect(extractMechanicalFailureCode([STALE_PRODUCER_STEP])).toBe("workproduct_selector_stale_producer");
    expect(
      extractMechanicalFailureCode([
        { status: "failed", metadata: { toolInvocation: { dispatchError: "wrapped: workproduct_selector_stale_producer" } } },
      ]),
    ).toBeNull();
    expect(
      extractMechanicalFailureCode([
        { status: "failed", metadata: { toolInvocation: { dispatchError: "llm_timeout" } } },
      ]),
    ).toBeNull();
    expect(
      extractMechanicalFailureCode([
        { status: "completed", metadata: { toolInvocation: { dispatchError: "workproduct_selector_stale_producer" } } },
      ]),
    ).toBeNull();
  });

  it("allows first failed top-level active-mission run with allowlisted mechanical error", () => {
    const res = evaluateMechanicalAutoRestartEligibility({
      runStatus: "failed",
      parentRunId: null,
      missionId: "m1",
      missionStatus: "active",
      metadata: { url: "https://example.com" },
      hasExistingReplacement: false,
      hasActiveSibling: false,
      failedSteps: [STALE_PRODUCER_STEP],
    });
    expect(res).toEqual({ eligible: true, reasonCode: "workproduct_selector_stale_producer" });
  });

  it("blocks child runs, inactive missions, already-auto-restarted chains (max 1), and existing replacements", () => {
    const base = {
      runStatus: "failed",
      parentRunId: null as string | null,
      missionId: "m1",
      missionStatus: "active",
      metadata: {} as Record<string, unknown>,
      hasExistingReplacement: false,
      hasActiveSibling: false,
      failedSteps: [STALE_PRODUCER_STEP],
    };

    expect(evaluateMechanicalAutoRestartEligibility({ ...base, parentRunId: "parent-1" })).toEqual({
      eligible: false,
      reason: "child_run_excluded",
    });
    expect(evaluateMechanicalAutoRestartEligibility({ ...base, missionStatus: "cancelled" })).toEqual({
      eligible: false,
      reason: "mission_not_active",
    });
    expect(
      evaluateMechanicalAutoRestartEligibility({
        ...base,
        metadata: { mechanicalAutoRestart: { schemaVersion: 1, sourceWorkflowRunId: "r0", reasonCode: "workproduct_selector_stale_producer" } },
      }),
    ).toEqual({ eligible: false, reason: "max_one_auto_restart_reached" });
    expect(evaluateMechanicalAutoRestartEligibility({ ...base, hasExistingReplacement: true })).toEqual({
      eligible: false,
      reason: "replacement_already_exists",
    });
    expect(evaluateMechanicalAutoRestartEligibility({ ...base, hasActiveSibling: true })).toEqual({
      eligible: false,
      reason: "active_sibling_exists",
    });
  });

  it("enforces 5-minute claim TTL and allows re-claim once expired unless completedRunId is set", () => {
    const now = Date.parse("2026-11-22T12:10:00Z");
    const fresh = { claimId: "c1", claimedAt: new Date(now - 60_000).toISOString(), reasonCode: "workproduct_selector_stale_producer" };
    const expired = { claimId: "c2", claimedAt: new Date(now - MECHANICAL_CLAIM_TTL_MS - 1000).toISOString(), reasonCode: "workproduct_selector_stale_producer" };
    const completed = { ...expired, completedRunId: "run-2" };

    expect(isMechanicalClaimActive(fresh, now)).toBe(true);
    expect(isMechanicalClaimActive(expired, now)).toBe(false);
    expect(isMechanicalClaimActive(completed, now)).toBe(true);
  });

  it("strips all 9 runtime stamps while preserving caller inputs", () => {
    const carried = stripPerRunMetadataStamps({
      url: "https://github.com/postzen-dev/instagram-agent-skill",
      slug: "instagram-agent-skill",
      section: "manuals",
      operatorDecisionRestart: { sourceWorkflowRunId: "r0" },
      mechanicalAutoRestart: { sourceWorkflowRunId: "r0" },
      mechanicalAutoRestartClaimed: { claimId: "c1" },
      executionDefinitionVersion: 1,
      replacementAuthorityId: "a1",
      replacementStart: { ok: true },
      resumeRequestId: "req1",
      resumeAuthorityVersion: 2,
      ownerPlanExecution: { planId: "p1" },
    });
    expect(carried).toEqual({
      url: "https://github.com/postzen-dev/instagram-agent-skill",
      slug: "instagram-agent-skill",
      section: "manuals",
    });
  });
});
