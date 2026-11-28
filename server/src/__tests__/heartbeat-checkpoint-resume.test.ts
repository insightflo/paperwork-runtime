import { describe, expect, it } from "vitest";
import { planCheckpointResume, type CheckpointResumeInput } from "../services/heartbeat-checkpoint-resume.js";

function input(overrides: Partial<CheckpointResumeInput> = {}): CheckpointResumeInput {
  return {
    interruptReason: "preempted",
    resumeAttempts: 0,
    hasValidSessionId: true,
    ...overrides,
  };
}

describe("planCheckpointResume", () => {
  it.each(["preempted", "provider_transient"] as const)(
    "resumes the existing session after %s with a valid session and unchanged workspace",
    (interruptReason) => {
      const plan = planCheckpointResume(input({ interruptReason, resumeAttempts: 1 }));

      expect(plan).toMatchObject({
        strategy: "resume_session",
        nextAttempt: 2,
        preserveSessionId: true,
      });
      expect(plan.reason).toContain(interruptReason);
    },
  );

  it("falls back to a fresh carryover session when the workspace changed", () => {
    const plan = planCheckpointResume(input({ workspaceChanged: true, hasCheckpointSummary: true }));

    expect(plan).toMatchObject({
      strategy: "fresh_with_carryover",
      nextAttempt: 1,
      preserveSessionId: false,
    });
    expect(plan.reason).toContain("workspace changed");
  });

  it("falls back to a fresh carryover session when the session id is missing", () => {
    const plan = planCheckpointResume(input({ hasValidSessionId: false }));

    expect(plan).toMatchObject({
      strategy: "fresh_with_carryover",
      nextAttempt: 1,
      preserveSessionId: false,
    });
    expect(plan.reason).toContain("no valid session id");
  });

  it.each(["timed_out", "process_lost"] as const)(
    "falls back to a fresh carryover session after %s even with a valid session",
    (interruptReason) => {
      const plan = planCheckpointResume(input({ interruptReason, resumeAttempts: 2 }));

      expect(plan).toMatchObject({
        strategy: "fresh_with_carryover",
        nextAttempt: 3,
        preserveSessionId: false,
      });
      expect(plan.reason).toContain(interruptReason);
    },
  );

  it("escalates auth_fatal even when the existing session otherwise looks resumable", () => {
    const plan = planCheckpointResume(input({ interruptReason: "auth_fatal", resumeAttempts: 1 }));

    expect(plan).toMatchObject({
      strategy: "escalate_operator",
      nextAttempt: 1,
      preserveSessionId: false,
    });
    expect(plan.reason).toContain("authentication failure");
  });

  it("escalates when the default resume attempt budget is reached", () => {
    const plan = planCheckpointResume(input({ resumeAttempts: 3 }));

    expect(plan).toMatchObject({
      strategy: "escalate_operator",
      nextAttempt: 3,
      preserveSessionId: false,
    });
    expect(plan.reason).toContain("3/3");
  });

  it("uses a custom maxResumeAttempts budget", () => {
    expect(planCheckpointResume(input({ resumeAttempts: 1, maxResumeAttempts: 2 }))).toMatchObject({
      strategy: "resume_session",
      nextAttempt: 2,
    });
    expect(planCheckpointResume(input({ resumeAttempts: 2, maxResumeAttempts: 2 }))).toMatchObject({
      strategy: "escalate_operator",
      nextAttempt: 2,
    });
  });
});
