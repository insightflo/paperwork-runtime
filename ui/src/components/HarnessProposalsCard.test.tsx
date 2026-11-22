import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessProposalsCard } from "./HarnessProposalsCard";
import type {
  HarnessLedgerEntry,
  HarnessProposal,
  HarnessProposalsResponse,
} from "../api/harnessRsi";

// [목적] HarnessProposalsCard의 순수 렌더 경로(data/isLoading/error/defaultHideFlagged 주입)를
//   검증한다 — 라운드/예산 pill·Approval Required·Stalled 배지, Critic Pass/Flagged + 이의
//   목록, "Hide critic-flagged" 클라이언트 필터, 로딩·에러 폴백(레이아웃 크래시 없음).
//   Stage 4C 추가: onDecide Approve (Record)/Reject 버튼, critic 실패 시 overrideReason
//   입력 + 승인 disabled 가드(<10자), HarnessLedgerHistory 배지·델타·Evaluate 버튼.

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

function makeLedgerEntry(overrides: Partial<HarnessLedgerEntry>): HarnessLedgerEntry {
  return {
    id: "e1", companyId: "co-1", round: 1, variant: "v1", component: "guardrails",
    hypothesis: "hyp", diffRef: "v1", decision: "approved", decidedBy: "board",
    overrideReason: null, baselineJson: { score: 0.5, cost: 10 },
    deltaScore: null, deltaCost: null, accepted: null, verdict: null,
    createdAt: "2026-11-22T00:00:00.000Z", evaluatedAt: null,
    ...overrides,
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

  it("renders Approve (Record)/Reject buttons per proposal only when onDecide is provided", () => {
    const response = makeResponse([makeProposal({ id: "p1" })]);
    const html = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={response} onDecide={() => {}} />,
    );
    expect(html).toContain("Approve (Record)");
    expect(html).toContain(">Reject<");
    const without = renderToStaticMarkup(
      <HarnessProposalsCard companyId="co-1" data={response} />,
    );
    expect(without).not.toContain("Approve (Record)");
    expect(without).not.toContain(">Reject<");
  });

  it("renders an override input and disables Approve (Record) on a critic-flagged proposal", () => {
    const html = renderToStaticMarkup(
      <HarnessProposalsCard
        companyId="co-1"
        data={makeResponse([
          makeProposal({
            id: "p1",
            critic: {
              pass: false,
              objections: [{ code: "tenant-hardcoding", detail: "matched path" }],
            },
          }),
        ])}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain('placeholder="Override reason (min 10 chars)..."');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve \(Record\)<\/button>/);
  });

  it("renders ledger history badges/deltas and Evaluate only on a pending approved entry", () => {
    const entries = [
      makeLedgerEntry({ id: "e-pending", round: 2, component: "memory" }),
      makeLedgerEntry({
        id: "e-winner", component: "skills", accepted: true, verdict: "winner",
        deltaScore: 0.12, deltaCost: -0.3, evaluatedAt: "2026-11-22T01:00:00.000Z",
      }),
      makeLedgerEntry({
        id: "e-loser", component: "scripts", decision: "rejected", accepted: false,
        verdict: "rejected", deltaScore: -0.05, deltaCost: 0.1,
        evaluatedAt: "2026-11-22T02:00:00.000Z",
      }),
    ];
    const html = renderToStaticMarkup(
      <HarnessProposalsCard
        companyId="co-1"
        data={makeResponse([])}
        ledgerEntries={entries}
        onEvaluate={() => {}}
      />,
    );
    expect(html).toContain("Ledger History");
    expect(html).toContain(">approved<");
    expect(html).toContain(">rejected<");
    expect(html).toContain(">R2<");
    expect(html).toContain(">pending<");
    expect(html).toContain(">winner<");
    expect(html).toContain("+0.120");
    expect(html).toContain("-30.0%");
    expect(html).toContain("-0.050");
    expect(html).toContain("+10.0%");
    expect(html.match(/>Evaluate</g)?.length ?? 0).toBe(1);
  });
});
