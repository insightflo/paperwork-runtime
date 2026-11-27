import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type WorkflowHarnessFleetSummaryCardProps } from "./WorkflowHarnessFleetSummaryCard";
import { FLEET_EMPTY_COPY, FLEET_ERROR_LABEL, WorkflowHarnessFleetBanner } from "./WorkflowHarnessFleetBanner";

const delegated = vi.hoisted(() => ({ calls: [] as WorkflowHarnessFleetSummaryCardProps[] }));

vi.mock("./WorkflowHarnessFleetSummaryCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./WorkflowHarnessFleetSummaryCard")>();
  return {
    ...actual,
    WorkflowHarnessFleetSummaryCard: (props: WorkflowHarnessFleetSummaryCardProps) => {
      delegated.calls.push(props);
      return actual.WorkflowHarnessFleetSummaryCard(props);
    },
  };
});

const FLEET: WorkflowHarnessFleetSummaryCardProps = {
  totalRuns: 9,
  healthyRuns: 6,
  stalledRuns: 2,
  timedOutRuns: 1,
  sharpRuns: 4,
  splitRuns: 3,
  escalatedRuns: 1,
  pendingAdvisorGates: 1,
  challengedAdvisorGates: 0,
  avgSuccessRatePct: 77.5,
  maxIdleMs: 125_000,
};

const EMPTY_FLEET: WorkflowHarnessFleetSummaryCardProps = { ...FLEET, totalRuns: 0, healthyRuns: 0, avgSuccessRatePct: null, maxIdleMs: 0 };
const CARD_MARK = 'aria-label="Workflow harness fleet summary"';

function render(props: Parameters<typeof WorkflowHarnessFleetBanner>[0]): string {
  return renderToStaticMarkup(<WorkflowHarnessFleetBanner {...props} />);
}

beforeEach(() => {
  delegated.calls.length = 0;
});

describe("WorkflowHarnessFleetBanner", () => {
  it("renders an explicit loading skeleton and delegates nothing", () => {
    const html = render({ status: "loading" });

    expect(html).toContain('data-fleet-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(CARD_MARK);
    expect(html).not.toContain(FLEET_EMPTY_COPY);
    expect(html).not.toContain('role="alert"');
    expect(delegated.calls).toEqual([]);
  });

  it("surfaces the error as an alert with its detail instead of an empty view", () => {
    const html = render({ status: "error", error: new Error("500 <upstream down>") });

    expect(html).toContain('data-fleet-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(FLEET_ERROR_LABEL);
    expect(html).toContain("500 &lt;upstream down&gt;");
    expect(html).not.toContain(CARD_MARK);
    expect(html).not.toContain(FLEET_EMPTY_COPY);
    expect(html).not.toContain("animate-pulse");
    expect(delegated.calls).toEqual([]);
  });

  it("keeps the notice readable when the error carries no message", () => {
    const html = render({ status: "error", error: new Error("   ") });

    expect(html).toContain('role="alert"');
    expect(html).toContain(FLEET_ERROR_LABEL);
    expect(html).toContain("원인 메시지 없음");
  });

  it("still delegates a stale fleet beneath the error notice", () => {
    const html = render({ status: "error", error: "timeout", fleet: FLEET });

    expect(html).toContain('role="alert"');
    expect(html).toContain("timeout");
    expect(html).toContain(CARD_MARK);
    expect(delegated.calls).toEqual([FLEET]);
  });

  it("renders compact empty copy without delegating to the card", () => {
    const html = render({ status: "ready", fleet: EMPTY_FLEET });

    expect(html).toContain('data-fleet-state="empty"');
    expect(html).toContain(FLEET_EMPTY_COPY);
    expect(html).not.toContain(CARD_MARK);
    expect(html).not.toContain("No runs yet");
    expect(html).not.toContain('role="alert"');
    expect(delegated.calls).toEqual([]);
  });

  it("delegates a populated fleet unchanged to WorkflowHarnessFleetSummaryCard", () => {
    const html = render({ status: "ready", fleet: FLEET, className: "extra-class" });

    expect(html).toContain('data-fleet-state="populated"');
    expect(html).toContain("extra-class");
    expect(html).toContain(CARD_MARK);
    expect(html).not.toContain(FLEET_EMPTY_COPY);
    expect(html).not.toContain('role="alert"');
    expect(delegated.calls).toHaveLength(1);
    expect(delegated.calls[0]).toEqual(FLEET);
    const total = html.match(/data-metric="total"[^>]*>(.*?)<\/span><\/span>/);
    expect(total?.[1].replace(/<[^>]+>/g, "")).toBe("Total9");
  });
});
