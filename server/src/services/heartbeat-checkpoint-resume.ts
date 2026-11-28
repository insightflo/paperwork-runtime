export type ResumeInterruptReason = "preempted" | "timed_out" | "process_lost" | "provider_transient" | "auth_fatal";

export type ResumeStrategy = "resume_session" | "fresh_with_carryover" | "escalate_operator";

export interface CheckpointResumeInput {
  interruptReason: ResumeInterruptReason;
  resumeAttempts: number;
  maxResumeAttempts?: number;
  hasValidSessionId: boolean;
  workspaceChanged?: boolean;
  hasCheckpointSummary?: boolean;
}

export interface CheckpointResumePlan {
  strategy: ResumeStrategy;
  nextAttempt: number;
  preserveSessionId: boolean;
  reason: string;
}

const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

export function planCheckpointResume(input: CheckpointResumeInput): CheckpointResumePlan {
  const maxResumeAttempts = input.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;

  if (input.interruptReason === "auth_fatal") {
    return {
      strategy: "escalate_operator",
      nextAttempt: input.resumeAttempts,
      preserveSessionId: false,
      reason: "authentication failure is fatal; operator intervention is required",
    };
  }

  if (input.resumeAttempts >= maxResumeAttempts) {
    return {
      strategy: "escalate_operator",
      nextAttempt: input.resumeAttempts,
      preserveSessionId: false,
      reason: `resume attempt budget exhausted (${input.resumeAttempts}/${maxResumeAttempts}); operator intervention is required`,
    };
  }

  const canReuseSession = input.hasValidSessionId
    && input.workspaceChanged !== true
    && (input.interruptReason === "preempted" || input.interruptReason === "provider_transient");

  if (canReuseSession) {
    return {
      strategy: "resume_session",
      nextAttempt: input.resumeAttempts + 1,
      preserveSessionId: true,
      reason: `valid session is intact after ${input.interruptReason}; resume the existing session`,
    };
  }

  const cause = input.workspaceChanged === true
    ? "workspace changed"
    : !input.hasValidSessionId
      ? "no valid session id remains"
      : `${input.interruptReason} cannot safely reuse the existing session`;

  return {
    strategy: "fresh_with_carryover",
    nextAttempt: input.resumeAttempts + 1,
    preserveSessionId: false,
    reason: `${cause}; start a fresh session with checkpoint carryover`,
  };
}
