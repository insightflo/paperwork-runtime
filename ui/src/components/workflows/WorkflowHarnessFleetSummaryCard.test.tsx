import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type WorkflowHarnessFleetSummaryCardProps, WorkflowHarnessFleetSummaryCard } from "./WorkflowHarnessFleetSummaryCard";

const HEALTHY: WorkflowHarnessFleetSummaryCardProps = {
  totalRuns: 12,
  healthyRuns: 12,
  stalledRuns: 0,
  timedOutRuns: 0,
  sharpRuns: 5,
  splitRuns: 4,
  escalatedRuns: 0,
  pendingAdvisorGates: 0,
  challengedAdvisorGates: 0,
  avgSuccessRatePct: 91.6667,
  maxIdleMs: 95_000,
};

function render(overrides: Partial<WorkflowHarnessFleetSummaryCardProps> = {}): string {
  return renderToStaticMarkup(<WorkflowHarnessFleetSummaryCard {...HEALTHY} {...overrides} />);
}

function metricBadge(html: string, id: string): string {
  const match = html.match(new RegExp(`<span[^>]*data-metric="${id}"[^>]*>`));
  if (!match) throw new Error(`metric "${id}" not rendered`);
  return match[0];
}

function metricText(html: string, id: string): string {
  const match = html.match(new RegExp(`<span[^>]*data-metric="${id}"[^>]*>(.*?)</span></span>`));
  if (!match) throw new Error(`metric "${id}" not rendered`);
  return match[1].replace(/<[^>]+>/g, "");
}

describe("WorkflowHarnessFleetSummaryCard", () => {
  it("renders an empty fleet with no warning badges and an em dash success rate", () => {
    const html = render({ totalRuns: 0, healthyRuns: 0, sharpRuns: 0, splitRuns: 0, avgSuccessRatePct: null, maxIdleMs: 0 });

    expect(html).toContain("tactile-card");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("No runs yet");
    expect(html).toContain("dark:");
    expect(html).not.toContain('data-metric="stalled"');
    expect(html).not.toContain('data-tone="warning"');
    expect(html).not.toContain('data-tone="danger"');
    expect(metricText(html, "success-rate")).toBe("Success—");
  });

  it("renders every counter for a healthy fleet with a one-decimal success rate", () => {
    const html = render();

    expect(html).not.toContain("No runs yet");
    expect(metricText(html, "total")).toBe("Total12");
    expect(metricText(html, "healthy")).toBe("Healthy12");
    expect(metricBadge(html, "healthy")).toContain('data-tone="good"');
    expect(metricText(html, "sharp")).toBe("Sharp5");
    expect(metricText(html, "split")).toBe("Split4");
    expect(metricText(html, "success-rate")).toBe("Success91.7%");
    expect(metricText(html, "idle")).toBe("Max idle1m 35s");
    expect(html).not.toContain('data-tone="warning"');
  });

  it("flags stalled, timed-out, and escalated runs as warning badges", () => {
    const html = render({
      healthyRuns: 7,
      stalledRuns: 3,
      timedOutRuns: 1,
      escalatedRuns: 2,
      avgSuccessRatePct: 100,
      maxIdleMs: 7_385_000,
    });

    expect(metricBadge(html, "stalled")).toContain('data-tone="warning"');
    expect(metricText(html, "stalled")).toBe("Stalled3");
    expect(metricBadge(html, "timed-out")).toContain('data-tone="warning"');
    expect(metricBadge(html, "escalated")).toContain('data-tone="warning"');
    expect(metricBadge(html, "sharp")).toContain('data-tone="neutral"');
    expect(metricBadge(html, "healthy")).toContain('data-tone="good"');
    expect(metricText(html, "success-rate")).toBe("Success100.0%");
    expect(metricText(html, "idle")).toBe("Max idle2h 3m");
  });

  it("raises advisor gate alerts for pending and challenged gates", () => {
    const html = render({ pendingAdvisorGates: 2, challengedAdvisorGates: 1 });

    expect(metricBadge(html, "advisor-pending")).toContain('data-tone="warning"');
    expect(metricText(html, "advisor-pending")).toBe("Gates2");
    expect(metricBadge(html, "advisor-challenged")).toContain('data-tone="danger"');
    expect(metricText(html, "advisor-challenged")).toBe("Challenged1");
    expect(metricBadge(html, "stalled")).toContain('data-tone="neutral"');
  });

  it("treats a non-finite success rate as unknown", () => {
    expect(metricText(render({ avgSuccessRatePct: Number.NaN }), "success-rate")).toBe("Success—");
  });
});
