import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessProposalsCard } from "./HarnessProposalsCard";
import type { HarnessProposal, HarnessProposalsResponse } from "../api/harnessRsi";

// [목적] HarnessProposalsCard의 순수 렌더 경로(data/isLoading/error/defaultHideFlagged 주입)를
//   검증한다 — 라운드/예산 pill·Approval Required·Stalled 배지, Critic Pass/Flagged + 이의
//   목록, "Hide critic-flagged" 클라이언트 필터, 로딩·에러 폴백(레이아웃 크래시 없음).

function makeProposal(overrides: Partial<HarnessProposal>): HarnessProposal {
  return {
    id: "rrsi-r1-guardrails-1",
    component: "guardrails",
    severity: "medium",
    targetMetric: "lock_timeouts",
    hypothesis: "hypothesis-text",
    recommendedAction: "action-text",
    critic: { pass: true, objections: [] },
    requiresApproval: true,
    autoApply: false,
    ...overrides,
  };
}

function makeResponse(proposals: HarnessProposal[], stallFlag = false): HarnessProposalsResponse {
  return {
    companyId: "co-1",
    windowHours: 24,
    result: {
      round: 1,
      totalRounds: 6,
      budget: 3,
      stallFlag,
      prunedComponents: [],
      proposals,
    },
  };
}

describe("HarnessProposalsCard", () => {
  it("renders the round/budget header, approval badge, and empty state", () => {
    const html = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={makeResponse([])} />,
    );
    expect(html).toContain("Harness Proposals");
    expect(html).toContain("Round 1/6 · Budget 3");
    expect(html).toContain("Approval Required (No Auto-Apply)");
    expect(html).not.toContain("Stalled");
    expect(html).toContain("No proposals generated for this round.");
  });

  it("renders proposals with Critic Pass vs Flagged badges, objections, and Stalled", () => {
    const proposals = [
      makeProposal({
        id: "p1",
        severity: "high",
        component: "adapter_config",
        targetMetric: "high_token_runs",
        hypothesis: "Token-heavy runs spike cost",
        recommendedAction: "Cap output tokens.",
      }),
      makeProposal({
        id: "p2",
        severity: "low",
        component: "memory",
        targetMetric: "step_avg_duration_ms:plan",
        hypothesis: "Memory hint embeds a tenant path",
        recommendedAction: "Generalize the hint.",
        critic: {
          pass: false,
          objections: [
            { code: "tenant-hardcoding", detail: ":2 matched deploy-path" },
            { code: "hardcoded-uuid", detail: ":3 matched hardcoded-uuid" },
          ],
        },
      }),
    ];
    const html = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={makeResponse(proposals, true)} />,
    );
    expect(html).toContain("Stalled");
    expect(html).toContain(">high<");
    expect(html).toContain(">low<");
    expect(html).toContain("adapter config");
    expect(html).toContain(">Critic Pass<");
    expect(html).toContain(">Critic Flagged<");
    expect(html).toContain("tenant-hardcoding");
    expect(html).toContain("matched hardcoded-uuid");
    expect(html).toContain("Token-heavy runs spike cost");
    expect(html).toContain("Cap output tokens.");
    expect(html).toContain("Approval Required (No Auto-Apply)");
  });

  it("shows all proposals by default and filters critic-flagged rows when toggled", () => {
    const proposals = [
      makeProposal({ id: "p1", hypothesis: "keep-me" }),
      makeProposal({
        id: "p2",
        hypothesis: "flagged-hide-me",
        critic: {
          pass: false,
          objections: [{ code: "missing-hypothesis", detail: "empty hypothesis" }],
        },
      }),
    ];
    const all = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={makeResponse(proposals)} />,
    );
    expect(all).toContain("Hide critic-flagged");
    expect(all).toContain("keep-me");
    expect(all).toContain("flagged-hide-me");

    const filtered = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={makeResponse(proposals)} defaultHideFlagged />,
    );
    expect(filtered).toContain("keep-me");
    expect(filtered).not.toContain("flagged-hide-me");
    expect(filtered).not.toContain("missing-hypothesis");
  });

  it("renders a quiet loading fallback", () => {
    const html = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" isLoading={true} />,
    );
    expect(html).toContain("Harness Proposals");
    expect(html).toContain("Loading proposals");
    expect(html).not.toContain("No proposals generated");
  });

  it("renders a non-intrusive fallback on error without crashing", () => {
    const html = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" error={new Error("boom-503")} />,
    );
    expect(html).toContain("Harness Proposals");
    expect(html).toContain("Proposals unavailable");
    expect(html).toContain("boom-503");
    expect(html).toContain("Approval Required (No Auto-Apply)");
  });
});
