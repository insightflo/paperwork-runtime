// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveWorkflowHarnessBar, formatIdleMs, toHarnessBarModel, type HarnessBarModel,
} from "./LiveWorkflowHarnessBar";
import {
  useWorkflowRunHarnessStatus,
  type UseWorkflowRunHarnessStatusResult,
} from "../../hooks/useWorkflowRunHarnessStatus";
import type { WorkflowRunHarnessSummary } from "../../api/workflowHarness";

vi.mock("../../hooks/useWorkflowRunHarnessStatus", () => ({ useWorkflowRunHarnessStatus: vi.fn() }));

const hookMock = vi.mocked(useWorkflowRunHarnessStatus);
const RUN_ID = "run-0199-harness";
const summary: WorkflowRunHarnessSummary = {
  runId: RUN_ID, stallStatus: "stalled", idleMs: 612_000, route: "escalate", advisorGate: "g2_challenge",
  successRatePct: 66.7, totalSteps: 3, completedSteps: 2, failedSteps: 1, stalledSteps: 1,
  evaluatedAt: "2026-11-27T09:30:00.000Z",
};
const LOCAL: UseWorkflowRunHarnessStatusResult = { summary: null, isLoading: false, error: null, isFetching: false, refetch: vi.fn() };
const FALLBACK_MARK = "로컬에서 추정한 하네스 상태";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(
  props: { runId: string | null | undefined; isRunning: boolean; fallback?: ReactNode },
): Promise<string> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(LiveWorkflowHarnessBar, { fallback: FALLBACK_MARK, ...props }));
  });
  return host.innerHTML;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = host = null;
  hookMock.mockReset();
});

describe("LiveWorkflowHarnessBar", () => {
  it("renders the live server summary when the hook returns data", async () => {
    hookMock.mockReturnValue({ ...LOCAL, summary });
    const html = await render({ runId: RUN_ID, isRunning: true });

    expect(hookMock).toHaveBeenCalledWith(RUN_ID, { isRunning: true });
    expect(html).toContain('data-harness-source="server"');
    expect(html).toContain('data-harness-summary="run-0199-harness"');
    expect(html).toContain("실시간 서버");
    expect(html).not.toContain("로컬 추정");
    expect(html).not.toContain(FALLBACK_MARK);
    for (const text of ["지연", "10m 12s", "escalate", "G2 이의 검토", "66.7%", "2/3 완료", "실패 1", "지연 1"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("서버 조회 실패");
  });

  it("forwards isRunning=false so a terminal run does not keep polling", async () => {
    hookMock.mockReturnValue({ ...LOCAL, summary });
    await render({ runId: RUN_ID, isRunning: false });

    expect(hookMock).toHaveBeenCalledWith(RUN_ID, { isRunning: false });
  });

  it("falls back to the client estimate while the first load is pending", async () => {
    hookMock.mockReturnValue({ ...LOCAL, isLoading: true, isFetching: true });
    const html = await render({ runId: RUN_ID, isRunning: true });

    expect(html).toContain('data-harness-source="local"');
    expect(html).toContain(FALLBACK_MARK);
    expect(html).toContain("로컬 추정");
    expect(html).toContain("서버 요약을 불러오는 중");
    expect(html).not.toContain("실시간 서버");
    expect(html).not.toContain("서버 조회 실패");
  });

  it("falls back when the server returns null (fail closed) without claiming an error", async () => {
    hookMock.mockReturnValue(LOCAL);
    const html = await render({ runId: RUN_ID, isRunning: true });

    expect(html).toContain(FALLBACK_MARK);
    expect(html).toContain("로컬 추정");
    expect(html).not.toContain("실시간 서버");
    expect(html).not.toContain("서버 조회 실패");
  });

  it("falls back and surfaces the failure when the server lookup errors", async () => {
    hookMock.mockReturnValue({ ...LOCAL, error: new Error("boom") });
    const html = await render({ runId: RUN_ID, isRunning: true });

    expect(html).toContain(FALLBACK_MARK);
    expect(html).toContain("로컬 추정");
    expect(html).not.toContain("실시간 서버");
    expect(html).toContain("서버 조회 실패");
    expect(html).toContain('title="boom"');
  });

  it("falls back for a blank runId without a server claim", async () => {
    hookMock.mockReturnValue(LOCAL);
    for (const runId of [null, "", "   "]) {
      const html = await render({ runId, isRunning: true });
      expect(html).toContain('data-harness-source="local"');
      expect(html).toContain("실행 ID가 없어");
      expect(html).toContain(FALLBACK_MARK);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  it("keeps the source badge a fixed-size sibling so the fallback keeps its own layout", async () => {
    hookMock.mockReturnValue(LOCAL);
    const html = await render({ runId: RUN_ID, isRunning: true });

    const badge = html.match(/<span[^>]*data-testid="harness-source-badge"[^>]*>/)?.[0] ?? "";
    expect(badge).toContain("shrink-0");
    expect(html).toMatch(/min-w-0 flex-1/);
  });
});

describe("toHarnessBarModel / formatIdleMs", () => {
  it("maps every server field to a display string", () => {
    const m: HarnessBarModel = toHarnessBarModel(summary);
    expect(m).toEqual({
      stallLabel: "지연", stallTone: "warn", idleLabel: "10m 12s", route: "escalate",
      gateLabel: "G2 이의 검토", successLabel: "66.7%", stepsLabel: "2/3 완료 · 실패 1 · 지연 1",
      evaluatedAtLabel: expect.stringMatching(/\d{2}:\d{2}:\d{2}/),
    });
  });

  it("handles null success rate, idle 0, and the healthy/timed_out tones", () => {
    const base: WorkflowRunHarnessSummary = {
      ...summary, successRatePct: null, idleMs: 0, advisorGate: "none", route: "sharp",
    };
    expect(toHarnessBarModel({ ...base, stallStatus: "healthy" })).toMatchObject({
      stallLabel: "정상", stallTone: "ok", idleLabel: "0s", successLabel: "집계 전", gateLabel: "없음",
    });
    expect(toHarnessBarModel({ ...base, stallStatus: "timed_out" })).toMatchObject({
      stallLabel: "시간 초과", stallTone: "bad",
    });
  });

  it("formats idle durations and clamps negatives", () => {
    expect(formatIdleMs(59_999)).toBe("59s");
    expect(formatIdleMs(60_000)).toBe("1m 0s");
    expect(formatIdleMs(3_600_000)).toBe("60m 0s");
    expect(formatIdleMs(-5)).toBe("0s");
  });
});
