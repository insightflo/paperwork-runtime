import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHeartbeatRunFailure } from "../services/heartbeat-failure-classification.js";

/**
 * [목적] commandcode_local max-turns 전용 분기의 TS 팔 동작 검증(게이트 OFF 기본).
 *   어댑터는 max_turns 종료를 isFailure=false + errorCode commandcode_max_turns로
 *   보고하지만 서버 정산은 원시 exit 8 run을 failed로 기록한다. 이 분기는 failure
 *   카드 표시·분류를 위한 것으로 실행 권한 근거가 아니다(AGENTS.md rule 9).
 *   전수 TS/Rust parity 는 heartbeat-core-stage1-parity.test.ts 가 담당한다(범위 밖).
 */
const MAX_TURNS_INPUT = {
  status: "failed",
  adapterType: "commandcode_local",
  errorCode: "commandcode_max_turns",
  errorMessage: "Command Code reached the --max-turns cap before completing; partial response returned.",
};

/** heartbeat-core-client FAILURE_CATEGORIES 와 같은 집합 — 분기가 새 category를 만들지 않는다. */
const SHARED_CATEGORIES = ["timeout", "cancelled", "overload", "quota", "auth", "command", "adapter"] as const;

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", ""); // 게이트 OFF — TS 팔 고정
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("classifyHeartbeatRunFailure: commandcode_max_turns branch", () => {
  it("classifies the max-turns cap with actionable guidance instead of the generic adapter fallback", () => {
    const classification = classifyHeartbeatRunFailure(MAX_TURNS_INPUT);
    expect(classification).toEqual({
      category: "adapter",
      reasonCode: "COMMANDCODE_MAX_TURNS",
      summary: expect.stringContaining("--max-turns cap"),
      fallbackCandidates: [],
    });
    expect(classification.summary).toMatch(/maxTurns/i);
    expect(classification.summary).toMatch(/session is preserved/i);
  });

  it("keeps the category inside the shared TS/Rust set", () => {
    expect(SHARED_CATEGORIES).toContain(classifyHeartbeatRunFailure(MAX_TURNS_INPUT).category);
  });

  it("outranks incidental stderr noise such as ENOENT for the dedicated errorCode", () => {
    const classification = classifyHeartbeatRunFailure({
      ...MAX_TURNS_INPUT,
      stderrExcerpt: "ENOENT: no such file or directory",
    });
    expect(classification.reasonCode).toBe("COMMANDCODE_MAX_TURNS");
    expect(classification.category).toBe("adapter");
  });

  it("does not capture other errorCodes even with the same message text", () => {
    const classification = classifyHeartbeatRunFailure({ ...MAX_TURNS_INPUT, errorCode: "adapter_failed" });
    expect(classification.reasonCode).toBe("adapter_failed");
    expect(classification.summary).toBe("Adapter run failed without a more specific local classification.");
  });

  it("does not classify max-turns message text alone without the machine errorCode", () => {
    const classification = classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: "reached the --max-turns cap",
    });
    expect(classification.reasonCode).toBe("ADAPTER_RUN_FAILED");
  });

  it("requires the exact errorCode (no substring or whitespace-tolerant match)", () => {
    expect(classifyHeartbeatRunFailure({ ...MAX_TURNS_INPUT, errorCode: "commandcode_max_turns_extra" }).reasonCode)
      .toBe("commandcode_max_turns_extra");
    expect(classifyHeartbeatRunFailure({ ...MAX_TURNS_INPUT, errorCode: "  commandcode_max_turns  " }).reasonCode)
      .toBe("COMMANDCODE_MAX_TURNS");
  });
});
