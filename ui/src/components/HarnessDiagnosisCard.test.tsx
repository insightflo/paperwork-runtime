import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessDiagnosisCard } from "./HarnessDiagnosisCard";
import type { HarnessBottleneck, HarnessDiagnosisResponse } from "../api/harnessRsi";

// [목적] HarnessDiagnosisCard의 순수 렌더 경로(data/isLoading/error 주입)를 검증한다 —
//   healthy 상태, 병목 배지·포맷된 지표, 에러 폴백(레이아웃 크래시 없음).

const summary = {
  totalRuns: 12,
  successRate: 0.9167,
  avgDurationMs: 522_000, // 8.7m
  p90DurationMs: 1_140_000, // 19.0m
  selfBlockCancels: 0,
  lockTimeouts: 1,
  highTokenRuns: 2,
  slowRuns: 3,
};

function makeResponse(bottlenecks: HarnessBottleneck[]): HarnessDiagnosisResponse {
  return { companyId: "co-1", windowHours: 24, report: { summary, bottlenecks } };
}

describe("HarnessDiagnosisCard", () => {
  it("renders the compact metrics row and a healthy state when bottlenecks are empty", () => {
    const html = renderToStaticMarkup(
      <HarnessDiagnosisCard companyId="co-1" data={makeResponse([])} />,
    );
    expect(html).toContain("Harness Diagnosis");
    expect(html).toContain("last 24h");
    // metrics: runs, success %, avg/p90 formatted durations, counters
    expect(html).toContain(">12<");
    expect(html).toContain("91.7%");
    expect(html).toContain("8.7m");
    expect(html).toContain("19.0m");
    expect(html).toContain(">3<"); // slow runs
    expect(html).toContain(">2<"); // high-token runs
    expect(html).toContain(">1<"); // lock timeouts
    expect(html).toContain("No bottlenecks detected in this window.");
  });

  it("renders up-to-5 bottlenecks with severity badges, component pills, and actions", () => {
    const bottlenecks: HarnessBottleneck[] = [
      {
        component: "adapter_config",
        severity: "high",
        metric: "high_token_runs",
        hypothesis: "5 run(s) emitted at least 30000 output tokens",
        recommendedAction: "Cap output in adapterConfig.",
      },
      {
        component: "guardrails",
        severity: "medium",
        metric: "guardrail_faults",
        hypothesis: "2 lock-timeout failure(s) burned runs",
        recommendedAction: "Reduce lock contention.",
      },
      {
        component: "tool_guidance",
        severity: "low",
        metric: "step_avg_duration_ms:plan",
        hypothesis: "Step plan averages 16min",
        recommendedAction: "Split the step.",
      },
    ];
    const html = renderToStaticMarkup(
      <HarnessDiagnosisCard companyId="co-1" data={makeResponse(bottlenecks)} />,
    );
    // severity badges
    expect(html).toContain(">high<");
    expect(html).toContain(">medium<");
    expect(html).toContain(">low<");
    // component pill prettified + metric
    expect(html).toContain("adapter config");
    expect(html).toContain("guardrails");
    expect(html).toContain("step_avg_duration_ms:plan");
    // hypothesis + recommended action
    expect(html).toContain("5 run(s) emitted at least 30000 output tokens");
    expect(html).toContain("Action:");
    expect(html).toContain("Reduce lock contention.");
    // healthy state must not appear
    expect(html).not.toContain("No bottlenecks detected");
  });

  it("caps the bottleneck list at 5 entries", () => {
    const many: HarnessBottleneck[] = Array.from({ length: 7 }, (_, i) => ({
      component: "memory",
      severity: "low",
      metric: `m${i}`,
      hypothesis: `hypothesis-${i}`,
      recommendedAction: `action-${i}`,
    }));
    const html = renderToStaticMarkup(
      <HarnessDiagnosisCard companyId="co-1" data={makeResponse(many)} />,
    );
    expect(html).toContain("hypothesis-4");
    expect(html).not.toContain("hypothesis-5");
  });

  it("renders a non-intrusive fallback on error without crashing", () => {
    const html = renderToStaticMarkup(
      <HarnessDiagnosisCard companyId="co-1" error={new Error("boom-500")} />,
    );
    expect(html).toContain("Harness Diagnosis");
    expect(html).toContain("Diagnosis unavailable");
    expect(html).toContain("boom-500");
  });

  it("renders a quiet loading fallback", () => {
    const html = renderToStaticMarkup(
      <HarnessDiagnosisCard companyId="co-1" isLoading={true} />,
    );
    expect(html).toContain("Loading diagnosis");
    expect(html).not.toContain("No bottlenecks detected");
  });
});
